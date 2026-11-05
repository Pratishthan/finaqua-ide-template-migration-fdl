import path from "node:path";
import { Command, Option } from "commander";
import ExcelJS from "exceljs";
import { type DbType, dialect, parseDbType } from "@/Mapping/dialect.js";
import { emitPlan } from "@/Mapping/emit.js";
import {
	bronzeJob,
	type JobOptions,
	type LoadMode,
	silverJob,
} from "@/Mapping/finaqua.js";
import { loadLayout, type SheetLayout } from "@/Mapping/layout.js";
import {
	parseBronzeMapping,
	parseEntityAttributes,
	parseMappingWorkbook,
} from "@/Mapping/parse.js";
import { buildPlan, DEFAULT_PLAN_OPTIONS } from "@/Mapping/plan.js";
import { applyQualityRules } from "@/Mapping/quality.js";
import type { EntityAttribute, Plan } from "@/Mapping/types.js";
import { resolveDestinationPath, resolveExistingPath } from "@/utils.js";

type CommonOptions = {
	sourceDb: DbType;
	targetDb: DbType;
	batchName: string;
	stagingPrefix: string;
	watermark: string;
	keyColumn: string;
	layout?: string;
	dqWorkbook?: string;
	bronzeMapping?: string;
};

async function readWorkbook(file: string): Promise<ExcelJS.Workbook> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(file);
	return workbook;
}

/** entity_attributes from --dq-workbook, which must have the tab, or else from
 * the mapping workbook, if it happens to have one. */
async function readAttributes(
	mapping: ExcelJS.Workbook,
	file: string,
	options: CommonOptions,
	layout: SheetLayout,
): Promise<EntityAttribute[] | undefined> {
	if (!options.dqWorkbook) {
		return parseEntityAttributes(mapping, path.basename(file), layout);
	}

	const name = path.basename(options.dqWorkbook);
	const attributes = parseEntityAttributes(
		await readWorkbook(options.dqWorkbook),
		name,
		layout,
	);
	if (!attributes) {
		throw new Error(`${name}: no ${layout.entityAttributes.sheet} tab`);
	}
	return attributes;
}

async function readPlan(file: string, options: CommonOptions): Promise<Plan> {
	const layout = loadLayout(options.layout);
	const workbook = await readWorkbook(file);
	const spec = parseMappingWorkbook(workbook, path.basename(file), layout);

	// BronzeMappings from --bronze-mapping, which must have the tab, or else from
	// the mapping workbook; with neither, staging is derived from DataMapping.
	if (options.bronzeMapping) {
		const name = path.basename(options.bronzeMapping);
		const bronze = await readWorkbook(options.bronzeMapping);
		if (!parseBronzeMapping(bronze, name, spec, layout)) {
			throw new Error(`${name}: no ${layout.bronzeMapping.sheet} tab`);
		}
	} else {
		parseBronzeMapping(workbook, path.basename(file), spec, layout);
	}

	const plan = buildPlan(spec, {
		...DEFAULT_PLAN_OPTIONS,
		stagingPrefix: options.stagingPrefix,
		watermarkColumn: options.watermark,
		keyColumn: options.keyColumn,
		target: dialect(options.targetDb),
	});

	const attributes = await readAttributes(workbook, file, options, layout);
	return attributes ? applyQualityRules(plan, attributes) : plan;
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
			"CDH",
		)
		.option("--staging-prefix <prefix>", "staging table prefix", "s_")
		.option(
			"--watermark <column>",
			"FDL column that carries the source change time",
			DEFAULT_PLAN_OPTIONS.watermarkColumn,
		)
		.option(
			"--key-column <column>",
			"FDL column holding the business key, used as the upsert key",
			DEFAULT_PLAN_OPTIONS.keyColumn,
		)
		.addOption(
			new Option(
				"--layout <file>",
				"JSON overriding the workbook's tab names and column headers",
			)
				.env("FDL_SHEET_LAYOUT")
				.argParser(resolveExistingPath),
		)
		.option(
			"--bronze-mapping <file>",
			"workbook whose BronzeMappings tab defines the staging tables (source -> bronze)",
			resolveExistingPath,
		)
		.option(
			"--dq-workbook <file>",
			"data model workbook whose entity_attributes tab gives the silver data quality checks",
			resolveExistingPath,
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

		if (entity?.quality) {
			console.log(`\n-- data quality schema\n${entity.quality.schema}`);
		}

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
