import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { buildDdl } from "@/Mapping/ddl.js";
import { dialect } from "@/Mapping/dialect.js";
import { emitPlan } from "@/Mapping/emit.js";
import { bronzeJob, silverJob } from "@/Mapping/finaqua.js";
import { loadLayout } from "@/Mapping/layout.js";
import { parseMappingWorkbook } from "@/Mapping/parse.js";
import { buildPlan, DEFAULT_PLAN_OPTIONS } from "@/Mapping/plan.js";
import type { Plan } from "@/Mapping/types.js";

/**
 * FinacleCDH_Person_Mapping.xlsx is the real Source-to-Silver workbook the
 * tool is built against - "DataMapping"/"Conditions" tabs with the
 * un-prefixed headers `loadLayout()` already defaults to, no `--layout`
 * override needed. These tests drive the same path the `generate` CLI
 * command takes with no flags at all (postgres/postgres, batch "CDH",
 * staging prefix "s_", watermark column "metadata_persisted_timestamp"), so a
 * change that breaks the actual requirement shows up here - not only on the
 * synthetic rows in plan.test.ts.
 */

const SAMPLE_WORKBOOK = fileURLToPath(
	new URL("../../test/sample/FinacleCDH_Person_Mapping.xlsx", import.meta.url),
);

const pg = dialect("postgres");
const planOptions = { ...DEFAULT_PLAN_OPTIONS, target: pg };
// Matches what withCommonOptions() gives the CLI when no flags are passed.
const jobOptions = { batchName: "CDH", source: pg, target: pg };

async function loadPlan(): Promise<Plan> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(SAMPLE_WORKBOOK);
	const spec = parseMappingWorkbook(
		workbook,
		path.basename(SAMPLE_WORKBOOK),
		loadLayout(),
	);
	return buildPlan(spec, planOptions);
}

describe("FinacleCDH_Person_Mapping.xlsx with default configs", () => {
	let plan: Plan;

	before(async () => {
		plan = await loadPlan();
	});

	it("parses every DataMapping/Conditions row under the built-in layout", () => {
		assert.equal(plan.spec.rows.length, 748);
		assert.equal(plan.spec.conditions.length, 1);
		assert.equal(plan.spec.skipped.length, 3);
	});

	it("builds 28 staging tables and 25 FDL entities", () => {
		assert.equal(plan.bronze.length, 28);
		assert.equal(plan.silver.length, 25);
	});

	it("flags the one real sheet defect, and reports no others", () => {
		const errors = plan.issues.filter((i) => i.level === "error");
		assert.deepEqual(errors, [
			{
				level: "error",
				scope: "financial_profile",
				cell: "DataMapping!A737",
				message:
					"asset_market_value_currency: a straight move needs exactly one source table, got '##na'",
			},
		]);
	});

	it("pins the warning/note count so a planner change shows up here, not only in coverage.md", () => {
		assert.equal(plan.issues.filter((i) => i.level === "warning").length, 78);
		assert.equal(plan.issues.filter((i) => i.level === "info").length, 0);
	});

	it("never stages the sheet's ##NA placeholder as a column", () => {
		for (const b of plan.bronze) {
			assert.ok(
				!b.columns.some((c) => c.name.startsWith("##")),
				`${b.staging} stages a ## column`,
			);
		}
	});

	it("keeps ##PIPELINEGENERATED columns in the FDL table, filled by the job", () => {
		const person = plan.silver.find((s) => s.name === "person");
		assert.ok(person);
		assert.ok(person.columns.some((c) => c.name === "audit_created_timestamp"));
		for (const s of plan.silver) {
			for (const b of s.branches) {
				for (const c of b.columns) {
					assert.ok(!c.expr.includes("##"), `${s.name}.${c.name}: ${c.expr}`);
				}
			}
		}
		assert.deepEqual(
			person.pipeline.map((p) => `${p.value} as ${p.name}`),
			[
				"brd.batch_run_id as metadata_batch_execution_id",
				"0 as metadata_job_execution_id",
				"'DataUser' as audit_created_by",
				"current_timestamp as audit_created_timestamp",
				"'DataUser' as audit_updated_by",
				"current_timestamp as audit_updated_timestamp",
				"'N' as audit_deleted_indicator",
			],
		);
		const [view] = silverJob(person, "full", jobOptions).source.views as {
			params: { query: string };
		}[];
		assert.match(
			view?.params.query ?? "",
			/^select brd\.batch_run_id as metadata_batch_execution_id, 0 as metadata_job_execution_id, .* 'N' as audit_deleted_indicator, q\.\* from /,
		);
	});

	it("stages s_aml like the agreed sample: source columns, then the standard ones", () => {
		const ddl = buildDdl(plan, pg);
		const body = /create table if not exists s_aml \(([^;]*)\);/.exec(ddl)?.[1];
		assert.deepEqual(
			body?.split(",\n").map((c) => c.trim()),
			[
				"cifid varchar(50)",
				"bankentityid varchar(50)",
				"changesintransactionpattern varchar(50)",
				"dateofexemption date",
				"ctrremarks varchar(250)",
				"exemptfromctr varchar(50)",
				"seniororregionalmgr varchar(250)",
				"ctrdesignation varchar(50)",
				"riskcategory varchar(50)",
				"pepreason varchar(100)",
				"documents varchar(4000)",
				"eddperformed varchar(50)",
				"amlreason varchar(50)",
				"pep varchar(50)",
				"bizlineamlosro varchar(250)",
				"metadata_source_system_name varchar(50)",
				"metadata_source_created_timestamp timestamp",
				"metadata_persisted_timestamp timestamp",
				"metadata_business_key_name varchar(200)",
				"metadata_business_key_value varchar(200)",
				"metadata_batch_execution_id integer",
				"metadata_job_execution_id integer",
				"audit_created_by varchar(50)",
				"audit_created_timestamp timestamp",
				"audit_updated_by varchar(50)",
				"audit_updated_timestamp timestamp",
				"audit_deleted_indicator varchar(5)",
			],
		);
		assert.match(
			ddl,
			/create unique index if not exists s_aml_bcv_uk on s_aml \(metadata_business_key_value\);/,
		);
	});

	it("the recon counts this run's rows by metadata_batch_execution_id under batch CDH", () => {
		const aml = plan.bronze.find((b) => b.staging === "s_aml");
		assert.ok(aml);
		const audit = bronzeJob(aml, "incremental", jobOptions).srcevents[0]
			?.procedure.execplan[1]?.steps[0]?.sql;
		const target = audit?.views.find((v) => v.name === "target");
		assert.equal(
			target?.params.query,
			"select count(*) as target_row_count, max(metadata_persisted_timestamp) as max_data_persistance_time, min(metadata_persisted_timestamp) as min_data_persistance_time from s_aml where metadata_batch_execution_id = (select batch_run_id from batch_run_detail where batch_name = 'CDH' and status = 'running')",
		);
	});

	it("person reads the single retail staging table, keyed on the sheet's business key", () => {
		const person = plan.silver.find((s) => s.name === "person");
		assert.ok(person);
		assert.equal(person.strategy, "JOIN");
		assert.equal(person.branches.length, 1);
		assert.deepEqual(person.branches[0]?.reads, ["s_retail"]);
		assert.equal(person.columns.length, 58);
		assert.equal(person.keyed, true);
		assert.equal(person.keyColumn, "metadata_business_key_value");
		assert.equal(person.watermark, "metadata_persisted_timestamp");
		assert.ok(person.columns.some((c) => c.name === "customer_identifier"));
		assert.ok(
			person.columns.some((c) => c.name === "tax_identification_number"),
		);
	});

	it("financial_profile unions its four source tables", () => {
		const financial = plan.silver.find((s) => s.name === "financial_profile");
		assert.ok(financial);
		assert.equal(financial.strategy, "UNION");
		assert.equal(financial.branches.length, 4);
		assert.equal(financial.columns.length, 25);
	});

	it("every bronze table takes its key and watermark from the sheet's standard rows", () => {
		for (const b of plan.bronze) {
			assert.equal(b.keyColumn, "metadata_business_key_value", b.staging);
			assert.deepEqual(b.key, [], b.staging);
			assert.equal(b.watermark, "_modifiedon", b.staging);
			assert.equal(b.stagedAs._modifiedon, "metadata_persisted_timestamp");
		}
	});

	it("emits the full default bundle: 109 files, every job a well-formed JSON", async () => {
		const dest = fs.mkdtempSync(path.join(os.tmpdir(), "fdl-person-"));

		try {
			const result = await emitPlan(plan, dest, jobOptions);

			assert.equal(result.bronze, 28);
			assert.equal(result.silver, 25);
			assert.equal(result.errors, 1);
			assert.equal(result.warnings, 78);
			// Every bronze/silver table has a watermark, so each gets an _incr
			// variant: 2 x (28 + 25) job files, plus ddl.sql, connections.json and
			// coverage.md.
			assert.equal(result.files, 109);

			const bronzeFiles = fs.readdirSync(path.join(dest, "bronze"));
			const silverFiles = fs.readdirSync(path.join(dest, "silver"));
			assert.equal(bronzeFiles.length, 56);
			assert.equal(silverFiles.length, 50);
			assert.equal(
				bronzeFiles.filter((f) => f.endsWith("_incr.json")).length,
				28,
			);
			assert.equal(
				silverFiles.filter((f) => f.endsWith("_incr.json")).length,
				25,
			);

			for (const dir of ["bronze", "silver"] as const) {
				for (const file of fs.readdirSync(path.join(dest, dir))) {
					const job = JSON.parse(
						fs.readFileSync(path.join(dest, dir, file), "utf8"),
					);
					assert.equal(typeof job.source.query, "string");
					assert.ok(job.source.query.length > 0);
				}
			}

			assert.ok(fs.existsSync(path.join(dest, "ddl.sql")));
			assert.ok(fs.existsSync(path.join(dest, "connections.json")));
			const coverage = fs.readFileSync(path.join(dest, "coverage.md"), "utf8");
			assert.match(
				coverage,
				/source database: \*\*postgres\*\*, target database: \*\*postgres\*\*/,
			);
			assert.match(
				coverage,
				/sheet issues: \*\*1 errors\*\*, 78 warnings, 0 notes/,
			);
		} finally {
			fs.rmSync(dest, { recursive: true, force: true });
		}
	});

	it("-e person scopes the bundle to person and the s_retail table it reads", async () => {
		const dest = fs.mkdtempSync(path.join(os.tmpdir(), "fdl-person-scoped-"));

		try {
			const result = await emitPlan(plan, dest, jobOptions, {
				entity: "person",
			});

			assert.equal(result.bronze, 1);
			assert.equal(result.silver, 1);
			// 1 bronze + 1 silver job, each with an _incr variant, plus ddl.sql,
			// connections.json, coverage.md.
			assert.equal(result.files, 7);
			// The financial_profile error is out of scope once person is selected.
			assert.equal(result.errors, 0);

			assert.deepEqual(fs.readdirSync(path.join(dest, "bronze")).sort(), [
				"s_retail.json",
				"s_retail_incr.json",
			]);
			assert.deepEqual(fs.readdirSync(path.join(dest, "silver")).sort(), [
				"person.json",
				"person_incr.json",
			]);
		} finally {
			fs.rmSync(dest, { recursive: true, force: true });
		}
	});
});
