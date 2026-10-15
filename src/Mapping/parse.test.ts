import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import { DEFAULT_LAYOUT, loadLayout } from "@/Mapping/layout.js";
import { parseMappingWorkbook } from "@/Mapping/parse.js";

function writeLayout(json: unknown): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-"));
	const file = path.join(dir, "layout.json");
	fs.writeFileSync(file, JSON.stringify(json));
	return file;
}

function workbook(mappingTab: string, headers: string[]): ExcelJS.Workbook {
	const wb = new ExcelJS.Workbook();
	const ws = wb.addWorksheet(mappingTab);
	ws.addRow(headers);
	ws.addRow(["Limits", "limit_id", "bigint", "t_limit", "id", "int8", "id"]);
	return wb;
}

describe("sheet layout", () => {
	it("defaults to the built-in labels", () => {
		assert.deepEqual(loadLayout(), DEFAULT_LAYOUT);
	});

	it("reads renamed tabs and headers from a partial override", () => {
		const layout = loadLayout(
			writeLayout({
				dataMapping: {
					sheet: "Mapping",
					columns: { entity: "Target Table", rule: "Logic" },
				},
			}),
		);

		assert.equal(layout.dataMapping.columns.column, "column_name");

		const spec = parseMappingWorkbook(
			workbook("Mapping", [
				"Target Table",
				"column_name",
				"data_type",
				"source_entity_name",
				"source_column_name",
				"source_data_type",
				"Logic",
			]),
			"test.xlsx",
			layout,
		);

		assert.equal(spec.rows.length, 1);
		assert.equal(spec.rows[0]?.entity, "limits");
		assert.equal(spec.rows[0]?.rule, "id");
	});

	it("names the configured label when a header is missing", () => {
		const layout = loadLayout(
			writeLayout({ dataMapping: { columns: { rule: "Logic" } } }),
		);
		assert.throws(
			() =>
				parseMappingWorkbook(
					workbook("DataMapping", ["entity_name", "column_name", "Logic"]),
					"test.xlsx",
					layout,
				),
			/DataMapping is missing the 'data_type' column/,
		);
	});

	it("fails when any DataMapping column is missing", () => {
		const headers = Object.values(DEFAULT_LAYOUT.dataMapping.columns);
		for (const missing of headers) {
			assert.throws(
				() =>
					parseMappingWorkbook(
						workbook(
							"DataMapping",
							headers.map((h) => (h === missing ? `${h}_x` : h)),
						),
						"test.xlsx",
					),
				new RegExp(`DataMapping is missing the '${missing}' column`),
			);
		}
	});

	it("fails when a Conditions tab named in the layout is missing", () => {
		const layout = loadLayout(
			writeLayout({ conditions: { sheet: "Condition" } }),
		);
		assert.throws(
			() =>
				parseMappingWorkbook(
					workbook(
						"DataMapping",
						Object.values(DEFAULT_LAYOUT.dataMapping.columns),
					),
					"test.xlsx",
					layout,
				),
			/no Condition tab/,
		);
	});

	it("rejects inherited object keys", () => {
		assert.throws(
			() => loadLayout(writeLayout({ constructor: "x" })),
			/layout\.constructor is not a layout key/,
		);
	});

	it("rejects unknown keys and blank labels", () => {
		assert.throws(
			() => loadLayout(writeLayout({ dataMapping: { columns: { rul: "x" } } })),
			/layout\.dataMapping\.columns\.rul is not a layout key/,
		);
		assert.throws(
			() => loadLayout(writeLayout({ conditions: { sheet: " " } })),
			/layout\.conditions\.sheet must be a non-empty string/,
		);
	});
});
