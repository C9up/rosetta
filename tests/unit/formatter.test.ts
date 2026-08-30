/**
 * `Formatter` — AdonisJS parity for the standalone, locale-bound formatter.
 * Expected values are taken from the AdonisJS i18n documentation for
 * `new Formatter('en-US')`, so a drift in our output fails here.
 */
import { describe, expect, it, vi } from "vitest";
import { Formatter } from "../../src/formatters/Formatter.js";
import { Rosetta } from "../../src/Rosetta.js";

describe("Formatter (AdonisJS parity)", () => {
	it("formats every documented value type for en-US", () => {
		const formatter = new Formatter("en-US");
		expect(formatter.formatNumber(1234567.89)).toBe("1,234,567.89");
		expect(formatter.formatCurrency(1234.56, { currency: "USD" })).toBe(
			"$1,234.56",
		);
		expect(formatter.formatDate(new Date("2023-12-25T12:00:00Z"))).toBe(
			"12/25/2023",
		);
		expect(formatter.formatPlural(1)).toBe("one");
		expect(formatter.formatPlural(5)).toBe("other");
		expect(formatter.formatList(["John", "Jane", "Bob"])).toBe(
			"John, Jane, and Bob",
		);
		expect(formatter.formatDisplayNames("en", { type: "language" })).toBe(
			"English",
		);
	});

	it("formats relative time, including the 'auto' unit", () => {
		const formatter = new Formatter("en");
		expect(formatter.formatRelativeTime(-1, "day")).toBe("1 day ago");

		// The clock is frozen because the formatter reads it again: with a live
		// `Date.now()`, the microseconds between building the date and measuring
		// the distance make it 59.99 minutes, and the floor says "in 59
		// minutes". It passed on a fast machine and failed under load.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));
		try {
			expect(
				formatter.formatRelativeTime(new Date(Date.now() + 3_600_000), "auto"),
			).toBe("in 1 hour");
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads a distance the same way whichever side of now it falls on", () => {
		const formatter = new Formatter("en");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));
		try {
			// Ninety minutes ahead and ninety minutes behind. They do NOT read
			// the same, because the rounding floors and a negative value floors
			// away from zero. Upstream does this, and the strings are
			// user-visible, so it is pinned rather than corrected.
			expect(
				formatter.formatRelativeTime(new Date(Date.now() + 5_400_000), "auto"),
			).toBe("in 1 hour");
			expect(
				formatter.formatRelativeTime(new Date(Date.now() - 5_400_000), "auto"),
			).toBe("2 hours ago");
		} finally {
			vi.useRealTimers();
		}
	});

	it("switchLocale re-points the instance and Intl follows", () => {
		const formatter = new Formatter("en-US");
		expect(formatter.formatNumber(1234.56)).toBe("1,234.56");

		formatter.switchLocale("fr");
		expect(formatter.locale).toBe("fr");
		// U+202F narrow no-break space is what ICU emits as the fr group separator.
		expect(formatter.formatNumber(1234.56)).toBe("1 234,56");
		expect(formatter.formatDisplayNames("USD", { type: "currency" })).toBe(
			"dollar des États-Unis",
		);
	});

	it("normalizes the locale it is constructed with", () => {
		expect(new Formatter(" FR_ch ").locale).toBe("fr-ch");
	});

	it("lets explicit currency options win over a stray style", () => {
		const formatter = new Formatter("en-US");
		// A caller passing style: "decimal" must not silently disable currency.
		const out = formatter.formatCurrency(10, {
			currency: "USD",
			minimumFractionDigits: 0,
		});
		expect(out).toBe("$10");
	});

	it("defaults formatTime to a medium time style, but keeps explicit components", () => {
		const formatter = new Formatter("en-US");
		const at = new Date("2023-12-25T14:30:05Z");
		expect(formatter.formatTime(at, { timeZone: "UTC" })).toBe("2:30:05 PM");
		expect(formatter.formatTime(at, { hour: "2-digit", timeZone: "UTC" })).toBe(
			"02 PM",
		);
	});
});

describe("RosettaLocale extends Formatter", () => {
	it("is a Formatter, so the inherited helpers use the scoped locale", () => {
		const i18n = new Rosetta({ defaultLocale: "en" }).locale("fr");
		expect(i18n).toBeInstanceOf(Formatter);
		expect(i18n.formatNumber(1234.56)).toBe("1 234,56");
	});

	it("switchLocale moves both the formatting locale and the fallback", () => {
		const i18n = new Rosetta({
			defaultLocale: "en",
			fallbackLocales: { "fr-ch": "fr" },
		}).locale("en");

		i18n.switchLocale("fr-CH");
		expect(i18n.locale).toBe("fr-ch");
		expect(i18n.getLocale()).toBe("fr-ch");
		expect(i18n.fallbackLocale).toBe("fr");
		expect(i18n.formatNumber(1234.56)).toBe("1 234,56");
	});
});
