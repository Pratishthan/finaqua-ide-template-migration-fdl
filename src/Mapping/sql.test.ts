import assert from "node:assert/strict";
import { test } from "node:test";
import { dialect } from "@/Mapping/dialect.js";
import {
	columnRefs,
	fromTables,
	hasWhere,
	isStringLiteral,
	quoteQualifiers,
	rewriteFromClause,
} from "@/Mapping/sql.js";

const pg = dialect("postgres");
const staging = (t: string) => `s_${t}`;

test("a FROM clause is pointed at staging, keeping source names as aliases", () => {
	const r = rewriteFromClause(
		"from limit left outer join basel on basel.limitid = limit.limitid",
		staging,
		pg.quote,
	);
	assert.equal(
		r.sql,
		'from s_limit as "limit" left outer join s_basel as basel on basel.limitid = "limit".limitid',
	);
	assert.deepEqual(
		[...r.aliases],
		[
			["limit", "limit"],
			["basel", "basel"],
		],
	);
});

test("an existing alias is kept rather than replaced", () => {
	const r = rewriteFromClause(
		"from temporarylimit t left join parentlimitdetail as p on t.id = p.limitid",
		staging,
		pg.quote,
	);
	assert.equal(
		r.sql,
		"from s_temporarylimit t left join s_parentlimitdetail as p on t.id = p.limitid",
	);
	assert.equal(r.aliases.get("temporarylimit"), "t");
});

test("a table no mapping row reads is reported, not invented", () => {
	const r = rewriteFromClause(
		"from limit join mystery on mystery.id = limit.id",
		(t) => (t === "limit" ? "s_limit" : undefined),
		pg.quote,
	);
	assert.deepEqual(r.unknown, ["mystery"]);
});

test("string literals are never rewritten", () => {
	// The business key label mentions `limit.` inside a string - that is data.
	const sql = quoteQualifiers(
		"'limit.x' || limit.limitid",
		new Set(["limit"]),
		pg.quote,
	);
	assert.equal(sql, `'limit.x' || "limit".limitid`);
});

test("column references are found only for known tables", () => {
	const refs = columnRefs(
		"limit.bankentityid||'.'||limit.limitid||'.'||other.x",
		new Set(["limit"]),
	);
	assert.deepEqual(refs, [
		{ table: "limit", column: "bankentityid" },
		{ table: "limit", column: "limitid" },
	]);
});

test("helpers: literals, FROM tables, top-level WHERE", () => {
	assert.equal(isStringLiteral(" 'Limits' "), true);
	assert.equal(isStringLiteral("deal.bankentityid||'.'"), false);
	assert.deepEqual(
		fromTables("from checklistitem LEFT OUTER JOIN checklist ON x = y"),
		["checklistitem", "checklist"],
	);
	assert.equal(hasWhere("from a where a.x = 1"), true);
	assert.equal(
		hasWhere("from a join (select * from b where y) c on true"),
		false,
	);
});

test("reserved words are quoted per dialect, others left alone", () => {
	assert.equal(pg.quote("limit"), '"limit"');
	assert.equal(pg.quote("freeze"), '"freeze"');
	assert.equal(pg.quote("basel"), "basel");
	assert.equal(dialect("oracle").quote("limit"), '"LIMIT"');
	assert.equal(dialect("mysql").quote("limit"), "`limit`");
	assert.equal(dialect("mssql").concat(["a", "b"]), "CONCAT(a, b)");
});
