/**
 * The database types a job can read from or write to.
 *
 * Which dialect a piece of SQL uses depends on where it runs:
 *
 *   bronze source view      -> source database   (source dialect)
 *   bronze source count     -> source database   (source dialect)
 *   silver query, counts    -> target database   (target dialect; staging lives there)
 *
 * The workbook's transformation rules are Postgres (`->>`, `unnest`, `::jsonb`)
 * and only ever run in the silver query, so a non-Postgres *source* is fully
 * supported while a non-Postgres *target* is reported - the rules would need
 * translating first.
 */

export type DbType = "postgres" | "oracle" | "mysql" | "mssql";

export const DB_TYPES: readonly DbType[] = [
	"postgres",
	"oracle",
	"mysql",
	"mssql",
];

export type Dialect = {
	type: DbType;
	driver: string;
	/** JDBC URL shape, for the connections file a deployer fills in. */
	urlTemplate: string;
	/** Quotes an identifier only when it has to be (reserved word). */
	quote: (ident: string) => string;
	/** String concatenation of already-rendered SQL expressions. */
	concat: (parts: string[]) => string;
};

/** Words that must be quoted as identifiers: Postgres's reserved and
 * type/function-name keywords (`pg_get_keywords()` catcode R and T - `limit`
 * and `freeze` are both column/table names in the mapping), plus the common
 * Oracle/MySQL/SQL Server reserved words. Quoting a word that did not need it
 * is harmless; missing one is a syntax error. */
const RESERVED = new Set([
	"access",
	"all",
	"analyse",
	"analyze",
	"and",
	"any",
	"array",
	"as",
	"asc",
	"asymmetric",
	"audit",
	"authorization",
	"binary",
	"both",
	"case",
	"cast",
	"check",
	"collate",
	"collation",
	"column",
	"comment",
	"concurrently",
	"constraint",
	"create",
	"cross",
	"current_catalog",
	"current_date",
	"current_role",
	"current_schema",
	"current_time",
	"current_timestamp",
	"current_user",
	"date",
	"default",
	"deferrable",
	"desc",
	"distinct",
	"do",
	"else",
	"end",
	"except",
	"false",
	"fetch",
	"file",
	"for",
	"foreign",
	"freeze",
	"from",
	"full",
	"grant",
	"group",
	"having",
	"ilike",
	"in",
	"index",
	"initially",
	"inner",
	"intersect",
	"into",
	"is",
	"isnull",
	"join",
	"key",
	"lateral",
	"leading",
	"left",
	"level",
	"like",
	"limit",
	"localtime",
	"localtimestamp",
	"mode",
	"natural",
	"not",
	"notnull",
	"null",
	"number",
	"offset",
	"on",
	"only",
	"or",
	"order",
	"outer",
	"overlaps",
	"placing",
	"primary",
	"range",
	"rank",
	"references",
	"resource",
	"returning",
	"right",
	"row",
	"rows",
	"select",
	"session",
	"session_user",
	"share",
	"similar",
	"size",
	"some",
	"start",
	"successful",
	"symmetric",
	"sysdate",
	"table",
	"tablesample",
	"then",
	"to",
	"trailing",
	"true",
	"uid",
	"union",
	"unique",
	"user",
	"using",
	"validate",
	"variadic",
	"verbose",
	"when",
	"where",
	"window",
	"with",
]);

function quoter(open: string, close: string, upper = false) {
	return (ident: string) => {
		if (!RESERVED.has(ident.toLowerCase())) return ident;
		return `${open}${upper ? ident.toUpperCase() : ident}${close}`;
	};
}

const pipes = (parts: string[]) => parts.join(" || ");
const concatFn = (parts: string[]) => `CONCAT(${parts.join(", ")})`;

const DIALECTS: Record<DbType, Dialect> = {
	postgres: {
		type: "postgres",
		driver: "org.postgresql.Driver",
		// stringtype=unspecified lets the JDBC writer send jsonb and array columns
		// as text and have Postgres cast them on insert.
		urlTemplate:
			"jdbc:postgresql://<host>:5432/<database>?stringtype=unspecified",
		quote: quoter('"', '"'),
		concat: pipes,
	},
	oracle: {
		type: "oracle",
		driver: "oracle.jdbc.OracleDriver",
		urlTemplate: "jdbc:oracle:thin:@//<host>:1521/<service>",
		// Oracle folds unquoted names to upper case, so a quoted name must be too.
		quote: quoter('"', '"', true),
		concat: pipes,
	},
	mysql: {
		type: "mysql",
		driver: "com.mysql.cj.jdbc.Driver",
		urlTemplate: "jdbc:mysql://<host>:3306/<database>",
		quote: quoter("`", "`"),
		concat: concatFn,
	},
	mssql: {
		type: "mssql",
		driver: "com.microsoft.sqlserver.jdbc.SQLServerDriver",
		urlTemplate: "jdbc:sqlserver://<host>:1433;databaseName=<database>",
		quote: quoter("[", "]"),
		concat: concatFn,
	},
};

export function dialect(type: DbType): Dialect {
	return DIALECTS[type];
}

export function parseDbType(value: string): DbType {
	const v = value.toLowerCase();
	const alias: Record<string, DbType> = {
		postgresql: "postgres",
		pg: "postgres",
		sqlserver: "mssql",
	};
	const type = alias[v] ?? v;
	if (!DB_TYPES.includes(type as DbType)) {
		throw new Error(
			`unknown database type '${value}' - expected one of ${DB_TYPES.join(", ")}`,
		);
	}
	return type as DbType;
}
