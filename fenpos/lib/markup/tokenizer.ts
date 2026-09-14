import type { RawAttribute } from "@/lib/markup/attributes";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
import type { VariableContext } from "@/lib/markup/parser";
import { hasControlCharacter, isControlCharacter, variableReferenceAt } from "@/lib/variables/definition";

/**
 * One piece of a document as the tokenizer read it.
 *
 * Text runs, entities and variable values are each their own token so that every token's
 * `column` is exact: an entity occupies more source characters than it produces, and a variable
 * value may be any length, so a run containing either could not be measured by arithmetic.
 */
export type Token =
	| { kind: "text"; text: string; line: number; column: number; expandedFrom?: string }
	| { kind: "open"; name: string; argument: string | null; attributes: RawAttribute[]; line: number; column: number }
	| { kind: "close"; name: string; line: number; column: number }
	| { kind: "break"; line: number; column: number };

/** The tokens, plus the raw length of every line for the character limits. */
export interface Tokenized {
	tokens: Token[];
	lineChars: number[];
}

const ENTITIES: readonly [string, string][] = [
	["&lt;", "<"],
	["&amp;", "&"],
	["&lbrace;", "{"],
];

const NAME_CHAR = /[a-z0-9_-]/i;

/**
 * Reads a whole document into tokens.
 *
 * Variables are substituted here and only here. A value is pushed as one token and the cursor
 * moves past the reference in the source, so the value's own characters are never read as
 * markup: nothing reaches the printer as a command except through a recognised tag.
 *
 * @param source the document, already `\r\n`-normalised
 * @param variables the resolved values, or null when the request has none
 */
export function tokenize(source: string, variables: VariableContext | null): Tokenized {
	return new Tokenizer(source, variables).run();
}

class Tokenizer {
	private readonly tokens: Token[] = [];
	private readonly lineChars: number[] = [];
	private index = 0;
	private line = 1;
	private lineStart = 0;
	private pending = "";
	private pendingColumn = 1;
	private substitutions = 0;

	constructor(
		private readonly source: string,
		private readonly variables: VariableContext | null,
	) {}

	run(): Tokenized {
		while (this.index < this.source.length) {
			const current = this.source[this.index];
			if (current === "\n") {
				this.endLine();
			} else if (current === "<") {
				this.readTag();
			} else if (current === "&") {
				this.readEntity();
			} else if (current === "{") {
				this.readVariable();
			} else {
				this.readText(current);
			}
		}
		this.flush();
		this.lineChars.push(this.index - this.lineStart);
		return { tokens: this.tokens, lineChars: this.lineChars };
	}

	private column(): number {
		return this.index - this.lineStart + 1;
	}

	private endLine(): void {
		this.flush();
		this.tokens.push({ kind: "break", line: this.line, column: this.column() });
		this.lineChars.push(this.index - this.lineStart);
		this.index += 1;
		this.line += 1;
		this.lineStart = this.index;
		this.substitutions = 0;
	}

	private readText(current: string): void {
		if (isControlCharacter(current)) {
			throw new MarkupError(
				MARKUP_ERRORS.controlCharacter,
				this.line,
				this.column(),
				`U+${current.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
				"Control characters cannot be printed; use markup tags for formatting",
			);
		}
		if (this.pending.length === 0) {
			this.pendingColumn = this.column();
		}
		this.pending += current;
		this.index += 1;
	}

	private flush(): void {
		if (this.pending.length > 0) {
			this.tokens.push({ kind: "text", text: this.pending, line: this.line, column: this.pendingColumn });
			this.pending = "";
		}
	}

	private emit(text: string, sourceLength: number, expandedFrom?: string): void {
		this.flush();
		if (text.length > 0) {
			this.tokens.push({
				kind: "text",
				text,
				line: this.line,
				column: this.column(),
				...(expandedFrom === undefined ? {} : { expandedFrom }),
			});
		}
		this.index += sourceLength;
	}

	private readEntity(): void {
		for (const [entity, decoded] of ENTITIES) {
			if (this.source.startsWith(entity, this.index)) {
				this.emit(decoded, entity.length);
				return;
			}
		}
		this.readText("&");
	}

	private readVariable(): void {
		const match = this.variables ? variableReferenceAt(this.source, this.index) : null;
		if (!match || !this.variables) {
			this.readText("{");
			return;
		}
		const name = match[1];
		const value = this.variables.values.get(name);
		if (value === undefined) {
			throw new MarkupError(
				MARKUP_ERRORS.unknownVariable,
				this.line,
				this.column(),
				name,
				`Unknown variable '${name}'`,
			);
		}
		this.substitutions += 1;
		if (this.substitutions > this.variables.maxPerElement) {
			throw new MarkupError(
				MARKUP_ERRORS.tooManyVariableReferences,
				this.line,
				this.column(),
				name,
				`At most ${this.variables.maxPerElement} variable references are allowed on one line`,
			);
		}
		if (hasControlCharacter(value)) {
			throw new MarkupError(
				MARKUP_ERRORS.controlCharacter,
				this.line,
				this.column(),
				name,
				`Variable '${name}' contains a control character and cannot be printed`,
			);
		}
		this.emit(value, match[0].length, name);
	}

	private readTag(): void {
		const start = this.index;
		const column = this.column();
		const unterminated = (): MarkupError =>
			new MarkupError(
				MARKUP_ERRORS.unknownTag,
				this.line,
				column,
				this.source.slice(start, this.lineEnd()),
				"Unterminated tag; write &lt; for a literal '<'",
			);

		this.flush();
		let at = start + 1;
		const closing = this.source[at] === "/";
		if (closing) {
			at += 1;
		}

		const nameStart = at;
		while (at < this.source.length && NAME_CHAR.test(this.source[at])) {
			at += 1;
		}
		const name = this.source.slice(nameStart, at).toLowerCase();
		if (name.length === 0) {
			throw unterminated();
		}

		if (closing) {
			if (this.source[at] !== ">") {
				throw unterminated();
			}
			this.tokens.push({ kind: "close", name, line: this.line, column });
			this.index = at + 1;
			return;
		}

		let argument: string | null = null;
		if (this.source[at] === "=") {
			at += 1;
			const argumentStart = at;
			while (
				at < this.source.length &&
				!isSpace(this.source[at]) &&
				this.source[at] !== ">" &&
				this.source[at] !== "\n"
			) {
				at += 1;
			}
			argument = this.source.slice(argumentStart, at);
		}

		const attributes: RawAttribute[] = [];
		while (at < this.source.length && this.source[at] !== ">") {
			if (this.source[at] === "\n") {
				throw unterminated();
			}
			if (isSpace(this.source[at])) {
				at += 1;
				continue;
			}
			const keyColumn = at - this.lineStart + 1;
			const keyStart = at;
			while (at < this.source.length && NAME_CHAR.test(this.source[at])) {
				at += 1;
			}
			const key = this.source.slice(keyStart, at).toLowerCase();
			if (key.length === 0 || this.source[at] !== "=") {
				const shown = key.length === 0 ? this.source.slice(keyStart, keyStart + 1) : key;
				throw new MarkupError(
					MARKUP_ERRORS.unknownAttribute,
					this.line,
					keyColumn,
					shown,
					`<${name}> attribute '${shown}' must be written as ${shown}=value`,
				);
			}
			at += 1;
			let value: string;
			if (this.source[at] === '"') {
				const close = this.source.indexOf('"', at + 1);
				const lineEnd = this.lineEnd();
				if (close < 0 || close > lineEnd) {
					throw unterminated();
				}
				value = this.source.slice(at + 1, close);
				at = close + 1;
			} else {
				const valueStart = at;
				while (
					at < this.source.length &&
					!isSpace(this.source[at]) &&
					this.source[at] !== ">" &&
					this.source[at] !== "\n"
				) {
					at += 1;
				}
				value = this.source.slice(valueStart, at);
			}
			for (const character of value) {
				if (isControlCharacter(character)) {
					throw new MarkupError(
						MARKUP_ERRORS.controlCharacter,
						this.line,
						keyColumn,
						key,
						"Control characters cannot be printed; use markup tags for formatting",
					);
				}
			}
			attributes.push({ name: key, value, column: keyColumn });
		}
		if (this.source[at] !== ">") {
			throw unterminated();
		}

		this.tokens.push({ kind: "open", name, argument, attributes, line: this.line, column });
		this.index = at + 1;
	}

	private lineEnd(): number {
		const end = this.source.indexOf("\n", this.index);
		return end < 0 ? this.source.length : end;
	}
}

function isSpace(character: string): boolean {
	return character === " " || character === "\t";
}
