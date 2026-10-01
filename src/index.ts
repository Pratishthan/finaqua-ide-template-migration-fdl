import path from "node:path";
import { Command } from "commander";
import ExcelJS from "exceljs";
import { type DbType, dialect, parseDbType } from "@/Mapping/dialect.js";
import { emitPlan } from "@/Mapping/emit.js";
import {
	bronzeJob,
	type JobOptions,
	type LoadMode,
	silverJob,
} from "@/Mapping/finaqua.js";
import { parseMappingWorkbook } from "@/Mapping/parse.js";
import { buildPlan, DEFAULT_PLAN_OPTIONS } from "@/Mapping/plan.js";
import type { Plan } from "@/Mapping/types.js";
import { resolveDestinationPath, resolveExistingPath } from "@/utils.js";

type CommonOptions = {
	sourceDb: DbType;
	targetDb: DbType;
	batchName: string;
	stagingPrefix: string;
	watermark: string;
};

async function readPlan(file: string, options: CommonOptions): Promise<Plan> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(file);
	const spec = parseMappingWorkbook(workbook, path.basename(file));

	return buildPlan(spec, {
		...DEFAULT_PLAN_OPTIONS,
		stagingPrefix: options.stagingPrefix,
		watermarkColumn: options.watermark,
		target: dialect(options.targetDb),
	});
}

function jobOptions(options: CommonOptions): JobOptions {
	return {
		batchName: options.batchName,
		source: dialect(options.sourceDb),
		target: dialect(options.targetDb),
	};
}

/** Options every command shares: the database types are the provision to pick
 * source and destination, the rest name things in the generated SQL. */
function withCommonOptions(command: Command): Command {
	return command
		.option(
			"--source-db <type>",
			"source database: postgres | oracle | mysql | mssql",
			parseDbType,
			"postgres",
		)
		.option(
			"--target-db <type>",
			"target (staging + FDL) database: postgres | oracle | mysql | mssql",
			parseDbType,
			"postgres",
		)
		.option(
			"-b, --batch-name <name>",
			"batch name recorded in batch_run_detail and audit_log_detail",
			"limits",
		)
		.option("--staging-prefix <prefix>", "staging table prefix", "s_")
		.option(
			"--watermark <column>",
			"FDL column that carries the source change time",
			"data_persistance_time",
		);
}

const program = new Command();

program
	.name("finaqua-ide-template-migration-fdl")
	.description(
		"generates FinAqua bronze (source -> staging) and silver (staging -> FDL) jobs from a Source-to-Silver mapping workbook",
	);

withCommonOptions(
	program
		.command("generate", { isDefault: true })
		.description("write the FinAqua jobs, DDL and coverage report")
		.argument("<workbook>", "mapping workbook (.xlsx)", resolveExistingPath)
		.argument("<dest>", "output folder", resolveDestinationPath)
		.option(
			"-e, --entity <name>",
			"only this FDL entity and the staging tables it reads",
		),
).action(
	async (
		workbook: string,
		dest: string,
		options: CommonOptions & { entity?: string },
	) => {
		const plan = await readPlan(workbook, options);

		if (options.entity && !plan.silver.some((s) => s.name === options.entity)) {
			throw new Error(
				`no FDL entity '${options.entity}' in ${path.basename(workbook)}`,
			);
		}

		const result = await emitPlan(plan, dest, jobOptions(options), {
			entity: options.entity,
		});

		console.log(
			`${result.bronze} staging tables, ${result.silver} FDL entities -> ${result.files} files in ${dest}`,
		);
		console.log(
			`sheet issues: ${result.errors} errors, ${result.warnings} warnings - see ${path.join(dest, "coverage.md")}`,
		);
	},
);

withCommonOptions(
	program
		.command("inspect")
		.description(
			"print the SQL of one FDL entity or staging table, or list the issues",
		)
		.argument("<workbook>", "mapping workbook (.xlsx)", resolveExistingPath)
		.argument(
			"[name]",
			"FDL entity or staging table; omit to list every sheet issue",
		)
		.option("-i, --incremental", "show the incremental variant"),
).action(
	async (
		workbook: string,
		name: string | undefined,
		options: CommonOptions & { incremental?: boolean },
	) => {
		const plan = await readPlan(workbook, options);
		const opts = jobOptions(options);
		const mode: LoadMode = options.incremental ? "incremental" : "full";

		if (!name) {
			for (const i of plan.issues) {
				console.log(
					`${i.level.padEnd(8)}${i.scope.padEnd(38)}${(i.cell ?? "").padEnd(18)}${i.message}`,
				);
			}
			return;
		}

		const entity = plan.silver.find((s) => s.name === name);
		const table = plan.bronze.find(
			(b) => b.staging === name || b.source === name,
		);
		const job = entity
			? silverJob(entity, mode, opts)
			: table
				? bronzeJob(table, mode, opts)
				: undefined;

		if (!job) {
			console.log(`no FDL entity or staging table named '${name}'`);
			return;
		}

		for (const view of job.source.views as {
			name: string;
			params: { query: string };
		}[]) {
			console.log(`\n-- view ${view.name}\n${view.params.query}`);
		}
		console.log(`\n-- engine query\n${job.source.query}`);

		const audit = job.srcevents[0]?.procedure.execplan[1]?.steps[0]?.sql;
		for (const view of audit?.views ?? []) {
			console.log(`\n-- audit view ${view.name}\n${view.params.query}`);
		}

		for (const i of plan.issues.filter((x) => x.scope === name)) {
			console.log(`\n! ${i.level} ${i.cell ?? ""} ${i.message}`);
		}
	},
);

program
	.parseAsync()
	.catch((error: unknown) =>
		program.error(error instanceof Error ? error.message : String(error)),
	);
