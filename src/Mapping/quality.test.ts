import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { dialect } from "@/Mapping/dialect.js";
import { bronzeJob, silverJob } from "@/Mapping/finaqua.js";
import {
	parseEntityAttributes,
	parseMappingWorkbook,
} from "@/Mapping/parse.js";
import { buildPlan, DEFAULT_PLAN_OPTIONS } from "@/Mapping/plan.js";
import { applyQualityRules } from "@/Mapping/quality.js";
import type { EntityAttribute, Plan } from "@/Mapping/types.js";

const pg = dialect("postgres");
const jobOptions = { batchName: "CDH", source: pg, target: pg };

const sample = (name: string) =>
	fileURLToPath(new URL(`../../test/sample/${name}`, import.meta.url));

async function read(file: string): Promise<ExcelJS.Workbook> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(file);
	return workbook;
}

function attribute(
	column: string,
	dataType: string,
	dataLength: string,
	nullable: string,
	entity = "person",
): EntityAttribute {
	return { entity, column, dataType, dataLength, nullable, cell: "a!A2" };
}

function planOf(columns: [string, string][]): Plan {
	return buildPlan(
		{
			sourceFile: "t.xlsx",
			conditions: [],
			skipped: [],
			rows: columns.map(([column, fdlType], i) => ({
				entity: "person",
				column,
				fdlType,
				sourceEntity: "retail",
				sourceColumn: column,
				sourceType: fdlType,
				rule: "##STRAIGHTMOVE",
				cell: `DataMapping!A${i + 2}`,
			})),
		},
		{ ...DEFAULT_PLAN_OPTIONS, target: pg },
	);
}

function schemaOf(plan: Plan) {
	const schema = plan.silver[0]?.quality?.schema;
	assert.ok(schema);
	return JSON.parse(schema);
}

describe("data quality rules", () => {
	it("turns data_type, data_length and nullable into a JSON schema", () => {
		const plan = applyQualityRules(
			planOf([
				["name", "varchar(50)"],
				["age", "integer"],
				["amount", "numeric(20,4)"],
				["born", "date"],
				["seen", "timestamp"],
			]),
			[
				attribute("name", "VARCHAR", "50", "N"),
				attribute("age", "INTEGER", "", "Y"),
				attribute("amount", "NUMERIC(20,4)", "", "Y"),
				attribute("born", "DATE", "", "N"),
				attribute("seen", "TIMESTAMP", "", "Y"),
			],
		);
		const schema = schemaOf(plan);

		assert.deepEqual(schema.required, ["name", "born"]);
		assert.deepEqual(schema.properties.name, {
			type: "string",
			maxLength: 50,
		});
		assert.deepEqual(schema.properties.age, { type: ["integer", "null"] });
		assert.deepEqual(schema.properties.amount, {
			type: ["number", "null"],
			exclusiveMinimum: -1e16,
			exclusiveMaximum: 1e16,
		});
		assert.equal(schema.properties.born.type, "string");
		assert.ok(new RegExp(schema.properties.born.pattern).test("2026-10-30"));
		assert.ok(
			new RegExp(schema.properties.seen.pattern).test(
				"2026-10-30T10:15:00.000+05:30",
			),
		);
		assert.ok(!new RegExp(schema.properties.seen.pattern).test("30/10/2026"));
		assert.deepEqual(
			plan.issues.filter((i) => /entity_attributes/.test(i.message)),
			[],
		);
	});

	it("reports every column it cannot check, and never guesses", () => {
		const plan = applyQualityRules(
			planOf([
				["name", "varchar(50)"],
				["extra", "text"],
				["flag", "varchar(1)"],
				["code", "varchar(5)"],
			]),
			[
				attribute("name", "VARCHAR", "20", "Y"),
				attribute("flag", "VARCHAR", "1", "maybe"),
				attribute("code", "VARCHAR", "abc", "Y"),
				attribute("gone", "VARCHAR", "5", "N"),
				attribute("x", "VARCHAR", "5", "N", "other_entity"),
			],
		);
		const messages = plan.issues.map((i) => i.message).join("\n");

		assert.match(messages, /extra is not in entity_attributes/);
		assert.match(
			messages,
			/name is varchar\(50\) in the mapping but varchar\(20\)/,
		);
		assert.match(messages, /flag: nullable 'maybe'/);
		assert.match(messages, /code: data_length 'abc'/);
		assert.match(messages, /gone is in entity_attributes as not nullable/);
		assert.match(messages, /other_entity is in entity_attributes/);
		assert.deepEqual(schemaOf(plan).required, []);
		assert.deepEqual(plan.silver[0]?.quality?.unchecked, ["extra"]);
	});

	it("leaves a job without rules exactly as it was", () => {
		const plan = planOf([["name", "varchar(50)"]]);
		const entity = plan.silver[0];
		assert.ok(entity);

		const job = silverJob(entity, "full", jobOptions);
		assert.deepEqual(job.providers.validators, []);
		assert.ok(!("onvalidationerror" in job));
		assert.deepEqual(job.srcevents[0]?.procedure.execplan[0].steps, []);
	});
});

describe("FinacleCDH Person mapping with the CDM's entity_attributes", () => {
	let plan: Plan;

	before(async () => {
		const name = "FinacleCDH_Person_Mapping.xlsx";
		const spec = parseMappingWorkbook(await read(sample(name)), name);
		const attributes = parseEntityAttributes(
			await read(sample("FinacleCDH_Person_CDM.xlsx")),
			"FinacleCDH_Person_CDM.xlsx",
		);
		assert.ok(attributes);
		plan = applyQualityRules(
			buildPlan(spec, { ...DEFAULT_PLAN_OPTIONS, target: pg }),
			attributes,
		);
	});

	it("checks every column of every entity, with no disagreement", () => {
		assert.equal(plan.silver.length, 25);
		for (const s of plan.silver) {
			assert.equal(s.quality?.columns, s.columns.length, s.name);
			assert.deepEqual(s.quality?.unchecked, [], s.name);
		}

		const raised = plan.issues.filter((i) =>
			/entity_attributes/.test(i.message),
		);
		assert.deepEqual(
			raised.map((i) => i.message),
			[
				// Rows with a blank rule in the mapping sheet, so the job never loads them.
				"fatca_compliance_identification is in entity_attributes as not nullable but the mapping does not load it - not checked",
				"involvement_type is in entity_attributes as not nullable but the mapping does not load it - not checked",
				"employee_reference is in entity_attributes as not nullable but the mapping does not load it - not checked",
				"cdh_reference_data is in entity_attributes but the mapping has no such entity",
			],
		);
	});

	it("puts the validator before the writer in both load modes", () => {
		const entity = plan.silver.find((s) => s.name === "person");
		assert.ok(entity);
		assert.equal(entity.quality?.required, 16);

		for (const mode of ["full", "incremental"] as const) {
			const job = silverJob(entity, mode, jobOptions);
			const load = job.srcevents[0]?.procedure.execplan[0];
			const step = load?.steps[0];

			assert.equal(step?.type, "VALIDATOR");
			assert.equal(step?.validation.name, "person_dq");
			assert.equal(step?.validation.validations[0]?.name, "_dfltjsonvalidator");
			assert.deepEqual(step?.validation.validationMessageKeys, [
				"metadata_business_key_value",
			]);
			assert.equal(load?.actions[0]?.name, "person_writer");
			assert.deepEqual(
				job.providers.validators.map((v) => v.provider),
				["com.fininfra.aqua.validators.JsonSchemaValidator"],
			);
			// The runtime refuses a validator step without this.
			assert.equal(
				job.onvalidationerror?.[0]?.params.topic,
				"validationErrorTopic",
			);
		}
	});

	it("does not touch the bronze jobs", () => {
		const table = plan.bronze[0];
		assert.ok(table);
		const job = bronzeJob(table, "full", jobOptions);

		assert.deepEqual(job.srcevents[0]?.procedure.execplan[0].steps, []);
		assert.deepEqual(job.providers.validators, []);
	});
});
