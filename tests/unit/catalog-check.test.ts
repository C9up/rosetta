/**
 * Cross-locale catalog reconciliation. Each test pins one drift kind to the
 * failure it actually prevents at runtime.
 */
import { describe, expect, it } from "vitest";
import {
	checkCatalogs,
	formatCatalogFindings,
	runCatalogCheck,
	suggestKey,
	verifyCatalogs,
} from "../../src/CatalogCheck.js";
import { Rosetta } from "../../src/Rosetta.js";

describe("checkCatalogs", () => {
	it("reports nothing when every locale agrees", () => {
		const findings = checkCatalogs({
			en: {
				greeting: "Hello {name}",
				items: "{n, plural, one {# item} other {# items}}",
			},
			fr: {
				greeting: "Bonjour {name}",
				items: "{n, plural, one {# objet} other {# objets}}",
			},
		});
		expect(findings).toEqual([]);
		expect(formatCatalogFindings(findings)).toContain("catalogs OK");
	});

	it("flags a key present in the reference locale and missing elsewhere", () => {
		const findings = checkCatalogs(
			{
				en: { greeting: "Hello", farewell: "Bye" },
				fr: { greeting: "Bonjour" },
			},
			{ referenceLocale: "en" },
		);
		expect(findings).toEqual([
			{
				locale: "fr",
				key: "farewell",
				kind: "missing-in-locale",
				detail: "present in 'en', missing here",
			},
		]);
	});

	it("flags an orphan key and suggests the reference key it typos", () => {
		const findings = checkCatalogs(
			{
				en: { greeting: "Hello" },
				fr: { greeting: "Bonjour", greetng: "Salut" },
			},
			{ referenceLocale: "en" },
		);
		const orphan = findings.find((f) => f.kind === "orphan-key");
		expect(orphan).toMatchObject({
			locale: "fr",
			key: "greetng",
			suggestion: "greeting",
		});
	});

	it("catches a renamed variable — the runtime error this exists to prevent", () => {
		const translations = {
			en: { items: "{count, plural, one {# item} other {# items}}" },
			fr: { items: "{n, plural, one {# objet} other {# objets}}" },
		};
		const findings = checkCatalogs(translations, { referenceLocale: "en" });
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			locale: "fr",
			key: "items",
			kind: "param-mismatch",
		});
		expect(findings[0].detail).toContain("n:plural");
		expect(findings[0].detail).toContain("count:plural");

		// Proof the drift is real: the fr message throws on the en call site.
		const i18n = new Rosetta({ defaultLocale: "en" }).locale("fr");
		expect(() =>
			i18n.formatRawMessage(translations.fr.items, { count: 2 }),
		).toThrow(/'n' was not provided/);
	});

	it("flags a variable whose type changed across locales", () => {
		const findings = checkCatalogs(
			{
				en: { total: "{amount, number}" },
				fr: { total: "{amount}" },
			},
			{ referenceLocale: "en" },
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ kind: "param-mismatch", key: "total" });
		expect(findings[0].detail).toContain("amount:text");
	});

	it("reports invalid ICU instead of throwing, so one bad message keeps the report", () => {
		const findings = checkCatalogs(
			{
				en: { ok: "fine", broken: "{count, plural, one {#}" },
				fr: { ok: "bien", broken: "{count, plural, one {#} other {#}}" },
			},
			{ referenceLocale: "en" },
		);
		const invalid = findings.find((f) => f.kind === "invalid-message");
		expect(invalid).toMatchObject({ locale: "en", key: "broken" });
		// The rest of the catalog was still compared.
		expect(findings.every((f) => f.key !== "ok")).toBe(true);
	});

	it("defaults the reference to the first locale, and handles an unknown one", () => {
		expect(checkCatalogs({ en: { a: "A" }, fr: {} })).toHaveLength(1);
		expect(checkCatalogs({}, {})).toEqual([]);
		expect(
			checkCatalogs({ en: { a: "A" } }, { referenceLocale: "de" })[0],
		).toMatchObject({ kind: "missing-in-locale", key: "<catalog>" });
	});

	it("ignores a select's branch keys differing — those are values, not variables", () => {
		// `male`/`female` are message content; only the variable name and kind bind
		// the call site, so a locale with different branches is not drift.
		const findings = checkCatalogs(
			{
				en: { g: "{gender, select, male {his} female {her} other {their}}" },
				fr: { g: "{gender, select, male {son} other {leur}}" },
			},
			{ referenceLocale: "en" },
		);
		expect(findings).toEqual([]);
	});
});

describe("verifyCatalogs / runCatalogCheck", () => {
	const drifted = { en: { a: "A", b: "B" }, fr: { a: "A" } };

	it("warns by default and throws on demand", () => {
		const warned: unknown[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => warned.push(args[0]);
		try {
			expect(verifyCatalogs(drifted, { referenceLocale: "en" })).toHaveLength(
				1,
			);
			expect(String(warned[0])).toContain("1 catalog issue(s) found");
		} finally {
			console.warn = original;
		}

		expect(() =>
			verifyCatalogs(drifted, { referenceLocale: "en", mode: "throw" }),
		).toThrow(/catalog issue/);
	});

	it("stays quiet when the catalogs agree", () => {
		const original = console.warn;
		let called = false;
		console.warn = () => {
			called = true;
		};
		try {
			expect(verifyCatalogs({ en: { a: "A" }, fr: { a: "A" } })).toEqual([]);
			expect(called).toBe(false);
		} finally {
			console.warn = original;
		}
	});

	it("returns an exit code", () => {
		const original = console.log;
		console.log = () => {};
		try {
			expect(runCatalogCheck(drifted, { referenceLocale: "en" })).toBe(1);
			expect(runCatalogCheck({ en: { a: "A" }, fr: { a: "A" } })).toBe(0);
		} finally {
			console.log = original;
		}
	});
});

describe("suggestKey", () => {
	it("suggests within edit distance 2, and nothing beyond", () => {
		expect(suggestKey("greetng", ["greeting", "farewell"])).toBe("greeting");
		expect(suggestKey("totally.different", ["greeting"])).toBeUndefined();
	});
});
