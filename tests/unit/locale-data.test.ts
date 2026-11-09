/**
 * Unit tests for `Rosetta.getNumberFormatData` and
 * `Rosetta.formatNumberString` — Story 35.8.
 */

import { describe, expect, it } from "vitest";
import { Rosetta } from "../../src/Rosetta.js";

describe("Rosetta.getNumberFormatData", () => {
	it("keeps a bounded cache however many locales callers invent", () => {
		const r = new Rosetta({ defaultLocale: "en" });
		const first = r.getNumberFormatData("en-x-first");
		expect(r.getNumberFormatData("en-x-first")).toBe(first);
		// Private-use tags are well formed, so each one resolves to itself: a
		// locale taken from user input could otherwise grow the heap forever.
		for (let i = 0; i < 10_000; i++) {
			const data = r.getNumberFormatData(`en-x-u${i.toString(36)}`);
			expect(data.decimal).toBe(".");
		}
		const again = r.getNumberFormatData("en-x-first");
		expect(again).not.toBe(first);
		expect(again).toEqual(first);
	});

	it("keeps a recently used locale cached", () => {
		const r = new Rosetta({ defaultLocale: "en" });
		const fr = r.getNumberFormatData("fr-FR");
		for (let i = 0; i < 1_000; i++) {
			r.getNumberFormatData(`en-x-u${i.toString(36)}`);
			// Read between every insertion, so it never becomes the oldest.
			expect(r.getNumberFormatData("fr-FR")).toBe(fr);
		}
	});

	it('returns the fr-FR separators for "fr-FR"', () => {
		const r = new Rosetta();
		const data = r.getNumberFormatData("fr-FR");
		expect(data.decimal).toBe(",");
		// fr-FR group separator is a narrow no-break space (U+202F)
		// on modern Node; older runtimes use a regular non-breaking
		// space. Accept either.
		expect([" ", " ", " "]).toContain(data.group);
		expect(data.minus).toBe("-");
		expect(["+", "+"]).toContain(data.plusSign);
	});

	it("honors fallbackLocales — eo-CUSTOM resolves through fr-FR", () => {
		const r = new Rosetta({
			fallbackLocales: { "eo-CUSTOM": "fr-FR" },
		});
		const data = r.getNumberFormatData("eo-CUSTOM");
		expect(data.decimal).toBe(",");
		// Group separator from fr-FR — same accept set as above.
		expect([" ", " ", " "]).toContain(data.group);
	});

	it("returns the data for the bound locale on RosettaLocale", () => {
		const r = new Rosetta();
		const fr = r.locale("fr-FR");
		const data = fr.getNumberFormatData();
		expect(data.decimal).toBe(",");
	});

	it("caches the result per resolved locale", () => {
		const r = new Rosetta();
		const a = r.getNumberFormatData("fr-FR");
		const b = r.getNumberFormatData("fr-FR");
		// Same resolved locale must return the cached object reference.
		expect(b).toBe(a);
	});
});

describe("Rosetta.formatNumberString", () => {
	it("preserves precision on 18-digit values via the string overload", () => {
		const r = new Rosetta();
		const out = r.formatNumberString(
			"1234567890123456.789",
			undefined,
			"en-US",
		);
		// Every significant digit must survive — no truncation.
		expect(out.replace(/[^0-9]/g, "")).toBe("1234567890123456789");
	});

	it("formats with locale separators for fr-FR", () => {
		const r = new Rosetta();
		const out = r.formatNumberString("1234.56", undefined, "fr-FR");
		expect(out).toContain(",");
		expect(out).toMatch(/56/);
	});

	it("preserves precision on 18-digit values for fr-FR (matches AC literal)", () => {
		const r = new Rosetta();
		const out = r.formatNumberString(
			"1234567890123456.789",
			undefined,
			"fr-FR",
		);
		expect(out.replace(/[^0-9]/g, "")).toBe("1234567890123456789");
		expect(out).toContain(",");
	});

	it("honors fallbackLocales for the resolved separators", () => {
		const r = new Rosetta({
			fallbackLocales: { "eo-CUSTOM": "fr-FR" },
		});
		const fallback = r.formatNumberString("1234.56", undefined, "eo-CUSTOM");
		const direct = r.formatNumberString("1234.56", undefined, "fr-FR");
		// Strip whitespace variants — both runs must produce the
		// same logical separator pattern.
		const normalize = (s: string) => s.replace(/[   ]/g, "·");
		expect(normalize(fallback)).toBe(normalize(direct));
	});

	it("accepts currency style options", () => {
		const r = new Rosetta();
		const out = r.formatNumberString(
			"1234.56",
			{ style: "currency", currency: "EUR" },
			"fr-FR",
		);
		expect(out).toMatch(/€|EUR/);
	});
});

describe("Rosetta.formatCurrency", () => {
	it("ignores stray `style: 'decimal'` in user options — currency wins", () => {
		const r = new Rosetta();
		const out = r.formatCurrency(
			1234.56,
			"EUR",
			{ style: "decimal" } as Intl.NumberFormatOptions,
			"fr-FR",
		);
		// Currency formatting MUST apply despite the override attempt.
		expect(out).toMatch(/€|EUR/);
	});
});
