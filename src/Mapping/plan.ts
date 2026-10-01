import type { Dialect } from "@/Mapping/dialect.js";
import {
	columnRefs,
	fromAliases,
	fromTables,
	hasCommaJoin,
	isStringLiteral,
	rewriteFromClause,
	rewriteQualifiers,
} from "@/Mapping/sql.js";
import {
	type BronzeTable,
	type Column,
	type Condition,
	type Issue,
	type MappingRow,
	type MappingSpec,
	type Plan,
	type SilverBranch,
	type SilverColumn,
	type SilverEntity,
	STRAIGHT_MOVE,
} from "@/Mapping/types.js";

export type PlanOptions = {
	/** Prefix of the staging tables, e.g. "s_" -> s_limit. */
	stagingPrefix: string;
	/** FDL column that carries the source change time. */
	watermarkColumn: string;
	/** FDL column holding the concatenated business key. */
	keyColumn: string;
	/** Dialect the silver query runs in - the target database. */
	target: Dialect;
};

export const DEFAULT_PLAN_OPTIONS: Omit<PlanOptions, "target"> = {
	stagingPrefix: "s_",
	watermarkColumn: "data_persistance_time",
	keyColumn: "business_column_value",
};

/** Values of source_entity_name / source_data_type meaning "no source". */
const NONE = new Set(["", "na", "##na", "n/a"]);

function sourceTablesOf(row: MappingRow): string[] {
	return row.sourceEntity
		.split(",")
		.map((s) => s.trim())
		.filter((s) => !NONE.has(s.toLowerCase()));
}

const isStraight = (row: MappingRow) =>
	row.rule.trim().toUpperCase() === STRAIGHT_MOVE;

/** Type family, so a cast is only emitted when the kind of value changes. */
type Family =
	| "text"
	| "number"
	| "timestamp"
	| "date"
	| "bool"
	| "json"
	| "array";

const NUMERIC_TYPES = new Set([
	"numeric",
	"decimal",
	"money",
	"int",
	"int2",
	"int4",
	"int8",
	"integer",
	"bigint",
	"smallint",
	"serial",
	"bigserial",
	"float",
	"float4",
	"float8",
	"real",
	"double",
	"double precision",
]);

export function family(type: string): Family {
	const t = type.toLowerCase().trim();
	if (t.startsWith("_") || t.endsWith("[]")) return "array";
	if (t.startsWith("json")) return "json";
	if (t === "bool" || t === "boolean") return "bool";
	if (t.startsWith("timestamp")) return "timestamp";
	if (t === "date") return "date";
	// Matched exactly, with any precision stripped: a prefix test would read
	// `interval` as numeric and then skip the cast it needs.
	if (NUMERIC_TYPES.has(t.replace(/\(.*$/, "").trim())) return "number";
	return "text";
}

/** Postgres spelling of a workbook type. `clob` is an Oracle-ism in the FDL
 * column; Postgres has no clob, text is the equivalent. */
export function pgType(type: string): string {
	const t = type.toLowerCase().trim();
	const exact: Record<string, string> = {
		clob: "text",
		bool: "boolean",
		float8: "double precision",
		float4: "real",
		timestamptz: "timestamp with time zone",
		_jsonb: "jsonb[]",
		_text: "text[]",
		_varchar: "varchar[]",
	};
	return exact[t] ?? (t || "text");
}

/**
 * Straight move of `alias.column` into an FDL column.
 *
 * Only a change of type *family* is cast. Casting text to varchar(8) would
 * silently truncate in Postgres, where an assignment raises instead - and a
 * load that fails loudly beats one that quietly cuts data.
 */
function straightExpr(
	qualified: string,
	sourceType: string,
	fdlType: string,
): string {
	const from = family(sourceType);
	const to = family(fdlType);
	if (from === to) return qualified;

	// Y/N matches the del_flg convention the staging templates already carry.
	if (from === "bool" && to === "text")
		return `case when ${qualified} then 'Y' when not ${qualified} then 'N' end`;
	if (from === "array" && to === "text")
		return `array_to_string(${qualified}, ',')`;

	return `cast(${qualified} as ${pgType(fdlType)})`;
}

/** Expressions yield text when they extract JSON (`->>`) - cast when the FDL
 * column is not text. Other expressions are passed through as written. */
function ruleExpr(rule: string, fdlType: string): string {
	const to = family(fdlType);
	if (to === "text" || !rule.includes("->>")) return rule;
	return `cast((${rule}) as ${pgType(fdlType)})`;
}

class Planner {
	readonly issues: Issue[] = [];
	/** source table -> physical columns (with type), first-seen order. */
	readonly physical = new Map<string, Map<string, string>>();
	readonly conditions = new Map<string, Condition[]>();
	readonly entities = new Map<string, MappingRow[]>();

	constructor(
		readonly spec: MappingSpec,
		readonly options: PlanOptions,
	) {
		for (const row of spec.rows) {
			const rows = this.entities.get(row.entity) ?? [];
			rows.push(row);
			this.entities.set(row.entity, rows);
		}
		for (const c of spec.conditions) {
			const list = this.conditions.get(c.entity) ?? [];
			list.push(c);
			this.conditions.set(c.entity, list);
		}
	}

	issue(level: Issue["level"], scope: string, message: string, cell?: string) {
		this.issues.push({ level, scope, message, cell });
	}

	addPhysical(table: string, column: string, type: string) {
		const cols = this.physical.get(table) ?? new Map<string, string>();
		const known = cols.get(column);
		// A typed row beats a guess from a join clause.
		if (known === undefined || (known === "" && type !== "")) {
			cols.set(column, type);
		}
		this.physical.set(table, cols);
	}

	knownTables(): Set<string> {
		const tables = new Set<string>();
		for (const row of this.spec.rows)
			for (const t of sourceTablesOf(row)) tables.add(t);
		for (const c of this.spec.conditions)
			for (const t of fromTables(c.clause)) tables.add(t);
		return tables;
	}

	/**
	 * Pass 1: which physical columns each source table must bring into staging.
	 *
	 * A straight move names its column directly. A typed expression row (a JSONB
	 * extraction) names its column through the expression's `table.column`
	 * references, falling back to source_column_name for an unqualified
	 * `unnest(contributordetails)`. Key rows (`##NA`) only reference columns
	 * already known - their source_column_name mixes real columns with JSON keys
	 * (`categoryType`), so it cannot be trusted to name physical columns.
	 */
	collectPhysical() {
		const tables = this.knownTables();

		for (const row of this.spec.rows) {
			const typed = !NONE.has(row.sourceType.toLowerCase());
			const owners = sourceTablesOf(row);

			if (isStraight(row)) {
				const [table] = owners;
				if (!table || owners.length > 1) {
					this.issue(
						"error",
						row.entity,
						`${row.column}: a straight move needs exactly one source table, got '${row.sourceEntity}'`,
						row.cell,
					);
					continue;
				}
				this.addPhysical(table, row.sourceColumn.toLowerCase(), row.sourceType);
				continue;
			}

			if (!typed) continue;

			// source_column_name says which reference is the physical column
			// (`limitcategorybalance.fundexposure` -> limitcategorybalance); a rule
			// may also reference JSON keys as if they were columns.
			const named = new Set(
				row.sourceColumn
					.split(",")
					.map((c) => c.split(".")[0]?.trim().toLowerCase()),
			);
			const refs = columnRefs(row.rule, tables);
			const physical = refs.filter((r) => named.has(r.column));
			for (const r of physical.length > 0 ? physical : refs)
				this.addPhysical(r.table, r.column, row.sourceType);
			if (refs.length > 0) continue;

			const [table] = owners;
			const column = row.sourceColumn.split(/[.,]/)[0]?.trim().toLowerCase();
			if (table && column) this.addPhysical(table, column, row.sourceType);
		}

		// Join columns have to reach staging too, even if nothing maps them. The
		// clause may introduce aliases (`from limit l`), and the join condition is
		// then written against the alias, so each name is resolved to its table.
		for (const c of this.spec.conditions) {
			const aliases = fromAliases(c.clause);
			const named = new Set([...aliases.keys(), ...tables]);
			for (const ref of columnRefs(c.clause, named)) {
				const r = {
					table: aliases.get(ref.table) ?? ref.table,
					column: ref.column,
				};
				if (!tables.has(r.table)) continue;
				if (this.physical.get(r.table)?.has(r.column)) continue;
				this.addPhysical(r.table, r.column, "");
				this.issue(
					"info",
					c.entity,
					`join column ${r.table}.${r.column} is not mapped anywhere - staged as text`,
					c.cell,
				);
			}
		}

		this.typeFromUsage(tables);
	}

	/**
	 * The sheet types a column by what the FDL gets out of it, not always by what
	 * it is: `limit.limitcategory` is written as `jsonb` but read with unnest(),
	 * which only takes an array; `feeassessmentdetails` is written as `text` but
	 * read with ->>, which only takes json. Staging has to hold the column in a
	 * type the silver rule can read, so the usage wins - once per column, loudly.
	 */
	typeFromUsage(tables: Set<string>) {
		const unnested =
			/unnest\s*\(\s*(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\)/gi;
		const extracted = /(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*->>/g;
		const decided = new Set<string>();

		const retype = (
			row: MappingRow,
			match: RegExpMatchArray,
			wanted: "array" | "json",
		) => {
			const qualifier = match[1]?.toLowerCase();
			const table =
				qualifier && tables.has(qualifier) ? qualifier : sourceTablesOf(row)[0];
			const column = match[2]?.toLowerCase();
			if (!table || !column) return;

			const cols = this.physical.get(table);
			const current = cols?.get(column);
			if (current === undefined || family(current) === wanted) return;
			if (wanted === "json" && family(current) === "array") return;

			const staged = wanted === "array" ? "_jsonb" : "jsonb";
			cols?.set(column, staged);
			if (decided.has(`${table}.${column}`)) return;
			decided.add(`${table}.${column}`);

			this.issue(
				"warning",
				`${this.options.stagingPrefix}${table}`,
				wanted === "array"
					? `${table}.${column} is typed '${current || "?"}' but the rules unnest() it, which needs an array - staged as jsonb[]. If the source column is a jsonb document holding an array, change the rules to jsonb_array_elements() instead`
					: `${table}.${column} is typed '${current || "?"}' but the rules read it with ->>, which needs json - staged as jsonb`,
				row.cell,
			);
		};

		for (const row of this.spec.rows) {
			if (isStraight(row)) continue;
			for (const m of row.rule.matchAll(unnested)) retype(row, m, "array");
			for (const m of row.rule.matchAll(extracted)) retype(row, m, "json");
		}
	}

	/**
	 * Staging key per source table, borrowed from an FDL business key built from
	 * that table alone: `limit.bankentityid||'.'||limit.limitid` gives s_limit the
	 * key (bankentityid, limitid). The narrowest such key wins.
	 */
	stagingKeys(): Map<string, string[]> {
		const tables = new Set(this.physical.keys());
		const keys = new Map<string, string[]>();

		for (const row of this.spec.rows) {
			if (row.column !== this.options.keyColumn || isStraight(row)) continue;
			const refs = columnRefs(row.rule, tables);
			const table = refs[0]?.table;
			if (!table || refs.some((r) => r.table !== table)) continue;
			if (!refs.every((r) => this.physical.get(table)?.has(r.column))) continue;

			const cols = [...new Set(refs.map((r) => r.column))];
			const current = keys.get(table);
			if (!current || cols.length < current.length) keys.set(table, cols);
		}

		return keys;
	}

	bronze(): BronzeTable[] {
		const keys = this.stagingKeys();
		const result: BronzeTable[] = [];

		const mapped = new Map<string, { column: string; type: string }>();
		for (const r of this.spec.rows) {
			const [table] = sourceTablesOf(r);
			if (r.column !== this.options.watermarkColumn || !isStraight(r)) continue;
			if (table && !mapped.has(table)) {
				mapped.set(table, {
					column: r.sourceColumn.toLowerCase(),
					type: r.sourceType,
				});
			}
		}

		// A joined table's change time never reaches the FDL (the entity takes it
		// from the driving table), so the sheet does not name it. When every table
		// that does name one uses the same column - `_modifiedon` here - that is a
		// convention of the source system, and the joined tables follow it.
		const conventions = new Set([...mapped.values()].map((m) => m.column));
		const convention =
			conventions.size === 1 ? [...mapped.values()][0] : undefined;

		for (const [source, cols] of this.physical) {
			const scope = `${this.options.stagingPrefix}${source}`;
			let watermark = mapped.get(source)?.column;

			if (!watermark && convention) {
				watermark = convention.column;
				if (!cols.has(watermark)) cols.set(watermark, convention.type);
				this.issue(
					"info",
					scope,
					`no mapped change-time column - assumed ${convention.column} like every other table; confirm it exists in the source`,
				);
			}

			const columns: Column[] = [...cols].map(([name, type]) => ({
				name,
				type: type || "text",
			}));

			if (!watermark) {
				this.issue(
					"warning",
					scope,
					`no source column maps to ${this.options.watermarkColumn} - incremental staging job not generated`,
				);
			}
			const key = keys.get(source) ?? [];
			if (key.length === 0) {
				this.issue(
					"info",
					scope,
					"no single-table business key in the mapping - staging has no business_column_value and incremental loads insert rather than upsert",
				);
			}

			result.push({
				source,
				staging: `${this.options.stagingPrefix}${source}`,
				columns,
				key,
				watermark,
			});
		}

		return result.sort((a, b) => a.source.localeCompare(b.source));
	}

	/** Checks a rule for defects that would make the silver query fail or load
	 * the wrong thing. Reported against the row's cell. */
	checkRule(row: MappingRow, tables: Set<string>) {
		if (isStraight(row)) {
			this.checkStraightTypes(row);
			return;
		}

		for (const r of columnRefs(row.rule, tables)) {
			if (!this.physical.get(r.table)?.has(r.column)) {
				this.issue(
					"error",
					row.entity,
					`${row.column}: rule references ${r.table}.${r.column}, which is not a column of ${r.table} (a JSON key?) - the silver query will fail until the rule is fixed`,
					row.cell,
				);
			}
		}

		const jsonKey = /->>\s*'([^']*)'/.exec(row.rule)?.[1]?.toLowerCase();
		if (jsonKey !== undefined) {
			const wantsCurrency = row.column.endsWith("_currency");
			const isCurrencyKey = jsonKey === "ccy" || jsonKey.includes("currency");
			if (
				wantsCurrency !== isCurrencyKey &&
				(wantsCurrency || jsonKey === "ccy")
			) {
				this.issue(
					"warning",
					row.entity,
					`${row.column}: extracts JSON key '${jsonKey}' - ${wantsCurrency ? "expected a currency key" : "a currency code into a non-currency column"}`,
					row.cell,
				);
			}
		}
	}

	/** A straight move between type families that cannot convert - an amount
	 * into a timestamp column - is a sheet error; one that converts only for
	 * some values (text into numeric) is a warning. */
	checkStraightTypes(row: MappingRow) {
		const from = family(row.sourceType);
		const to = family(row.fdlType);
		if (from === to || to === "text") return;

		const temporal = (f: string) => f === "timestamp" || f === "date";
		const impossible =
			(from === "number" && temporal(to)) ||
			(temporal(from) && to === "number") ||
			from === "bool" ||
			to === "bool" ||
			from === "array";

		this.issue(
			impossible ? "error" : "warning",
			row.entity,
			impossible
				? `${row.column}: straight move of ${row.sourceType} into ${row.fdlType} - these types do not convert; the FDL type is probably wrong`
				: `${row.column}: straight move of ${row.sourceType} into ${row.fdlType} - cast at load time, fails on any value that does not convert`,
			row.cell,
		);
	}

	/**
	 * Whether a mapping row belongs in a UNION branch.
	 *
	 * A row that reads a table belongs only to that table's branch. A row that
	 * reads nothing - a constant like `'Limits'`, or a business key label - belongs
	 * in every branch, so the branches line up. "Reads nothing" cannot be decided
	 * from qualified references alone: `unnest(contributordetails)` names its
	 * column unqualified, and copying that into a branch whose table has no such
	 * column breaks the query.
	 */
	inBranch(row: MappingRow, table: string, tables: Set<string>): boolean {
		if (sourceTablesOf(row).includes(table)) return true;
		if (isStringLiteral(row.rule)) return true;
		return (
			!isStraight(row) &&
			sourceTablesOf(row).length === 0 &&
			columnRefs(row.rule, tables).length === 0
		);
	}

	silver(bronze: BronzeTable[]): SilverEntity[] {
		const tables = new Set(bronze.map((b) => b.source));
		const stagingOf = (t: string) => bronze.find((b) => b.source === t);
		const result: SilverEntity[] = [];

		for (const [name, rows] of this.entities) {
			for (const row of rows) this.checkRule(row, tables);

			const conditions = this.conditions.get(name) ?? [];
			const strategy = conditions[0]?.strategy ?? "JOIN";
			const sourceTables = [...new Set(rows.flatMap(sourceTablesOf))];

			let branches: SilverBranch[];
			if (strategy === "UNION") {
				branches = sourceTables.map((table) =>
					this.branch(
						name,
						rows.filter((r) => this.inBranch(r, table, tables)),
						conditions.find((c) => fromTables(c.clause)[0] === table)?.clause ??
							`from ${table}`,
						stagingOf,
						conditions[0]?.cell,
					),
				);
			} else {
				// A Conditions row with an empty join_condition is as good as missing:
				// the clause, not the row, is what decides whether the join happens.
				const written = conditions[0]?.clause?.trim();
				if (sourceTables.length > 1 && !written) {
					this.issue(
						"error",
						name,
						`reads ${sourceTables.join(", ")} but has no join clause${conditions.length > 0 ? " (the Conditions row is blank)" : " (no Conditions row)"} - add the join, only ${sourceTables[0]} is read`,
						conditions[0]?.cell,
					);
				}
				const clause = written || `from ${sourceTables[0] ?? name}`;
				branches = [
					this.branch(name, rows, clause, stagingOf, conditions[0]?.cell),
				];
			}

			// UNION branches must line up column for column: fill each branch's gaps
			// with a typed NULL, in sheet order.
			const columns = this.entityColumns(name, rows);
			for (const b of branches) {
				b.columns = columns.map(
					(c) =>
						b.columns.find((bc) => bc.name === c.name) ?? {
							name: c.name,
							fdlType: c.type,
							expr: `cast(null as ${pgType(c.type)})`,
							cell: "",
						},
				);
			}

			const keyRow = rows.find((r) => r.column === this.options.keyColumn);
			let keyed = keyRow !== undefined;
			if (!keyRow) {
				this.issue(
					"warning",
					name,
					`no ${this.options.keyColumn} column - incremental load inserts instead of upserting`,
				);
			} else if (isStringLiteral(keyRow.rule)) {
				keyed = false;
				this.issue(
					"error",
					name,
					`${this.options.keyColumn} is the constant ${keyRow.rule.trim()} (business_column_name and business_column_value look swapped) - upserting on it would collapse every row into one, so incremental loads insert instead`,
					keyRow.cell,
				);
			}

			const watermark = columns.some(
				(c) => c.name === this.options.watermarkColumn,
			)
				? this.options.watermarkColumn
				: undefined;
			if (!watermark) {
				this.issue(
					"warning",
					name,
					`no ${this.options.watermarkColumn} column - incremental silver job not generated`,
				);
			}

			const arrays = new Set(
				rows.flatMap((r) =>
					[...r.rule.matchAll(/unnest\s*\(\s*([A-Za-z0-9_.]+)\s*\)/gi)].map(
						(m) => m[1]?.toLowerCase(),
					),
				),
			);
			if (arrays.size > 1) {
				this.issue(
					"info",
					name,
					`unnests ${arrays.size} different arrays (${[...arrays].join(", ")}) in one SELECT - Postgres zips them element by element, it does not cross-join them`,
				);
			}

			result.push({ name, strategy, branches, columns, keyed, watermark });
		}

		return result;
	}

	entityColumns(entity: string, rows: MappingRow[]): Column[] {
		const columns: Column[] = [];
		for (const row of rows) {
			const existing = columns.find((c) => c.name === row.column);
			if (!existing) {
				columns.push({ name: row.column, type: row.fdlType || "text" });
			} else if (existing.type !== row.fdlType) {
				this.issue(
					"warning",
					entity,
					`${row.column} is mapped more than once with different types (${existing.type} / ${row.fdlType}) - using ${existing.type}`,
					row.cell,
				);
			}
		}
		return columns;
	}

	branch(
		entity: string,
		rows: MappingRow[],
		clause: string,
		stagingOf: (t: string) => BronzeTable | undefined,
		conditionCell: string | undefined,
	): SilverBranch {
		const { quote } = this.options.target;
		const from = rewriteFromClause(clause, (t) => stagingOf(t)?.staging, quote);

		if (hasCommaJoin(clause)) {
			// Only a table following FROM or JOIN is pointed at staging, so the rest
			// of a comma list would still name the source database.
			this.issue(
				"error",
				entity,
				"FROM clause lists tables separated by commas - write them as explicit JOINs so they can be read from staging",
				conditionCell,
			);
		}

		for (const t of from.unknown) {
			this.issue(
				"error",
				entity,
				`FROM clause names '${t}', which no mapping row reads - it has no staging table`,
				conditionCell,
			);
		}

		// A rule is written against the source table name; the clause may have
		// aliased it. Resolve source -> alias (quoted only if it needs to be).
		const asWritten = (name: string) => {
			const alias = from.aliases.get(name);
			return alias === undefined ? undefined : quote(alias);
		};
		const columns: SilverColumn[] = [];

		for (const row of rows) {
			if (columns.some((c) => c.name === row.column)) {
				// Mapped twice for the same branch: keep the first, as the sheet reads.
				if (rows.filter((r) => r.column === row.column).length > 1) {
					this.issue(
						"warning",
						entity,
						`${row.column} has more than one row - the first is used`,
						row.cell,
					);
				}
				continue;
			}

			let expr: string;
			if (isStraight(row)) {
				const table = sourceTablesOf(row)[0] ?? "";
				const alias = from.aliases.get(table);
				if (!alias) {
					this.issue(
						"error",
						entity,
						`${row.column}: source table ${table} is not in the FROM clause`,
						row.cell,
					);
				}
				expr = straightExpr(
					`${quote(alias ?? table)}.${quote(row.sourceColumn.toLowerCase())}`,
					row.sourceType,
					row.fdlType,
				);
			} else {
				expr = ruleExpr(
					rewriteQualifiers(row.rule.trim(), asWritten),
					row.fdlType,
				);
			}

			columns.push({
				name: row.column,
				fdlType: row.fdlType,
				expr,
				cell: row.cell,
			});
		}

		const watermarks = [...from.aliases].flatMap(([table, alias]) => {
			const column = stagingOf(table)?.watermark;
			return column ? [{ alias: quote(alias), column }] : [];
		});

		const reads = [...from.aliases.keys()].flatMap((t) => {
			const staging = stagingOf(t)?.staging;
			return staging ? [staging] : [];
		});

		return { from: from.sql, reads, columns, watermarks };
	}
}

export function buildPlan(spec: MappingSpec, options: PlanOptions): Plan {
	const planner = new Planner(spec, options);
	planner.collectPhysical();
	const bronze = planner.bronze();
	const silver = planner.silver(bronze);

	for (const s of spec.skipped) {
		planner.issue("warning", "workbook", s.reason, s.cell);
	}

	return { spec, bronze, silver, issues: planner.issues };
}
