/**
 * Compiles every SQL statement in a generated bundle against a real Postgres.
 *
 *   pnpm run verify:pg -- <bundle> [database-url]
 *
 * Creates a scratch database, builds mock source tables (the staging tables
 * minus batch_run_id/business key, under schema `src`), runs ddl.sql, and
 * EXPLAINs every view query, audit query and engine query - the engine queries
 * against temp views of the same name, as FinAqua would see them. Nothing is
 * executed against data; EXPLAIN only plans, which is what catches a wrong
 * column, a bad cast or a reserved word. The scratch database is dropped after.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type View = {
	name: string;
	reader: string;
	params: { query: string; table?: string };
};
type Job = {
	source: { views: View[]; query: string };
	srcevents: {
		procedure: {
			execplan: {
				steps: { sql: { views: View[]; query: string } }[];
				actions: { params: { table: string } }[];
			}[];
		};
	}[];
};

const [bundle, url = "postgres://localhost:5432/postgres"] =
	process.argv.slice(2);
if (!bundle) {
	console.error("usage: verify-postgres.ts <bundle> [database-url]");
	process.exit(2);
}

const scratch = `finaqua_verify_${process.pid}`;
const scratchUrl = url.replace(/\/[^/]*$/, `/${scratch}`);
const lowerBound = /'\$\{#get\(params,'[^']*'\)\}'/g;

function psql(target: string, sql: string): string {
	const file = path.join(tmpdir(), `${scratch}.sql`);
	writeFileSync(file, sql);
	// One stream, so each error lands after the #CHECK line it belongs to.
	const run = spawnSync(
		"sh",
		["-c", 'psql "$0" -X -q -f "$1" 2>&1', target, file],
		{
			encoding: "utf8",
		},
	);
	return run.stdout;
}

const ddl = readFileSync(path.join(bundle, "ddl.sql"), "utf8");

/** Quote every identifier: a source table may be a reserved word (`limit`). */
const q = (ident: string) => `"${ident.replaceAll('"', '""')}"`;

/**
 * Mock source tables, built from each bronze job rather than from a name
 * convention: the job's view says which source table it reads (`params.table`)
 * and its writer says which staging table it fills, so any --staging-prefix
 * works. Columns come from that staging table's DDL, minus the ones the job adds.
 */
const bronzeJobs = readdirSync(path.join(bundle, "bronze"))
	.filter((f) => f.endsWith(".json"))
	.map(
		(f) =>
			JSON.parse(readFileSync(path.join(bundle, "bronze", f), "utf8")) as Job,
	);

const ddlColumns = new Map(
	[...ddl.matchAll(/create table if not exists (\S+) \(([^;]*)\);/g)].map(
		([, table, body]) => [
			(table ?? "").replaceAll('"', ""),
			(body ?? "")
				.split(",\n")
				.map((c) => c.trim())
				.filter((c) => c.length > 0),
		],
	),
);

const added = /^(batch_run_id|business_column_(name|value))\b/;
const sourceTables = new Map<string, string>(); // source table -> staging table
for (const job of bronzeJobs) {
	const view = job.source.views.find(
		(v) => v.reader === "source_db_connection",
	);
	const staging =
		job.srcevents[0]?.procedure.execplan[0]?.actions[0]?.params.table;
	const source = view?.params.table;
	if (source && staging) sourceTables.set(source, staging);
}

const sourceDdl = [...sourceTables]
	.map(([source, staging]) => {
		const cols = (ddlColumns.get(staging) ?? []).filter((c) => !added.test(c));
		return `create table src.${q(source)} (${cols.join(", ")});`;
	})
	.join("\n");

if (sourceTables.size === 0) {
	console.error(
		`no bronze jobs with a source view in ${bundle}/bronze - nothing to verify`,
	);
	process.exit(1);
}

const checks: string[] = [];
let count = 0;

function explain(label: string, searchPath: string, sql: string) {
	count++;
	checks.push(
		`\\echo '#CHECK ${label}'`,
		`set search_path = ${searchPath};`,
		`explain ${sql.replace(lowerBound, "'2020-01-01'").replace(/;\s*$/, "")};`,
	);
}

/** Engine query: its views become temp views, then the query is planned. */
function explainEngine(label: string, views: View[], sql: string) {
	count++;
	checks.push(`\\echo '#CHECK ${label}'`, "begin;");
	for (const v of views) {
		const where =
			v.reader === "source_db_connection" ? "src, public" : "public";
		checks.push(
			`set search_path = ${where};`,
			`create temp view "${v.name}" as ${v.params.query.replace(lowerBound, "'2020-01-01'").replace(/;\s*$/, "")};`,
		);
	}
	checks.push(
		"set search_path = pg_temp, public;",
		`explain ${sql.replace(/;\s*$/, "")};`,
		"rollback;",
	);
}

for (const layer of ["bronze", "silver"]) {
	for (const file of readdirSync(path.join(bundle, layer)).sort()) {
		const job = JSON.parse(
			readFileSync(path.join(bundle, layer, file), "utf8"),
		) as Job;
		// Bronze reads the source schema; silver reads staging, in the target.
		const sourcePath = layer === "bronze" ? "src" : "public";

		for (const v of job.source.views) {
			const where = v.reader === "source_db_connection" ? sourcePath : "public";
			explain(`${file} view ${v.name}`, where, v.params.query);
		}
		explainEngine(
			`${file} engine`,
			job.source.views.map((v) =>
				v.reader === "source_db_connection" && layer === "silver"
					? { ...v, reader: "target_db_connection" }
					: v,
			),
			job.source.query,
		);

		const audit = job.srcevents[0]?.procedure.execplan[1]?.steps[0]?.sql;
		if (!audit) continue;
		for (const v of audit.views) {
			const where = v.reader === "source_db_connection" ? sourcePath : "public";
			explain(`${file} audit ${v.name}`, where, v.params.query);
		}
		explainEngine(
			`${file} audit engine`,
			audit.views.map((v) =>
				v.reader === "source_db_connection" && layer === "silver"
					? { ...v, reader: "target_db_connection" }
					: v,
			),
			audit.query,
		);
	}
}

const created = psql(url, `create database ${scratch};`).trim();
if (created) {
	// Anything printed here means no scratch database - never report a pass.
	console.error(created);
	process.exit(1);
}
try {
	const setup = psql(
		scratchUrl,
		`\\set ON_ERROR_STOP on\ncreate schema src;\n${sourceDdl}\n${ddl}`,
	);
	if (/error/i.test(setup)) {
		console.log(setup);
		process.exitCode = 1;
	} else {
		const output = psql(scratchUrl, checks.join("\n"));
		const failures: string[] = [];
		let current = "";
		for (const line of output.split("\n")) {
			if (line.startsWith("#CHECK ")) current = line.slice(7);
			else if (
				line.includes("ERROR:") &&
				!failures.some((f) => f.startsWith(`${current}\n`))
			)
				failures.push(
					`${current}\n    ${line.replace(/^psql:[^:]*:\d+: /, "")}`,
				);
		}
		console.log(`${count} statements planned, ${failures.length} failed`);
		for (const f of failures) console.log(`  ${f}`);
		if (failures.length > 0) process.exitCode = 1;
	}
} finally {
	psql(url, `drop database if exists ${scratch};`);
}
