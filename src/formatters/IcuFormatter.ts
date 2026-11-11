import type { RosettaOptions } from "../Rosetta.js";
import { parseIsoDateTime } from "./Formatter.js";
import {
	getDateTimeFormatter,
	getNumberFormatter,
	getPluralRules,
} from "./IntlFormatterCache.js";

export type NumberFormatOptions = Intl.NumberFormatOptions;
export type TimeFormatOptions = Omit<
	Intl.DateTimeFormatOptions,
	"dateStyle" | "weekday" | "era" | "year" | "month" | "day" | "timeZoneName"
>;

export interface TranslationsFormatterContract {
	readonly name: string;
	format(
		message: string,
		locale: string,
		data?: Record<string, unknown>,
	): string;
}

export type FormatterFactory = (
	config: RosettaOptions,
) => TranslationsFormatterContract;

type CustomFormats = {
	number?: Record<string, Intl.NumberFormatOptions>;
	date?: Record<string, Intl.DateTimeFormatOptions>;
	time?: Record<string, TimeFormatOptions>;
};

const MAX_NESTING_DEPTH = 100;
const MAX_AST_NODES = 100_000;
const MAX_AST_CACHE_ENTRIES = 1_000;
const MAX_CACHED_MESSAGE_LENGTH = 16_384;
const MAX_MESSAGE_LENGTH = 1_000_000;

type MessageNode =
	| { type: "text"; value: string }
	| { type: "argument"; name: string }
	| {
			type: "select";
			name: string;
			options: Record<string, MessageNode[]>;
	  }
	| {
			type: "plural";
			name: string;
			options: Record<string, MessageNode[]>;
			offset: number;
			ordinal: boolean;
	  }
	| { type: "number"; name: string; style: string }
	| {
			type: "dateTime";
			name: string;
			style: string;
			kind: "date" | "time";
	  }
	| { type: "pound" };

const messageAstCache = new Map<string, MessageNode[]>();

/**
 * How a message uses one of its variables. `text` means plain interpolation
 * (`{name}`) — the value is stringified as-is, so it accepts anything.
 */
export type MessageParamKind =
	| "text"
	| "number"
	| "date"
	| "time"
	| "plural"
	| "selectordinal"
	| "select";

/** A variable a message requires, as declared by its ICU syntax. */
export interface MessageParam {
	name: string;
	kind: MessageParamKind;
	/** For `select` only: the declared branch keys, `other` excluded. */
	options?: string[];
}

/**
 * The variables a message needs, sorted by name so two messages can be
 * compared directly. Parses through the shared cache, so calling this on a
 * message that will also be formatted costs nothing extra.
 *
 * Powers translation-key typing and the cross-locale catalog check: `en` using
 * `{count, plural, ...}` while `fr` uses `{n, plural, ...}` is a runtime
 * "variable not provided" error waiting for whoever switches locale.
 *
 * @throws SyntaxError if the message is not valid ICU.
 */
export function extractMessageParams(message: string): MessageParam[] {
	const found = new Map<string, MessageParam>();
	collectParams(getMessageAst(message), found);
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function collectParams(
	nodes: MessageNode[],
	found: Map<string, MessageParam>,
): void {
	for (const node of nodes) {
		switch (node.type) {
			case "text":
			case "pound":
				break;
			case "argument":
				addParam(found, { name: node.name, kind: "text" });
				break;
			case "number":
				addParam(found, { name: node.name, kind: "number" });
				break;
			case "dateTime":
				addParam(found, { name: node.name, kind: node.kind });
				break;
			case "plural":
				addParam(found, {
					name: node.name,
					kind: node.ordinal ? "selectordinal" : "plural",
				});
				for (const branch of Object.values(node.options)) {
					collectParams(branch, found);
				}
				break;
			case "select":
				addParam(found, {
					name: node.name,
					kind: "select",
					options: Object.keys(node.options).filter((k) => k !== "other"),
				});
				for (const branch of Object.values(node.options)) {
					collectParams(branch, found);
				}
				break;
			default:
				assertNever(node);
		}
	}
}

/**
 * A name can appear more than once (`{n} of {n, plural, ...}`). The typed use
 * is the constraining one, so it wins over bare interpolation; between two
 * typed uses the first is kept, which only happens in a message that is already
 * self-contradictory.
 */
function addParam(found: Map<string, MessageParam>, param: MessageParam): void {
	const existing = found.get(param.name);
	if (!existing || (existing.kind === "text" && param.kind !== "text")) {
		found.set(param.name, param);
	}
}

/**
 * Dependency-free ICU MessageFormat formatter backed by the runtime's ECMA-402
 * implementation. CLDR plural rules and value formatting therefore stay in
 * sync with Node/browser Intl instead of being maintained by hand.
 */
export class IcuFormatter implements TranslationsFormatterContract {
	static customFormats: CustomFormats = Object.create(null);
	readonly name = "icu";

	static addFormatFor(
		type: "number",
		key: string,
		options: Intl.NumberFormatOptions,
	): void;
	static addFormatFor(
		type: "date",
		key: string,
		options: Intl.DateTimeFormatOptions,
	): void;
	static addFormatFor(
		type: "time",
		key: string,
		options: TimeFormatOptions,
	): void;
	static addFormatFor(
		type: "number" | "date" | "time",
		key: string,
		options:
			| Intl.NumberFormatOptions
			| Intl.DateTimeFormatOptions
			| TimeFormatOptions,
	): void {
		if (["__proto__", "prototype", "constructor"].includes(key)) {
			throw new Error(`Unsafe ICU custom format key '${key}'`);
		}
		if (!key) throw new TypeError("ICU custom format key cannot be empty");
		let formats = IcuFormatter.customFormats[type];
		if (formats === undefined) {
			const created: Record<string, never> = Object.create(null);
			IcuFormatter.customFormats[type] = created;
			formats = created;
		}
		Reflect.set(formats, key, options);
	}

	format(
		message: string,
		locale: string,
		data: Record<string, unknown> = {},
	): string {
		return new MessageEvaluator(
			message,
			getMessageAst(message),
			locale,
			data,
		).format();
	}
}

/**
 * Resolve a message to its AST, memoized, so a message is parsed once per
 * process however often it is formatted.
 */
function getMessageAst(message: string): MessageNode[] {
	if (message.length > MAX_MESSAGE_LENGTH) {
		throw new RangeError(
			`ICU message exceeds the ${MAX_MESSAGE_LENGTH} character limit`,
		);
	}
	const cached = messageAstCache.get(message);
	if (cached) return cached;
	const ast = parseMessageToAst(message);
	if (message.length <= MAX_CACHED_MESSAGE_LENGTH) {
		if (messageAstCache.size >= MAX_AST_CACHE_ENTRIES) {
			const oldest = messageAstCache.keys().next().value;
			if (oldest !== undefined) messageAstCache.delete(oldest);
		}
		messageAstCache.set(message, ast);
	}
	return ast;
}

class MessageEvaluator {
	readonly #source: string;
	readonly #ast: MessageNode[];
	readonly #locale: string;
	readonly #data: Record<string, unknown>;

	constructor(
		source: string,
		ast: MessageNode[],
		locale: string,
		data: Record<string, unknown>,
	) {
		this.#source = source;
		this.#ast = ast;
		this.#locale = locale;
		this.#data = data;
	}

	format(): string {
		return this.#formatNodes(this.#ast);
	}

	#formatNodes(nodes: MessageNode[], poundValue?: number): string {
		return nodes
			.map((node) => {
				switch (node.type) {
					case "text":
						return node.value;
					case "argument":
						return stringifyValue(this.#value(node.name));
					case "pound":
						return poundValue === undefined
							? "#"
							: getNumberFormatter(this.#locale).format(poundValue);
					case "select": {
						const selected =
							node.options[String(this.#value(node.name))] ??
							node.options.other;
						if (!selected) throw new SyntaxError("Invalid ICU select argument");
						return this.#formatNodes(selected, poundValue);
					}
					case "plural": {
						const number = toIcuNumber(this.#value(node.name));
						const adjusted = number - node.offset;
						const category = getPluralRules(this.#locale, {
							type: node.ordinal ? "ordinal" : "cardinal",
						}).select(adjusted);
						const selected =
							node.options[`=${canonicalNumber(number)}`] ??
							node.options[category] ??
							node.options.other;
						if (!selected) throw new SyntaxError("Invalid ICU plural argument");
						return this.#formatNodes(selected, adjusted);
					}
					case "number":
						return formatIcuNumber(
							this.#value(node.name),
							node.style,
							this.#locale,
						);
					case "dateTime":
						return formatIcuDate(
							this.#value(node.name),
							node.style,
							node.kind,
							this.#locale,
						);
					default:
						return assertNever(node);
				}
			})
			.join("");
	}

	#value(identifier: string): unknown {
		if (!Object.hasOwn(this.#data, identifier)) {
			throw new Error(
				`The ICU variable '${identifier}' was not provided for message '${this.#source}'`,
			);
		}
		return this.#data[identifier];
	}
}

function assertNever(value: never): never {
	throw new TypeError(`Unsupported ICU AST node: ${JSON.stringify(value)}`);
}

/** Dependency-free ICU parser. Emits the AST consumed by {@link MessageEvaluator}. */
function parseMessageToAst(message: string): MessageNode[] {
	return parseSegmentToAst(message, 0, { nodes: 0 }, false);
}

interface AstParseState {
	nodes: number;
}

function pushAstNode(
	nodes: MessageNode[],
	node: MessageNode,
	state: AstParseState,
): void {
	state.nodes += 1;
	if (state.nodes > MAX_AST_NODES) {
		throw new RangeError(
			`ICU message exceeds the ${MAX_AST_NODES} AST node limit`,
		);
	}
	nodes.push(node);
}

/** Flush the pending literal run as one text node (Rust coalesces the same way). */
function flushAstText(
	nodes: MessageNode[],
	text: string,
	state: AstParseState,
): string {
	if (text) pushAstNode(nodes, { type: "text", value: text }, state);
	return "";
}

/**
 * @param plural Whether this text is the direct body of a plural or
 *   selectordinal option: only there is `#` the number, and an apostrophe
 *   before it a quote (formatjs's `parentArgType`).
 */
function parseSegmentToAst(
	source: string,
	depth: number,
	state: AstParseState,
	plural: boolean,
): MessageNode[] {
	if (depth > MAX_NESTING_DEPTH) {
		throw new RangeError(
			`ICU message exceeds ${MAX_NESTING_DEPTH} nesting levels`,
		);
	}
	const nodes: MessageNode[] = [];
	let text = "";
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		if (char === "'") {
			const quoted = consumeQuote(source, index, plural);
			text += quoted.value;
			index = quoted.next;
			continue;
		}
		if (char === "{") {
			text = flushAstText(nodes, text, state);
			const end = findArgumentEnd(source, index, depth + 1);
			if (end < 0) throw new SyntaxError("Unclosed ICU argument");
			pushAstNode(
				nodes,
				parseArgumentToAst(source.slice(index + 1, end), depth + 1, state),
				state,
			);
			index = end + 1;
			continue;
		}
		// A body is cut at its closing brace, so a `}` reaching here closes
		// nothing: it is text, as upstream reads it at the top level.
		if (char === "#" && plural) {
			text = flushAstText(nodes, text, state);
			pushAstNode(nodes, { type: "pound" }, state);
			index++;
			continue;
		}
		text += char;
		index++;
	}
	flushAstText(nodes, text, state);
	return nodes;
}

function parseArgumentToAst(
	content: string,
	depth: number,
	state: AstParseState,
): MessageNode {
	const parts = splitArgument(content, depth);
	const name = parts[0]?.trim();
	if (!name) throw new SyntaxError("Empty ICU argument");
	if (parts.length === 1) return { type: "argument", name };

	const kind = parts[1]?.trim();
	const style = parts.slice(2).join(",").trim();
	switch (kind) {
		case "select": {
			// `offset:` is plural-only — for select it must parse as a plain option
			// key (and therefore fail), exactly as the Rust grammar does.
			const { options } = parseOptions(style, false, depth);
			const parsed = parseOptionNodes(options, depth, state, false);
			requireOtherOption(parsed, "select");
			return { type: "select", name, options: parsed };
		}
		case "plural":
		case "selectordinal": {
			const { options, offset } = parseOptions(style, true, depth);
			const parsed = parseOptionNodes(options, depth, state, true);
			requireOtherOption(parsed, kind);
			return {
				type: "plural",
				name,
				options: parsed,
				offset,
				ordinal: kind === "selectordinal",
			};
		}
		case "number":
			validateNumberStyle(style);
			return { type: "number", name, style };
		case "date":
		case "time":
			validateDateStyle(style, kind);
			return { type: "dateTime", name, style, kind };
		default:
			throw new SyntaxError(`Unsupported ICU argument type '${kind}'`);
	}
}

function parseOptionNodes(
	options: Map<string, string>,
	depth: number,
	state: AstParseState,
	plural: boolean,
): Record<string, MessageNode[]> {
	const parsed: Record<string, MessageNode[]> = Object.create(null);
	for (const [key, body] of options) {
		parsed[key] = parseSegmentToAst(body, depth, state, plural);
	}
	return parsed;
}

function requireOtherOption(
	options: Record<string, MessageNode[]>,
	kind: string,
): void {
	if (!Object.hasOwn(options, "other")) {
		throw new SyntaxError(`ICU ${kind} arguments require an 'other' option`);
	}
}

/**
 * Validate a number style at parse time — but ONLY skeletons (`::…`). Plain
 * styles (`integer`, `percent`, `currency/USD`) and caller-registered custom
 * format keys are resolved at format time against `IcuFormatter.customFormats`,
 * which the parser cannot see. Mirrors Rust's `validate_number_style`.
 */
function validateNumberStyle(style: string): void {
	if (!style.startsWith("::")) return;
	parseNumberSkeleton(style);
}

/** Skeleton-only date/time validation — see {@link validateNumberStyle}. */
function validateDateStyle(style: string, kind: "date" | "time"): void {
	if (!style.startsWith("::")) return;
	parseDateStyle(style, kind);
}

function formatIcuNumber(
	value: unknown,
	style: string,
	locale: string,
): string {
	const normalized = normalizeNumericValue(value);
	const custom = style ? IcuFormatter.customFormats.number?.[style] : undefined;
	if (custom) {
		return getNumberFormatter(locale, custom).format(normalized);
	}
	return formatNumberSkeleton(normalized, locale, parseNumberSkeleton(style));
}

function formatIcuDate(
	value: unknown,
	style: string,
	type: "date" | "time",
	locale: string,
): string {
	const date = normalizeDate(value);
	const custom = style ? IcuFormatter.customFormats[type]?.[style] : undefined;
	const options = custom ?? parseDateStyle(style, type);
	return getDateTimeFormatter(locale, options).format(date);
}

function consumeQuote(
	source: string,
	start: number,
	plural: boolean,
): { value: string; next: number } {
	const next = source[start + 1];
	if (next === "'") return { value: "'", next: start + 2 };
	// Quoting "only where needed": before a brace or an angle bracket, and
	// before `#` only where `#` means something.
	const special =
		next === "{" ||
		next === "}" ||
		next === "<" ||
		next === ">" ||
		(next === "#" && plural);
	if (!special) return { value: "'", next: start + 1 };
	let output = "";
	for (let index = start + 1; index < source.length; index++) {
		if (source[index] !== "'") {
			output += source[index];
			continue;
		}
		if (source[index + 1] === "'") {
			output += "'";
			index++;
			continue;
		}
		return { value: output, next: index + 1 };
	}
	return { value: output, next: source.length };
}

/**
 * The `}` closing the argument opened at `start`, or -1.
 *
 * Where a quote starts depends on whether the text sits in a plural body, so
 * the scan follows the structure: the argument's header, then its option
 * bodies, each read with the quoting of its own kind.
 */
function findArgumentEnd(source: string, start: number, depth: number): number {
	// One level past what the parser accepts: anything deeper is rejected there
	// with the same error, and the recursion stays bounded.
	if (depth > MAX_NESTING_DEPTH + 1) {
		throw new RangeError(
			`ICU message exceeds ${MAX_NESTING_DEPTH} nesting levels`,
		);
	}
	const headerStart = start + 1;
	let index = headerStart;
	while (index < source.length) {
		const char = source[index];
		if (char === "'") {
			index = consumeQuote(source, index, false).next;
			continue;
		}
		if (char === "}") return index;
		if (char === "{") break;
		index++;
	}
	const kind = source.slice(headerStart, index).split(",")[1]?.trim();
	const plural = kind === "plural" || kind === "selectordinal";
	while (index < source.length) {
		const char = source[index];
		if (char === "}") return index;
		if (char === "{") {
			const end = findBodyEnd(source, index, plural, depth);
			if (end < 0) return -1;
			index = end + 1;
			continue;
		}
		if (char === "'") {
			index = consumeQuote(source, index, false).next;
			continue;
		}
		index++;
	}
	return -1;
}

/** The `}` closing the option body opened at `start`, or -1. */
function findBodyEnd(
	source: string,
	start: number,
	plural: boolean,
	depth: number,
): number {
	let index = start + 1;
	while (index < source.length) {
		const char = source[index];
		if (char === "'") {
			index = consumeQuote(source, index, plural).next;
			continue;
		}
		if (char === "}") return index;
		if (char === "{") {
			const end = findArgumentEnd(source, index, depth + 1);
			if (end < 0) return -1;
			index = end + 1;
			continue;
		}
		index++;
	}
	return -1;
}

/** An argument's content split on its own commas, option bodies skipped. */
function splitArgument(content: string, depth: number): string[] {
	const parts: string[] = [];
	let start = 0;
	let index = 0;
	while (index < content.length) {
		const char = content[index];
		if (char === "'") {
			index = consumeQuote(content, index, false).next;
			continue;
		}
		if (char === "{") {
			const kind = parts[1];
			const plural = kind === "plural" || kind === "selectordinal";
			const end = findBodyEnd(content, index, plural, depth);
			// Unclosed: the option parser reports it.
			index = end < 0 ? content.length : end + 1;
			continue;
		}
		if (char === ",") {
			parts.push(content.slice(start, index).trim());
			start = index + 1;
		}
		index++;
	}
	parts.push(content.slice(start).trim());
	return parts;
}

/**
 * @param plural A plural or selectordinal argument. Only those take an
 *   `offset:` (for `select`, `offset:2` falls through to the option-key branch
 *   and raises the "invalid option list" error), and only their bodies give
 *   `#` a meaning.
 */
function parseOptions(
	source: string,
	plural: boolean,
	depth: number,
): {
	options: Map<string, string>;
	offset: number;
} {
	const options = new Map<string, string>();
	let offset = 0;
	let sawOffset = false;
	let sawOption = false;
	let index = 0;
	while (index < source.length) {
		while (/\s/.test(source[index] ?? "")) index++;
		if (plural && source.startsWith("offset:", index)) {
			if (sawOffset) throw new SyntaxError("Duplicate ICU plural offset");
			if (sawOption) {
				throw new SyntaxError("ICU plural offset must precede all options");
			}
			sawOffset = true;
			index += 7;
			const match = source.slice(index).match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/);
			if (!match) throw new SyntaxError("Invalid ICU plural offset");
			offset = Number(match[0]);
			if (!Number.isFinite(offset) || offset < 0) {
				throw new SyntaxError(
					"ICU plural offset must be a non-negative finite number",
				);
			}
			index += match[0].length;
			if (index < source.length && !/\s/.test(source[index] ?? "")) {
				throw new SyntaxError("Invalid ICU plural offset delimiter");
			}
			continue;
		}
		const keyStart = index;
		while (index < source.length && !/[\s{]/.test(source[index] ?? "")) index++;
		const key = source.slice(keyStart, index);
		while (/\s/.test(source[index] ?? "")) index++;
		if (!key || source[index] !== "{") {
			throw new SyntaxError(
				`Invalid ICU option list near '${source.slice(index)}'`,
			);
		}
		const end = findBodyEnd(source, index, plural, depth);
		if (end < 0) throw new SyntaxError("Unclosed ICU option body");
		if (options.has(key)) {
			throw new SyntaxError(`Duplicate ICU option '${key}'`);
		}
		options.set(key, source.slice(index + 1, end));
		sawOption = true;
		index = end + 1;
	}
	return { options, offset };
}

type ExtendedNumberFormatOptions = Omit<
	Intl.NumberFormatOptions,
	"useGrouping" | "signDisplay" | "roundingPriority"
> & {
	useGrouping?: boolean | "min2" | "auto" | "always";
	signDisplay?: Intl.NumberFormatOptions["signDisplay"] | "negative";
	roundingIncrement?: number;
	roundingMode?:
		| "ceil"
		| "floor"
		| "trunc"
		| "expand"
		| "halfEven"
		| "halfFloor"
		| "halfExpand";
	trailingZeroDisplay?: "auto" | "stripIfInteger";
	roundingPriority?: "auto" | "morePrecision" | "lessPrecision";
};

interface ParsedNumberSkeleton {
	options: ExtendedNumberFormatOptions;
	scale: number;
	replacePercentWithPermille: boolean;
	hideUnit: boolean;
	decimalAlways: boolean;
	exponentSignDisplay: "auto" | "always" | "exceptZero" | "never";
	minimumExponentDigits: number;
	denominatorUnit?: string;
	maximumIntegerDigits?: number;
}

function parseNumberSkeleton(style: string): ParsedNumberSkeleton {
	const parsed: ParsedNumberSkeleton = {
		options: {},
		scale: 1,
		replacePercentWithPermille: false,
		hideUnit: false,
		decimalAlways: false,
		exponentSignDisplay: "auto",
		minimumExponentDigits: 1,
	};
	if (!style) return parsed;
	if (!style.startsWith("::")) {
		if (style === "integer") parsed.options.maximumFractionDigits = 0;
		else if (style === "percent") parsed.options.style = "percent";
		else if (style.startsWith("currency/")) {
			parsed.options.style = "currency";
			parsed.options.currency = style.slice("currency/".length);
		} else if (style === "currency") {
			parsed.options.style = "currency";
			parsed.options.currency = "USD";
		} else if (style) {
			throw new SyntaxError(`Unsupported ICU number style '${style}'`);
		}
		return parsed;
	}
	if (!style.slice(2).trim()) {
		throw new SyntaxError("Empty ICU number skeleton");
	}
	const options = parsed.options;
	for (const token of style.slice(2).trim().split(/\s+/)) {
		if (!token) continue;
		if (token.startsWith("currency/")) {
			assertSkeletonValue(token, "currency/");
			options.style = "currency";
			options.currency = token.slice("currency/".length);
		} else if (token.startsWith("measure-unit/")) {
			assertSkeletonValue(token, "measure-unit/");
			options.style = "unit";
			options.unit = coreMeasureUnit(token.slice("measure-unit/".length));
		} else if (token.startsWith("unit/")) {
			assertSkeletonValue(token, "unit/");
			options.style = "unit";
			// `unit/` is the short spelling of `measure-unit/` and takes the same
			// identifier — `length-kilometer`, not `kilometer`. Passing the
			// dimension prefix through reaches Intl as an unknown unit and
			// throws, so it is dropped here as it is there.
			options.unit = coreMeasureUnit(token.slice("unit/".length));
		} else if (token.startsWith("per-measure-unit/")) {
			assertSkeletonValue(token, "per-measure-unit/");
			parsed.denominatorUnit = coreMeasureUnit(
				token.slice("per-measure-unit/".length),
			);
		} else if (token === "compact-long" || token === "KK") {
			options.notation = "compact";
			options.compactDisplay = "long";
		} else if (token === "compact-short" || token === "K") {
			options.notation = "compact";
			options.compactDisplay = "short";
		} else if (token === "scientific" || token.startsWith("scientific/")) {
			applyScientificNotation(parsed, token, "scientific");
		} else if (token === "engineering" || token.startsWith("engineering/")) {
			applyScientificNotation(parsed, token, "engineering");
		} else if (/^EE?(?:\+!|\+\?)?0+$/.test(token)) {
			applyConciseScientificNotation(parsed, token);
		} else if (token === "notation-simple") {
			options.notation = "standard";
		} else if (token === "percent" || token === "%") {
			options.style = "percent";
			parsed.scale *= 0.01;
		} else if (token === "%x100") {
			options.style = "percent";
		} else if (token === "permille") {
			options.style = "percent";
			parsed.scale *= 0.01;
			parsed.replacePercentWithPermille = true;
		} else if (token === "base-unit") {
			delete options.style;
			delete options.unit;
			delete options.currency;
		} else if (token === "group-off" || token === ",_") {
			options.useGrouping = false;
		} else if (token === "group-min2" || token === ",?") {
			options.useGrouping = "min2";
		} else if (token === "group-on-aligned" || token === ",!") {
			options.useGrouping = "always";
		} else if (token === "group-auto") {
			options.useGrouping = "auto";
		} else if (token === "group-thousands") {
			options.useGrouping = "always";
		} else if (token === "sign-always" || token === "+!") {
			options.signDisplay = "always";
		} else if (token === "sign-auto") {
			options.signDisplay = "auto";
		} else if (token === "sign-never" || token === "+_") {
			options.signDisplay = "never";
		} else if (token === "sign-except-zero" || token === "+?") {
			options.signDisplay = "exceptZero";
		} else if (token === "sign-negative" || token === "+-") {
			options.signDisplay = "negative";
		} else if (
			[
				"sign-accounting",
				"sign-accounting-always",
				"sign-accounting-except-zero",
				"sign-accounting-negative",
				"()",
				"()!",
				"()?",
				"()-",
			].includes(token)
		) {
			options.currencySign = "accounting";
			if (token.endsWith("always") || token === "()!")
				options.signDisplay = "always";
			else if (token.endsWith("except-zero") || token === "()?")
				options.signDisplay = "exceptZero";
			else if (token.endsWith("negative") || token === "()-")
				options.signDisplay = "negative";
		} else if (token === "unit-width-narrow") {
			options.unitDisplay = "narrow";
			options.currencyDisplay = "narrowSymbol";
		} else if (token === "unit-width-short") {
			options.unitDisplay = "short";
			options.currencyDisplay = "symbol";
		} else if (token === "unit-width-full-name") {
			options.unitDisplay = "long";
			options.currencyDisplay = "name";
		} else if (token === "unit-width-iso-code") {
			options.currencyDisplay = "code";
		} else if (token === "unit-width-hidden") {
			parsed.hideUnit = true;
		} else if (token === "precision-integer" || token === ".") {
			options.maximumFractionDigits = 0;
		} else if (token === "precision-unlimited") {
			options.maximumFractionDigits = 20;
		} else if (token === "precision-currency-standard") {
			// Intl applies standard currency precision from CLDR by default.
		} else if (token === "precision-currency-standard/w") {
			options.trailingZeroDisplay = "stripIfInteger";
		} else if (token.startsWith("precision-currency-cash")) {
			throw new SyntaxError(
				"ICU cash currency precision is not representable by Intl",
			);
		} else if (token.startsWith("precision-increment/")) {
			applyIncrementPrecision(
				options,
				token.slice("precision-increment/".length),
			);
		} else if (/^\.0*[#*+]*(?:\/.*)?$/.test(token)) {
			applyFractionPrecision(options, token);
		} else if (/^@+[#*+]*(?:[rs])?$/.test(token)) {
			applySignificantPrecision(options, token);
		} else if (token.startsWith("rounding-mode-")) {
			applyRoundingMode(options, token.slice("rounding-mode-".length));
		} else if (token.startsWith("integer-width/")) {
			const width = token.slice("integer-width/".length);
			if (!/^[*+]?(?:#+)?0+$/.test(width)) {
				throw new SyntaxError(`Invalid ICU integer width '${width}'`);
			}
			applyIntegerWidth(parsed, width);
		} else if (token === "integer-width-trunc") {
			parsed.maximumIntegerDigits = 0;
		} else if (/^0+$/.test(token)) {
			options.minimumIntegerDigits = Math.min(21, token.length);
		} else if (token.startsWith("scale/")) {
			const scale = Number(token.slice("scale/".length));
			if (!Number.isFinite(scale))
				throw new SyntaxError(`Invalid ICU scale '${token}'`);
			parsed.scale *= scale;
		} else if (token === "latin") {
			options.numberingSystem = "latn";
		} else if (token.startsWith("numbering-system/")) {
			assertSkeletonValue(token, "numbering-system/");
			options.numberingSystem = token.slice("numbering-system/".length);
		} else if (token === "decimal-always") {
			parsed.decimalAlways = true;
		} else if (token === "decimal-auto") {
			parsed.decimalAlways = false;
		} else {
			throw new SyntaxError(`Unsupported ICU number skeleton token '${token}'`);
		}
	}
	if (parsed.denominatorUnit) {
		if (!options.unit) {
			throw new SyntaxError("ICU per-measure-unit requires a numerator unit");
		}
		options.unit = `${options.unit}-per-${parsed.denominatorUnit}`;
	}
	return parsed;
}

function assertSkeletonValue(token: string, prefix: string): void {
	const value = token.slice(prefix.length);
	if (!value || !/^[A-Za-z0-9-]+$/.test(value)) {
		throw new SyntaxError(`Invalid ICU number skeleton token '${token}'`);
	}
}

function coreMeasureUnit(unit: string): string {
	return unit.includes("-") ? unit.slice(unit.indexOf("-") + 1) : unit;
}

function applyScientificNotation(
	parsed: ParsedNumberSkeleton,
	token: string,
	notation: "scientific" | "engineering",
): void {
	parsed.options.notation = notation;
	for (const option of token.split("/").slice(1)) {
		if (/^[*+]e+$/.test(option)) {
			parsed.minimumExponentDigits = option.length - 1;
		} else if (option === "sign-always") {
			parsed.exponentSignDisplay = "always";
		} else if (option === "sign-except-zero") {
			parsed.exponentSignDisplay = "exceptZero";
		} else if (option === "sign-never") {
			parsed.exponentSignDisplay = "never";
		} else if (option === "sign-auto") {
			parsed.exponentSignDisplay = "auto";
		} else {
			throw new SyntaxError(`Unsupported ICU scientific option '${option}'`);
		}
	}
}

function applyConciseScientificNotation(
	parsed: ParsedNumberSkeleton,
	token: string,
): void {
	const engineering = token.startsWith("EE");
	parsed.options.notation = engineering ? "engineering" : "scientific";
	const rest = token.slice(engineering ? 2 : 1);
	if (rest.startsWith("+!")) parsed.exponentSignDisplay = "always";
	else if (rest.startsWith("+?")) parsed.exponentSignDisplay = "exceptZero";
	parsed.minimumExponentDigits = rest.replace(/^\+(?:!|\?)/, "").length;
}

function applyFractionPrecision(
	options: ExtendedNumberFormatOptions,
	token: string,
): void {
	const [precision, significant] = token.split("/");
	const body = (precision ?? "").slice(1);
	const zeros = body.match(/^0*/)?.[0].length ?? 0;
	options.minimumFractionDigits = zeros;
	if (body.endsWith("*") || body.endsWith("+"))
		options.maximumFractionDigits = 20;
	else options.maximumFractionDigits = zeros + (body.match(/#/g)?.length ?? 0);
	if (significant && significant !== "w")
		applySignificantPrecision(options, significant.replace(/[rs]$/, ""));
	if (token.endsWith("/w")) options.trailingZeroDisplay = "stripIfInteger";
}

function applySignificantPrecision(
	options: ExtendedNumberFormatOptions,
	token: string,
): void {
	const normalized = token.replace(/[rs]$/, "");
	const minimum = normalized.match(/^@+/)?.[0].length ?? 1;
	options.minimumSignificantDigits = minimum;
	options.maximumSignificantDigits =
		normalized.endsWith("*") || normalized.endsWith("+")
			? 21
			: minimum + (normalized.match(/#/g)?.length ?? 0);
	if (token.endsWith("r")) options.roundingPriority = "morePrecision";
	if (token.endsWith("s")) options.roundingPriority = "lessPrecision";
}

/**
 * The increments `Intl.NumberFormat` accepts for `roundingIncrement`.
 *
 * Declared `as const` so membership NARROWS to the literal union the option
 * expects: a plain `Set<number>` type-checks inside rosetta but breaks every
 * consumer compiling against the stricter lib, since `has()` proves nothing
 * about the value's type.
 */
const SUPPORTED_INCREMENTS = [
	1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000,
] as const;

/** Type guard narrowing a computed increment to a supported literal. */
function isSupportedIncrement(
	value: number,
): value is (typeof SUPPORTED_INCREMENTS)[number] {
	return SUPPORTED_INCREMENTS.some((allowed) => allowed === value);
}

function applyIncrementPrecision(
	options: ExtendedNumberFormatOptions,
	raw: string,
): void {
	const increment = Number(raw);
	if (!Number.isFinite(increment) || increment <= 0) {
		throw new SyntaxError(`Invalid ICU rounding increment '${raw}'`);
	}
	const [, fraction] = raw.split(".");
	const fractionDigits = fraction?.length ?? 0;
	const integerIncrement = Math.round(increment * 10 ** fractionDigits);
	if (!isSupportedIncrement(integerIncrement)) {
		throw new SyntaxError(
			`ICU rounding increment '${raw}' is not supported by Intl`,
		);
	}
	options.minimumFractionDigits = fractionDigits;
	options.maximumFractionDigits = fractionDigits;
	options.roundingIncrement = integerIncrement;
}

function applyRoundingMode(
	options: ExtendedNumberFormatOptions,
	mode: string,
): void {
	const modes: Record<
		string,
		NonNullable<ExtendedNumberFormatOptions["roundingMode"]>
	> = {
		ceiling: "ceil",
		floor: "floor",
		down: "trunc",
		up: "expand",
		"half-even": "halfEven",
		"half-down": "halfFloor",
		"half-up": "halfExpand",
	};
	const resolved = modes[mode];
	if (!resolved)
		throw new SyntaxError(`Unsupported ICU rounding mode '${mode}'`);
	options.roundingMode = resolved;
}

function applyIntegerWidth(parsed: ParsedNumberSkeleton, raw: string): void {
	const minimum = raw.match(/0+$/)?.[0].length ?? 0;
	if (minimum > 0) parsed.options.minimumIntegerDigits = Math.min(21, minimum);
	if (!raw.startsWith("*") && !raw.startsWith("+")) {
		parsed.maximumIntegerDigits = (raw.match(/#/g)?.length ?? 0) + minimum;
	}
}

function formatNumberSkeleton(
	value: number | bigint,
	locale: string,
	parsed: ParsedNumberSkeleton,
): string {
	let normalized: number | bigint = value;
	if (parsed.scale !== 1) {
		normalized =
			typeof normalized === "bigint" && Number.isInteger(parsed.scale)
				? normalized * BigInt(parsed.scale)
				: Number(normalized) * parsed.scale;
	}
	if (parsed.maximumIntegerDigits !== undefined) {
		const modulo = 10 ** parsed.maximumIntegerDigits;
		normalized =
			parsed.maximumIntegerDigits === 0 ? 0 : Number(normalized) % modulo;
	}
	const formatter = getNumberFormatter(
		locale,
		intlNumberOptions(parsed.options),
	);
	const needsPartTransforms =
		parsed.hideUnit ||
		parsed.replacePercentWithPermille ||
		parsed.decimalAlways ||
		parsed.minimumExponentDigits > 1 ||
		parsed.exponentSignDisplay !== "auto";
	if (!needsPartTransforms) {
		return formatter.format(normalized);
	}
	const parts = formatter
		.formatToParts(normalized)
		.map((part) => ({ ...part }));
	transformExponentParts(parts, parsed, locale);
	if (parsed.decimalAlways && !parts.some((part) => part.type === "decimal")) {
		const decimal = getNumberFormatter(locale, {
			minimumFractionDigits: 1,
		})
			.formatToParts(1)
			.find((part) => part.type === "decimal")?.value;
		const exponentSeparator = parts.findIndex(
			(part) => part.type === "exponentSeparator",
		);
		let insertion = exponentSeparator;
		if (insertion < 0) {
			let lastInteger = -1;
			for (const [index, part] of parts.entries()) {
				if (["integer", "group"].includes(part.type)) lastInteger = index;
			}
			insertion = lastInteger < 0 ? parts.length : lastInteger + 1;
		}
		parts.splice(insertion, 0, {
			type: "decimal",
			value: decimal ?? ".",
		});
	}
	return parts
		.filter(
			(part) =>
				!parsed.hideUnit ||
				!["currency", "unit", "percentSign"].includes(part.type),
		)
		.map((part) =>
			parsed.replacePercentWithPermille && part.type === "percentSign"
				? "‰"
				: part.value,
		)
		.join("")
		.trim();
}

function transformExponentParts(
	parts: Intl.NumberFormatPart[],
	parsed: ParsedNumberSkeleton,
	locale: string,
): void {
	const exponentIndex = parts.findIndex(
		(part) => part.type === "exponentInteger",
	);
	const exponentPart = parts[exponentIndex];
	if (exponentPart === undefined) return;
	exponentPart.value = exponentPart.value.padStart(
		parsed.minimumExponentDigits,
		"0",
	);
	const signIndex = parts.findIndex(
		(part) => part.type === "exponentMinusSign",
	);
	if (parsed.exponentSignDisplay === "never" && signIndex >= 0) {
		parts.splice(signIndex, 1);
		return;
	}
	if (signIndex >= 0 || parsed.exponentSignDisplay === "auto") return;
	const exponent = Number(exponentPart.value);
	if (parsed.exponentSignDisplay === "exceptZero" && exponent === 0) return;
	const plus = getNumberFormatter(locale, { signDisplay: "always" })
		.formatToParts(1)
		.find((part) => part.type === "plusSign")?.value;
	parts.splice(exponentIndex, 0, {
		type: "exponentMinusSign",
		value: plus ?? "+",
	});
}

const DATE_TIME_STYLES = ["full", "long", "medium", "short"] as const;

function isDateTimeStyle(
	style: string,
): style is (typeof DATE_TIME_STYLES)[number] {
	return DATE_TIME_STYLES.some((known) => known === style);
}

/**
 * Skeleton options as Intl takes them. Node 24 accepts every one of them, but
 * the ES2022 lib this package compiles against (and so must its consumers,
 * who compile its source) does not list `useGrouping: "min2"`, `roundingMode`
 * and the rest. Copied rather than retyped, so nothing claims a shape it lacks.
 */
function intlNumberOptions(
	options: ExtendedNumberFormatOptions,
): Intl.NumberFormatOptions {
	const intl: Intl.NumberFormatOptions = {};
	Object.assign(intl, options);
	return intl;
}

function parseDateStyle(
	style: string,
	type: "date" | "time",
): Intl.DateTimeFormatOptions {
	if (!style) return type === "time" ? { timeStyle: "medium" } : {};
	if (isDateTimeStyle(style)) {
		return type === "time" ? { timeStyle: style } : { dateStyle: style };
	}
	if (!style.startsWith("::")) {
		throw new SyntaxError(`Unsupported ICU ${type} style '${style}'`);
	}
	const skeleton = style.slice(2).trim();
	if (!skeleton) throw new SyntaxError(`Empty ICU ${type} skeleton`);
	if (/[^A-Za-z\s:.,/-]/.test(skeleton)) {
		throw new SyntaxError(`Invalid ICU ${type} skeleton '${style}'`);
	}
	const options: Intl.DateTimeFormatOptions = {};
	const fields = skeleton.match(/([A-Za-z])\1*/g);
	if (!fields) throw new SyntaxError(`Invalid ICU ${type} skeleton '${style}'`);
	for (const field of fields) {
		const symbol = field[0];
		const length = field.length;
		switch (symbol) {
			case "y":
				options.year = length === 2 ? "2-digit" : "numeric";
				break;
			case "M":
			case "L":
				options.month = dateTextWidth(length);
				break;
			case "d":
				options.day = length === 2 ? "2-digit" : "numeric";
				break;
			case "E":
				options.weekday =
					length === 4 ? "long" : length >= 5 ? "narrow" : "short";
				break;
			case "e":
			case "c":
				if (length <= 3) {
					throw new SyntaxError(
						`ICU date skeleton field '${field}' is not supported by Intl`,
					);
				}
				options.weekday =
					length === 4 ? "long" : length >= 5 ? "narrow" : "short";
				break;
			case "G":
				options.era = length === 4 ? "long" : length >= 5 ? "narrow" : "short";
				break;
			case "h":
				options.hour = length === 2 ? "2-digit" : "numeric";
				options.hour12 = true;
				break;
			case "H":
				options.hour = length === 2 ? "2-digit" : "numeric";
				options.hour12 = false;
				break;
			case "K":
				options.hour = length === 2 ? "2-digit" : "numeric";
				options.hourCycle = "h11";
				break;
			case "k":
				options.hour = length === 2 ? "2-digit" : "numeric";
				options.hourCycle = "h24";
				break;
			case "j":
				options.hour = length === 2 ? "2-digit" : "numeric";
				break;
			case "a":
				options.hour12 = true;
				break;
			case "m":
				options.minute = length === 2 ? "2-digit" : "numeric";
				break;
			case "s":
				options.second = length === 2 ? "2-digit" : "numeric";
				break;
			case "S":
				if (length > 3) {
					throw new SyntaxError(
						"Intl supports at most 3 fractional second digits",
					);
				}
				options.fractionalSecondDigits = length as 1 | 2 | 3;
				break;
			case "z":
				options.timeZoneName = length >= 4 ? "long" : "short";
				break;
			case "v":
				options.timeZoneName = length >= 4 ? "longGeneric" : "shortGeneric";
				break;
			case "O":
			case "X":
			case "x":
				options.timeZoneName = length >= 4 ? "longOffset" : "shortOffset";
				break;
			default:
				throw new SyntaxError(`Unsupported ICU date skeleton field '${field}'`);
		}
	}
	return options;
}

function dateTextWidth(
	length: number,
): NonNullable<Intl.DateTimeFormatOptions["month"]> {
	if (length === 2) return "2-digit";
	if (length === 3) return "short";
	if (length === 4) return "long";
	if (length >= 5) return "narrow";
	return "numeric";
}

function normalizeDate(value: unknown): Date | number {
	if (value instanceof Date || typeof value === "number") return value;
	if (typeof value === "string") {
		const date = parseIsoDateTime(value);
		if (Number.isNaN(date.getTime()))
			throw new RangeError(`Invalid ISO date '${value}'`);
		return date;
	}
	if (value && typeof value === "object") {
		const toJSDate: unknown = Reflect.get(value, "toJSDate");
		if (typeof toJSDate === "function") {
			const date: unknown = Reflect.apply(toJSDate, value, []);
			if (date instanceof Date) return date;
		}
		const toMillis: unknown = Reflect.get(value, "toMillis");
		if (typeof toMillis === "function") {
			const millis: unknown = Reflect.apply(toMillis, value, []);
			if (typeof millis === "number") return millis;
		}
	}
	throw new TypeError(
		"ICU date/time values must be Date, timestamp, ISO string, or Luxon-like DateTime",
	);
}

function normalizeNumericValue(value: unknown): number | bigint {
	if (typeof value === "bigint" || typeof value === "number") return value;
	if (typeof value === "string" && value.trim()) {
		if (/^-?\d+$/.test(value) && value.replace("-", "").length > 15)
			return BigInt(value);
		return toIcuNumber(value);
	}
	return toIcuNumber(value);
}

/**
 * The number a plural or number argument stands for.
 *
 * Read the way `Intl` reads it, and never refused: a value that is not a
 * number becomes NaN, so a plural selects `other` and the number renders as
 * "NaN" — what the upstream formatter renders. Throwing instead turned a bad
 * query parameter passed to `t()` into a 500 on a page that only meant to
 * show it.
 */
function toIcuNumber(value: unknown): number {
	return typeof value === "number" ? value : Number(value);
}

function stringifyValue(value: unknown): string {
	if (value === null || value === undefined) return "";
	return String(value);
}

function canonicalNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toString();
}
