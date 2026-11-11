import { describe, expect, it } from "vitest";
import { IcuFormatter } from "../../src/formatters/IcuFormatter.js";
import { Rosetta, type RosettaLoader } from "../../src/Rosetta.js";

describe("rosetta > Rosetta > locale getters/setters", () => {
	it("constructor keeps the default locale as written, matched loosely", () => {
		const r = new Rosetta({
			defaultLocale: "EN_US",
			messages: { "en-us": { a: "A" } },
		});
		expect(r.getLocale()).toBe("EN_US");
		expect(r.getDefaultLocale()).toBe("EN_US");
		// Case and underscore are lookup details: the catalog is still found.
		expect(r.t("a")).toBe("A");
	});

	it("setLocale + setDefaultLocale + setFallbackLocale keep the configured spelling", () => {
		const r = new Rosetta();
		r.setDefaultLocale("EN_GB");
		r.setFallbackLocale("DE");
		r.setLocale("en_gb");
		// The ambient locale reads back as the configured locale it matches.
		expect(r.getLocale()).toBe("EN_GB");
		expect(r.getDefaultLocale()).toBe("EN_GB");
		expect(r.getFallbackLocale()).toBe("DE");
		// An unconfigured locale has no spelling to restore: its lookup form.
		r.setLocale("FR_CA");
		expect(r.getLocale()).toBe("fr-ca");
	});

	it("setSupportedLocales keeps the values as written", () => {
		const r = new Rosetta();
		r.setSupportedLocales(["EN_US", "fr_CA"]);
		expect(r.getSupportedLocales()).toEqual(["EN_US", "fr_CA"]);
		expect(r.getSupportedLocaleFor("fr-ca")).toBe("fr_CA");
	});

	it("setFallbackLocales / getFallbackLocales keep keys and values as written", () => {
		const r = new Rosetta({ messages: { fr: { a: "FR" } } });
		r.setFallbackLocales({ FR_CA: "FR", EN_GB: "EN" });
		expect(r.getFallbackLocales()).toEqual({ FR_CA: "FR", EN_GB: "EN" });
		expect(r.locale("fr-ca").t("a")).toBe("FR");
	});

	it("locale() builds a request-scoped RosettaLocale exposing the locale verbatim", () => {
		const r = new Rosetta({ defaultLocale: "en" });
		const fr = r.locale("FR_CA");
		expect(fr.getLocale()).toBe("FR_CA");
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

	it("negotiates against the inferred locales when no supportedLocales is configured", () => {
		// The client's token is never handed back as is: it is negotiated
		// against the default locale, the fallback map and the catalogs loaded,
		// the list supportedLocales() and getSupportedLocaleFor() use.
		const r = new Rosetta({
			defaultLocale: "en",
			messages: { fr: { hello: "Bonjour" } },
		});
		expect(r.resolveLocale("zh-CN")).toBe("en");
		expect(r.resolveLocale("fr")).toBe("fr");
		expect(r.resolveLocale("de, fr;q=0.5")).toBe("fr");
	});

	it("tries every accepted locale before the default, with a configured list too", () => {
		const r = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en", "fr"],
		});
		expect(r.resolveLocale("de, fr;q=0.5")).toBe("fr");
		expect(r.resolveLocale("fr-CA, en;q=0.5")).toBe("fr");
		expect(r.resolveLocale("de")).toBe("en");
	});

	it("never resolves to an untrusted header token that Intl would throw on", () => {
		// `Accept-Language: *` is a legitimate header value; resolved verbatim it
		// became the locale of every formatter, and `Intl` threw on it.
		const r = new Rosetta({
			defaultLocale: "en",
			messages: { en: { items: "{n, plural, one {# item} other {# items}}" } },
		});
		for (const header of ["*", "../../etc/passwd", "x".repeat(100)]) {
			const locale = r.resolveLocale({ header });
			expect(locale, header).toBe("en");
			const scoped = r.locale(locale);
			expect(scoped.t("items", { n: 1 })).toBe("1 item");
			expect(scoped.formatNumber(1234.5)).toBe("1,234.5");
		}
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

/**
 * What intl-messageformat renders for the same message (with `ignoreTag`, as
 * the upstream formatter builds it). `#` is special only directly inside a
 * plural or selectordinal, an apostrophe quotes only before a character that is
 * special where it stands, and a `}` that closes nothing is text.
 */
describe("rosetta > IcuFormatter > upstream syntax parity", () => {
	const icu = new IcuFormatter();
	const cases: Array<[string, Record<string, unknown>, string]> = [
		[
			"{n, plural, other {{g, select, a {# items} other {x}}}}",
			{ n: 3, g: "a" },
			"# items",
		],
		["It''s '{literal}' and '#'", {}, "It's {literal} and '#'"],
		["a } b", {}, "a } b"],
		["a }} b {x} c }", { x: 1 }, "a }} b 1 c }"],
		["{x}}", { x: 1 }, "1}"],
		["'<b>' and '>' and '<'", {}, "<b> and > and <"],
		["{n, plural, other {'#' is # and '<b>'}}", { n: 2 }, "# is 2 and <b>"],
		["'#{x}'", { x: 1 }, "'#1'"],
		["{n, plural, other {'#{x}'}}", { n: 1, x: 2 }, "#{x}"],
		["{g, select, a {# sel} other {o}}", { g: "a" }, "# sel"],
		["{n, plural, other {{n, plural, other {# in}} #}}", { n: 2 }, "2 in 2"],
		[
			"{n, plural, other {{g, select, a {{m, plural, other {# m}}} other {x}} #}}",
			{ n: 2, g: "a", m: 5 },
			"5 m 2",
		],
		["{n, selectordinal, other {#th}}", { n: 2 }, "2th"],
		["# top", {}, "# top"],
		["x '' y", {}, "x ' y"],
		["'}' and '{'", {}, "} and {"],
	];

	for (const [message, data, expected] of cases) {
		it(`renders ${JSON.stringify(message)}`, () => {
			expect(icu.format(message, "en", data)).toBe(expected);
		});
	}

	it("still rejects a body that never closes", () => {
		expect(() =>
			icu.format("{n, plural, other {a } b}}", "en", { n: 1 }),
		).toThrow(SyntaxError);
		expect(() => icu.format("{x", "en", { x: 1 })).toThrow(SyntaxError);
	});
});

describe("rosetta > IcuFormatter > a non-numeric value for a numeric argument", () => {
	// `t("items", { n: req.query.n })` with `n = "abc"` threw out of t(), and a
	// page that used to render answered 500 over a bad query parameter. Intl's
	// own reading of such a value is NaN: the plural selects `other`, and the
	// number renders as "NaN" — which is what is rendered here too.
	const icu = new IcuFormatter();
	const cases: Array<[string, Record<string, unknown>, string]> = [
		["{n, plural, one {# item} other {# items}}", { n: "abc" }, "NaN items"],
		["{n, plural, =0 {none} other {some}}", { n: "abc" }, "some"],
		["{n, selectordinal, one {#st} other {#th}}", { n: "abc" }, "NaNth"],
		["{n, number}", { n: "abc" }, "NaN"],
		["{n, number, integer}", { n: {} }, "NaN"],
		["{n, plural, other {# left}}", { n: Number.POSITIVE_INFINITY }, "∞ left"],
		// A numeric string still reads as its number.
		["{n, plural, one {# item} other {# items}}", { n: "1" }, "1 item"],
	];

	for (const [message, data, expected] of cases) {
		it(`renders ${JSON.stringify(message)} with ${String(data.n)}`, () => {
			expect(icu.format(message, "en", data)).toBe(expected);
		});
	}

	it("still refuses a variable that was not provided at all", () => {
		expect(() => icu.format("{n, plural, other {# items}}", "en", {})).toThrow(
			/was not provided/,
		);
	});
});
