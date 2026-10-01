/**
 * Just enough SQL lexing to rewrite the workbook's expressions safely.
 *
 * The rules and join clauses are written against the *source* table names
 * (`limit.limitid`), but the silver query reads staging tables (`s_limit`).
 * Rewriting that with a plain regex would also rewrite text inside string
 * literals - `'bank_identification.limit_identification'` is a business key
 * label, not a column reference - so everything here works on tokens.
 */

export type Token =
	| { kind: "word"; text: string }
	| { kind: "string"; text: string }
	| { kind: "quoted"; text: string }
	| { kind: "space"; text: string }
	| { kind: "punct"; text: string };

export function tokenize(sql: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < sql.length) {
		const ch = sql.charAt(i);

		if (ch === "'" || ch === '"') {
			// '' and "" are escaped quotes, not the end of the literal.
			let j = i + 1;
			while (j < sql.length) {
				if (sql[j] === ch) {
					if (sql[j + 1] === ch) j += 2;
					else break;
				} else j++;
			}
			tokens.push({
				kind: ch === "'" ? "string" : "quoted",
				text: sql.slice(i, j + 1),
			});
			i = j + 1;
			continue;
		}

		const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i));
		if (word) {
			tokens.push({ kind: "word", text: word[0] });
			i += word[0].length;
			continue;
		}

		const space = /^\s+/.exec(sql.slice(i));
		if (space) {
			tokens.push({ kind: "space", text: space[0] });
			i += space[0].length;
			continue;
		}

		tokens.push({ kind: "punct", text: ch });
		i++;
	}

	return tokens;
}

export function render(tokens: Token[]): string {
	return tokens.map((t) => t.text).join("");
}

function nextSolid(tokens: Token[], from: number): number {
	let i = from;
	while (i < tokens.length && tokens[i]?.kind === "space") i++;
	return i;
}

/** Name of an identifier token, unquoted and lower-cased; undefined otherwise. */
function identName(token: Token | undefined): string | undefined {
	if (!token) return undefined;
	if (token.kind === "word") return token.text.toLowerCase();
	if (token.kind === "quoted") return token.text.slice(1, -1).toLowerCase();
	return undefined;
}

/** `table.column` references, restricted to the given tables. */
export function columnRefs(
	sql: string,
	tables: ReadonlySet<string>,
): { table: string; column: string }[] {
	const tokens = tokenize(sql);
	const refs: { table: string; column: string }[] = [];

	for (let i = 0; i + 2 < tokens.length; i++) {
		const table = identName(tokens[i]);
		if (!table || !tables.has(table)) continue;
		if (tokens[i + 1]?.text !== ".") continue;
		const column = identName(tokens[i + 2]);
		if (column) refs.push({ table, column });
	}

	return refs;
}

/** Table names that directly follow FROM or JOIN, in order. */
export function fromTables(clause: string): string[] {
	const tokens = tokenize(clause);
	const tables: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const word = identName(tokens[i]);
		if (tokens[i]?.kind !== "word" || (word !== "from" && word !== "join"))
			continue;
		const name = identName(tokens[nextSolid(tokens, i + 1)]);
		if (name) tables.push(name);
	}

	return tables;
}

/** Words that can follow a table name without being its alias. */
const NOT_AN_ALIAS = new Set([
	"on",
	"using",
	"left",
	"right",
	"inner",
	"outer",
	"full",
	"cross",
	"natural",
	"join",
	"where",
	"group",
	"order",
	"having",
	"union",
	"limit",
	"offset",
	"window",
	"lateral",
]);

export type TableRewrite = {
	/** Rewritten SQL. */
	sql: string;
	/** Source table -> the name it is referenced by after the rewrite. */
	aliases: Map<string, string>;
	/** Tables after FROM/JOIN that are not known source tables. */
	unknown: string[];
};

/**
 * Points a FROM clause at the staging tables.
 *
 * `from limit left outer join basel on basel.limitid = limit.limitid` becomes
 * `from s_limit as "limit" left outer join s_basel as basel on basel.limitid =
 * "limit".limitid`. Each staging table keeps its source name as alias, so every
 * `table.column` in the rules keeps working unchanged - only reserved words
 * need quoting, and `limit` is one.
 */
export function rewriteFromClause(
	clause: string,
	staging: (table: string) => string | undefined,
	quote: (ident: string) => string,
): TableRewrite {
	const tokens = tokenize(clause);
	const aliases = new Map<string, string>();
	const unknown: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const word = identName(tokens[i]);
		if (tokens[i]?.kind !== "word" || (word !== "from" && word !== "join"))
			continue;

		const at = nextSolid(tokens, i + 1);
		const table = identName(tokens[at]);
		if (!table) continue; // a sub-select, left as written

		const target = staging(table);
		if (!target) {
			unknown.push(table);
			continue;
		}

		let aliasAt = nextSolid(tokens, at + 1);
		if (identName(tokens[aliasAt]) === "as")
			aliasAt = nextSolid(tokens, aliasAt + 1);
		const alias = identName(tokens[aliasAt]);
		const hasAlias =
			alias !== undefined &&
			!NOT_AN_ALIAS.has(alias) &&
			tokens[aliasAt]?.kind !== "punct";

		if (hasAlias) {
			aliases.set(table, alias);
			tokens[at] = { kind: "word", text: target };
		} else {
			aliases.set(table, table);
			tokens[at] = { kind: "word", text: `${target} as ${quote(table)}` };
		}
	}

	return {
		sql: quoteQualifiers(render(tokens), new Set(aliases.values()), quote),
		aliases,
		unknown,
	};
}

/**
 * Rewrites `name.` qualifiers, outside string literals.
 *
 * `resolve` maps a source table name to the text it should be referenced by -
 * the staging alias, quoted if it needs to be - and returns undefined to leave a
 * qualifier alone. A rule written `limit.limitid` against a clause that aliased
 * the table (`from limit l`) has to become `l.limitid`, or Postgres rejects it
 * with "missing FROM-clause entry".
 */
export function rewriteQualifiers(
	sql: string,
	resolve: (name: string) => string | undefined,
): string {
	const tokens = tokenize(sql);

	for (let i = 0; i + 1 < tokens.length; i++) {
		const token = tokens[i];
		if (token?.kind !== "word" || tokens[i + 1]?.text !== ".") continue;
		// `x.limit.col` - only the leading qualifier is a table.
		if (i > 0 && tokens[i - 1]?.text === ".") continue;
		const replacement = resolve(token.text.toLowerCase());
		if (replacement !== undefined)
			tokens[i] = { kind: "word", text: replacement };
	}

	return render(tokens);
}

/** Quotes `name.` qualifiers for the given names, outside string literals. The
 * quote function decides whether a name actually needs it. */
export function quoteQualifiers(
	sql: string,
	names: ReadonlySet<string>,
	quote: (ident: string) => string,
): string {
	return rewriteQualifiers(sql, (name) =>
		names.has(name) ? quote(name) : undefined,
	);
}

/**
 * Every name a FROM clause makes available, mapped to the source table it reads:
 * `from limit l join basel on …` gives l -> limit and basel -> basel.
 *
 * Join conditions are written against whichever name the clause introduced, so
 * resolving an alias back to its table is what lets a join column be traced to
 * the staging table that must carry it.
 */
export function fromAliases(clause: string): Map<string, string> {
	const tokens = tokenize(clause);
	const aliases = new Map<string, string>();

	for (let i = 0; i < tokens.length; i++) {
		const word = identName(tokens[i]);
		if (tokens[i]?.kind !== "word" || (word !== "from" && word !== "join"))
			continue;

		const at = nextSolid(tokens, i + 1);
		const table = identName(tokens[at]);
		if (!table) continue;

		let aliasAt = nextSolid(tokens, at + 1);
		if (identName(tokens[aliasAt]) === "as")
			aliasAt = nextSolid(tokens, aliasAt + 1);
		const alias = identName(tokens[aliasAt]);
		aliases.set(
			alias !== undefined &&
				!NOT_AN_ALIAS.has(alias) &&
				tokens[aliasAt]?.kind !== "punct"
				? alias
				: table,
			table,
		);
	}

	return aliases;
}

/** True when the FROM clause lists tables by comma rather than by JOIN. Only a
 * table following FROM or JOIN is rewritten onto staging, so a comma list would
 * leave the others pointing at the source database. */
export function hasCommaJoin(clause: string): boolean {
	const tokens = tokenize(clause);
	let depth = 0;

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t?.text === "(") depth++;
		else if (t?.text === ")") depth--;
		else if (t?.text === "," && depth === 0) {
			// A comma inside a function call is already covered by depth; at depth 0
			// in a FROM clause it separates table references.
			return true;
		}
	}

	return false;
}

/** True when the expression is nothing but a string literal, e.g. `'Limits'`. */
export function isStringLiteral(sql: string): boolean {
	const solid = tokenize(sql.trim()).filter((t) => t.kind !== "space");
	return solid.length === 1 && solid[0]?.kind === "string";
}

/** True when the clause already has a top-level WHERE. */
export function hasWhere(sql: string): boolean {
	let depth = 0;
	for (const t of tokenize(sql)) {
		if (t.text === "(") depth++;
		else if (t.text === ")") depth--;
		else if (depth === 0 && identName(t) === "where" && t.kind === "word")
			return true;
	}
	return false;
}

/** Escapes a value for use inside a single-quoted SQL literal. */
export function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
