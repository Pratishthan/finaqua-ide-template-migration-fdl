import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { dialect } from "@/Mapping/dialect.js";
import { bronzeJob, silverJob } from "@/Mapping/finaqua.js";
import {
	parseBronzeMapping,
	parseEntityAttributes,
	parseMappingWorkbook,
} from "@/Mapping/parse.js";
import { buildPlan, DEFAULT_PLAN_OPTIONS } from "@/Mapping/plan.js";
import { applyQualityRules } from "@/Mapping/quality.js";
import type { Condition, MappingRow, Plan } from "@/Mapping/types.js";

const pg = dialect("postgres");
const planOptions = { ...DEFAULT_PLAN_OPTIONS, target: pg };
const jobOptions = { batchName: "CDH", source: pg, target: pg };

const sample = (name: string) =>
	fileURLToPath(new URL(`../../test/sample/${name}`, import.meta.url));

async function read(file: string): Promise<ExcelJS.Workbook> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(file);
	return workbook;
}

let n = 1;
function row(
	entity: string,
	column: string,
	type: string,
	source: string,
	sourceColumn: string,
	rule = "##STRAIGHTMOVE",
): MappingRow {
	n++;
	return {
		entity,
		column,
		fdlType: type,
		sourceEntity: source,
		sourceColumn,
		sourceType: type,
		rule,
		cell: `Sheet!A${n}`,
	};
}

function planOf(
	bronzeRows: MappingRow[],
	rows: MappingRow[],
	conditions: Condition[] = [],
): Plan {
	return buildPlan(
		{ sourceFile: "t.xlsx", rows, conditions, skipped: [], bronzeRows },
		planOptions,
	);
}

const S_RETAIL = [
	row("s_retail", "cifid", "varchar(50)", "retail", "cifid"),
	row("s_retail", "deleted", "varchar(5)", "retail", "_deleted"),
	row(
		"s_retail",
		"metadata_persisted_timestamp",
		"timestamptz",
		"retail",
		"_modifiedon",
	),
	row(
		"s_retail",
		"metadata_business_key_value",
		"varchar(200)",
		"retail",
		"cifid",
		"retail.cifid||'.'||retail.bankentityid",
	),
	row(
		"s_retail",
		"metadata_batch_execution_id",
		"integer",
		"##NA",
		"##NA",
		"##PIPELINEGENERATED",
	),
];

describe("staging tables from BronzeMappings", () => {
	it("stages each column as the sheet says", () => {
		const plan = planOf(S_RETAIL, [
			row("person", "customer_identifier", "varchar(50)", "retail", "cifid"),
		]);
		const [table] = plan.bronze;
		assert.ok(table);

		assert.equal(table.staging, "s_retail");
		assert.equal(table.source, "retail");
		assert.deepEqual(table.columns, [{ name: "cifid", type: "varchar(50)" }]);
		assert.deepEqual(table.stagedAs, {
			_deleted: "deleted",
			_modifiedon: "metadata_persisted_timestamp",
		});
		// The incremental filter reads the source column; the ts guard the staged one.
		assert.equal(table.watermark, "_modifiedon");
		assert.equal(table.keyColumn, "metadata_business_key_value");

		const job = bronzeJob(table, "incremental", jobOptions);
		const view = job.source.views[1] as { params: { query: string } };
		assert.match(view.params.query, /\b_deleted as deleted\b/);
		assert.match(view.params.query, /where _modifiedon >/);
		const writer = job.srcevents[0]?.procedure.execplan[0].actions[0]?.params;
		assert.equal(writer?.action, "upsert");
		assert.deepEqual(writer?.ts, ["metadata_persisted_timestamp"]);
	});

	it("does not derive staging from DataMapping when the sheet is given", () => {
		// DataMapping reads retail.extra; only BronzeMappings decides staging.
		const plan = planOf(S_RETAIL, [
			row("person", "extra", "text", "retail", "extra"),
		]);
		assert.ok(!plan.bronze[0]?.columns.some((c) => c.name === "extra"));
		assert.ok(
			plan.issues.some(
				(i) =>
					i.level === "error" && /s_retail has no column extra/.test(i.message),
			),
		);
	});

	it("reads staged names in silver: a renamed column by either name", () => {
		const plan = planOf(S_RETAIL, [
			row("person", "deleted_flag", "varchar(5)", "retail", "_deleted"),
			row(
				"person",
				"metadata_persisted_timestamp",
				"timestamptz",
				"retail",
				"metadata_persisted_timestamp",
			),
		]);
		const exprs = plan.silver[0]?.branches[0]?.columns.map((c) => c.expr);
		assert.deepEqual(exprs, [
			"retail.deleted",
			"retail.metadata_persisted_timestamp",
		]);
		assert.deepEqual(
			plan.issues.filter((i) => i.level === "error"),
			[],
		);
	});

	it("reports what it cannot stage", () => {
		const plan = planOf(
			[
				row("s_a", "x", "text", "a", "x"),
				row("s_a", "y", "text", "b", "y"),
				row("s_c", "k", "text", "c", "k", "c.k||'.'||b.k"),
				row("s_c", "label", "text", "c", "##NA", "cifid.bankentityid'"),
				row("s_e", "x", "text", "e", "x"),
				row("s_e2", "x", "text", "e", "x"),
			],
			[],
		);
		const errors = plan.issues
			.filter((i) => i.level === "error")
			.map((i) => `${i.scope}: ${i.message}`);

		assert.deepEqual(errors, [
			"s_a: a staging table reads exactly one source table, got a, b - not generated",
			"s_c: k: the rule reads b.k, but the staging query only reads c",
			"s_c: label: the rule has an unbalanced quote - the staging query will fail",
			"s_e2: e is already staged as s_e - silver reads one staging table per source, so this one is not generated",
		]);
		assert.deepEqual(
			plan.bronze.map((b) => b.staging),
			["s_c", "s_e"],
		);
	});

	it("loads a ##NA rule as a typed NULL, and ignores a ##NA column", () => {
		const plan = planOf(S_RETAIL, [
			row("person", "customer_identifier", "varchar(50)", "retail", "cifid"),
			row(
				"person",
				"involvement_type",
				"varchar(50)",
				"retail",
				"##NA",
				"##NA",
			),
			row("person", "##na", "##na", "retail", "entityid"),
		]);
		const columns = plan.silver[0]?.branches[0]?.columns;
		assert.deepEqual(
			columns?.map((c) => [c.name, c.expr]),
			[
				["customer_identifier", "retail.cifid"],
				["involvement_type", "cast(null as varchar(50))"],
			],
		);
	});

	it("ignores a ##NA column in the bronze sheet, as in DataMapping", () => {
		const plan = planOf(
			[...S_RETAIL, row("s_retail", "##na", "##na", "retail", "entityid")],
			[],
		);
		const [table] = plan.bronze;
		assert.ok(table);
		assert.ok(
			![...table.columns, ...table.standard].some((c) => c.name === "##na"),
		);
		const view = bronzeJob(table, "full", jobOptions).source.views[1] as {
			params: { query: string };
		};
		assert.doesNotMatch(view.params.query, /##na|\bentityid\b/);
	});

	it("does not upsert on a NULL or constant business key", () => {
		const withKey = (rule: string) =>
			planOf(
				[
					...S_RETAIL.filter((r) => r.column !== "metadata_business_key_value"),
					row(
						"s_retail",
						"metadata_business_key_value",
						"varchar(200)",
						"retail",
						"##NA",
						rule,
					),
				],
				[],
			);

		for (const [rule, message] of [
			["##NA", /is ##NA, so every row stages a NULL key/],
			["'X'", /is the constant 'X'/],
		] as const) {
			const plan = withKey(rule);
			const [table] = plan.bronze;
			assert.ok(table);
			assert.equal(table.keyColumn, undefined, rule);
			const writer = bronzeJob(table, "incremental", jobOptions).srcevents[0]
				?.procedure.execplan[0].actions[0]?.params;
			assert.equal(writer?.action, "insert", rule);
			assert.ok(
				plan.issues.some((i) => i.level === "error" && message.test(i.message)),
				rule,
			);
		}

		// A business key copied under its own name is a key all the same.
		const straight = planOf(
			[
				...S_RETAIL.filter((r) => r.column !== "metadata_business_key_value"),
				row(
					"s_retail",
					"metadata_business_key_value",
					"varchar(200)",
					"retail",
					"metadata_business_key_value",
				),
			],
			[],
		);
		assert.equal(straight.bronze[0]?.keyColumn, "metadata_business_key_value");
	});

	it("borrows the FDL business key when the bronze sheet gives none", () => {
		const unkeyed = S_RETAIL.filter(
			(r) => r.column !== "metadata_business_key_value",
		);
		const keyRule = row(
			"person",
			"metadata_business_key_value",
			"varchar(200)",
			"retail",
			"##NA",
			"retail.cifid||'.'||retail.cifid",
		);
		const borrowed = planOf(unkeyed, [keyRule]);
		const table = borrowed.bronze[0];
		assert.ok(table);
		assert.equal(table.keyColumn, undefined);
		assert.deepEqual(table.key, ["cifid"]);
		const writer = bronzeJob(table, "incremental", jobOptions).srcevents[0]
			?.procedure.execplan[0].actions[0]?.params;
		assert.equal(writer?.action, "upsert");
		assert.deepEqual(writer?.key, ["business_column_value"]);

		// Nothing to borrow: a warning, since every run inserts its rows again.
		const none = planOf(unkeyed, []);
		assert.deepEqual(none.bronze[0]?.key, []);
		assert.ok(
			none.issues.some(
				(i) =>
					i.level === "warning" &&
					/incremental loads insert, so every run adds/.test(i.message),
			),
		);
	});

	it("keeps a JOIN entity's real column over a placeholder above it", () => {
		const plan = planOf(
			[
				...S_RETAIL,
				row("s_asset", "cifid", "varchar(50)", "asset", "cifid"),
				row("s_asset", "mv", "numeric", "asset", "mv"),
			],
			[
				row("person", "id", "varchar(50)", "retail", "cifid"),
				row("person", "mv", "numeric", "##NA", "##NA", "cast(null as numeric)"),
				row("person", "mv", "numeric", "asset", "mv"),
			],
			[
				{
					entity: "person",
					clause: "from retail join asset on asset.cifid = retail.cifid",
					strategy: "JOIN",
					cell: "Conditions!A2",
				},
			],
		);
		const mv = plan.silver[0]?.branches[0]?.columns.find(
			(c) => c.name === "mv",
		);
		assert.equal(mv?.expr, "asset.mv");
		assert.deepEqual(
			plan.issues.filter((i) => /mv has more than one row/.test(i.message)),
			[],
		);
	});

	it("casts a straight move from the staged type and says when the sheets disagree", () => {
		const plan = planOf(
			[...S_RETAIL, row("s_retail", "dob", "varchar(10)", "retail", "dob")],
			[row("person", "dob", "date", "retail", "dob")],
		);
		const dob = plan.silver[0]?.branches[0]?.columns.find(
			(c) => c.name === "dob",
		);
		assert.equal(dob?.expr, "cast(retail.dob as date)");
		assert.ok(
			plan.issues.some((i) =>
				/source_data_type is date, but s_retail.dob is varchar\(10\)/.test(
					i.message,
				),
			),
		);
	});
});

describe("FinacleCDH Person: MappingNew + Bronze_Mapping", () => {
	let plan: Plan;

	before(async () => {
		const spec = parseMappingWorkbook(
			await read(sample("FinacleCDH_Person_MappingNew.xlsx")),
			"FinacleCDH_Person_MappingNew.xlsx",
		);
		assert.ok(
			parseBronzeMapping(
				await read(sample("FinacleCDH_Person_Bronze_Mapping.xlsx")),
				"FinacleCDH_Person_Bronze_Mapping.xlsx",
				spec,
			),
		);
		const attributes = parseEntityAttributes(
			await read(sample("FinacleCDH_Person_CDM.xlsx")),
			"FinacleCDH_Person_CDM.xlsx",
		);
		assert.ok(attributes);
		plan = applyQualityRules(buildPlan(spec, planOptions), attributes);
	});

	it("stages the 28 tables of the bronze sheet, each incremental and keyed", () => {
		assert.equal(plan.bronze.length, 28);
		assert.equal(plan.silver.length, 25);
		for (const b of plan.bronze) {
			assert.equal(b.watermark, "_modifiedon", b.staging);
			assert.equal(b.keyColumn, "metadata_business_key_value", b.staging);
		}
		const retail = plan.bronze.find((b) => b.staging === "s_retail");
		assert.equal(
			(retail?.columns.length ?? 0) + (retail?.standard.length ?? 0),
			88,
		);
	});

	it("reports exactly the sheet defects", () => {
		const count = (re: RegExp) =>
			plan.issues.filter((i) => i.level === "error" && re.test(i.message))
				.length;

		// metadata_business_key_name is `cifid.bankentityid'` on every staging table.
		assert.equal(
			count(/metadata_business_key_name: the rule has an unbalanced quote/),
			28,
		);
		// `null as` in financial_profile.
		assert.equal(count(/ends in AS/), 7);
		assert.equal(count(/s_retailasset has no column expectedclosureyear/), 1);
		// involvement_type and employee_reference: ##NA, but not nullable.
		assert.equal(count(/never fills it/), 2);
		assert.equal(plan.issues.filter((i) => i.level === "error").length, 38);

		// DataMapping's source_data_type disagrees with the staged type: arrays and
		// jsonb staged for varchar, timestamptz for date, text for integer.
		const warnings = plan.issues.filter((i) => i.level === "warning");
		assert.equal(
			warnings.filter((i) =>
				/source_data_type is .* - cast from/.test(i.message),
			).length,
			11,
		);
		assert.equal(
			warnings.filter((i) =>
				/straight move of .* cast at load time/.test(i.message),
			).length,
			5,
		);
		assert.equal(warnings.length, 16);
	});

	it("casts from the staged type, not the sheet's source_data_type", () => {
		const aml = plan.silver.find((s) => s.name === "aml_profile");
		const reason = aml?.branches[0]?.columns.find(
			(c) => c.name === "aml_reason",
		);
		assert.match(reason?.expr ?? "", /^array_to_string\(.*amlreason/);
	});

	it("keeps a COALESCE over two staged columns and the validator on silver", () => {
		const entity = plan.silver.find((s) => s.name === "person_certificate");
		assert.ok(entity);
		const id = entity.branches[0]?.columns.find(
			(c) => c.name === "customer_identifier",
		);
		assert.equal(id?.expr, "COALESCE(cifid, entityid)");
		const staging = plan.bronze.find(
			(b) => b.staging === "s_identificationdocument",
		);
		assert.ok(staging?.columns.some((c) => c.name === "entityid"));

		const job = silverJob(entity, "incremental", jobOptions);
		assert.equal(
			job.srcevents[0]?.procedure.execplan[0].steps[0]?.type,
			"VALIDATOR",
		);
	});
});
