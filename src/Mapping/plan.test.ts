import assert from "node:assert/strict";
import { test } from "node:test";
import { dialect } from "@/Mapping/dialect.js";
import { bronzeJob, silverBody, silverJob } from "@/Mapping/finaqua.js";
import { buildPlan, DEFAULT_PLAN_OPTIONS } from "@/Mapping/plan.js";
import type { Condition, MappingRow, MappingSpec } from "@/Mapping/types.js";

const pg = dialect("postgres");
const options = { ...DEFAULT_PLAN_OPTIONS, target: pg };
const jobOptions = { batchName: "limits", source: pg, target: pg };

let line = 1;
function row(
	entity: string,
	column: string,
	fdlType: string,
	sourceEntity: string,
	sourceColumn: string,
	sourceType: string,
	rule = "##STRAIGHTMOVE",
): MappingRow {
	line++;
	return {
		entity,
		column,
		fdlType,
		sourceEntity,
		sourceColumn,
		sourceType,
		rule,
		cell: `DataMapping!A${line}`,
	};
}

function spec(rows: MappingRow[], conditions: Condition[] = []): MappingSpec {
	return { sourceFile: "test.xlsx", rows, conditions, skipped: [] };
}

/** limit_master: two tables joined, a JSONB amount, a key and a watermark. */
const limitMaster = [
	row(
		"limit_master",
		"business_column_name",
		"text",
		"limit",
		"na",
		"##NA",
		"'bank_identification.limit_identification'",
	),
	row(
		"limit_master",
		"business_column_value",
		"text",
		"limit",
		"limitid,bankentityid",
		"##NA",
		"limit.bankentityid||'.'||limit.limitid",
	),
	row(
		"limit_master",
		"source_system",
		"text",
		"limit",
		"na",
		"##NA",
		"'Limits'",
	),
	row(
		"limit_master",
		"bank_identification",
		"varchar(8)",
		"limit",
		"bankentityid",
		"text",
	),
	row(
		"limit_master",
		"limit_identification",
		"varchar(50)",
		"limit",
		"limitid",
		"varchar(50)",
	),
	row(
		"limit_master",
		"approved_limit",
		"numeric(10,2)",
		"limit",
		"approvedlimit",
		"jsonb",
		"limit.approvedlimit ->> 'value'",
	),
	row(
		"limit_master",
		"record_active_flag",
		"char(1)",
		"limit",
		"_isdeleted",
		"bool",
	),
	row(
		"limit_master",
		"data_persistance_time",
		"timestamp",
		"limit",
		"_modifiedon",
		"timestamptz",
	),
	row(
		"limit_master",
		"fund_exposure",
		"numeric",
		"limitbalance",
		"fundexposure",
		"numeric",
	),
];
const limitJoin: Condition = {
	entity: "limit_master",
	clause:
		"from limit left outer join limitbalance on limitbalance.limitid = limit.limitid",
	strategy: "JOIN",
	cell: "Conditions!A2",
};

test("a JOIN entity reads staging under the source names, reserved words quoted", () => {
	const plan = buildPlan(spec(limitMaster, [limitJoin]), options);
	const entity = plan.silver.find((s) => s.name === "limit_master");
	assert.ok(entity);

	const sql = silverBody(entity, "full", pg);
	assert.match(
		sql,
		/from s_limit as "limit" left outer join s_limitbalance as limitbalance on limitbalance\.limitid = "limit"\.limitid/,
	);
	assert.match(
		sql,
		/"limit"\.bankentityid\|\|'\.'\|\|"limit"\.limitid as business_column_value/,
	);
	// JSON text into a numeric column is cast; a bool into char(1) becomes Y/N.
	assert.match(
		sql,
		/cast\(\("limit"\.approvedlimit ->> 'value'\) as numeric\(10,2\)\) as approved_limit/,
	);
	assert.match(
		sql,
		/case when "limit"\._isdeleted then 'Y' when not "limit"\._isdeleted then 'N' end as record_active_flag/,
	);
});

test("staging gets every column the silver query needs, join keys included", () => {
	const plan = buildPlan(spec(limitMaster, [limitJoin]), options);
	const limit = plan.bronze.find((b) => b.source === "limit");
	const balance = plan.bronze.find((b) => b.source === "limitbalance");

	assert.deepEqual(
		limit?.columns.map((c) => c.name),
		["bankentityid", "limitid", "approvedlimit", "_isdeleted", "_modifiedon"],
	);
	assert.deepEqual(limit?.key, ["bankentityid", "limitid"]);
	assert.equal(limit?.watermark, "_modifiedon");
	// limitid only appears in the join - it still has to be staged.
	assert.ok(balance?.columns.some((c) => c.name === "limitid"));
	// No mapped change time: follows the one convention every other table uses.
	assert.equal(balance?.watermark, "_modifiedon");
});

test("incremental silver picks up a change in any joined table", () => {
	const plan = buildPlan(spec(limitMaster, [limitJoin]), options);
	const entity = plan.silver[0];
	assert.ok(entity);

	const sql = silverBody(entity, "incremental", pg);
	assert.match(
		sql,
		/where \("limit"\._modifiedon > \(select coalesce\(max\(max_data_persistance_time\), timestamp '1900-01-01'\) from audit_log_detail where target_table_name = 'limit_master'\) or limitbalance\._modifiedon > /,
	);

	const job = silverJob(entity, "incremental", jobOptions);
	const writer = job.srcevents[0]?.procedure.execplan[0]?.actions[0]?.params;
	assert.equal(writer?.action, "upsert");
	assert.deepEqual(writer?.key, ["business_column_value"]);
	assert.equal(
		silverJob(entity, "full", jobOptions).srcevents[0]?.procedure.execplan[0]
			?.actions[0]?.params.action,
		"insert",
	);
});

test("the audit counts what this batch run wrote, against the same query", () => {
	const plan = buildPlan(spec(limitMaster, [limitJoin]), options);
	const entity = plan.silver[0];
	assert.ok(entity);

	const audit = silverJob(entity, "full", jobOptions).srcevents[0]?.procedure
		.execplan[1]?.steps[0]?.sql;
	const [source, target] = audit?.views ?? [];
	assert.equal(
		source?.params.query,
		`select count(*) as source_row_count from (${silverBody(entity, "full", pg)}) as q`,
	);
	assert.match(
		target?.params.query ?? "",
		/from limit_master where batch_run_id = \(select batch_run_id from batch_run_detail where batch_name = 'limits' and status = 'running'\)/,
	);
});

test("bronze pushes the incremental filter to the source and builds the key there", () => {
	const plan = buildPlan(spec(limitMaster, [limitJoin]), options);
	const limit = plan.bronze.find((b) => b.source === "limit");
	assert.ok(limit);

	const job = bronzeJob(limit, "incremental", jobOptions);
	const view = job.source.views[1] as {
		name: string;
		params: { query: string };
	};
	assert.equal(view.name, "limit_src");
	assert.equal(
		view.params.query,
		`select bankentityid, limitid, approvedlimit, _isdeleted, _modifiedon, 'bankentityid ~ limitid' as business_column_name, bankentityid || '~' || limitid as business_column_value from "limit" where _modifiedon > '\${#get(params,'jdbcPartitionColumnLowerBound#limit')}'`,
	);

	const oracle = bronzeJob(limit, "full", {
		...jobOptions,
		source: dialect("mysql"),
	});
	const mysqlView = oracle.source.views[1] as { params: { query: string } };
	assert.match(
		mysqlView.params.query,
		/CONCAT\(bankentityid, '~', limitid\) as business_column_value from `limit`$/,
	);
});

test("a UNION entity lines its branches up, filling gaps with typed NULLs", () => {
	const rows = [
		row(
			"lien",
			"business_column_value",
			"text",
			"lien",
			"id",
			"##NA",
			"lien.id",
		),
		row("lien", "source_system", "text", "na", "na", "##NA", "'Limits'"),
		row("lien", "amount", "numeric", "lien", "amt", "numeric"),
		row(
			"lien",
			"data_persistance_time",
			"timestamp",
			"lien",
			"_modifiedon",
			"timestamptz",
		),
		row(
			"lien",
			"business_column_value",
			"text",
			"lienhistory",
			"id",
			"##NA",
			"lienhistory.id",
		),
		row("lien", "serial_number", "text", "lienhistory", "srlnum", "text"),
		row(
			"lien",
			"data_persistance_time",
			"timestamp",
			"lienhistory",
			"_modifiedon",
			"timestamptz",
		),
	];
	const plan = buildPlan(
		spec(rows, [
			{ entity: "lien", clause: "", strategy: "UNION", cell: "Conditions!A9" },
		]),
		options,
	);
	const entity = plan.silver[0];
	assert.ok(entity);
	assert.equal(entity.branches.length, 2);

	const sql = silverBody(entity, "full", pg);
	assert.equal(
		sql,
		"select lien.id as business_column_value, 'Limits' as source_system, lien.amt as amount, lien._modifiedon as data_persistance_time, cast(null as text) as serial_number from s_lien as lien" +
			" union " +
			"select lienhistory.id as business_column_value, 'Limits' as source_system, cast(null as numeric) as amount, lienhistory._modifiedon as data_persistance_time, lienhistory.srlnum as serial_number from s_lienhistory as lienhistory",
	);
});

test("sheet defects are reported against their cell, never silently fixed", () => {
	const rows = [
		row(
			"ccfa",
			"business_column_name",
			"text",
			"report",
			"customerid,reportid",
			"##NA",
			"report.customerid||'.'||report.reportid",
		),
		row(
			"ccfa",
			"business_column_value",
			"text",
			"report",
			"na",
			"##NA",
			"'customer.report'",
		),
		row("ccfa", "customer_id", "text", "report", "customerid", "text"),
		row("ccfa", "reportid", "text", "report", "reportid", "text"),
		row("ccfa", "exposure", "timestamp", "report", "exposure", "numeric"),
		row(
			"ccfa",
			"category",
			"text",
			"report",
			"details",
			"jsonb",
			"report.categorytype || (unnest(report.details)::jsonb ->> 'x')",
		),
	];
	const plan = buildPlan(spec(rows), options);
	const messages = plan.issues.map(
		(i) => `${i.level} ${i.cell ?? ""} ${i.message}`,
	);

	// A constant key would collapse every row into one on upsert.
	assert.ok(
		messages.some((m) =>
			/^error DataMapping!A\d+ business_column_value is the constant/.test(m),
		),
	);
	assert.equal(plan.silver[0]?.keyed, false);
	assert.ok(
		messages.some((m) =>
			/^error .* exposure: straight move of numeric into timestamp/.test(m),
		),
	);
	assert.ok(
		messages.some((m) =>
			/^error .* report\.categorytype, which is not a column/.test(m),
		),
	);
	// unnest() on a jsonb column: staged as an array, flagged once.
	assert.equal(
		plan.bronze[0]?.columns.find((c) => c.name === "details")?.type,
		"_jsonb",
	);
	assert.ok(
		messages.some((m) =>
			/report\.details is typed 'jsonb' but the rules unnest\(\) it/.test(m),
		),
	);
});

test("writer params match what the runtime does with them", () => {
	const plan = buildPlan(spec(limitMaster, [limitJoin]), options);
	const entity = plan.silver[0];
	const limit = plan.bronze.find((b) => b.source === "limit");
	assert.ok(entity && limit);

	const writer = (j: ReturnType<typeof silverJob>) =>
		j.srcevents[0]?.procedure.execplan[0]?.actions[0]?.params;

	// ts guards an upsert: PostgresJdbcWriter appends
	// `where <table>.<ts> < excluded.<ts>`, so a late extract cannot regress a
	// staged row. Staging is always one table, so the guard always applies there.
	assert.deepEqual(writer(bronzeJob(limit, "incremental", jobOptions))?.ts, [
		"_modifiedon",
	]);
	// A full load inserts, where the runtime ignores ts.
	assert.deepEqual(writer(silverJob(entity, "full", jobOptions))?.ts, []);

	// jsonb fields are bound as `? ::jsonb`; arrays have no writer type.
	const fields = writer(bronzeJob(limit, "full", jobOptions))?.fields ?? [];
	const typeOf = (name: string) =>
		fields.find((f: { name: string }) => f.name === name)?.type;
	assert.equal(typeOf("approvedlimit"), "jsonb");
	assert.equal(typeOf("_isdeleted"), "boolean");
	assert.equal(typeOf("_modifiedon"), "time");
});

test("a view names its table and leaves partitioning to the deployment", () => {
	const plan = buildPlan(spec(limitMaster, [limitJoin]), options);
	const limit = plan.bronze.find((b) => b.source === "limit");
	assert.ok(limit);

	const view = bronzeJob(limit, "full", jobOptions).source.views[1] as {
		params: Record<string, unknown>;
	};
	// JDBCReader reads partition run-args as jdbcPartitionColumn#<table>.
	assert.equal(view.params.table, "limit");
	// A literal "partitionColumn" is not empty, so the reader would take the
	// partitioned path and fail on the missing bounds - leave both out.
	assert.equal("partitionColumn" in view.params, false);
	assert.equal("numPartitions" in view.params, false);
});

test("the ts guard is left off a join, where it would drop a joined-table change", () => {
	// limit_master reads limit + limitbalance in one branch. Its
	// data_persistance_time comes from limit, so guarding on it would discard a
	// refresh triggered by limitbalance alone.
	const joined = buildPlan(spec(limitMaster, [limitJoin]), options).silver[0];
	assert.ok(joined);
	assert.deepEqual(
		silverJob(joined, "incremental", jobOptions).srcevents[0]?.procedure
			.execplan[0]?.actions[0]?.params.ts,
		[],
	);

	// A single-source entity keeps the guard: row and watermark agree.
	const single = buildPlan(
		spec(limitMaster.filter((r) => r.sourceEntity === "limit")),
		options,
	).silver[0];
	assert.ok(single);
	assert.deepEqual(
		silverJob(single, "incremental", jobOptions).srcevents[0]?.procedure
			.execplan[0]?.actions[0]?.params.ts,
		["data_persistance_time"],
	);
});

test("an aliased join clause carries through to the rules and to staging", () => {
	// Rules are written against the source name; the clause may alias it. Both the
	// projection and the staged join column have to follow the alias.
	const plan = buildPlan(
		spec(limitMaster, [
			{
				...limitJoin,
				clause:
					"from limit l left outer join limitbalance b on b.limitid = l.limitid",
			},
		]),
		options,
	);
	const entity = plan.silver[0];
	assert.ok(entity);

	const sql = silverBody(entity, "full", pg);
	assert.match(
		sql,
		/l\.bankentityid\|\|'\.'\|\|l\.limitid as business_column_value/,
	);
	assert.match(
		sql,
		/cast\(\(l\.approvedlimit ->> 'value'\) as numeric\(10,2\)\)/,
	);
	assert.equal(sql.includes('"limit".'), false);
	// b.limitid is only in the join condition, under an alias.
	assert.ok(
		plan.bronze
			.find((b) => b.source === "limitbalance")
			?.columns.some((c) => c.name === "limitid"),
	);
	assert.equal(plan.issues.filter((i) => i.level === "error").length, 0);
});

test("a UNION keeps an unqualified rule in its own branch", () => {
	const rows = [
		row(
			"lien",
			"business_column_value",
			"text",
			"lien",
			"id",
			"##NA",
			"lien.id",
		),
		row("lien", "source_system", "text", "lien", "na", "##NA", "'Limits'"),
		row(
			"lien",
			"category",
			"text",
			"lien",
			"details",
			"jsonb",
			"(unnest(details)::jsonb) ->> 'cat'",
		),
		row(
			"lien",
			"business_column_value",
			"text",
			"lienhistory",
			"id",
			"##NA",
			"lienhistory.id",
		),
		row("lien", "serial_number", "text", "lienhistory", "srlnum", "text"),
	];
	const plan = buildPlan(
		spec(rows, [
			{ entity: "lien", clause: "", strategy: "UNION", cell: "Conditions!A9" },
		]),
		options,
	);
	const branches = plan.silver[0]?.branches ?? [];
	assert.equal(branches.length, 2);

	const expr = (i: number, name: string) =>
		branches[i]?.columns.find((c) => c.name === name)?.expr;
	// unnest(details) names no table, but it is not branch-independent: the
	// history branch has no such column, so it gets a typed NULL.
	assert.match(expr(0, "category") ?? "", /unnest\(details\)/);
	assert.equal(expr(1, "category"), "cast(null as text)");
	// A true constant does belong in both branches.
	assert.equal(expr(0, "source_system"), "'Limits'");
	assert.equal(expr(1, "source_system"), "'Limits'");
});

test("a blank join clause and a comma join are both reported", () => {
	const twoTables = [
		row("e", "a", "text", "limit", "x", "text"),
		row("e", "b", "numeric", "limitbalance", "y", "numeric"),
	];
	const blank = buildPlan(
		spec(twoTables, [
			{ entity: "e", clause: "   ", strategy: "JOIN", cell: "C1" },
		]),
		options,
	);
	assert.ok(
		blank.issues.some(
			(i) =>
				i.level === "error" && /the Conditions row is blank/.test(i.message),
		),
	);

	const comma = buildPlan(
		spec(twoTables, [
			{
				entity: "e",
				clause: "from limit, limitbalance",
				strategy: "JOIN",
				cell: "C2",
			},
		]),
		options,
	);
	assert.ok(
		comma.issues.some(
			(i) => i.level === "error" && /separated by commas/.test(i.message),
		),
	);
});

test("types are matched exactly, so interval is not mistaken for a number", () => {
	const plan = buildPlan(
		spec([
			row("e", "business_column_value", "text", "t", "id", "##NA", "t.id"),
			row("e", "span", "numeric", "t", "span", "interval"),
			row("e", "n", "numeric", "t", "n", "numeric(10,2)"),
		]),
		options,
	);
	// interval -> numeric is a cast that may fail, not a free copy.
	assert.ok(
		plan.issues.some((i) =>
			/straight move of interval into numeric/.test(i.message),
		),
	);
	const entity = plan.silver[0];
	assert.ok(entity);
	assert.match(silverBody(entity, "full", pg), /cast\(t\.span as numeric\)/);
});
