import type ExcelJS from "exceljs";
import { byHeader, normalizeHeader, readHeader } from "@/Mapping/cells.js";
import type { Condition, MappingSpec, QueryStrategy } from "@/Mapping/types.js";

/** The tabs are found by trimmed, case-insensitive name: the workbook as
 * delivered names the first one " DataMapping", with a leading space. */
function sheet(
	workbook: ExcelJS.Workbook,
	name: string,
): ExcelJS.Worksheet | undefined {
	return workbook.worksheets.find(
		(ws) => normalizeHeader(ws.name) === normalizeHeader(name),
	);
}

function cellRef(ws: ExcelJS.Worksheet, row: number): string {
	return `${ws.name.trim()}!A${row}`;
}

export function parseMappingWorkbook(
	workbook: ExcelJS.Workbook,
	sourceFile: string,
): MappingSpec {
	const spec: MappingSpec = {
		sourceFile,
		rows: [],
		conditions: [],
		skipped: [],
	};

	const mapping = sheet(workbook, "DataMapping");
	if (!mapping) {
		throw new Error(`${sourceFile}: no DataMapping tab`);
	}

	const header = readHeader(mapping.getRow(1));
	for (const required of [
		"fdl_entity_name",
		"fdl_column_name",
		"source_entity_name",
		"transformation_rule",
	]) {
		if (!(normalizeHeader(required) in header)) {
			throw new Error(
				`${sourceFile}: DataMapping is missing the '${required}' column`,
			);
		}
	}

	mapping.eachRow((row, n) => {
		if (n === 1) return;

		const get = (name: string) => byHeader(row, header, name);
		const entity = get("fdl_entity_name").toLowerCase();
		const column = get("fdl_column_name").toLowerCase();
		const cell = cellRef(mapping, n);

		if (!entity && !column) return;
		if (!entity || !column) {
			spec.skipped.push({ cell, reason: "entity or column name is blank" });
			return;
		}

		const rule = get("transformation_rule");
		if (!rule) {
			spec.skipped.push({ cell, reason: `${entity}.${column} has no rule` });
			return;
		}

		spec.rows.push({
			entity,
			column,
			fdlType: get("fdl_data_type").toLowerCase(),
			sourceEntity: get("source_entity_name").toLowerCase(),
			sourceColumn: get("source_column_name"),
			sourceType: get("source_data_type").toLowerCase(),
			rule,
			cell,
		});
	});

	const conditions = sheet(workbook, "Conditions");
	if (conditions) spec.conditions = parseConditions(conditions, spec);

	return spec;
}

function parseConditions(
	ws: ExcelJS.Worksheet,
	spec: MappingSpec,
): Condition[] {
	const header = readHeader(ws.getRow(1));
	const found: Condition[] = [];

	// A renamed or missing header would otherwise read as an empty clause for
	// every entity, quietly dropping every join in the workbook.
	for (const required of [
		"fdl_entity_name",
		"join_condition",
		"query_strategy",
	]) {
		if (!(normalizeHeader(required) in header)) {
			throw new Error(
				`${spec.sourceFile}: Conditions is missing the '${required}' column`,
			);
		}
	}

	ws.eachRow((row, n) => {
		if (n === 1) return;

		const entity = byHeader(row, header, "fdl_entity_name").toLowerCase();
		const clause = byHeader(row, header, "join_condition");
		const rawStrategy = byHeader(row, header, "query_strategy").toUpperCase();
		const cell = cellRef(ws, n);

		if (!entity) return;

		const strategy: QueryStrategy | undefined =
			rawStrategy === "JOIN" || rawStrategy === "UNION"
				? rawStrategy
				: undefined;

		if (!strategy) {
			spec.skipped.push({
				cell,
				reason: `${entity}: query_strategy '${rawStrategy}' is not JOIN or UNION`,
			});
			return;
		}

		found.push({ entity, clause, strategy, cell });
	});

	return found;
}
