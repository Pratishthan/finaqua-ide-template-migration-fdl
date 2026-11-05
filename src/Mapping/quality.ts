import { family } from "@/Mapping/plan.js";
import type {
	EntityAttribute,
	Issue,
	Plan,
	QualityRules,
	SilverEntity,
} from "@/Mapping/types.js";

/**
 * Data quality checks for the silver jobs, from the data model's
 * entity_attributes tab: data_type, data_length and nullable.
 *
 * They are compiled to the JSON schema FinAqua's JsonSchemaValidator evaluates.
 * It sees each row as Spark's `Dataset.toJSON()` wrote it, which leaves NULL
 * columns out - so "not null" has to be `required`; a `type` alone passes a
 * missing column.
 */

/** Only what the writer's formats parse (TIME_FORMAT, DATE_FORMAT). The end is
 * left open: Spark appends fractions and an offset to a timestamp. */
const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}";
const TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}";

type ColumnSchema = {
	type?: string | string[];
	maxLength?: number;
	pattern?: string;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
};

/** The size in `numeric(20,4)` or `varchar(50)`, else the data_length cell. */
function declaredSize(attribute: EntityAttribute): string {
	const inType = attribute.dataType.match(/\(\s*([\d\s,]+?)\s*\)/)?.[1];
	return (inType ?? attribute.dataLength).replace(/\s/g, "");
}

function baseType(type: string): string {
	return type.toLowerCase().replace(/\(.*$/, "").trim();
}

function columnSchema(
	attribute: EntityAttribute,
	report: (message: string) => void,
): ColumnSchema {
	const nullable = (type: string) =>
		attribute.nullable === "N" ? type : [type, "null"];
	const size = declaredSize(attribute);
	const unusableSize = () =>
		report(
			`data_length '${size}' is not usable for ${attribute.dataType} - length not checked`,
		);

	switch (family(attribute.dataType)) {
		case "number": {
			if (
				/^(int|int2|int4|int8|integer|smallint|bigint|serial)$/.test(
					baseType(attribute.dataType),
				)
			) {
				return { type: nullable("integer") };
			}
			if (!size) return { type: nullable("number") };

			const match = size.match(/^(\d+)(?:,(\d+))?$/);
			if (!match) {
				unusableSize();
				return { type: nullable("number") };
			}
			// Digits left of the point only: Postgres rounds excess scale but raises
			// an error on excess precision.
			const limit = 10 ** (Number(match[1]) - Number(match[2] ?? 0));
			return {
				type: nullable("number"),
				exclusiveMinimum: -limit,
				exclusiveMaximum: limit,
			};
		}
		case "date":
			return { type: nullable("string"), pattern: DATE_PATTERN };
		case "timestamp":
			return { type: nullable("string"), pattern: TIMESTAMP_PATTERN };
		case "bool":
			return { type: nullable("boolean") };
		case "text": {
			if (!size) return { type: nullable("string") };
			if (!/^\d+$/.test(size)) {
				unusableSize();
				return { type: nullable("string") };
			}
			return { type: nullable("string"), maxLength: Number(size) };
		}
		default:
			// json and array columns reach the validator as the source wrote them.
			return {};
	}
}

/** `VARCHAR` + `50`, as the mapping sheet would spell it: `varchar(50)`. */
function spelled(attribute: EntityAttribute): string {
	const type = attribute.dataType.toLowerCase().replace(/\s/g, "");
	return attribute.dataLength && !type.includes("(")
		? `${type}(${attribute.dataLength.replace(/\s/g, "")})`
		: type;
}

/** Whether every branch loads a column as a bare NULL (`##NA`, `cast(null ...)`). */
function alwaysNull(entity: SilverEntity, column: string): boolean {
	if (entity.pipeline.some((p) => p.name === column)) return false;
	return entity.branches.every((b) =>
		/^(cast\(\s*)?null\b/i.test(
			b.columns.find((c) => c.name === column)?.expr.trim() ?? "null",
		),
	);
}

function entityRules(
	entity: SilverEntity,
	attributes: Map<string, EntityAttribute>,
	issue: (message: string, cell?: string, level?: Issue["level"]) => void,
): QualityRules {
	const properties: Record<string, ColumnSchema> = {};
	const required: string[] = [];
	const unchecked: string[] = [];

	for (const column of entity.columns) {
		const attribute = attributes.get(column.name);
		if (!attribute) {
			unchecked.push(column.name);
			issue(`${column.name} is not in entity_attributes - not checked`);
			continue;
		}

		const { cell } = attribute;
		if (attribute.nullable === "N") {
			required.push(column.name);
			if (alwaysNull(entity, column.name)) {
				issue(
					`${column.name} is not nullable in entity_attributes but the mapping never fills it - every row of ${entity.name} will be rejected`,
					cell,
					"error",
				);
			}
		} else if (attribute.nullable !== "Y") {
			issue(
				`${column.name}: nullable '${attribute.nullable}' is not Y or N - null not checked`,
				cell,
			);
		}

		properties[column.name] = columnSchema(attribute, (m) =>
			issue(`${column.name}: ${m}`, cell),
		);

		const mapped = column.type.toLowerCase().replace(/\s/g, "");
		if (mapped !== spelled(attribute)) {
			issue(
				`${column.name} is ${column.type} in the mapping but ${spelled(attribute)} in entity_attributes - checked against entity_attributes`,
				cell,
			);
		}
	}

	const loaded = new Set(entity.columns.map((c) => c.name));
	for (const [name, attribute] of attributes) {
		if (!loaded.has(name)) {
			issue(
				`${name} is in entity_attributes${attribute.nullable === "N" ? " as not nullable" : ""} but the mapping does not load it - not checked`,
				attribute.cell,
			);
		}
	}

	return {
		schema: JSON.stringify({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			required,
			properties,
		}),
		columns: Object.keys(properties).length,
		required: required.length,
		unchecked,
	};
}

/** Attaches the checks to every silver entity with attributes. An entity without
 * any gets no validator step, and that is reported rather than assumed. */
export function applyQualityRules(
	plan: Plan,
	attributes: EntityAttribute[],
): Plan {
	const issues: Issue[] = [];
	const byEntity = new Map<string, Map<string, EntityAttribute>>();

	for (const attribute of attributes) {
		const columns = byEntity.get(attribute.entity) ?? new Map();
		if (columns.has(attribute.column)) {
			issues.push({
				level: "warning",
				scope: attribute.entity,
				cell: attribute.cell,
				message: `${attribute.column} is listed twice in entity_attributes - the first row is used`,
			});
		} else {
			columns.set(attribute.column, attribute);
		}
		byEntity.set(attribute.entity, columns);
	}

	const silver = plan.silver.map((entity) => {
		const columns = byEntity.get(entity.name);
		if (!columns) {
			issues.push({
				level: "warning",
				scope: entity.name,
				message: "not in entity_attributes - no data quality checks",
			});
			return entity;
		}

		return {
			...entity,
			quality: entityRules(entity, columns, (message, cell, level) =>
				issues.push({
					level: level ?? "warning",
					scope: entity.name,
					cell,
					message,
				}),
			),
		};
	});

	const mapped = new Set(plan.silver.map((s) => s.name));
	for (const entity of byEntity.keys()) {
		if (!mapped.has(entity)) {
			issues.push({
				level: "info",
				scope: "workbook",
				message: `${entity} is in entity_attributes but the mapping has no such entity`,
			});
		}
	}

	return { ...plan, silver, issues: [...plan.issues, ...issues] };
}
