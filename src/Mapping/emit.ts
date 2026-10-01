import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildDdl } from "@/Mapping/ddl.js";
import {
	bronzeJob,
	type JobOptions,
	type LoadMode,
	silverJob,
} from "@/Mapping/finaqua.js";
import type { Issue, Plan } from "@/Mapping/types.js";

export type EmitResult = {
	bronze: number;
	silver: number;
	files: number;
	errors: number;
	warnings: number;
};

async function writeText(file: string, text: string): Promise<void> {
	// Every write makes its directory: with nothing generated, the coverage report
	// explaining why is the one file that must still land.
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, text, "utf8");
}

async function writeJson(file: string, data: unknown): Promise<void> {
	await writeText(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Writes one bundle:
 *
 *   bronze/<staging>.json, <staging>_incr.json   source table -> staging
 *   silver/<entity>.json, <entity>_incr.json     staging -> FDL entity
 *   ddl.sql                                      tables the jobs write to
 *   connections.json                             placeholders to fill at deploy
 *   coverage.md                                  what was generated, and every sheet issue
 *
 * An _incr file is only written when the table has a watermark column; without
 * one there is nothing to be incremental on, and that is listed in coverage.md.
 */
export async function emitPlan(
	plan: Plan,
	destination: string,
	opts: JobOptions,
	only?: { entity?: string | undefined },
): Promise<EmitResult> {
	let files = 0;

	const wantedSilver = plan.silver.filter(
		(s) => !only?.entity || s.name === only.entity,
	);
	// Scoped to one entity: emit only the staging tables that entity reads.
	const wantedTables = new Set(
		wantedSilver.flatMap((s) => s.branches.flatMap((b) => b.reads)),
	);
	const wantedBronze = only?.entity
		? plan.bronze.filter((b) => wantedTables.has(b.staging))
		: plan.bronze;

	const modes: LoadMode[] = ["full", "incremental"];

	for (const table of wantedBronze) {
		for (const mode of modes) {
			if (mode === "incremental" && !table.watermark) continue;
			const suffix = mode === "incremental" ? "_incr" : "";
			await writeJson(
				path.join(destination, "bronze", `${table.staging}${suffix}.json`),
				bronzeJob(table, mode, opts),
			);
			files++;
		}
	}

	for (const entity of wantedSilver) {
		for (const mode of modes) {
			if (mode === "incremental" && !entity.watermark) continue;
			const suffix = mode === "incremental" ? "_incr" : "";
			await writeJson(
				path.join(destination, "silver", `${entity.name}${suffix}.json`),
				silverJob(entity, mode, opts),
			);
			files++;
		}
	}

	// The report describes what was written, not what the workbook holds: on a
	// scoped run, issues belonging to entities nobody generated are noise.
	const scopes = new Set([
		...wantedBronze.map((b) => b.staging),
		...wantedSilver.map((s) => s.name),
		"workbook",
	]);
	const emitted: Plan = {
		...plan,
		bronze: wantedBronze,
		silver: wantedSilver,
		issues: only?.entity
			? plan.issues.filter((i) => scopes.has(i.scope))
			: plan.issues,
	};

	await writeText(
		path.join(destination, "ddl.sql"),
		buildDdl(emitted, opts.target),
	);
	await writeJson(
		path.join(destination, "connections.json"),
		connections(opts),
	);
	await writeText(
		path.join(destination, "coverage.md"),
		renderCoverage(emitted, opts),
	);
	files += 3;

	return {
		bronze: wantedBronze.length,
		silver: wantedSilver.length,
		files,
		errors: emitted.issues.filter((i) => i.level === "error").length,
		warnings: emitted.issues.filter((i) => i.level === "warning").length,
	};
}

/** Every placeholder the jobs reference, with the driver and URL shape for the
 * chosen database types filled in. */
function connections(opts: JobOptions) {
	return {
		note: "Values for the placeholder names in the generated jobs. Staging and silver tables both live in the target database; the silver jobs read staging with the target* credentials.",
		sourceDbType: opts.source.type,
		targetDbType: opts.target.type,
		placeholders: {
			sourceDriver: opts.source.driver,
			sourceUrl: opts.source.urlTemplate,
			sourceUser: "",
			sourcePassword: "",
			targetDriver: opts.target.driver,
			targetUrl: opts.target.urlTemplate,
			targetUser: "",
			targetPassword: "",
			bootstrapServers: "",
			aquaErrorUrl: "",
			aquaErrorDriver: "",
			aquaErrorUser: "",
			aquaErrorPassword: "",
			errorWriterTopic: "",
			errorWriterUrl: "",
			errorWriterDriver: "",
			errorWriterUser: "",
			errorWriterPassword: "",
			partitionColumn: "",
			numPartitions: "",
		},
	};
}

function issueTable(issues: Issue[]): string[] {
	const lines = ["| scope | cell | issue |", "|---|---|---|"];
	for (const i of issues) {
		lines.push(
			`| ${i.scope} | ${i.cell ?? ""} | ${i.message.replaceAll("|", "\\|")} |`,
		);
	}
	return lines;
}

/** The review document: what was generated, and every defect in the sheet. */
function renderCoverage(plan: Plan, opts: JobOptions): string {
	const errors = plan.issues.filter((i) => i.level === "error");
	const warnings = plan.issues.filter((i) => i.level === "warning");
	const infos = plan.issues.filter((i) => i.level === "info");

	const lines: string[] = [
		`# ${plan.spec.sourceFile} - FinAqua generation coverage\n`,
		`- source database: **${opts.source.type}**, target database: **${opts.target.type}**`,
		`- batch name: **${opts.batchName}**`,
		`- mapping rows read: **${plan.spec.rows.length}**`,
		`- bronze (staging) jobs: **${plan.bronze.length}** tables, ${plan.bronze.filter((b) => b.watermark).length} with an incremental variant`,
		`- silver (FDL) jobs: **${plan.silver.length}** entities, ${plan.silver.filter((s) => s.watermark).length} with an incremental variant`,
		`- sheet issues: **${errors.length} errors**, ${warnings.length} warnings, ${infos.length} notes\n`,
	];

	if (opts.target.type !== "postgres") {
		lines.push(
			"> **The target is not Postgres.** The transformation rules in the sheet are Postgres SQL (`->>`, `unnest`, `::jsonb`) and run on the target; they need translating before the silver jobs will run. `ddl.sql` is Postgres DDL.\n",
		);
	}

	lines.push("## Bronze - source table -> staging\n");
	lines.push("| staging table | source | columns | business key | watermark |");
	lines.push("|---|---|---|---|---|");
	for (const b of plan.bronze) {
		lines.push(
			`| ${b.staging} | ${b.source} | ${b.columns.length} | ${b.key.join(", ") || "-"} | ${b.watermark ?? "-"} |`,
		);
	}

	lines.push("\n## Silver - staging -> FDL entity\n");
	lines.push(
		"| entity | strategy | reads | columns | upsert key | incremental |",
	);
	lines.push("|---|---|---|---|---|---|");
	for (const s of plan.silver) {
		const reads = [...new Set(s.branches.flatMap((b) => b.reads))];
		lines.push(
			`| ${s.name} | ${s.strategy} | ${reads.join(", ")} | ${s.columns.length} | ${s.keyed ? "business_column_value" : "-"} | ${s.watermark ? "yes" : "no"} |`,
		);
	}

	if (errors.length > 0) {
		lines.push(
			"\n## Errors - the generated query will fail or load wrong data\n",
		);
		lines.push(
			"Generated exactly as the sheet says; fix the row and regenerate.\n",
		);
		lines.push(...issueTable(errors));
	}
	if (warnings.length > 0) {
		lines.push("\n## Warnings\n");
		lines.push(...issueTable(warnings));
	}
	if (infos.length > 0) {
		lines.push("\n## Notes\n");
		lines.push(...issueTable(infos));
	}

	lines.push("");
	return lines.join("\n");
}
