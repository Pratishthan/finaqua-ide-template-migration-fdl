import fs from "node:fs";

/** Where the parser finds things in the workbook: the tab names and the header
 * label of each field. Labels are matched like any header - trimmed,
 * case-insensitive, spacing ignored - so only a real rename needs an entry. */
export type SheetLayout = {
	dataMapping: {
		sheet: string;
		columns: {
			entity: string;
			column: string;
			fdlType: string;
			sourceEntity: string;
			sourceColumn: string;
			sourceType: string;
			rule: string;
		};
	};
	conditions: {
		sheet: string;
		columns: {
			entity: string;
			clause: string;
			strategy: string;
		};
	};
};

/** Matches the reference workbook. Workbooks laid out
 * differently, like Limits with its fdl_-prefixed headers, pass a layout
 * file (see `layouts/`). */
export const DEFAULT_LAYOUT: SheetLayout = {
	dataMapping: {
		sheet: "DataMapping",
		columns: {
			entity: "entity_name",
			column: "column_name",
			fdlType: "data_type",
			sourceEntity: "source_entity_name",
			sourceColumn: "source_column_name",
			sourceType: "source_data_type",
			rule: "transformation_rule",
		},
	},
	conditions: {
		sheet: "Conditions",
		columns: {
			entity: "entity_name",
			clause: "join_condition",
			strategy: "query_strategy",
		},
	},
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Overlays `override` on `base`, key by key. An unknown key or a non-string
 * label is an error: a typo would otherwise fall back to the default label and
 * the override would silently do nothing. */
function merge<T extends Json>(base: T, override: unknown, where: string): T {
	if (!isObject(override)) {
		throw new Error(`${where} must be an object`);
	}

	const out: Json = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const path = `${where}.${key}`;
		if (!Object.hasOwn(base, key)) {
			throw new Error(
				`${path} is not a layout key (expected one of: ${Object.keys(base).join(", ")})`,
			);
		}

		const current = base[key];
		if (isObject(current)) {
			out[key] = merge(current, value, path);
		} else if (typeof value === "string" && value.trim()) {
			out[key] = value;
		} else {
			throw new Error(`${path} must be a non-empty string`);
		}
	}

	return out as T;
}

/** Reads a layout JSON file, which may override any subset of the defaults,
 * e.g. `{ "dataMapping": { "columns": { "rule": "Transformation Logic" } } }`. */
export function loadLayout(file?: string): SheetLayout {
	if (!file) return DEFAULT_LAYOUT;

	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`cannot read layout ${file}: ${reason}`);
	}

	return merge(DEFAULT_LAYOUT, raw, "layout");
}
