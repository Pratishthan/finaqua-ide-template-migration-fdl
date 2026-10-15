import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { dialect } from "@/Mapping/dialect.js";
import { emitPlan } from "@/Mapping/emit.js";
import { loadLayout } from "@/Mapping/layout.js";
import { parseMappingWorkbook } from "@/Mapping/parse.js";
import { buildPlan, DEFAULT_PLAN_OPTIONS } from "@/Mapping/plan.js";
import type { Plan } from "@/Mapping/types.js";

/**
 * FinacleCDH_Person_Mapping.xlsx is the real Source-to-Silver workbook the
 * tool is built against - "DataMapping"/"Conditions" tabs with the
 * un-prefixed headers `loadLayout()` already defaults to, no `--layout`
 * override needed. These tests drive the same path the `generate` CLI
 * command takes with no flags at all (postgres/postgres, batch "limits",
 * staging prefix "s_", watermark column "data_persistance_time"), so a
 * change that breaks the actual requirement shows up here - not only on the
 * synthetic rows in plan.test.ts.
 */

const SAMPLE_WORKBOOK = fileURLToPath(
	new URL("../../test/sample/FinacleCDH_Person_Mapping.xlsx", import.meta.url),
);

const pg = dialect("postgres");
const planOptions = { ...DEFAULT_PLAN_OPTIONS, target: pg };
// Matches what withCommonOptions() gives the CLI when no flags are passed.
const jobOptions = { batchName: "limits", source: pg, target: pg };

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
		assert.equal(plan.issues.filter((i) => i.level === "warning").length, 240);
		assert.equal(plan.issues.filter((i) => i.level === "info").length, 28);
	});

	it("person reads the single retail staging table, unkeyed", () => {
		const person = plan.silver.find((s) => s.name === "person");
		assert.ok(person);
		assert.equal(person.strategy, "JOIN");
		assert.equal(person.branches.length, 1);
		assert.deepEqual(person.branches[0]?.reads, ["s_retail"]);
		assert.equal(person.columns.length, 58);
		assert.equal(person.keyed, false);
		assert.equal(person.watermark, undefined);
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

	it("no bronze table gets an invented key or watermark the sheet never supplied", () => {
		assert.ok(plan.bronze.every((b) => b.key.length === 0 && !b.watermark));
	});

	it("emits the full default bundle: 56 files, every job a well-formed JSON", async () => {
		const dest = fs.mkdtempSync(path.join(os.tmpdir(), "fdl-person-"));

		try {
			const result = await emitPlan(plan, dest, jobOptions);

			assert.equal(result.bronze, 28);
			assert.equal(result.silver, 25);
			assert.equal(result.errors, 1);
			assert.equal(result.warnings, 240);
			// No bronze/silver table has a watermark, so no _incr variant is
			// written: 28 + 25 job files, plus ddl.sql, connections.json and
			// coverage.md.
			assert.equal(result.files, 56);

			const bronzeFiles = fs.readdirSync(path.join(dest, "bronze"));
			const silverFiles = fs.readdirSync(path.join(dest, "silver"));
			assert.equal(bronzeFiles.length, 28);
			assert.equal(silverFiles.length, 25);
			assert.ok(bronzeFiles.every((f) => !f.endsWith("_incr.json")));
			assert.ok(silverFiles.every((f) => !f.endsWith("_incr.json")));

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
				/sheet issues: \*\*1 errors\*\*, 240 warnings, 28 notes/,
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
			// 1 bronze + 1 silver job file, plus ddl.sql, connections.json, coverage.md.
			assert.equal(result.files, 5);
			// The financial_profile error is out of scope once person is selected.
			assert.equal(result.errors, 0);

			assert.deepEqual(fs.readdirSync(path.join(dest, "bronze")), [
				"s_retail.json",
			]);
			assert.deepEqual(fs.readdirSync(path.join(dest, "silver")), [
				"person.json",
			]);
		} finally {
			fs.rmSync(dest, { recursive: true, force: true });
		}
	});
});
