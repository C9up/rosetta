/**
 * What `node ace configure @c9up/rosetta` leaves behind.
 *
 * The meta-file entry is the one worth a test: without it the build emits a
 * `dist/` that boots and then answers every lookup with `translation missing`,
 * and nothing says why.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configure } from "../../src/configure.js";

interface Recorded {
	providers: string[];
	files: string[];
	metaFiles: Array<{ pattern: string; reloadServer: boolean | undefined }>;
}

/**
 * Read a stub the way `codemods.makeUsingStub` does.
 *
 * The real file, not a fixture: a test that stubbed this out would pass with
 * a stub that does not exist.
 */
function renderStub(
	stubsRoot: string,
	stubPath: string,
	state: Record<string, string | number | boolean>,
): { to: string; body: string } {
	const raw = readFileSync(resolve(stubsRoot, stubPath), "utf8");
	const [, front = "", body = ""] = raw.split(/^---\r?\n/m, 3);
	const declared = /^to:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
	const render = (text: string): string =>
		text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
			state[key] === undefined ? match : String(state[key]),
		);
	return { to: render(declared), body: render(body) };
}

function spy(options: { withMetaFile?: boolean } = {}) {
	const recorded: Recorded = { providers: [], files: [], metaFiles: [] };
	const codemods = {
		async addProvider(importPath: string) {
			recorded.providers.push(importPath);
		},
		async makeUsingStub(
			stubsRoot: string,
			stubPath: string,
			state: Record<string, string | number | boolean> = {},
		) {
			const { to, body } = renderStub(stubsRoot, stubPath, state);
			await this.writeFile(to);
			return { path: to, contents: body };
		},
		async writeFile(filePath: string) {
			recorded.files.push(filePath);
		},
		...(options.withMetaFile === false
			? {}
			: {
					async addMetaFile(pattern: string, reloadServer?: boolean) {
						recorded.metaFiles.push({ pattern, reloadServer });
					},
				}),
	};
	return { codemods, recorded };
}

describe("rosetta > configure", () => {
	it("registers the translations so the build ships them", async () => {
		const { codemods, recorded } = spy();
		await configure(codemods);
		expect(recorded.metaFiles).toEqual([
			{ pattern: "resources/lang/**/*.{json,yaml,yml}", reloadServer: false },
		]);
	});

	it("asks for NO restart, matching upstream", async () => {
		// Translations are read once at boot; upstream passes `false` for the
		// same reason, and a `true` here would restart the server on every
		// wording tweak.
		const { codemods, recorded } = spy();
		await configure(codemods);
		expect(recorded.metaFiles[0]?.reloadServer).toBe(false);
	});

	it("still registers the provider and the config file", async () => {
		const { codemods, recorded } = spy();
		await configure(codemods);
		expect(recorded.providers).toContain("@c9up/rosetta/i18n_provider");
		expect(recorded.files).toContain("config/i18n.ts");
	});

	it("survives a CLI that has no addMetaFile", async () => {
		// Configuring against an older CLI skips the entry rather than failing
		// the install half-way through.
		const { codemods, recorded } = spy({ withMetaFile: false });
		await expect(configure(codemods)).resolves.toBeUndefined();
		expect(recorded.providers).toContain("@c9up/rosetta/i18n_provider");
	});
});
