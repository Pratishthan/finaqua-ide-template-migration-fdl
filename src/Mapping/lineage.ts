import { tokenize } from "@/Mapping/sql.js";

/**
 * Which columns feed an expression, for column-level lineage.
 *
 * Adapted from finaqua-ide-template-fdl's FDLSqlLineage extractor, on this
 * repo's tokenizer: the rules here are Postgres SQL (`::`, `->>`, `||`), not
 * Spark SQL. A column read only in a CASE condition (WHEN ... THEN) steers the
 * branch but is never stored, so it is reported as not feeding the target.
 */

export type ColumnInput = {
	/** Table as the expression names it: a FROM alias or a table name. */
	table: string;
	column: string;
	/** False when the column is only read in a CASE condition. */
	feeds: boolean;
};

const ident = (text: string | undefined, kind: string | undefined) =>
	kind === "word"
		? text?.toLowerCase()
		: kind === "quoted"
			? text?.slice(1, -1).toLowerCase()
			: undefined;

/**
 * @param qualifiers the names a column may be qualified with (`retail` in
 *   `retail.cifid`)
 * @param bare the table an unqualified name is a column of, if any. Names are
 *   passed lower-cased, as Postgres folds an unquoted identifier.
 */
export function columnInputs(
	expr: string,
	qualifiers: ReadonlySet<string>,
	bare?: (column: string) => string | undefined,
): ColumnInput[] {
	const tokens = tokenize(expr).filter((t) => t.kind !== "space");
	const results: ColumnInput[] = [];
	const seen = new Map<string, ColumnInput>();
	// One entry per open CASE: true while in its condition.
	const cases: boolean[] = [];

	const record = (table: string, column: string) => {
		const feeds = !cases.some(Boolean);
		const key = `${table}.${column}`;
		const known = seen.get(key);
		// A direct use anywhere means the value does reach the target.
		if (known) known.feeds ||= feeds;
		else {
			const input = { table, column, feeds };
			seen.set(key, input);
			results.push(input);
		}
	};

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		const name = ident(t?.text, t?.kind);
		if (!t || !name) continue;

		if (t.kind === "word") {
			if (name === "case") {
				cases.push(true);
				continue;
			}
			if (name === "when") {
				if (cases.length > 0) cases[cases.length - 1] = true;
				continue;
			}
			if (name === "then" || name === "else") {
				if (cases.length > 0) cases[cases.length - 1] = false;
				continue;
			}
			if (name === "end") {
				cases.pop();
				continue;
			}
			// `as alias`, `cast(x as type)`: the next word is not an input.
			if (name === "as") {
				i++;
				continue;
			}
		}

		const prev = tokens[i - 1]?.text;
		// `x::type` - a type, not a column; `a.b.c` past its first part.
		if (prev === "." || (prev === ":" && tokens[i - 2]?.text === ":")) continue;

		const next = tokens[i + 1]?.text;
		if (next === "(") continue; // a function name

		if (next === ".") {
			const column = ident(tokens[i + 2]?.text, tokens[i + 2]?.kind);
			if (column && qualifiers.has(name)) {
				record(name, column);
				i += 2;
			}
			continue;
		}

		const table = bare?.(name);
		if (table) record(table, name);
	}

	return results;
}
