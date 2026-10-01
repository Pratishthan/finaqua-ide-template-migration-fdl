import fs from "node:fs";
import path from "node:path";
import { InvalidArgumentError } from "commander";

export function resolveExistingPath(value: string): string {
	if (!fs.existsSync(value)) {
		throw new InvalidArgumentError(`The path '${value}' does not exist.`);
	}

	return path.resolve(value);
}

export function resolveDestinationPath(value: string): string {
	return path.resolve(value);
}
