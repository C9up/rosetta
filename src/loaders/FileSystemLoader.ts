import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageCatalog, MessageTree, RosettaLoader } from "../Rosetta.js";

const SAFE_LOCALE_PATTERN = /^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_CATALOG_DEPTH = 100;
const MAX_CATALOG_KEYS = 100_000;

export interface FileSystemLoaderOptions {
	rootDir?: string;
	/** AdonisJS-compatible alias. */
	location?: string | URL;
}

export type FsLoaderOptions = FileSystemLoaderOptions;

export class FileSystemLoader implements RosettaLoader {
	#rootDir: string;

	constructor(options: FileSystemLoaderOptions) {
		const location = options.rootDir ?? options.location;
		if (!location) {
			throw new TypeError("FileSystemLoader requires 'location' or 'rootDir'");
		}
		this.#rootDir =
			location instanceof URL ? fileURLToPath(location) : location;
	}

	async load(): Promise<Record<string, MessageTree | MessageCatalog>>;
	async load(locale: string): Promise<MessageTree | MessageCatalog | null>;
	async load(
		locale?: string,
	): Promise<
		| MessageTree
		| MessageCatalog
		| Record<string, MessageTree | MessageCatalog>
		| null
	> {
		if (locale === undefined) return this.loadAll();
		return this.#loadLocale(locale);
	}

	async loadAll(): Promise<Record<string, MessageTree | MessageCatalog>> {
		const translations: Record<string, MessageTree | MessageCatalog> = {};
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fsp.readdir(this.#rootDir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return translations;
			throw error;
		}
		entries.sort(compareDirectoryEntries);
		const locales = new Map<string, string>();
		for (const entry of entries) {
			const extension = path.extname(entry.name).toLowerCase();
			const candidate = entry.isDirectory()
				? entry.name
				: [".json", ".yaml", ".yml"].includes(extension)
					? entry.name.slice(0, -extension.length)
					: "";
			if (candidate && SAFE_LOCALE_PATTERN.test(candidate)) {
				locales.set(candidate.toLowerCase(), candidate);
			}
		}
		for (const actualLocale of locales.values()) {
			const messages = await this.#loadLocale(actualLocale);
			if (messages) translations[actualLocale] = messages;
		}
		return translations;
	}

	async #loadLocale(
		locale: string,
	): Promise<MessageTree | MessageCatalog | null> {
		// Validate locale to prevent path traversal. A locale like
		// `../../etc/passwd` would escape the rootDir without this check.
		if (!SAFE_LOCALE_PATTERN.test(locale)) return null;

		const actualLocale = await this.#resolveLocaleName(locale);
		const tree: MessageTree = {};
		let found = false;

		// 1. Flat catalog: `{locale}.{json,yaml,yml}`.
		const flat = await this.#loadFlatFile(actualLocale);
		if (flat) {
			deepMerge(tree, flat);
			found = true;
		}

		// 2. Nested namespaces: scan `{locale}/**` and prefix each file's keys
		//    with its path relative to the locale dir (AdonisJS FS-loader parity).
		const nested = await this.#loadNestedDir(actualLocale);
		if (nested) {
			deepMerge(tree, nested);
			found = true;
		}

		return found ? tree : null;
	}

	async #resolveLocaleName(locale: string): Promise<string> {
		try {
			const entries = await fsp.readdir(this.#rootDir, { withFileTypes: true });
			const lower = locale.toLowerCase();
			for (const entry of entries) {
				const ext = path.extname(entry.name).toLowerCase();
				const candidate = entry.isDirectory()
					? entry.name
					: [".json", ".yaml", ".yml"].includes(ext)
						? entry.name.slice(0, -ext.length)
						: "";
				if (candidate.toLowerCase() === lower) return candidate;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return locale;
	}

	async #loadFlatFile(
		locale: string,
	): Promise<MessageTree | MessageCatalog | null> {
		for (const ext of ["json", "yaml", "yml"] as const) {
			const fullPath = path.join(this.#rootDir, `${locale}.${ext}`);
			// Defense-in-depth: verify the resolved path is still inside rootDir
			// even after the regex check (belt + suspenders).
			if (!isPathInside(this.#rootDir, fullPath)) return null;

			try {
				const raw = await readFileNoFollow(fullPath, this.#rootDir);
				return parseCatalog(raw, ext, `${locale}.${ext}`);
			} catch (err: unknown) {
				// ENOENT = file doesn't exist → try next extension. Any other error
				// (permission denied, invalid JSON, disk failure) is a real problem
				// that must surface — silently swallowing it would turn a config bug
				// into a "missing translation" ghost that's impossible to debug in prod.
				const code = (err as NodeJS.ErrnoException)?.code;
				if (code === "ENOENT") continue;
				throw err;
			}
		}
		return null;
	}

	async #loadNestedDir(locale: string): Promise<MessageTree | null> {
		const baseDir = path.join(this.#rootDir, locale);
		// Defense-in-depth: keep the namespace directory inside rootDir.
		if (!isPathInside(this.#rootDir, baseDir)) return null;

		let files: string[];
		try {
			files = await walkDir(baseDir);
		} catch (err: unknown) {
			// No namespace directory for this locale → nothing to load.
			if (
				typeof err === "object" &&
				err !== null &&
				"code" in err &&
				err.code === "ENOENT"
			)
				return null;
			throw err;
		}

		const tree: MessageTree = {};
		let found = false;

		for (const file of files) {
			const ext = path.extname(file).slice(1).toLowerCase();
			if (ext !== "json" && ext !== "yaml" && ext !== "yml") continue;

			const rel = path.relative(baseDir, file);
			const relNoExt = rel.slice(0, rel.length - path.extname(rel).length);
			const segments = relNoExt.split(path.sep).filter(Boolean);
			if (segments.length === 0) continue;

			const raw = await readFileNoFollow(file, this.#rootDir);
			const content = parseCatalog(
				raw,
				ext,
				path.relative(this.#rootDir, file),
			);

			deepMerge(tree, nest(segments, content));
			found = true;
		}

		return found ? tree : null;
	}
}

function parseCatalog(
	input: string,
	format: "json" | "yaml" | "yml",
	filePath?: string,
): MessageTree | MessageCatalog {
	const normalizedInput = input.replace(/^\uFEFF/, "");
	try {
		const catalog: unknown =
			format === "json"
				? JSON.parse(normalizedInput.trim())
				: parseYaml(normalizedInput);
		validateCatalogValue(catalog, "<root>", 0, { keys: 0 });
		return catalog;
	} catch (error) {
		if (filePath && error instanceof Error && error.stack) {
			const stack = error.stack.split("\n");
			stack.splice(1, 0, `    at anonymous (${filePath})`);
			error.stack = stack.join("\n");
		}
		throw error;
	}
}

function validateCatalogValue(
	value: unknown,
	pathLabel: string,
	depth: number,
	state: { keys: number },
): asserts value is MessageTree | MessageCatalog {
	if (depth > MAX_CATALOG_DEPTH) {
		throw new RangeError(
			`Translation catalog exceeds ${MAX_CATALOG_DEPTH} nesting levels`,
		);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(
			`Translation catalog '${pathLabel}' must be an object mapping or scalar value`,
		);
	}
	for (const [key, child] of Object.entries(value)) {
		state.keys += 1;
		if (state.keys > MAX_CATALOG_KEYS) {
			throw new RangeError(
				`Translation catalog exceeds the ${MAX_CATALOG_KEYS} key limit`,
			);
		}
		assertSafeKey(key);
		if (Array.isArray(child)) {
			throw new TypeError(
				`Translation catalog arrays are not allowed at '${key}'`,
			);
		}
		if (child !== null && typeof child === "object") {
			validateCatalogValue(child, `${pathLabel}.${key}`, depth + 1, state);
		} else if (
			!["string", "number", "boolean"].includes(typeof child) &&
			child !== null
		) {
			throw new TypeError(
				`Unsupported translation value at '${pathLabel}.${key}'`,
			);
		}
	}
}

/**
 * Recursively collect every file path under `dir`. Entry names from `readdir`
 * are single path components, so they cannot contain `..` — traversal stays
 * contained within `dir`.
 */
async function walkDir(dir: string): Promise<string[]> {
	const directoryStat = await fsp.lstat(dir);
	if (directoryStat.isSymbolicLink()) {
		throw new Error(`Translation directory cannot be a symbolic link: ${dir}`);
	}
	if (!directoryStat.isDirectory()) {
		throw new Error(`Translation path is not a directory: ${dir}`);
	}
	const out: string[] = [];
	const entries = await fsp.readdir(dir, { withFileTypes: true });
	entries.sort(compareDirectoryEntries);
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...(await walkDir(full)));
		} else if (entry.isFile()) {
			out.push(full);
		}
	}
	return out;
}

function compareDirectoryEntries(
	left: import("node:fs").Dirent,
	right: import("node:fs").Dirent,
): number {
	return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

async function readFileNoFollow(
	filePath: string,
	rootDir: string,
): Promise<string> {
	const fileStat = await fsp.lstat(filePath);
	if (fileStat.isSymbolicLink()) {
		throw new Error(`Translation file cannot be a symbolic link: ${filePath}`);
	}
	const [canonicalRoot, canonicalFile] = await Promise.all([
		fsp.realpath(rootDir),
		fsp.realpath(filePath),
	]);
	if (!isPathInside(canonicalRoot, canonicalFile)) {
		throw new Error(`Translation file resolves outside its root: ${filePath}`);
	}
	const handle = await fsp.open(
		filePath,
		fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
	);
	try {
		const stat = await handle.stat();
		if (!stat.isFile())
			throw new Error(`Translation path is not a file: ${filePath}`);
		if (stat.size > MAX_CATALOG_BYTES) {
			throw new RangeError(
				`Translation file exceeds the ${MAX_CATALOG_BYTES} byte limit: ${filePath}`,
			);
		}
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

/** Wrap `value` in a nested object following `segments` (`["a","b"] → {a:{b:value}}`). */
function nest(
	segments: string[],
	value: MessageTree | MessageCatalog,
): MessageTree {
	const root: MessageTree = {};
	let node = root;
	for (let i = 0; i < segments.length - 1; i++) {
		assertSafeKey(segments[i]);
		const child: MessageTree = {};
		node[segments[i]] = child;
		node = child;
	}
	assertSafeKey(segments[segments.length - 1]);
	node[segments[segments.length - 1]] = value;
	return root;
}

/** Deep-merge `source` into `target`, recursing into nested object nodes. */
function deepMerge(
	target: MessageTree,
	source: MessageTree | MessageCatalog,
): void {
	for (const [key, value] of Object.entries(source)) {
		assertSafeKey(key);
		const existing = target[key];
		if (
			value !== null &&
			typeof value === "object" &&
			existing !== null &&
			typeof existing === "object"
		) {
			deepMerge(existing, value);
		} else {
			target[key] = value;
		}
	}
}

function assertSafeKey(key: string): void {
	if (DANGEROUS_KEYS.has(key)) {
		throw new Error(`Unsafe translation key '${key}'`);
	}
}

function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

/**
 * Minimal YAML parser for locale files. Supports:
 * - Nested keys via indentation
 * - Quoted and unquoted scalar values
 * - Colons in values (URLs like `https://example.com`)
 * - Multiline block scalars: `|` (literal) and `>` (folded)
 * - Comments (`#`)
 *
 * Unsupported YAML constructs fail closed instead of being partially loaded.
 * Locale catalogs intentionally accept mappings and scalar message values only.
 */
function parseYaml(input: string): MessageTree {
	const root: MessageTree = {};
	const stack: Array<{ indent: number; node: MessageTree }> = [
		{ indent: -1, node: root },
	];
	const lines = input.split(/\r?\n/);
	let i = 0;
	let previousIndent = 0;
	let previousWasMapping = false;
	let hasValue = false;

	while (i < lines.length) {
		const rawLine = lines[i];
		i++;
		if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
		if (/^\s*\t/.test(rawLine)) {
			throw new SyntaxError(`Tabs are not valid YAML indentation on line ${i}`);
		}

		if (["---", "..."].includes(rawLine.trim())) continue;
		const indent = rawLine.match(/^ */)?.[0].length ?? 0;
		if (stack.length === 1 && indent !== 0) {
			throw new SyntaxError(
				`Top-level YAML keys must not be indented on line ${i}`,
			);
		}
		if (hasValue && indent > previousIndent && !previousWasMapping) {
			throw new SyntaxError(`Unexpected YAML indentation on line ${i}`);
		}
		const content = rawLine.slice(indent);
		const delimiter = findYamlMappingDelimiter(content);
		if (delimiter < 0) {
			throw new SyntaxError(`Unsupported YAML syntax on line ${i}: ${rawLine}`);
		}
		const parsedKey = parseScalar(content.slice(0, delimiter).trim());
		if (typeof parsedKey !== "string" || !parsedKey) {
			throw new SyntaxError(`YAML mapping keys must be strings on line ${i}`);
		}
		const key = parsedKey;
		assertSafeKey(key);
		let valueRaw = content.slice(delimiter + 1).trim();
		if (/^(?:&|\*|!|<<\s*:|\[|\{)/.test(valueRaw)) {
			throw new SyntaxError(
				`Unsupported YAML construct for key '${key}'. Rosetta locale files accept mappings and scalar messages only.`,
			);
		}

		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}
		const parent = stack[stack.length - 1].node;
		if (Object.hasOwn(parent, key)) {
			throw new SyntaxError(`Duplicate YAML key '${key}'`);
		}

		// Block scalar: `|` (literal) or `>` (folded).
		if (["|", ">", "|-", ">-", "|+", ">+"].includes(valueRaw)) {
			const block = parseBlockScalar(
				lines,
				i,
				indent,
				valueRaw.startsWith(">"),
			);
			parent[key] = block.value;
			i = block.nextIndex;
			previousIndent = indent;
			previousWasMapping = false;
			hasValue = true;
			continue;
		}

		if (!valueRaw) {
			const child: MessageTree = {};
			parent[key] = child;
			stack.push({ indent, node: child });
			previousIndent = indent;
			previousWasMapping = true;
			hasValue = true;
			continue;
		}

		// Strip inline comments: `value # comment` → `value`. But only if the `#`
		// is preceded by whitespace (to avoid stripping inside URLs like `#fragment`).
		valueRaw = stripInlineComment(valueRaw);

		parent[key] = parseScalar(valueRaw);
		previousIndent = indent;
		previousWasMapping = false;
		hasValue = true;
	}

	return root;
}

function findYamlMappingDelimiter(line: string): number {
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (quote === '"' && char === "\\") {
			index++;
			continue;
		}
		if (char === quote) {
			quote = undefined;
			continue;
		}
		if (!quote && (char === "'" || char === '"')) {
			quote = char;
			continue;
		}
		if (
			!quote &&
			char === ":" &&
			(index === line.length - 1 || /\s/.test(line[index + 1]))
		) {
			return index;
		}
	}
	return -1;
}

/**
 * Consume a `|` (literal) or `>` (folded) block scalar starting at `startIndex`.
 * Returns the joined value and the index of the first line past the block.
 */
function parseBlockScalar(
	lines: string[],
	startIndex: number,
	indent: number,
	fold: boolean,
): { value: string; nextIndex: number } {
	const blockLines: string[] = [];
	let blockIndent: number | undefined;
	let i = startIndex;
	while (i < lines.length) {
		const bl = lines[i];
		// A line with less indent (or empty after content) ends the block.
		const lineIndent = bl.search(/\S/);
		if (bl.trim() && lineIndent <= indent) break;
		if (bl.trim() && blockIndent === undefined) blockIndent = lineIndent;
		blockLines.push(bl.slice(blockIndent ?? indent + 2) || "");
		i++;
	}
	// Trim trailing empty lines.
	while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
		blockLines.pop();
	}
	return {
		value: fold ? foldParagraphs(blockLines) : blockLines.join("\n"),
		nextIndex: i,
	};
}

/**
 * Fold a `>` block scalar: consecutive non-blank lines join with a space, blank
 * lines become hard newlines (paragraph breaks per the YAML spec).
 */
function foldParagraphs(blockLines: string[]): string {
	const paragraphs: string[] = [];
	let current: string[] = [];
	for (const bl of blockLines) {
		if (bl === "") {
			if (current.length > 0) paragraphs.push(current.join(" "));
			current = [];
			paragraphs.push("");
		} else {
			current.push(bl);
		}
	}
	if (current.length > 0) paragraphs.push(current.join(" "));
	return paragraphs.join("\n");
}

function parseScalar(value: string): string | number | boolean | null {
	if (value.startsWith('"')) {
		if (!value.endsWith('"'))
			throw new SyntaxError("Unclosed double-quoted YAML scalar");
		try {
			return JSON.parse(value) as string;
		} catch (error) {
			throw new SyntaxError("Invalid double-quoted YAML scalar", {
				cause: error,
			});
		}
	}
	if (value.startsWith("'")) {
		if (!value.endsWith("'"))
			throw new SyntaxError("Unclosed single-quoted YAML scalar");
		// Single-quoted: only '' escape (doubled apostrophe → single)
		return value.slice(1, -1).replace(/''/g, "'");
	}
	const normalized = value.toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	if (normalized === "null" || value === "~") return null;

	const n = Number(value);
	if (Number.isFinite(n) && value !== "") return n;

	return value;
}

function stripInlineComment(value: string): string {
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (quote === '"' && char === "\\") {
			index++;
			continue;
		}
		if (char === quote) {
			if (quote === "'" && value[index + 1] === "'") {
				index++;
				continue;
			}
			quote = undefined;
			continue;
		}
		if (!quote && (char === "'" || char === '"')) {
			quote = char;
			continue;
		}
		if (!quote && char === "#" && /\s/.test(value[index - 1] ?? "")) {
			return value.slice(0, index).trimEnd();
		}
	}
	return value;
}
