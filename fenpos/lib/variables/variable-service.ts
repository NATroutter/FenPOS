import "server-only";

import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { integerSetting } from "@/lib/settings/settings-service";
import {
	type ContextSource,
	type OffsetUnit,
	type VariableDefinition,
	type VariableKind,
	variableDefinitionSchema,
} from "@/lib/variables/definition";

/**
 * Reading and writing the variables table.
 *
 * Every write goes through {@link requireValid}, which is the only place a definition is checked.
 * Validating here rather than in each caller means the panel's server actions and any future API
 * route cannot diverge on what a valid variable is — the same reason `asset-service.ts` owns its own
 * name and size checks rather than leaving them to the upload route.
 */

/** A variable as stored, which is a definition plus the columns the database owns. */
export interface StoredVariable extends VariableDefinition {
	id: string;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Every defined variable, by name.
 *
 * Ordered by name rather than by creation, so the panel's list and the picker in the Tools dialog
 * read the same way every time rather than in the order an operator happened to add things.
 *
 * @returns every variable
 */
export async function listVariables(): Promise<StoredVariable[]> {
	const rows = await prisma.variable.findMany({ orderBy: { name: "asc" } });
	return rows.map(toStored);
}

/**
 * Defines a new variable.
 *
 * @param input the definition
 * @returns the stored variable
 * @throws ApiError if the definition is invalid, the name is taken, or the install is full
 */
export async function createVariable(input: VariableDefinition): Promise<StoredVariable> {
	const definition = await requireValid(input);

	const cap = await integerSetting("variables.maxCount");
	if ((await prisma.variable.count()) >= cap) {
		throw new ApiError("too_many_variables", `At most ${cap} variables can be defined.`);
	}

	if (await prisma.variable.findUnique({ where: { name: definition.name }, select: { id: true } })) {
		throw new ApiError("name_taken", `A variable called '${definition.name}' already exists.`);
	}

	return toStored(await prisma.variable.create({ data: definition }));
}

/**
 * Replaces a variable's definition.
 *
 * Every field is written, including the ones the new kind does not use. A partial update would
 * leave a `pattern` behind on a variable that is no longer a date, which is exactly the ambiguous
 * row `variableDefinitionSchema` refuses to accept in the first place.
 *
 * @param id the variable to replace
 * @param input the new definition
 * @returns the stored variable
 * @throws ApiError if the definition is invalid, the variable is gone, or the name is taken
 */
export async function updateVariable(id: string, input: VariableDefinition): Promise<StoredVariable> {
	const definition = await requireValid(input);

	const existing = await prisma.variable.findUnique({ where: { id }, select: { id: true } });
	if (!existing) {
		throw new ApiError("unknown_variable", "That variable no longer exists.");
	}

	const clash = await prisma.variable.findUnique({ where: { name: definition.name }, select: { id: true } });
	if (clash && clash.id !== id) {
		throw new ApiError("name_taken", `A variable called '${definition.name}' already exists.`);
	}

	// Overrides are dropped when a variable stops being static, because only a static variable may
	// carry them. Left behind, they would be rows nothing reads and nothing can edit — and they would
	// come back to life if the variable were switched to static again, with values nobody remembers
	// setting.
	if (definition.kind !== "STATIC") {
		await prisma.deviceVariable.deleteMany({ where: { variableId: id } });
	}

	return toStored(await prisma.variable.update({ where: { id }, data: definition }));
}

/**
 * Removes a variable. Its device overrides go with it, by cascade.
 *
 * Receipts still naming it will fail to compile, loudly, which is the intended consequence of the
 * decision that an unknown name is refused rather than printed.
 *
 * @param id the variable to remove
 */
export async function deleteVariable(id: string): Promise<void> {
	await prisma.variable.deleteMany({ where: { id } });
}

/**
 * Sets or clears one printer's own value for one variable.
 *
 * @param deviceId the printer
 * @param variableId the variable
 * @param value the printer's value, or null to fall back to the install-wide one
 * @throws ApiError if the variable is not static, is gone, or the value is not storable
 */
export async function setDeviceOverride(deviceId: string, variableId: string, value: string | null): Promise<void> {
	if (value === null) {
		await prisma.deviceVariable.deleteMany({ where: { deviceId, variableId } });
		return;
	}

	const variable = await prisma.variable.findUnique({ where: { id: variableId }, select: { kind: true } });
	if (!variable) {
		throw new ApiError("unknown_variable", "That variable no longer exists.");
	}
	if (variable.kind !== "STATIC") {
		throw new ApiError(
			"not_overridable",
			"Only a static variable can be given a different value on one printer. A date's format and a printer's own name are the same everywhere.",
		);
	}

	await requireStorableValue(value);

	await prisma.deviceVariable.upsert({
		where: { deviceId_variableId: { deviceId, variableId } },
		create: { deviceId, variableId, value },
		update: { value },
	});
}

/**
 * One printer's overrides, keyed by variable name.
 *
 * Keyed by name rather than id because that is what the resolver needs: it is building a map from
 * the names markup writes, and an id would have to be translated back on every lookup.
 *
 * @param deviceId the printer
 * @returns each overridden variable's name, mapped to that printer's value
 */
export async function listDeviceOverrides(deviceId: string): Promise<Map<string, string>> {
	const rows = await prisma.deviceVariable.findMany({
		where: { deviceId },
		select: { value: true, variable: { select: { name: true } } },
	});
	return new Map(rows.map((row) => [row.variable.name, row.value]));
}

/**
 * Validates a definition and applies the install's value-length cap to it.
 *
 * The schema's own ceiling is a hard bound that no setting can raise; this adds the operator's
 * policy on top. Two checks rather than one because they answer different questions — "could this
 * ever be stored" and "does this install allow it" — and only the first is a fact about the code.
 *
 * @param input the candidate definition
 * @returns the definition, parsed
 * @throws ApiError with the first problem, worded for the panel
 */
async function requireValid(input: VariableDefinition): Promise<VariableDefinition> {
	const parsed = variableDefinitionSchema.safeParse(input);
	if (!parsed.success) {
		throw new ApiError("invalid_variable", parsed.error.issues[0]?.message ?? "That variable is not valid.");
	}

	if (parsed.data.value !== null) {
		await requireStorableValue(parsed.data.value);
	}

	return parsed.data;
}

/**
 * Applies `variables.maxValueChars` to one value.
 *
 * @param value the candidate
 * @throws ApiError if it exceeds the install's cap
 */
async function requireStorableValue(value: string): Promise<void> {
	const cap = await integerSetting("variables.maxValueChars");
	if (value.length > cap) {
		throw new ApiError("variable_too_long", `A value must be at most ${cap} characters, got ${value.length}.`);
	}
}

/** Narrows the TEXT columns Prisma types as `string` back to their closed sets. */
function toStored(row: {
	id: string;
	name: string;
	kind: string;
	value: string | null;
	pattern: string | null;
	offsetAmount: number | null;
	offsetUnit: string | null;
	source: string | null;
	overridable: boolean;
	description: string | null;
	createdAt: Date;
	updatedAt: Date;
}): StoredVariable {
	return {
		...row,
		kind: row.kind as VariableKind,
		offsetUnit: row.offsetUnit as OffsetUnit | null,
		source: row.source as ContextSource | null,
	};
}
