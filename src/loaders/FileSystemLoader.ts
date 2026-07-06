import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { MessageCatalog, MessageTree, RosettaLoader } from "../Rosetta.js";

/** IANA BCP 47 locale ID pattern — allows `en`, `en-US`, `zh-Hant-TW`, etc. */
const SAFE_LOCALE_PATTERN = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/;

export interface FileSystemLoaderOptions {
	rootDir: string;
}

export class FileSystemLoader implements RosettaLoader {
	#rootDir: string;

	constructor(options: FileSystemLoaderOptions) {
		this.#rootDir = options.rootDir;
	}

	async load(locale: string): Promise<MessageTree | MessageCatalog | null> {
		// Validate locale to prevent path traversal. A locale like
		// `../../etc/passwd` would escape the rootDir without this check.
		if (!SAFE_LOCALE_PATTERN.test(locale)) return null;

		const tree: MessageTree = {};
		let found = false;

		// 1. Flat catalog: `{locale}.{json,yaml,yml}`.
		const flat = await this.#loadFlatFile(locale);
		if (flat) {
			deepMerge(tree, flat);
			found = true;
		}

		// 2. Nested namespaces: scan `{locale}/**` and prefix each file's keys
		//    with its path relative to the locale dir (AdonisJS FS-loader parity).
		const nested = await this.#loadNestedDir(locale);
		if (nested) {
			deepMerge(tree, nested);
			found = true;
		}

		return found ? tree : null;
	}

	async #loadFlatFile(
		locale: string,
	): Promise<MessageTree | MessageCatalog | null> {
		for (const ext of ["json", "yaml", "yml"]) {
			const fullPath = path.join(this.#rootDir, `${locale}.${ext}`);
			// Defense-in-depth: verify the resolved path is still inside rootDir
			// even after the regex check (belt + suspenders).
			if (!path.resolve(fullPath).startsWith(path.resolve(this.#rootDir)))
				return null;

			try {
				const raw = await fsp.readFile(fullPath, "utf8");
				return ext === "json"
					? (JSON.parse(raw) as MessageTree | MessageCatalog)
					: parseYaml(raw);
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
		if (!path.resolve(baseDir).startsWith(path.resolve(this.#rootDir)))
			return null;

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

			const raw = await fsp.readFile(file, "utf8");
			const content: MessageTree | MessageCatalog =
				ext === "json" ? JSON.parse(raw) : parseYaml(raw);

			deepMerge(tree, nest(segments, content));
			found = true;
		}

		return found ? tree : null;
	}
}

/**
 * Recursively collect every file path under `dir`. Entry names from `readdir`
 * are single path components, so they cannot contain `..` — traversal stays
 * contained within `dir`.
 */
async function walkDir(dir: string): Promise<string[]> {
	const out: string[] = [];
	const entries = await fsp.readdir(dir, { withFileTypes: true });
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

/** Wrap `value` in a nested object following `segments` (`["a","b"] → {a:{b:value}}`). */
function nest(
	segments: string[],
	value: MessageTree | MessageCatalog,
): MessageTree {
	const root: MessageTree = {};
	let node = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const child: MessageTree = {};
		node[segments[i]] = child;
		node = child;
	}
	node[segments[segments.length - 1]] = value;
	return root;
}

/** Deep-merge `source` into `target`, recursing into nested object nodes. */
function deepMerge(
	target: MessageTree,
	source: MessageTree | MessageCatalog,
): void {
	for (const [key, value] of Object.entries(source)) {
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

/**
 * Minimal YAML parser for locale files. Supports:
 * - Nested keys via indentation
 * - Quoted and unquoted scalar values
 * - Colons in values (URLs like `https://example.com`)
 * - Multiline block scalars: `|` (literal) and `>` (folded)
 * - Comments (`#`)
 *
 * Does NOT support: anchors/aliases (`&`/`*`), flow sequences (`[a, b]`),
 * flow mappings (`{a: 1}`), complex keys, merge keys (`<<`), or tags (`!!`).
 * For production apps with complex locale files, replace with `js-yaml`.
 */
function parseYaml(input: string): MessageTree {
	const root: MessageTree = {};
	const stack: Array<{ indent: number; node: MessageTree }> = [
		{ indent: -1, node: root },
	];
	const lines = input.split(/\r?\n/);
	let i = 0;

	while (i < lines.length) {
		const rawLine = lines[i];
		i++;
		if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;

		// Match `key:` with an optional value. The key stops at the first unquoted
		// colon that is NOT inside a URL scheme (`://`). We use a simpler heuristic:
		// split on the first `:` followed by a space or end-of-line. This correctly
		// handles `url: https://example.com` because the `: ` after `url` is the
		// first split point, and `://` inside the value has no preceding space.
		const match = rawLine.match(/^(\s*)([^:#\s][^:]*?)\s*:\s*(.*)$/);
		if (!match) continue;

		const indent = match[1].length;
		const key = match[2].trim();
		let valueRaw = match[3].trim();

		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}
		const parent = stack[stack.length - 1].node;

		// Block scalar: `|` (literal) or `>` (folded).
		if (valueRaw === "|" || valueRaw === ">") {
			const block = parseBlockScalar(lines, i, indent, valueRaw === ">");
			parent[key] = block.value;
			i = block.nextIndex;
			continue;
		}

		if (!valueRaw) {
			const child: MessageTree = {};
			parent[key] = child;
			stack.push({ indent, node: child });
			continue;
		}

		// Strip inline comments: `value # comment` → `value`. But only if the `#`
		// is preceded by whitespace (to avoid stripping inside URLs like `#fragment`).
		const commentIdx = valueRaw.search(/\s+#/);
		if (commentIdx > 0) valueRaw = valueRaw.slice(0, commentIdx).trim();

		parent[key] = parseScalar(valueRaw);
	}

	return root;
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
	const blockIndent = indent + 2;
	let i = startIndex;
	while (i < lines.length) {
		const bl = lines[i];
		// A line with less indent (or empty after content) ends the block.
		if (bl.trim() && bl.search(/\S/) < blockIndent) break;
		blockLines.push(bl.slice(blockIndent) || "");
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
	if (value.startsWith('"') && value.endsWith('"')) {
		// Double-quoted: process YAML escape sequences (\n, \t, \\, \', \")
		return value
			.slice(1, -1)
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/\\\\/g, "\\")
			.replace(/\\'/g, "'")
			.replace(/\\"/g, '"');
	}
	if (value.startsWith("'") && value.endsWith("'")) {
		// Single-quoted: only '' escape (doubled apostrophe → single)
		return value.slice(1, -1).replace(/''/g, "'");
	}
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;

	const n = Number(value);
	if (Number.isFinite(n) && value !== "") return n;

	return value;
}
