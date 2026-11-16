import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { dialect } from "@/Mapping/dialect.js";
import { emitPlan } from "@/Mapping/emit.js";
import { columnInputs } from "@/Mapping/lineage.js";
import {
	buildOpenMetadata,
	DEFAULT_OPENMETADATA_OPTIONS,
	type OpenMetadataResult,
	omType,
} from "@/Mapping/openmetadata.js";
import { parseBronzeMapping, parseMappingWorkbook } from "@/Mapping/parse.js";
import { buildPlan, DEFAULT_PLAN_OPTIONS } from "@/Mapping/plan.js";
import { fromAliases } from "@/Mapping/sql.js";
import type { BronzeTable, Plan, SilverEntity } from "@/Mapping/types.js";

const pg = dialect("postgres");

describe("columnInputs", () => {
	const tables = new Set(["retail", "kyc"]);

	it("reads qualified columns, quoted or not, and skips function names", () => {
		assert.deepEqual(
			columnInputs(`coalesce(retail.cifid, "kyc"."CifId")`, tables),
			[
				{ table: "retail", column: "cifid", feeds: true },
				{ table: "kyc", column: "cifid", feeds: true },
			],
		);
	});

	it("does not take a cast's type, an alias or a string for a column", () => {
		const columns = new Set(["numeric", "x", "y"]);
		const bare = (c: string) => (columns.has(c) ? "retail" : undefined);
		assert.deepEqual(
			columnInputs(
				"cast(x as numeric(20,4)) || y::numeric || 'retail.cifid' as x",
				tables,
				bare,
			).map((i) => i.column),
			["x", "y"],
		);
	});

	it("marks a column read only in a CASE condition as not feeding", () => {
		const inputs = columnInputs(
			"case when retail.minor = 'Y' then kyc.status else retail.cifid end",
			tables,
		);
		assert.deepEqual(
			inputs.map((i) => [i.column, i.feeds]),
			[
				["minor", false],
				["status", true],
				["cifid", true],
			],
		);
	});

	it("follows JSON extraction to the column it reads", () => {
		assert.deepEqual(
			columnInputs("(retail.data->>'name')::text", tables).map((i) => i.column),
			["data"],
		);
	});
});

describe("omType", () => {
	it("maps workbook types to OpenMetadata, with the length it requires", () => {
		assert.deepEqual(omType("varchar(50)"), {
			dataType: "VARCHAR",
			dataLength: 50,
			dataTypeDisplay: "varchar(50)",
		});
		assert.equal(omType("varchar").dataType, "TEXT");
		assert.equal(omType("numeric(20,4)").dataType, "NUMERIC");
		assert.equal(omType("timestamptz").dataType, "TIMESTAMPZ");
		assert.equal(omType("jsonb").dataType, "JSON");
		assert.equal(omType("bool").dataType, "BOOLEAN");
		assert.deepEqual(omType("_jsonb"), {
			dataType: "ARRAY",
			arrayDataType: "JSON",
			dataTypeDisplay: "jsonb[]",
		});
		assert.equal(omType("whatever").dataType, "STRING");
		assert.equal(omType("timestamp(6) with time zone").dataType, "TIMESTAMPZ");
		assert.equal(omType("timestamp(3)").dataType, "TIMESTAMP");
	});
});

describe("buildOpenMetadata on hand-built plans", () => {
	const T = DEFAULT_OPENMETADATA_OPTIONS.targetSchema;
	const S = DEFAULT_OPENMETADATA_OPTIONS.sourceSchema;
	const staging = (
		source: string,
		name: string,
		columns: string[],
	): BronzeTable => ({
		source,
		staging: name,
		columns: columns.map((c) => ({ name: c, type: "varchar(20)" })),
		standard: [],
		stagedAs: {},
		key: [],
	});
	const plan = (bronze: BronzeTable[], silver: SilverEntity[] = []): Plan => ({
		spec: { sourceFile: "t.xlsx", rows: [], conditions: [], skipped: [] },
		bronze,
		silver,
		issues: [],
	});
	const entity = (
		from: string,
		reads: string[],
		expr: string,
	): SilverEntity => ({
		name: "e",
		strategy: "JOIN",
		branches: [
			{
				from,
				reads,
				columns: [{ name: "out", fdlType: "text", expr, cell: "D!A2" }],
				watermarks: [],
			},
		],
		columns: [{ name: "out", type: "text" }],
		pipeline: [],
		keyColumn: "metadata_business_key_value",
		keyed: false,
	});
	const lineageOf = (p: Plan) =>
		buildOpenMetadata(p).lineageEdges.flatMap((e) =>
			e.edge.lineageDetails.columnsLineage.map((c) => c.fromColumns),
		);

	it('reads a keyword alias the staging rewrite quotes, as `as "limit"`', () => {
		assert.deepEqual(
			[
				...fromAliases(
					`from s_limit as "limit" join s_b as b on b.id = "limit".id`,
				),
			],
			[
				["limit", "s_limit"],
				["b", "s_b"],
			],
		);
		const p = plan(
			[staging("limit", "s_limit", ["limitid"])],
			[entity(`from s_limit as "limit"`, ["s_limit"], `"limit".limitid`)],
		);
		assert.deepEqual(lineageOf(p).at(-1), [`${T}.s_limit.limitid`]);
	});

	it("gives an unqualified column in a JOIN to the one table that has it", () => {
		const p = plan(
			[staging("a", "s_a", ["id", "x"]), staging("b", "s_b", ["id", "y"])],
			[
				entity(
					"from s_a as a join s_b as b on a.id = b.id",
					["s_a", "s_b"],
					"coalesce(x, y, id)",
				),
			],
		);
		// `id` is in both tables, so it is ambiguous and left out.
		assert.deepEqual(lineageOf(p).slice(-2), [[`${T}.s_a.x`], [`${T}.s_b.y`]]);
	});

	it("matches names by case, as Postgres folds them", () => {
		const p = plan(
			[staging("a", "s_a", ["categoryType"])],
			[entity("from s_a as a", ["s_a"], "a.categoryType || a.CATEGORYTYPE")],
		);
		assert.deepEqual(lineageOf(p).at(-1), [`${T}.s_a.categoryType`]);
	});

	it("merges the columns of a source two staging tables read", () => {
		const om = buildOpenMetadata(
			plan([staging("src", "s_one", ["a"]), staging("src", "s_two", ["b"])]),
		);
		assert.equal(om.sources.length, 1);
		assert.deepEqual(
			om.sources[0]?.columns.map((c) => c.name),
			["a", "b"],
		);
		assert.ok(
			om.lineageEdges.every((e) => e.edge.fromEntity.id === `${S}.src`),
		);
	});

	it("rejects a schema that is not service.database.schema", () => {
		assert.throws(
			() =>
				buildOpenMetadata(plan([]), {
					sourceSchema: "public",
					targetSchema: T,
				}),
			/service\.database\.schema/,
		);
	});
});

describe("OpenMetadata from FinacleCDH_Person_MappingNew.xlsx", () => {
	let plan: Plan;
	let om: OpenMetadataResult;
	const sample = (name: string) =>
		fileURLToPath(new URL(`../../test/sample/${name}`, import.meta.url));
	const S = DEFAULT_OPENMETADATA_OPTIONS.sourceSchema;
	const T = DEFAULT_OPENMETADATA_OPTIONS.targetSchema;

	before(async () => {
		const read = async (file: string) => {
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(sample(file));
			return workbook;
		};
		const spec = parseMappingWorkbook(
			await read("FinacleCDH_Person_MappingNew.xlsx"),
			"FinacleCDH_Person_MappingNew.xlsx",
		);
		parseBronzeMapping(
			await read("FinacleCDH_Person_Bronze_Mapping.xlsx"),
			"FinacleCDH_Person_Bronze_Mapping.xlsx",
			spec,
		);
		plan = buildPlan(spec, { ...DEFAULT_PLAN_OPTIONS, target: pg });
		om = buildOpenMetadata(plan);
	});

	it("catalogues every source, staging and FDL table", () => {
		assert.equal(om.sources.length, plan.bronze.length);
		assert.equal(
			om.destinations.length,
			plan.bronze.length + plan.silver.length,
		);
	});

	it("only points lineage at columns the tables have", () => {
		const columns = new Map(
			[...om.sources, ...om.destinations].map((t) => [
				`${t.databaseSchema}.${t.name}`,
				new Set(t.columns.map((c) => c.name)),
			]),
		);
		const has = (table: string, column: string) =>
			column.startsWith(`${table}.`) &&
			(columns.get(table)?.has(column.slice(table.length + 1)) ?? false);

		for (const { edge } of om.lineageEdges) {
			for (const c of edge.lineageDetails.columnsLineage) {
				assert.ok(has(edge.toEntity.id, c.toColumn), c.toColumn);
				for (const from of c.fromColumns)
					assert.ok(has(edge.fromEntity.id, from), from);
			}
		}
	});

	it("traces retail.cifid -> s_retail.cifid -> person.customer_identifier", () => {
		const edge = (from: string, to: string) =>
			om.lineageEdges.find(
				(e) => e.edge.fromEntity.id === from && e.edge.toEntity.id === to,
			)?.edge.lineageDetails.columnsLineage;

		assert.deepEqual(
			edge(`${S}.retail`, `${T}.s_retail`)?.find(
				(c) => c.toColumn === `${T}.s_retail.cifid`,
			),
			{
				fromColumns: [`${S}.retail.cifid`],
				toColumn: `${T}.s_retail.cifid`,
				function: "DIRECT",
			},
		);
		assert.deepEqual(
			edge(`${T}.s_retail`, `${T}.person`)?.find(
				(c) => c.toColumn === `${T}.person.customer_identifier`,
			),
			{
				fromColumns: [`${T}.s_retail.cifid`],
				toColumn: `${T}.person.customer_identifier`,
				function: "DIRECT",
			},
		);
	});

	it("follows a renamed staging column back to its source name", () => {
		const columns = om.lineageEdges.find(
			(e) =>
				e.edge.fromEntity.id === `${S}.retail` &&
				e.edge.toEntity.id === `${T}.s_retail`,
		)?.edge.lineageDetails.columnsLineage;
		assert.deepEqual(
			columns?.find(
				(c) => c.toColumn === `${T}.s_retail.metadata_persisted_timestamp`,
			)?.fromColumns,
			[`${S}.retail._modifiedon`],
		);
	});

	it("keeps the staging and FDL upsert key as a unique constraint", () => {
		const person = om.destinations.find((t) => t.name === "person");
		assert.deepEqual(person?.tableConstraints, [
			{ constraintType: "UNIQUE", columns: ["metadata_business_key_value"] },
		]);
	});

	it("is written under openMetadata/ by generate", async () => {
		const dest = fs.mkdtempSync(path.join(os.tmpdir(), "om-"));
		try {
			await emitPlan(
				plan,
				dest,
				{ batchName: "CDH", source: pg, target: pg },
				{ entity: "person" },
				DEFAULT_OPENMETADATA_OPTIONS,
			);
			const dir = path.join(dest, "openMetadata");
			assert.deepEqual(fs.readdirSync(path.join(dir, "sources")), [
				"retail.json",
			]);
			assert.deepEqual(fs.readdirSync(path.join(dir, "destinations")).sort(), [
				"person.json",
				"s_retail.json",
			]);
			const edges = JSON.parse(
				fs.readFileSync(path.join(dir, "lineageEdges", "edge.json"), "utf8"),
			);
			assert.equal(edges.length, 2);
		} finally {
			fs.rmSync(dest, { recursive: true, force: true });
		}
	});
});
