import { describe, expect, it } from "vitest";
import { Rosetta, type RosettaLoader } from "../../src/Rosetta.js";

describe("rosetta > Rosetta > locale getters/setters", () => {
	it("constructor normalizes locale (case + underscore → dash)", () => {
		const r = new Rosetta({ defaultLocale: "EN_US" });
		expect(r.getLocale()).toBe("en-us");
		expect(r.getDefaultLocale()).toBe("en-us");
	});

	it("setLocale + setDefaultLocale + setFallbackLocale all normalize", () => {
		const r = new Rosetta();
		r.setLocale("FR_CA");
		r.setDefaultLocale("EN_GB");
		r.setFallbackLocale("DE");
		expect(r.getLocale()).toBe("fr-ca");
		expect(r.getDefaultLocale()).toBe("en-gb");
		expect(r.getFallbackLocale()).toBe("de");
	});

	it("setSupportedLocales stores normalized values", () => {
		const r = new Rosetta();
		r.setSupportedLocales(["EN_US", "fr_CA"]);
		const supported = r.getSupportedLocales();
		expect(supported).toContain("en-us");
		expect(supported).toContain("fr-ca");
	});

	it("setFallbackLocales / getFallbackLocales normalize keys and values", () => {
		const r = new Rosetta();
		r.setFallbackLocales({ FR_CA: "FR", EN_GB: "EN" });
		expect(r.getFallbackLocales()).toEqual({ "fr-ca": "fr", "en-gb": "en" });
	});

	it("locale() builds a request-scoped RosettaLocale exposing the locale verbatim", () => {
		const r = new Rosetta({ defaultLocale: "en" });
		const fr = r.locale("FR_CA");
		expect(fr.getLocale()).toBe("fr-ca");
	});
});

describe("rosetta > Rosetta > resolveLocale (Accept-Language)", () => {
	it("returns the highest-quality supported locale", () => {
		const r = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en", "fr", "de"],
		});
		expect(r.resolveLocale("fr;q=0.9, en;q=1.0")).toBe("en");
		expect(r.resolveLocale("de;q=1.0, en;q=0.5")).toBe("de");
	});

	it("respects q-value ordering even when not in sorted input order", () => {
		const r = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en", "fr"],
		});
		expect(r.resolveLocale("en;q=0.1, fr;q=0.9")).toBe("fr");
	});

	it("falls back through the language chain when the exact tag isn't supported (en-GB → en)", () => {
		const r = new Rosetta({
			defaultLocale: "fr",
			supportedLocales: ["fr", "en"],
		});
		expect(r.resolveLocale("en-GB,en;q=0.8")).toBe("en");
	});

	it("uses defaultLocale when no Accept-Language entry matches", () => {
		const r = new Rosetta({
			defaultLocale: "fr",
			supportedLocales: ["fr"],
		});
		expect(r.resolveLocale("zh-Hant,ja")).toBe("fr");
	});

	it("accepts the LocaleResolverInput object form via `accepted` array", () => {
		const r = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en", "fr"],
		});
		expect(r.resolveLocale({ accepted: ["fr", "en"] })).toBe("fr");
	});

	it("accepts the LocaleResolverInput object form via `header` string", () => {
		const r = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en", "fr"],
		});
		expect(r.resolveLocale({ header: "fr" })).toBe("fr");
	});

	it("returns the first parsed locale verbatim when no supportedLocales is configured (open mode)", () => {
		const r = new Rosetta({ defaultLocale: "en" });
		expect(r.resolveLocale("zh-CN")).toBe("zh-cn");
	});

	it("discards preferences with invalid q-values", () => {
		const r = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en", "fr"],
		});
		expect(r.resolveLocale("fr;q=NaN, en;q=0.5")).toBe("en");
	});
});

describe("rosetta > Rosetta > formatNumber + formatCurrency + formatNumberString", () => {
	it("formats a plain number per the requested locale", () => {
		const r = new Rosetta({ defaultLocale: "fr" });
		expect(r.formatNumber(1234.5)).toMatch(/1\s?234[,.]5/);
	});

	it("formatCurrency forces style:currency + the requested currency code", () => {
		const r = new Rosetta();
		const result = r.formatCurrency(99.99, "USD", undefined, "en-US");
		expect(result).toMatch(/\$99\.99/);
	});

	it("formatCurrency preserves explicit style/currency over caller's stray options", () => {
		const r = new Rosetta();
		const result = r.formatCurrency(
			10,
			"EUR",
			{ style: "decimal" } satisfies Intl.NumberFormatOptions,
			"en-US",
		);
		// 'decimal' style would have stripped the symbol — but the implementation
		// re-applies style:'currency' on top, so the EUR symbol stays.
		expect(result).toMatch(/€/);
	});

	it("formatNumberString preserves precision for very large integers (no Number cast loss)", () => {
		const r = new Rosetta();
		const result = r.formatNumberString(
			"123456789012345678",
			undefined,
			"en-US",
		);
		expect(result).toContain("123,456,789,012,345,678");
	});

	it("getNumberFormatData exposes distinct decimal vs group separators", () => {
		const r = new Rosetta();
		const fr = r.getNumberFormatData("fr-FR");
		expect(typeof fr.decimal).toBe("string");
		expect(typeof fr.group).toBe("string");
		expect(fr.decimal).not.toBe(fr.group);
	});
});

describe("rosetta > Rosetta > formatDate + formatRelativeTime", () => {
	it("formatDate accepts Date / number / string inputs interchangeably", () => {
		const r = new Rosetta();
		const d = new Date(Date.UTC(2026, 0, 15));
		const out1 = r.formatDate(d, undefined, "en-US");
		const out2 = r.formatDate(d.getTime(), undefined, "en-US");
		const out3 = r.formatDate(d.toISOString(), undefined, "en-US");
		expect(out1).toBe(out2);
		expect(out1).toBe(out3);
	});

	it("formatRelativeTime returns localized relative phrases", () => {
		const r = new Rosetta();
		const en = r.formatRelativeTime(-1, "day", undefined, "en");
		expect(en).toMatch(/yesterday|1 day ago/i);
		const fr = r.formatRelativeTime(-1, "day", undefined, "fr");
		expect(fr.toLowerCase()).toMatch(/hier|il y a 1 jour/);
	});
});

describe("rosetta > Rosetta > loaders + boot", () => {
	it("boot() invokes every loader for each configured supported locale", async () => {
		const calls: string[] = [];
		const loader: RosettaLoader = {
			async load(locale) {
				calls.push(locale);
				return { hello: `Hello ${locale}` };
			},
		};
		const r = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en", "fr"],
			loaders: [loader],
		});
		await r.boot();
		expect(calls).toContain("en");
		expect(calls).toContain("fr");
	});

	it("loadLocale invokes loaders for an arbitrary locale on demand", async () => {
		const calls: string[] = [];
		const loader: RosettaLoader = {
			async load(locale) {
				calls.push(locale);
				return { x: locale };
			},
		};
		const r = new Rosetta({ loaders: [loader] });
		await r.loadLocale("ja");
		expect(calls).toContain("ja");
	});

	it("loadLocale silently skips loaders that return null/undefined", async () => {
		const nullLoader: RosettaLoader = {
			async load() {
				return null;
			},
		};
		const undefinedLoader: RosettaLoader = {
			async load() {
				return undefined;
			},
		};
		const r = new Rosetta({ loaders: [nullLoader, undefinedLoader] });
		await expect(r.loadLocale("ja")).resolves.toBeInstanceOf(Rosetta);
	});
});
