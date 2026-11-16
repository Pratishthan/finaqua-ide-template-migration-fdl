import { columnInputs } from "@/Mapping/lineage.js";
import { BATCH_COLUMN, pgType } from "@/Mapping/plan.js";
import { fromAliases } from "@/Mapping/sql.js";
import {
	type BronzeTable,
	type Column,
	type Plan,
	type SilverEntity,
	STRAIGHT_MOVE,
} from "@/Mapping/types.js";

/**
 * OpenMetadata tables and column-level lineage for a plan, in the shape
 * finaqua-ide-template-fdl writes and the finaqua-ide-deploy-openmetadata
 * deployer publishes:
 *
 *   openMetadata/sources/<table>.json        source tables the bronze jobs read
 *   openMetadata/destinations/<table>.json   staging tables and FDL entities
 *   openMetadata/lineageEdges/edge.json      source -> staging -> FDL edges
 *
 * Unlike the FDL template there are two hops: a source column is copied (or
 * transformed) into staging, and the silver query reads staging. The lineage
 * comes from the same plan the jobs are generated from, so it describes the
 * columns the jobs actually move.
 */

export type OpenMetadataDataType =
	| "INT"
	| "BIGINT"
	| "SMALLINT"
	| "NUMERIC"
	| "FLOAT"
	| "DOUBLE"
	| "STRING"
	| "VARCHAR"
	| "CHAR"
	| "TEXT"
	| "DATE"
	| "TIME"
	| "TIMESTAMP"
	| "TIMESTAMPZ"
	| "INTERVAL"
	| "ARRAY"
	| "JSON"
	| "BOOLEAN"
	| "BYTES"
	| "UUID";

export type OpenMetadataColumn = {
	name: string;
	displayName: string;
	dataType: OpenMetadataDataType;
	dataTypeDisplay?: string;
	/** OpenMetadata rejects a CHAR or VARCHAR column without one. */
	dataLength?: number;
	/** OpenMetadata rejects an ARRAY column without one. */
	arrayDataType?: OpenMetadataDataType;
	description?: string;
	constraint?: "UNIQUE" | "PRIMARY_KEY";
};

export type OpenMetadataTableConstraint = {
	constraintType: "UNIQUE" | "PRIMARY_KEY";
	columns: string[];
};

export type OpenMetadataEntity = {
	name: string;
	/** Fully qualified schema: service.database.schema. */
	databaseSchema: string;
	description?: string;
	columns: OpenMetadataColumn[];
	tableConstraints: OpenMetadataTableConstraint[];
};

export type OpenMetadataColumnLineage = {
	fromColumns: string[];
	toColumn: string;
	/** DIRECT for a straight copy, else the sheet rule. */
	function: string;
};

export type OpenMetadataLineageEdge = {
	edge: {
		fromEntity: { id: string; type: "table" };
		toEntity: { id: string; type: "table" };
		lineageDetails: {
			source: "Manual";
			columnsLineage: OpenMetadataColumnLineage[];
		};
	};
};

export type OpenMetadataResult = {
	sources: OpenMetadataEntity[];
	destinations: OpenMetadataEntity[];
	lineageEdges: OpenMetadataLineageEdge[];
};

export type OpenMetadataOptions = {
	/** Schema the source tables are catalogued under. */
	sourceSchema: string;
	/** Schema of the target database, which holds staging and the FDL. */
	targetSchema: string;
};

export const DEFAULT_OPENMETADATA_OPTIONS: OpenMetadataOptions = {
	sourceSchema: "Postgres.postgres_db.postgres_schema",
	targetSchema: "FDL.lake_db.lake_schema",
};

const SCALAR: Record<string, OpenMetadataDataType> = {
	int: "INT",
	int4: "INT",
	integer: "INT",
	serial: "INT",
	int2: "SMALLINT",
	smallint: "SMALLINT",
	int8: "BIGINT",
	bigint: "BIGINT",
	bigserial: "BIGINT",
	numeric: "NUMERIC",
	decimal: "NUMERIC",
	money: "NUMERIC",
	number: "NUMERIC",
	real: "FLOAT",
	float4: "FLOAT",
	float: "DOUBLE",
	float8: "DOUBLE",
	double: "DOUBLE",
	"double precision": "DOUBLE",
	varchar: "VARCHAR",
	"character varying": "VARCHAR",
	varchar2: "VARCHAR",
	nvarchar: "VARCHAR",
	char: "CHAR",
	character: "CHAR",
	bpchar: "CHAR",
	text: "TEXT",
	clob: "TEXT",
	date: "DATE",
	time: "TIME",
	timestamp: "TIMESTAMP",
	"timestamp without time zone": "TIMESTAMP",
	"timestamp with time zone": "TIMESTAMPZ",
	timestamptz: "TIMESTAMPZ",
	interval: "INTERVAL",
	json: "JSON",
	jsonb: "JSON",
	bool: "BOOLEAN",
	boolean: "BOOLEAN",
	bytea: "BYTES",
	uuid: "UUID",
};

/** A workbook type, e.g. `varchar(50)`, `_jsonb`, `numeric(20,4)`, as an
 * OpenMetadata column type. Anything unrecognised is a STRING. */
export function omType(
	type: string,
): Pick<
	OpenMetadataColumn,
	"dataType" | "dataTypeDisplay" | "dataLength" | "arrayDataType"
> {
	const spelled = pgType(type);
	const array = spelled.endsWith("[]") || spelled.startsWith("_");
	// `timestamp(6) with time zone` -> `timestamp with time zone`
	const base = spelled
		.replace(/\[\]$/, "")
		.replace(/^_/, "")
		.replace(/\s*\([^)]*\)/g, "")
		.trim();
	const scalar = SCALAR[base] ?? "STRING";
	const display = spelled;

	if (array) {
		return {
			dataType: "ARRAY",
			arrayDataType: scalar,
			dataTypeDisplay: display,
		};
	}
	if (scalar === "VARCHAR" || scalar === "CHAR") {
		const length = Number(spelled.match(/\(\s*(\d+)\s*\)/)?.[1]);
		// Without a length the column holds any text; say so rather than invent one.
		if (!length) {
			return scalar === "CHAR"
				? { dataType: "CHAR", dataLength: 1, dataTypeDisplay: display }
				: { dataType: "TEXT", dataTypeDisplay: display };
		}
		return { dataType: scalar, dataLength: length, dataTypeDisplay: display };
	}
	return { dataType: scalar, dataTypeDisplay: display };
}

function omColumn(column: Column, unique?: string): OpenMetadataColumn {
	return {
		name: column.name,
		displayName: column.name,
		...omType(column.type),
		...(column.name === unique && { constraint: "UNIQUE" as const }),
	};
}

/** What the staging table holds, as ddl.sql creates it. */
function stagingColumns(table: BronzeTable): Column[] {
	const concatKey = !table.keyColumn && table.key.length > 0;
	return [
		...(table.standard.some((c) => c.name === BATCH_COLUMN)
			? []
			: [{ name: "batch_run_id", type: "integer" }]),
		...table.columns,
		...table.standard,
		...(concatKey
			? [
					{ name: "business_column_name", type: "text" },
					{ name: "business_column_value", type: "text" },
				]
			: []),
	];
}

function stagingKey(table: BronzeTable): string | undefined {
	if (table.keyColumn) return table.keyColumn;
	return table.key.length > 0 ? "business_column_value" : undefined;
}

/** Looks a column up the way Postgres resolves an unquoted name: by lower case. */
class Columns {
	readonly #byName = new Map<string, Column>();
	constructor(columns: Column[] = []) {
		for (const c of columns) this.add(c);
	}
	add(column: Column) {
		const key = column.name.toLowerCase();
		if (!this.#byName.has(key)) this.#byName.set(key, column);
	}
	/** The column as declared, for a name as an expression spells it. */
	get(name: string): Column | undefined {
		return this.#byName.get(name.toLowerCase());
	}
	values(): Column[] {
		return [...this.#byName.values()];
	}
}

class Builder {
	/** Columns of each source table, across every bronze job reading it. */
	readonly sources = new Map<string, Columns>();
	readonly destinations = new Map<string, OpenMetadataEntity>();
	readonly edges = new Map<string, OpenMetadataLineageEdge>();
	readonly rules: Map<string, string>;
	readonly staging: Map<string, { table: BronzeTable; columns: Columns }>;

	constructor(
		readonly plan: Plan,
		readonly options: OpenMetadataOptions,
	) {
		this.rules = new Map(plan.spec.rows.map((r) => [r.cell, r.rule.trim()]));
		for (const r of plan.spec.bronzeRows ?? [])
			this.rules.set(r.cell, r.rule.trim());
		// Keyed lower-case, as fromAliases resolves a FROM clause.
		this.staging = new Map(
			plan.bronze.map((b) => [
				b.staging.toLowerCase(),
				{ table: b, columns: new Columns(stagingColumns(b)) },
			]),
		);
	}

	source = (table: string) => `${this.options.sourceSchema}.${table}`;
	target = (table: string) => `${this.options.targetSchema}.${table}`;

	lineage(from: string, to: string, column: OpenMetadataColumnLineage) {
		const key = `${from}->${to}`;
		const edge = this.edges.get(key) ?? {
			edge: {
				fromEntity: { id: from, type: "table" as const },
				toEntity: { id: to, type: "table" as const },
				lineageDetails: { source: "Manual" as const, columnsLineage: [] },
			},
		};
		edge.edge.lineageDetails.columnsLineage.push(column);
		this.edges.set(key, edge);
	}

	bronze(table: BronzeTable) {
		const source = this.source(table.source);
		const staging = this.target(table.staging);
		const read = this.sources.get(table.source) ?? new Columns();
		this.sources.set(table.source, read);
		const direct = (from: string, to: string) =>
			this.lineage(source, staging, {
				fromColumns: [`${source}.${from}`],
				toColumn: `${staging}.${to}`,
				function: "DIRECT",
			});

		for (const c of table.columns) {
			read.add(c);
			direct(c.name, c.name);
		}

		// What an unqualified name in a rule can be: a column the job copies.
		const copied = new Columns([
			...table.columns,
			...table.standard.flatMap((c) =>
				"copies" in c ? [{ name: c.copies, type: c.type }] : [],
			),
		]);
		for (const c of table.standard) {
			if ("copies" in c) {
				read.add({ name: c.copies, type: c.type });
				direct(c.copies, c.name);
			} else if ("rule" in c) {
				const inputs = columnInputs(
					c.rule,
					new Set([table.source.toLowerCase()]),
					(name) => (copied.get(name) ? table.source : undefined),
				).filter((i) => i.feeds);
				if (inputs.length === 0) continue;
				// A column only a rule reads is still read from the source; its
				// type is not in the sheet.
				const names = inputs.map((i) => copied.get(i.column)?.name ?? i.column);
				for (const name of names)
					read.add(copied.get(name) ?? { name, type: "" });
				this.lineage(source, staging, {
					fromColumns: names.map((n) => `${source}.${n}`),
					toColumn: `${staging}.${c.name}`,
					function: c.rule,
				});
			}
		}

		if (!table.keyColumn && table.key.length > 0) {
			this.lineage(source, staging, {
				fromColumns: table.key.map((k) => `${source}.${k}`),
				toColumn: `${staging}.business_column_value`,
				function: table.key.join(" || '~' || "),
			});
		}

		const key = stagingKey(table);
		this.destinations.set(table.staging, {
			name: table.staging,
			databaseSchema: this.options.targetSchema,
			description: `Staging copy of ${table.source}`,
			columns: stagingColumns(table).map((c) => omColumn(c, key)),
			tableConstraints: key
				? [{ constraintType: "UNIQUE", columns: [key] }]
				: [],
		});
	}

	silver(entity: SilverEntity) {
		const to = this.target(entity.name);

		for (const branch of entity.branches) {
			const aliases = fromAliases(branch.from);
			const read = branch.reads.flatMap((r) => {
				const s = this.staging.get(r.toLowerCase());
				return s ? [s] : [];
			});
			// An unqualified name belongs to the one table read that has it - with
			// two, Postgres itself would call it ambiguous.
			const bare = (name: string) => {
				const owners = read.filter((s) => s.columns.get(name));
				return owners.length === 1 ? owners[0]?.table.staging : undefined;
			};

			for (const column of branch.columns) {
				const rule = this.rules.get(column.cell);
				const straight = rule?.toUpperCase() === STRAIGHT_MOVE;
				const inputs = columnInputs(column.expr, new Set(aliases.keys()), bare)
					// A straight move's bool -> text case reads its column in the condition.
					.filter((i) => i.feeds || straight);

				const byTable = new Map<string, string[]>();
				for (const i of inputs) {
					const staged = this.staging.get(
						(aliases.get(i.table) ?? i.table).toLowerCase(),
					);
					// A column staging does not carry is a sheet error, already in
					// coverage.md; OpenMetadata would reject the whole edge over it.
					const declared = staged?.columns.get(i.column);
					if (!staged || !declared) continue;
					const name = staged.table.staging;
					byTable.set(name, [...(byTable.get(name) ?? []), declared.name]);
				}
				for (const [table, columns] of byTable) {
					const from = this.target(table);
					this.lineage(from, to, {
						fromColumns: columns.map((c) => `${from}.${c}`),
						toColumn: `${to}.${column.name}`,
						function: straight ? "DIRECT" : (rule ?? column.expr),
					});
				}
			}
		}

		const key = entity.keyed ? entity.keyColumn : undefined;
		this.destinations.set(entity.name, {
			name: entity.name,
			databaseSchema: this.options.targetSchema,
			columns: [
				...(entity.pipeline.some((c) => c.name === BATCH_COLUMN)
					? []
					: [{ name: "batch_run_id", type: "integer" }]),
				...entity.columns,
			].map((c) => omColumn(c, key)),
			tableConstraints: key
				? [{ constraintType: "UNIQUE", columns: [key] }]
				: [],
		});
	}
}

/** `service.database.schema`, which is how OpenMetadata names a schema. */
export function checkSchemaName(name: string): string {
	if (!/^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(name)) {
		throw new Error(
			`'${name}' is not an OpenMetadata schema name - expected service.database.schema`,
		);
	}
	return name;
}

export function buildOpenMetadata(
	plan: Plan,
	options: OpenMetadataOptions = DEFAULT_OPENMETADATA_OPTIONS,
): OpenMetadataResult {
	checkSchemaName(options.sourceSchema);
	checkSchemaName(options.targetSchema);
	const builder = new Builder(plan, options);

	for (const table of plan.bronze) builder.bronze(table);
	for (const entity of plan.silver) builder.silver(entity);

	return {
		sources: [...builder.sources].map(([name, columns]) => ({
			name,
			databaseSchema: options.sourceSchema,
			columns: columns.values().map((c) => omColumn(c)),
			tableConstraints: [],
		})),
		destinations: [...builder.destinations.values()],
		lineageEdges: [...builder.edges.values()],
	};
}
