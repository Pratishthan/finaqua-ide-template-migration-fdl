import type ExcelJS from "exceljs";
import { byHeader, normalizeHeader, readHeader } from "@/Mapping/cells.js";
import { DEFAULT_LAYOUT, type SheetLayout } from "@/Mapping/layout.js";
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

function requireColumns(
	header: Record<string, number>,
	labels: string[],
	where: { file: string; sheet: string },
): void {
	for (const label of labels) {
		if (!(normalizeHeader(label) in header)) {
			throw new Error(
				`${where.file}: ${where.sheet} is missing the '${label}' column (set it in the sheet layout if it is named differently)`,
			);
		}
	}
}

function cellRef(ws: ExcelJS.Worksheet, row: number): string {
	return `${ws.name.trim()}!A${row}`;
}

export function parseMappingWorkbook(
	workbook: ExcelJS.Workbook,
	sourceFile: string,
	layout: SheetLayout = DEFAULT_LAYOUT,
): MappingSpec {
	const spec: MappingSpec = {
		sourceFile,
		rows: [],
		conditions: [],
		skipped: [],
	};

	const { sheet: mappingName, columns: col } = layout.dataMapping;
	const mapping = sheet(workbook, mappingName);
	if (!mapping) {
		throw new Error(`${sourceFile}: no ${mappingName} tab`);
	}

	const header = readHeader(mapping.getRow(1));
	// Every column feeds the jobs: an unread one is blank on every row, which
	// for source_column_name silently empties the staging projections.
	requireColumns(header, Object.values(col), {
		file: sourceFile,
		sheet: mappingName,
	});

	mapping.eachRow((row, n) => {
		if (n === 1) return;

		const get = (name: string) => byHeader(row, header, name);
		const entity = get(col.entity).toLowerCase();
		const column = get(col.column).toLowerCase();
		const cell = cellRef(mapping, n);

		if (!entity && !column) return;
		if (!entity || !column) {
			spec.skipped.push({ cell, reason: "entity or column name is blank" });
			return;
		}

		const rule = get(col.rule);
		if (!rule) {
			spec.skipped.push({ cell, reason: `${entity}.${column} has no rule` });
			return;
		}

		spec.rows.push({
			entity,
			column,
			fdlType: get(col.fdlType).toLowerCase(),
			sourceEntity: get(col.sourceEntity).toLowerCase(),
			sourceColumn: get(col.sourceColumn),
			sourceType: get(col.sourceType).toLowerCase(),
			rule,
			cell,
		});
	});

	// The Conditions tab is optional, but one the layout names explicitly must
	// exist: a typo there would otherwise drop every join and union unnoticed.
	const conditionsName = layout.conditions.sheet;
	const conditions = sheet(workbook, conditionsName);
	if (conditions) {
		spec.conditions = parseConditions(conditions, spec, layout.conditions);
	} else if (conditionsName !== DEFAULT_LAYOUT.conditions.sheet) {
		throw new Error(`${sourceFile}: no ${conditionsName} tab`);
	}

	return spec;
}

function parseConditions(
	ws: ExcelJS.Worksheet,
	spec: MappingSpec,
	{ sheet: name, columns: col }: SheetLayout["conditions"],
): Condition[] {
	const header = readHeader(ws.getRow(1));
	const found: Condition[] = [];

	// A renamed or missing header would otherwise read as an empty clause for
	// every entity, quietly dropping every join in the workbook.
	requireColumns(header, [col.entity, col.clause, col.strategy], {
		file: spec.sourceFile,
		sheet: name,
	});

	ws.eachRow((row, n) => {
		if (n === 1) return;

		const entity = byHeader(row, header, col.entity).toLowerCase();
		const clause = byHeader(row, header, col.clause);
		const rawStrategy = byHeader(row, header, col.strategy).toUpperCase();
		const cell = cellRef(ws, n);

		if (!entity) return;

		const strategy: QueryStrategy | undefined =
			rawStrategy === "JOIN" || rawStrategy === "UNION"
				? rawStrategy
				: undefined;

		if (!strategy) {
			spec.skipped.push({
				cell,
				reason: `${entity}: ${col.strategy} '${rawStrategy}' is not JOIN or UNION`,
			});
			return;
		}

		found.push({ entity, clause, strategy, cell });
	});

	return found;
}
