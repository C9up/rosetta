import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Formatter } from "../../src/formatters/Formatter.js";
import { Rosetta } from "../../src/Rosetta.js";

/**
 * A date-only ISO string names a calendar day, not an instant. Read as UTC
 * midnight, it lands on the previous day anywhere west of UTC — so the suite
 * runs under one such zone. Set before the first format: Intl formatters are
 * cached and capture the zone they were built under.
 */
let previousTz: string | undefined;

beforeAll(() => {
	previousTz = process.env.TZ;
	process.env.TZ = "America/New_York";
});

afterAll(() => {
	if (previousTz === undefined) delete process.env.TZ;
	else process.env.TZ = previousTz;
});

describe("rosetta > date-only ISO strings in a zone west of UTC", () => {
	it("runs under a negative offset", () => {
		expect(new Date(2024, 0, 1).getTimezoneOffset()).toBeGreaterThan(0);
	});

	it("formatDate keeps the calendar day", () => {
		const formatter = new Formatter("en-US");
		expect(formatter.formatDate("2024-01-01")).toBe("1/1/2024");
		expect(formatter.formatDate("2024-03-10", { dateStyle: "long" })).toBe(
			"March 10, 2024",
		);
	});

	it("reads the year and year-month forms as local too", () => {
		const formatter = new Formatter("en-US");
		expect(formatter.formatDate("2024")).toBe("1/1/2024");
		expect(formatter.formatDate("2024-06")).toBe("6/1/2024");
	});

	it("keeps years below 100 as written", () => {
		const formatter = new Formatter("en-US");
		expect(formatter.formatDate("0099-12-31", { year: "numeric" })).toBe("99");
	});

	it("formatTime reads a date-only string as local midnight", () => {
		const formatter = new Formatter("en-US");
		expect(
			formatter.formatTime("2024-01-01", { hour: "2-digit", hour12: false }),
		).toBe("00");
	});

	it("still treats a string with an explicit offset as that instant", () => {
		const formatter = new Formatter("en-US");
		expect(formatter.formatDate("2024-01-01T00:00:00Z")).toBe("12/31/2023");
		// No offset on a date-time is local per ECMA-262, as in Luxon.
		expect(formatter.formatDate("2024-01-01T00:00:00")).toBe("1/1/2024");
	});

	it("rejects an impossible calendar day instead of rolling it over", () => {
		const formatter = new Formatter("en-US");
		expect(() => formatter.formatDate("2023-02-29")).toThrow(RangeError);
		expect(() => formatter.formatDate("2024-13-01")).toThrow(RangeError);
	});

	it("formatRelativeTime counts from local midnight", () => {
		const formatter = new Formatter("en-US");
		const now = new Date();
		const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
		const iso = [
			next.getFullYear(),
			String(next.getMonth() + 1).padStart(2, "0"),
			String(next.getDate()).padStart(2, "0"),
		].join("-");
		const hoursUntil = () =>
			Math.floor((next.getTime() - Date.now()) / (60 * 60 * 1000));
		const relative = new Intl.RelativeTimeFormat("en-US");
		const before = relative.format(hoursUntil(), "hour");
		const out = formatter.formatRelativeTime(iso, "hour");
		const after = relative.format(hoursUntil(), "hour");
		// Read as UTC midnight, the distance would be 4 or 5 hours short.
		expect([before, after]).toContain(out);
	});

	it("the ICU date and time arguments keep the calendar day", () => {
		const rosetta = new Rosetta({
			defaultLocale: "en-US",
			messages: {
				"en-US": {
					due: "Due {d, date, short}",
					at: "At {d, time, short}",
				},
			},
		});
		expect(rosetta.t("due", { d: "2024-01-01" })).toBe("Due 1/1/24");
		expect(rosetta.t("at", { d: "2024-01-01" })).toBe("At 12:00 AM");
	});
});
