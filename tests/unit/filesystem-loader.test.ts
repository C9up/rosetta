import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSystemLoader } from "../../src/loaders/FileSystemLoader.js";

describe("rosetta > FileSystemLoader > security", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rosetta-fs-"));
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("rejects locales with path traversal characters (../)", async () => {
		const loader = new FileSystemLoader({ rootDir: dir });
		expect(await loader.load("../etc/passwd")).toBe(null);
		expect(await loader.load("..%2fescape")).toBe(null);
		expect(await loader.load("/absolute")).toBe(null);
	});

	it("rejects locales with disallowed characters (only IANA BCP 47 shapes pass)", async () => {
		const loader = new FileSystemLoader({ rootDir: dir });
		expect(await loader.load("en_US")).toBe(null); // underscore not allowed
		expect(await loader.load("English")).toBe(null); // > 8 chars in subtag
		expect(await loader.load("e")).toBe(null); // < 2 chars
		expect(await loader.load("evil!")).toBe(null);
	});

	it("accepts BCP 47 shapes: 'en', 'en-US', 'zh-Hant-TW'", async () => {
		await fsp.writeFile(
			path.join(dir, "en.json"),
			JSON.stringify({ hello: "Hello" }),
		);
		await fsp.writeFile(
			path.join(dir, "en-US.json"),
			JSON.stringify({ hello: "Hi" }),
		);
		await fsp.writeFile(
			path.join(dir, "zh-Hant-TW.json"),
			JSON.stringify({ hello: "你好" }),
		);
		const loader = new FileSystemLoader({ rootDir: dir });

		expect(await loader.load("en")).toEqual({ hello: "Hello" });
		expect(await loader.load("en-US")).toEqual({ hello: "Hi" });
		expect(await loader.load("zh-Hant-TW")).toEqual({ hello: "你好" });
	});

	it("does not follow a flat locale symlink outside the language root", async () => {
		const outside = path.join(
			os.tmpdir(),
			`rosetta-outside-${Date.now()}.json`,
		);
		await fsp.writeFile(outside, JSON.stringify({ secret: "outside" }));
		try {
			await fsp.symlink(outside, path.join(dir, "en.json"));
			await expect(
				new FileSystemLoader({ rootDir: dir }).load("en"),
			).rejects.toBeTruthy();
		} finally {
			await fsp.rm(outside, { force: true });
		}
	});

	it("does not follow a locale directory symlink outside the language root", async () => {
		const outside = await fsp.mkdtemp(
			path.join(os.tmpdir(), "rosetta-outside-dir-"),
		);
		await fsp.writeFile(
			path.join(outside, "secret.json"),
			JSON.stringify({ value: "outside" }),
		);
		try {
			await fsp.symlink(outside, path.join(dir, "en"), "dir");
			await expect(
				new FileSystemLoader({ rootDir: dir }).load("en"),
			).rejects.toThrow(/symbolic link/);
		} finally {
			await fsp.rm(outside, { recursive: true, force: true });
		}
	});
});

describe("rosetta > FileSystemLoader > extension fallback", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rosetta-fs-"));
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("returns null when no file matches the locale on any supported extension", async () => {
		const loader = new FileSystemLoader({ rootDir: dir });
		expect(await loader.load("missing")).toBe(null);
	});

	it("prefers .json over .yaml when both exist", async () => {
		await fsp.writeFile(
			path.join(dir, "fr.json"),
			JSON.stringify({ source: "json" }),
		);
		await fsp.writeFile(path.join(dir, "fr.yaml"), "source: yaml");
		const loader = new FileSystemLoader({ rootDir: dir });
		expect(await loader.load("fr")).toEqual({ source: "json" });
	});

	it("falls back to .yaml when .json is missing", async () => {
		await fsp.writeFile(path.join(dir, "fr.yaml"), "title: Salut");
		const loader = new FileSystemLoader({ rootDir: dir });
		expect(await loader.load("fr")).toEqual({ title: "Salut" });
	});

	it("falls back to .yml when .json and .yaml are missing", async () => {
		await fsp.writeFile(path.join(dir, "fr.yml"), "title: Salut");
		const loader = new FileSystemLoader({ rootDir: dir });
		expect(await loader.load("fr")).toEqual({ title: "Salut" });
	});

	it("propagates non-ENOENT errors (malformed JSON must NOT be silenced)", async () => {
		await fsp.writeFile(path.join(dir, "broken.json"), "{ not valid json");
		const loader = new FileSystemLoader({ rootDir: dir });
		try {
			await loader.load("broken");
			expect.unreachable("malformed JSON should fail");
		} catch (error) {
			expect((error as Error).stack).toContain("at anonymous (broken.json)");
		}
	});

	it("trims a UTF-8 BOM from JSON catalogs like the Adonis loader", async () => {
		await fsp.writeFile(
			path.join(dir, "fr.json"),
			'\uFEFF{"greeting":"Bonjour"}',
		);
		await expect(
			new FileSystemLoader({ rootDir: dir }).load("fr"),
		).resolves.toEqual({ greeting: "Bonjour" });
	});

	it("rejects JSON arrays instead of flattening numeric indexes", async () => {
		await fsp.writeFile(
			path.join(dir, "broken.json"),
			JSON.stringify({ messages: ["one", "two"] }),
		);
		const loader = new FileSystemLoader({ rootDir: dir });
		await expect(loader.load("broken")).rejects.toThrow(
			/arrays are not allowed/,
		);
	});
});

describe("rosetta > FileSystemLoader > nested namespaces", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rosetta-fs-"));
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("prefixes nested files with their path (locale/ns.json → ns.*)", async () => {
		await fsp.mkdir(path.join(dir, "en", "admin"), { recursive: true });
		await fsp.writeFile(
			path.join(dir, "en", "messages.json"),
			JSON.stringify({ welcome: "Welcome" }),
		);
		await fsp.writeFile(
			path.join(dir, "en", "admin", "users.json"),
			JSON.stringify({ save: "Save" }),
		);
		const loader = new FileSystemLoader({ rootDir: dir });

		expect(await loader.load("en")).toEqual({
			messages: { welcome: "Welcome" },
			admin: { users: { save: "Save" } },
		});
	});

	it("merges the flat file with nested namespaces", async () => {
		await fsp.writeFile(
			path.join(dir, "en.json"),
			JSON.stringify({ hello: "Hi" }),
		);
		await fsp.mkdir(path.join(dir, "en"), { recursive: true });
		await fsp.writeFile(
			path.join(dir, "en", "validation.json"),
			JSON.stringify({ required: "Required" }),
		);
		const loader = new FileSystemLoader({ rootDir: dir });

		expect(await loader.load("en")).toEqual({
			hello: "Hi",
			validation: { required: "Required" },
		});
	});

	it("supports YAML namespace files", async () => {
		await fsp.mkdir(path.join(dir, "fr"), { recursive: true });
		await fsp.writeFile(path.join(dir, "fr", "app.yaml"), "title: Bonjour");
		const loader = new FileSystemLoader({ rootDir: dir });

		expect(await loader.load("fr")).toEqual({ app: { title: "Bonjour" } });
	});
});

describe("rosetta > FileSystemLoader > YAML parser", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rosetta-fs-"));
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	async function loadYaml(content: string): Promise<unknown> {
		await fsp.writeFile(path.join(dir, "fr.yaml"), content);
		return new FileSystemLoader({ rootDir: dir }).load("fr");
	}

	it("parses flat string values", async () => {
		expect(await loadYaml("hello: Hello\nbye: Goodbye")).toEqual({
			hello: "Hello",
			bye: "Goodbye",
		});
	});

	it("parses nested keys via indentation", async () => {
		const yaml = `app:\n  title: My App\n  meta:\n    author: hugo`;
		expect(await loadYaml(yaml)).toEqual({
			app: { title: "My App", meta: { author: "hugo" } },
		});
	});

	it("parses double-quoted strings with escape sequences", async () => {
		expect(await loadYaml('msg: "line1\\nline2\\ttab"')).toEqual({
			msg: "line1\nline2\ttab",
		});
	});

	it("parses single-quoted strings with doubled-apostrophe escape", async () => {
		expect(await loadYaml("name: 'O''Brien'")).toEqual({ name: "O'Brien" });
	});

	it("recognises true/false/null/numeric scalars", async () => {
		const yaml = `flag: true\noff: false\nnone: null\ncount: 42\nratio: 3.14`;
		expect(await loadYaml(yaml)).toEqual({
			flag: true,
			off: false,
			none: null,
			count: 42,
			ratio: 3.14,
		});
	});

	it("preserves URL values containing colons (not split as map keys)", async () => {
		const yaml = `url: https://example.com/path`;
		expect(await loadYaml(yaml)).toEqual({
			url: "https://example.com/path",
		});
	});

	it("strips inline comments after whitespace + #", async () => {
		expect(await loadYaml("name: hugo # this is a comment")).toEqual({
			name: "hugo",
		});
	});

	it("preserves hashes inside quoted scalar values", async () => {
		expect(await loadYaml('name: "hello # world" # comment')).toEqual({
			name: "hello # world",
		});
	});

	it("fails closed on unsupported YAML instead of partially loading it", async () => {
		await expect(loadYaml("items: [one, two]")).rejects.toThrow(
			/Unsupported YAML/,
		);
		await expect(loadYaml("- sequence item")).rejects.toThrow(
			/Unsupported YAML/,
		);
	});

	it("ignores blank lines and full-line comments", async () => {
		const yaml = `# top comment\nname: hugo\n\n# trailing comment`;
		expect(await loadYaml(yaml)).toEqual({ name: "hugo" });
	});

	it("parses block scalar `|` (literal newlines preserved)", async () => {
		const yaml = `desc: |\n  line one\n  line two\n`;
		expect(await loadYaml(yaml)).toEqual({ desc: "line one\nline two" });
	});

	it("parses block scalar `>` (folded — newlines become spaces, blank line = paragraph break)", async () => {
		const yaml = `desc: >\n  para one\n  continued\n\n  para two\n`;
		const result = await loadYaml(yaml);
		expect(result).toEqual({ desc: "para one continued\n\npara two" });
	});

	it("parses a mix of nested + scalars + comment in one document", async () => {
		const yaml = `# greetings\nen:\n  hello: Hello\n  bye: Goodbye  # farewell\nfr:\n  hello: Salut`;
		expect(await loadYaml(yaml)).toEqual({
			en: { hello: "Hello", bye: "Goodbye" },
			fr: { hello: "Salut" },
		});
	});

	it("supports quoted keys, exponent numbers, and case-insensitive core scalars", async () => {
		const yaml = `'message.key': Hello\nratio: 1.5e2\nenabled: TRUE\nmissing: ~`;
		expect(await loadYaml(yaml)).toEqual({
			"message.key": "Hello",
			ratio: 150,
			enabled: true,
			missing: null,
		});
	});

	it("rejects duplicate keys and unexpected indentation", async () => {
		await expect(loadYaml("name: first\nname: second")).rejects.toThrow(
			/Duplicate YAML key/,
		);
		await expect(loadYaml("name: first\n  nested: invalid")).rejects.toThrow(
			/indent/i,
		);
	});
});
