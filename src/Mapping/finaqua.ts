import type { Dialect } from "@/Mapping/dialect.js";
import { BATCH_COLUMN, family, stagedName } from "@/Mapping/plan.js";
import { hasWhere, literal, rewriteQualifiers } from "@/Mapping/sql.js";
import type {
	BronzeTable,
	Column,
	PipelineColumn,
	SilverEntity,
} from "@/Mapping/types.js";

/**
 * Builds FinAqua batch job configs in the exact shape of the hand-written
 * templates (s_account_lien_table.json, account_lien_detail.json and their
 * _incr variants):
 *
 *   execplan[0]  read the view(s), write the rows            -> the load
 *   execplan[1]  count source vs target, write one audit row -> the recon
 *
 * Connection details are never written, only the placeholder names the
 * templates use (sourceUrl, targetUser, ...), resolved at deploy time.
 */

export type LoadMode = "full" | "incremental";

export type JobOptions = {
	/** Batch name stamped on audit rows and used to find the running batch. */
	batchName: string;
	source: Dialect;
	target: Dialect;
};

export type Field = { name: string; type: string; format?: string };

/**
 * Formats for the writer's time/date fields.
 *
 * `JDBCStatement.setParam` parses the value with `new SimpleDateFormat(format)`,
 * and `JDBCExecConfig.verifyFields` rejects a date/time field without one. The
 * templates use `hh` (12-hour) and, for dates, `yyyy-mm-dd` - where `mm` means
 * minutes, so the month is never read and every date collapses into January.
 */
export const TIME_FORMAT = "yyyy-MM-dd'T'HH:mm:ss";
export const DATE_FORMAT = "yyyy-MM-dd";

/**
 * Workbook type -> FinAqua writer field type.
 *
 * The runtime's types are fixed by `JDBCStatement.setParam`: string, int/long,
 * double/number/float, date, time, boolean, and json/jsonb. `text` vs `string`
 * follows the templates - staging writers say string, silver writers say text -
 * and both end up as `setString`.
 */
export function field(column: Column, textType: "string" | "text"): Field {
	switch (family(column.type)) {
		case "number": {
			// setParam binds int/integer/long with setLong, so the distinction is
			// documentation - but a bigint field typed `int` reads as a defect.
			const t = column.type.toLowerCase().replace(/\(.*$/, "").trim();
			if (t === "bigint" || t === "int8")
				return { name: column.name, type: "long" };
			if (/^(int|int2|int4|integer|smallint|serial)$/.test(t))
				return { name: column.name, type: "int" };
			return { name: column.name, type: "double" };
		}
		case "timestamp":
			return { name: column.name, type: "time", format: TIME_FORMAT };
		case "date":
			return { name: column.name, type: "date", format: DATE_FORMAT };
		case "bool":
			return { name: column.name, type: "boolean" };
		case "json":
			// PostgresJdbcWriter binds a jsonb field as `? ::jsonb`, so the column
			// is cast by Postgres itself rather than by a JDBC URL option.
			return { name: column.name, type: "jsonb" };
		default:
			// Arrays have no writer type: they arrive as a JSON array from
			// Dataset.toJSON() and are bound with setString. See the array note in
			// the README - the source type needs confirming first.
			return { name: column.name, type: textType };
	}
}

const BATCH_RUN_ID: Field = { name: "batch_run_id", type: "int" };
const KEY_FIELDS: Field[] = [
	{ name: "business_column_name", type: "string" },
	{ name: "business_column_value", type: "string" },
];

/** Column a table records the batch run in: the sheet's own, if it has one. */
function batchColumn(pipeline: PipelineColumn[]): string {
	return pipeline.some((p) => p.name === BATCH_COLUMN)
		? BATCH_COLUMN
		: BATCH_RUN_ID.name;
}

function runningBatch(batchName: string): string {
	return `select batch_run_id from batch_run_detail where batch_name = ${literal(batchName)} and status = 'running'`;
}

function providers() {
	const connection = (name: string, prefix: string) => ({
		name,
		type: "QUERY",
		provider: "com.fininfra.aqua.action.extn.jdbc.JDBCReader",
		params: {
			user: `${prefix}User`,
			password: `${prefix}Password`,
			url: `${prefix}Url`,
			driver: `${prefix}Driver`,
		},
	});

	return {
		readers: [
			connection("source_db_connection", "source"),
			connection("target_db_connection", "target"),
		],
		transformations: [],
		destinations: [
			{
				name: "flowLogger",
				provider: "com.fininfra.aqua.defn.config.common.FlowLogger",
				params: { filePath: "./Logger.out", format: "text/plain" },
			},
			{
				name: "destination_storage",
				type: "LIST",
				provider: "com.fininfra.aqua.action.extn.jdbc.JDBCExecutorSaver",
				params: {
					driver: "targetDriver",
					url: "targetUrl",
					user: "targetUser",
					password: "targetPassword",
				},
			},
		],
		errdestinations: [
			{
				name: "aquaError",
				provider: "com.fininfra.aqua.extn.kafka.KafkaErrorWriter",
				params: {
					acks: "1",
					"bootstrap.servers": "bootstrapServers",
					url: "aquaErrorUrl",
					driver: "aquaErrorDriver",
					user: "aquaErrorUser",
					password: "aquaErrorPassword",
				},
				broadcast: "com.fininfra.aqua.extn.kafka.KafkaProducerFunction",
			},
		],
		validators: [],
	};
}

const ON_ERROR = [
	{
		name: "errorWriter",
		destination: "aquaError",
		params: {
			topic: "errorWriterTopic",
			url: "errorWriterUrl",
			driver: "errorWriterDriver",
			user: "errorWriterUser",
			password: "errorWriterPassword",
		},
	},
];

const AUDIT_FIELDS: Field[] = [
	{ name: "batch_run_id", type: "int" },
	{ name: "batch_name", type: "string" },
	{ name: "target_table_name", type: "string" },
	{ name: "source_row_count", type: "int" },
	{ name: "target_row_count", type: "int" },
	{ name: "recon_success_status", type: "string" },
	{ name: "load_status", type: "string" },
	{ name: "layer", type: "string" },
	{ name: "load_date", type: "time", format: TIME_FORMAT },
	{ name: "min_data_persistance_time", type: "time", format: TIME_FORMAT },
	{ name: "max_data_persistance_time", type: "time", format: TIME_FORMAT },
];

/**
 * The recon step. `source` counts what the load should have written; `target`
 * counts what this batch run actually wrote - rows carrying the running
 * batch_run_id - so a re-run or an upsert does not skew the comparison the way
 * a whole-table count would. min/max of the watermark are recorded because the
 * next incremental run starts from max_data_persistance_time.
 */
function auditPlan(opts: {
	batchName: string;
	layer: "bronze" | "silver";
	table: string;
	sourceCount: string;
	watermark: string | undefined;
	batchColumn: string;
}) {
	const wm = opts.watermark ?? "cast(null as timestamp)";

	return {
		steps: [
			{
				type: "SQL",
				sql: {
					empty: true,
					meta: {},
					type: "dataset",
					views: [
						{
							name: "source",
							reader: "source_db_connection",
							params: { query: opts.sourceCount },
						},
						{
							name: "target",
							reader: "target_db_connection",
							params: {
								query: `select count(*) as target_row_count, max(${wm}) as max_data_persistance_time, min(${wm}) as min_data_persistance_time from ${opts.table} where ${opts.batchColumn} = (${runningBatch(opts.batchName)})`,
							},
						},
						{
							name: "brd",
							reader: "target_db_connection",
							params: { query: runningBatch(opts.batchName) },
						},
					],
					inputSchema: "",
					query: `SELECT brd.batch_run_id, ${literal(opts.table)} as target_table_name, source.source_row_count, target.target_row_count, case when source.source_row_count = target.target_row_count then 'Y' else 'N' end as recon_success_status, 'success' AS load_status, ${literal(opts.layer)} AS layer, ${literal(opts.batchName)} as batch_name, CURRENT_TIMESTAMP AS load_date, target.min_data_persistance_time, target.max_data_persistance_time FROM (SELECT source_row_count FROM source) source INNER JOIN (SELECT target_row_count, min_data_persistance_time, max_data_persistance_time FROM target) target ON 1=1 JOIN brd ON 1=1`,
					maxRecs: 0,
				},
			},
		],
		actions: [
			{
				name: "audit_writer",
				condition: [],
				destination: "destination_storage",
				params: {
					table: "audit_log_detail",
					action: "insert",
					fields: AUDIT_FIELDS,
					key: [],
					ts: [],
				},
			},
		],
		onsuccess: [],
	};
}

function job(opts: {
	name: string;
	namespace: string;
	event: string;
	views: unknown[];
	query: string;
	table: string;
	action: "insert" | "upsert";
	fields: Field[];
	key: string[];
	/** Guard columns: an upsert only overwrites a row when the incoming value is
	 * newer. Ignored by an insert. */
	ts: string[];
	audit: ReturnType<typeof auditPlan>;
}) {
	return {
		namespace: "default",
		name: `${opts.namespace}.${opts.event}`,
		type: "BATCH",
		providers: providers(),
		onerror: ON_ERROR,
		source: {
			empty: true,
			meta: {},
			views: opts.views,
			pageSize: "0",
			query: opts.query,
		},
		validator: {},
		srcevents: [
			{
				namespace: `${opts.namespace}Vertical`,
				name: opts.event,
				steps: [],
				procedure: {
					namespace: "procedure_namespace",
					name: `${opts.event}_procedure`,
					logger: "false",
					inputschema: "{}",
					execplan: [
						{
							steps: [],
							actions: [
								{
									name: `${opts.event}_writer`,
									condition: [],
									destination: "destination_storage",
									params: {
										table: opts.table,
										action: opts.action,
										fields: opts.fields,
										key: opts.key,
										ts: opts.ts,
									},
								},
							],
							onsuccess: [],
						},
						opts.audit,
					],
					onsuccess: [],
				},
			},
		],
	};
}

/** Lower bound FinAqua supplies for an incremental JDBC read, keyed by table -
 * the same expression the _incr templates use. */
export function lowerBound(sourceTable: string): string {
	return `'\${#get(params,'jdbcPartitionColumnLowerBound#${sourceTable}')}'`;
}

/** Name of the view holding the source rows. The engine query selects from it,
 * so a reserved-word table name (`limit`) gets a suffix instead of quoting,
 * whose syntax the engine does not document. */
export function viewName(table: string, d: Dialect): string {
	return d.quote(table) === table ? table : `${table}_src`;
}

/** Bronze: one source table -> its staging table, columns unchanged, plus the
 * batch run and the concatenated source key. */
export function bronzeJob(
	table: BronzeTable,
	mode: LoadMode,
	opts: JobOptions,
) {
	const q = opts.source.quote;
	const incremental = mode === "incremental";
	// The sheet's key column, or else the source key concatenated into
	// business_column_value.
	const concatKey = !table.keyColumn && table.key.length > 0;
	const keyColumn =
		table.keyColumn ?? (concatKey ? "business_column_value" : undefined);
	const keyed = keyColumn !== undefined;
	const pipeline = table.standard.filter(
		(c): c is PipelineColumn => "value" in c,
	);
	const batch = batchColumn(pipeline);
	const watermark = table.watermark && stagedName(table, table.watermark);

	const filter =
		incremental && table.watermark
			? ` where ${q(table.watermark)} > ${lowerBound(table.source)}`
			: "";

	const projection = [
		...table.columns.map((c) => q(c.name)),
		// Pipeline values are added by the engine query, where brd is joined.
		...table.standard.flatMap((c) =>
			"copies" in c
				? [`${q(c.copies)} as ${q(c.name)}`]
				: "rule" in c
					? [
							`${rewriteQualifiers(c.rule, (t) => (t === table.source ? q(t) : undefined))} as ${q(c.name)}`,
						]
					: [],
		),
	];
	if (concatKey) {
		projection.push(
			`${literal(table.key.join(" ~ "))} as business_column_name`,
			`${opts.source.concat(table.key.flatMap((k, i) => (i === 0 ? [q(k)] : ["'~'", q(k)])))} as business_column_value`,
		);
	}

	const view = viewName(table.source, opts.source);
	const outColumns = [
		...(batch === BATCH_RUN_ID.name ? ["brd.batch_run_id"] : []),
		...table.columns.map((c) => `${view}.${c.name}`),
		...table.standard.map((c) =>
			"value" in c ? `${c.value} as ${c.name}` : `${view}.${c.name}`,
		),
		...(concatKey ? KEY_FIELDS.map((f) => `${view}.${f.name}`) : []),
	];

	return job({
		name: table.staging,
		namespace: opts.batchName,
		event: table.staging,
		table: table.staging,
		views: [
			{
				name: "batch_run_detail",
				reader: "target_db_connection",
				params: { query: "select * from batch_run_detail" },
			},
			{
				name: view,
				reader: "source_db_connection",
				params: {
					query: `select ${projection.join(", ")} from ${q(table.source)}${filter}`,
					// `table` is the key JDBCReader looks partition run-args up under
					// (jdbcPartitionColumn#<table> and its bounds), so a deployment can
					// turn on partitioned reads without editing this file.
					table: table.source,
				},
			},
		],
		query: `select ${outColumns.join(", ")} from ${view} JOIN (SELECT batch_run_id FROM batch_run_detail WHERE batch_name = ${literal(opts.batchName)} AND status = 'running') brd on TRUE`,
		action: incremental && keyed ? "upsert" : "insert",
		fields: [
			...(batch === BATCH_RUN_ID.name ? [BATCH_RUN_ID] : []),
			...table.columns.map((c) => field(c, "string")),
			...table.standard.map((c) => field(c, "string")),
			...(concatKey ? KEY_FIELDS : []),
		],
		key: keyColumn ? [keyColumn] : [],
		// Upserting on the source key must never let an older extract overwrite a
		// newer staged row; the writer adds `where staged.<ts> < excluded.<ts>`.
		ts: incremental && keyed && watermark ? [watermark] : [],
		audit: auditPlan({
			batchName: opts.batchName,
			layer: "bronze",
			table: table.staging,
			sourceCount: `select count(*) as source_row_count from ${q(table.source)}${filter}`,
			watermark: watermark && opts.target.quote(watermark),
			batchColumn: batch,
		}),
	});
}

/** High-water mark of the last silver load of an entity, from the audit log.
 * coalesce() so the very first incremental run - with no audit row yet - loads
 * everything instead of nothing. */
export function silverHighWater(entity: string): string {
	return `(select coalesce(max(max_data_persistance_time), timestamp '1900-01-01') from audit_log_detail where target_table_name = ${literal(entity)})`;
}

/** The silver SELECT, without the batch run: shared by the load and by the
 * recon's source count, so the two cannot drift apart. */
export function silverBody(
	entity: SilverEntity,
	mode: LoadMode,
	target: Dialect,
): string {
	const q = target.quote;

	return entity.branches
		.map((b) => {
			const projection = b.columns
				.map((c) => `${c.expr} as ${q(c.name)}`)
				.join(", ");

			let filter = "";
			if (mode === "incremental" && b.watermarks.length > 0) {
				// A row is part of the run when any table it is built from changed -
				// a new limitbalance must refresh its limit_master row even though
				// the limit row itself did not change.
				const since = silverHighWater(entity.name);
				const changed = b.watermarks
					.map((w) => `${w.alias}.${q(w.column)} > ${since}`)
					.join(" or ");
				filter = `${hasWhere(b.from) ? " and" : " where"} (${changed})`;
			}

			return `select ${projection} ${b.from.trim()}${filter}`;
		})
		.join(" union ");
}

/** Silver: staging -> FDL entity. The staging tables live in the target
 * database, so this job's "source" reader points at the target too. */
export function silverJob(
	entity: SilverEntity,
	mode: LoadMode,
	opts: JobOptions,
) {
	const incremental = mode === "incremental";
	const body = silverBody(entity, mode, opts.target);
	const namespace = `fdl-${opts.batchName}`;
	const batch = batchColumn(entity.pipeline);
	const added = [
		...(batch === BATCH_RUN_ID.name ? ["brd.batch_run_id"] : []),
		...entity.pipeline.map((p) => `${p.value} as ${opts.target.quote(p.name)}`),
	];

	const built = job({
		name: entity.name,
		namespace,
		event: entity.name,
		table: entity.name,
		views: [
			{
				name: entity.name,
				reader: "source_db_connection",
				params: {
					query: `select ${[...added, "q.*"].join(", ")} from (${body}) as q JOIN (${runningBatch(opts.batchName)}) brd on TRUE`,
					table: entity.name,
				},
			},
		],
		query: `select * from ${entity.name};`,
		action: incremental && entity.keyed ? "upsert" : "insert",
		fields: [
			...(batch === BATCH_RUN_ID.name ? [BATCH_RUN_ID] : []),
			...entity.columns.map((c) => field(c, "text")),
		],
		key: entity.keyed ? [entity.keyColumn] : [],
		// The ts guard compares the FDL watermark, which only tracks the table the
		// row's data_persistance_time is mapped from. On a join that is the driving
		// table, so a change in a joined table would be selected by the query and
		// then discarded by the guard - no ts there. One table per branch (a single
		// source, or a UNION) is safe: the row and its watermark agree.
		ts:
			incremental &&
			entity.keyed &&
			entity.watermark &&
			entity.branches.every((b) => b.reads.length === 1)
				? [entity.watermark]
				: [],
		audit: auditPlan({
			batchName: opts.batchName,
			layer: "silver",
			table: entity.name,
			sourceCount: `select count(*) as source_row_count from (${body}) as q`,
			watermark: entity.watermark && opts.target.quote(entity.watermark),
			batchColumn: batch,
		}),
	});

	// Staging is in the target database: read it with the target credentials
	// rather than asking the deployer to repeat them under source* names.
	const reader = built.providers.readers[0];
	if (reader) {
		reader.params = {
			user: "targetUser",
			password: "targetPassword",
			url: "targetUrl",
			driver: "targetDriver",
		};
	}

	return built;
}
