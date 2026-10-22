/**
 * Model for the Source-to-Silver (FDL) mapping workbook.
 *
 * The workbook has two tabs:
 *
 *   DataMapping  one row per FDL column: which source table/column feeds it and
 *                either `##STRAIGHTMOVE` or a Postgres expression (JSONB
 *                extraction, key concatenation, literals).
 *   Conditions   one row per FDL entity that reads more than one source table:
 *                the FROM clause and the query strategy (JOIN or UNION).
 *
 * Unlike the one-to-one migration, one FDL entity may be fed by several source
 * tables, and one source table may feed several FDL entities - so the source
 * tables become their own jobs (bronze, one per table) and the FDL entities
 * theirs (silver, one per entity).
 */

export const STRAIGHT_MOVE = "##STRAIGHTMOVE";

/** Rule of an FDL column the pipeline fills itself (audit_*, metadata_*_id):
 * it has no source, but the FDL table still carries it. */
export const PIPELINE_GENERATED = "##PIPELINEGENERATED";

export type MappingRow = {
	/** FDL (silver) entity, e.g. "limit_master". */
	entity: string;
	/** FDL column, e.g. "bank_identification". */
	column: string;
	/** FDL type as written, e.g. "varchar(8)", "numeric(10,2)". */
	fdlType: string;
	/** Source table, e.g. "limit"; "na" for columns with no source table. */
	sourceEntity: string;
	/** Source column(s) as written - informational for expression rows. */
	sourceColumn: string;
	/** Source type as written, e.g. "jsonb", "_jsonb", "bool"; "##NA" for derived. */
	sourceType: string;
	/** `##STRAIGHTMOVE`, or a Postgres expression over the source tables. */
	rule: string;
	/** Sheet-qualified cell of the row, for diagnostics - e.g. "DataMapping!A5". */
	cell: string;
};

export type QueryStrategy = "JOIN" | "UNION";

export type Condition = {
	entity: string;
	/** Everything from `from` onward, written against the source table names. */
	clause: string;
	strategy: QueryStrategy;
	cell: string;
};

export type MappingSpec = {
	sourceFile: string;
	rows: MappingRow[];
	conditions: Condition[];
	skipped: { cell: string; reason: string }[];
};

export type IssueLevel = "error" | "warning" | "info";

/** Something in the workbook a reviewer has to see. Errors are problems that
 * make a generated query fail or load wrong data; they are reported, never
 * silently patched, because the sheet is the source of truth. */
export type Issue = {
	level: IssueLevel;
	/** FDL entity or staging table the issue belongs to. */
	scope: string;
	cell?: string | undefined;
	message: string;
};

export type Column = { name: string; type: string };

/** A ##PIPELINEGENERATED column: the job adds `value` around the query, where
 * the running batch is joined as `brd`. */
export type PipelineColumn = Column & { value: string };

/** A staging column taken from the FDL sheet's standard rows (metadata_*,
 * audit_*): a source column staged under the FDL name, a sheet rule over the
 * source row, or a pipeline value. */
export type StandardColumn =
	| (Column & { copies: string })
	| (Column & { rule: string })
	| PipelineColumn;

/** One source table copied into staging: the bronze job. */
export type BronzeTable = {
	/** Source table name, e.g. "limit". */
	source: string;
	/** Staging table name, e.g. "s_limit". */
	staging: string;
	/** Physical source columns the FDL mapping needs, in first-seen order. */
	columns: Column[];
	/** Standard columns, in sheet order, after `columns`. */
	standard: StandardColumn[];
	/** Source column -> the name staging holds it under, for a source column
	 * copied into a standard column (`_modifiedon` -> metadata_persisted_timestamp). */
	stagedAs: Record<string, string>;
	/** Natural key of the source row, if one can be derived from the mapping. */
	key: string[];
	/** Standard column the staging rows are upserted on, when the sheet gives
	 * one; otherwise `key` is concatenated into business_column_value. */
	keyColumn?: string | undefined;
	/** Source column that drives incremental loads, e.g. "_modifiedon". */
	watermark?: string | undefined;
};

export type SilverColumn = {
	name: string;
	fdlType: string;
	/** Projection expression in target SQL, already rewritten for staging. */
	expr: string;
	cell: string;
};

/** One SELECT of a silver query. A JOIN entity has one branch; a UNION entity
 * has one per source table. */
export type SilverBranch = {
	/** Rewritten FROM clause, e.g. `from s_limit as "limit" left outer join ...`. */
	from: string;
	/** Staging tables the FROM clause reads. */
	reads: string[];
	columns: SilverColumn[];
	/** Staging tables (with the alias they are read under) whose watermark
	 * decides whether a row is part of an incremental run. */
	watermarks: { alias: string; column: string }[];
};

/** One FDL entity loaded from staging: the silver job. */
export type SilverEntity = {
	name: string;
	strategy: QueryStrategy;
	branches: SilverBranch[];
	/** FDL columns in sheet order - the writer's field list. */
	columns: Column[];
	/** Columns of `columns` the job fills itself; the branches leave them out. */
	pipeline: PipelineColumn[];
	/** FDL column holding the business key, e.g. "metadata_business_key_value". */
	keyColumn: string;
	/** Whether `keyColumn` can be used as an upsert key. */
	keyed: boolean;
	/** FDL column carrying the source change time, e.g. "data_persistance_time". */
	watermark?: string | undefined;
};

export type Plan = {
	spec: MappingSpec;
	bronze: BronzeTable[];
	silver: SilverEntity[];
	issues: Issue[];
};
