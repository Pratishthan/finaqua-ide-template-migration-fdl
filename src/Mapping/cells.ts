import type ExcelJS from "exceljs";

/** Flattens every cell shape ExcelJS returns - rich text, hyperlinks, formula
 * results - into a trimmed string. Never returns null so callers can compare
 * directly. */
export function text(value: ExcelJS.CellValue): string {
	if (value === null || value === undefined) return "";

	if (typeof value === "object") {
		if ("richText" in value && Array.isArray(value.richText)) {
			return value.richText
				.map((r) => r.text)
				.join("")
				.trim();
		}
		if ("text" in value && value.text !== undefined) {
			return String(value.text).trim();
		}
		if ("result" in value && value.result !== undefined) {
			return String(value.result).trim();
		}
		// ExcelJS returns a Date for any date-formatted cell - which Excel applies
		// readily to text like "1-2". Returning "" there would blank the cell
		// silently; the ISO date at least shows up in the mapping and the report.
		if (value instanceof Date) return value.toISOString().slice(0, 10);
		return String(value).trim();
	}

	return String(value).trim();
}

/** Normalises a header label so "Column Name", "ColumnName" and "column  name"
 * all match. The workbooks disagree on spacing - FINFADM writes "Table Name"
 * where the others write "Table" - so lookup is always by normalised name. */
export function normalizeHeader(label: string): string {
	return label.toLowerCase().replace(/\s+/g, "");
}

export type HeaderMap = Record<string, number>;

/** Builds a normalised header label -> column number map from a header row. */
export function readHeader(row: ExcelJS.Row): HeaderMap {
	const map: HeaderMap = {};

	row.eachCell((cell, colNumber) => {
		const key = normalizeHeader(text(cell.value));
		if (key && !(key in map)) map[key] = colNumber;
	});

	return map;
}

/** Reads a cell by header name, returning "" when the sheet omits that column. */
export function byHeader(
	row: ExcelJS.Row,
	header: HeaderMap,
	name: string,
): string {
	const col = header[normalizeHeader(name)];
	return col ? text(row.getCell(col).value) : "";
}

/** Cleans a schema or table name, tolerating a stray leading or trailing dot. */
export function cleanIdentifier(raw: string): string {
	return raw
		.trim()
		.replace(/^\.+|\.+$/g, "")
		.trim();
}
