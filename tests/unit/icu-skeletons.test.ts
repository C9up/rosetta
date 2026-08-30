/**
 * ICU skeletons — the `::` syntax a message uses to say how a number or a date
 * should look.
 *
 * The skeleton parser is the largest thing in this package and the least
 * exercised: it turns a compact string into `Intl` options, and getting a
 * mapping wrong produces output that is plausible and wrong. Each expectation
 * below is computed from `Intl` independently, so what is being checked is the
 * MAPPING rather than the formatting.
 */
import { describe, expect, it } from "vitest";
import { IcuFormatter } from "../../src/formatters/IcuFormatter.js";

const icu = new IcuFormatter();
const en = (message: string, data: Record<string, unknown> = {}) =>
	icu.format(message, "en-US", data);
const fr = (message: string, data: Record<string, unknown> = {}) =>
	icu.format(message, "fr-FR", data);

/** The same value through Intl, so the test does not restate the library. */
const intl = (
	value: number,
	options: Intl.NumberFormatOptions,
	locale = "en-US",
) => new Intl.NumberFormat(locale, options).format(value);

describe("rosetta > number skeletons", () => {
	it("formats a currency", () => {
		expect(en("{v, number, ::currency/EUR}", { v: 1234.5 })).toBe(
			intl(1234.5, { style: "currency", currency: "EUR" }),
		);
		expect(fr("{v, number, ::currency/EUR}", { v: 1234.5 })).toBe(
			intl(1234.5, { style: "currency", currency: "EUR" }, "fr-FR"),
		);
	});

	it("adds a percent sign without scaling, unlike the classic style", () => {
		// The distinction is the specification's, and it catches people out:
		// the classic `percent` style multiplies by 100, the `::percent`
		// skeleton only marks the unit. A value already expressed in percent
		// would be multiplied twice by the other one.
		expect(en("{v, number, ::percent}", { v: 26 })).toBe("26%");
		expect(en("{v, number, percent}", { v: 0.26 })).toBe(
			intl(0.26, { style: "percent" }),
		);
	});

	it("compacts, short and long", () => {
		expect(en("{v, number, ::compact-short}", { v: 12_400 })).toBe(
			intl(12_400, { notation: "compact", compactDisplay: "short" }),
		);
		expect(en("{v, number, ::compact-long}", { v: 12_400 })).toBe(
			intl(12_400, { notation: "compact", compactDisplay: "long" }),
		);
	});

	it("switches notation", () => {
		expect(en("{v, number, ::scientific}", { v: 12_400 })).toBe(
			intl(12_400, { notation: "scientific" }),
		);
		expect(en("{v, number, ::engineering}", { v: 12_400 })).toBe(
			intl(12_400, { notation: "engineering" }),
		);
	});

	it("turns grouping off", () => {
		expect(en("{v, number, ::group-off}", { v: 1_234_567 })).toBe(
			intl(1_234_567, { useGrouping: false }),
		);
	});

	it("controls the sign", () => {
		expect(en("{v, number, ::sign-always}", { v: 42 })).toBe(
			intl(42, { signDisplay: "always" }),
		);
		expect(en("{v, number, ::sign-never}", { v: -42 })).toBe(
			intl(-42, { signDisplay: "never" }),
		);
		expect(en("{v, number, ::sign-accounting currency/USD}", { v: -42 })).toBe(
			intl(-42, {
				style: "currency",
				currency: "USD",
				currencySign: "accounting",
			}),
		);
	});

	it("fixes the fraction digits", () => {
		// `.00` is exactly two, `.##` is at most two.
		expect(en("{v, number, ::.00}", { v: 1.5 })).toBe(
			intl(1.5, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
		);
		expect(en("{v, number, ::.##}", { v: 1.5 })).toBe(
			intl(1.5, { minimumFractionDigits: 0, maximumFractionDigits: 2 }),
		);
	});

	it("rounds to an integer", () => {
		expect(en("{v, number, ::precision-integer}", { v: 1.6 })).toBe(
			intl(1.6, { maximumFractionDigits: 0 }),
		);
	});

	it("combines several stems", () => {
		expect(en("{v, number, ::currency/USD .00 group-off}", { v: 1234.5 })).toBe(
			intl(1234.5, {
				style: "currency",
				currency: "USD",
				minimumFractionDigits: 2,
				maximumFractionDigits: 2,
				useGrouping: false,
			}),
		);
	});
});

describe("rosetta > the classic number styles", () => {
	it("still understands the pre-skeleton names", () => {
		expect(en("{v, number, integer}", { v: 1.6 })).toBe(
			intl(1.6, { maximumFractionDigits: 0 }),
		);
		expect(en("{v, number, percent}", { v: 0.5 })).toBe(
			intl(0.5, { style: "percent" }),
		);
	});

	it("refuses a style it does not know, rather than formatting it plainly", () => {
		// Silently ignoring the style is how a price renders without its
		// currency and nobody notices until a customer does.
		expect(() => en("{v, number, nonsense}", { v: 1 })).toThrow();
	});
});

describe("rosetta > date skeletons", () => {
	const when = new Date(Date.UTC(2026, 2, 14, 15, 9, 26));

	it("reads a symbol skeleton", () => {
		const out = en("{d, date, ::yyyyMMdd}", { d: when });

		// The symbols asked for a numeric year, month and day, and nothing else.
		expect(out).toMatch(/2026/);
		expect(out).not.toMatch(/15|:/);
	});

	it("reads the time symbols separately from the date ones", () => {
		const out = en("{d, time, ::jm}", { d: when });

		// Hour and minute, and no date.
		expect(out).toMatch(/\d{1,2}[:h]\d{2}/);
		expect(out).not.toMatch(/2026/);
	});

	it("refuses a named style dressed up as a skeleton", () => {
		// `dateStyle/full` is an Intl option, not a skeleton. Reading it as
		// symbols would silently produce something else entirely, so it is
		// named and refused.
		expect(() => en("{d, date, ::dateStyle/full}", { d: when })).toThrow(
			/Unsupported ICU date skeleton field/,
		);
	});

	it("still understands the pre-skeleton names", () => {
		for (const style of ["short", "medium", "long", "full"] as const) {
			expect(en(`{d, date, ${style}}`, { d: when })).toBe(
				new Intl.DateTimeFormat("en-US", { dateStyle: style }).format(when),
			);
		}
	});

	it("takes a Date, a timestamp or a parseable string alike", () => {
		const expected = en("{d, date, short}", { d: when });

		expect(en("{d, date, short}", { d: when.getTime() })).toBe(expected);
		expect(en("{d, date, short}", { d: when.toISOString() })).toBe(expected);
	});

	it("refuses a date it cannot read", () => {
		expect(() => en("{d, date, short}", { d: "not a date" })).toThrow();
	});
});

describe("rosetta > plural and select", () => {
	const message =
		"{count, plural, =0 {nobody} one {one guest} other {# guests}}";

	it("matches the exact case before the category", () => {
		expect(en(message, { count: 0 })).toBe("nobody");
		expect(en(message, { count: 1 })).toBe("one guest");
		expect(en(message, { count: 5 })).toBe("5 guests");
	});

	it("substitutes # with the value, formatted for the locale", () => {
		expect(en(message, { count: 1234 })).toBe(`${intl(1234, {})} guests`);
	});

	it("applies an offset to what # shows", () => {
		const offset =
			"{count, plural, offset:1 =1 {you} other {you and # others}}";

		expect(en(offset, { count: 1 })).toBe("you");
		expect(en(offset, { count: 4 })).toBe("you and 3 others");
	});

	it("selects on ordinal categories, not cardinal ones", () => {
		const ordinal =
			"{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";

		expect(en(ordinal, { n: 1 })).toBe("1st");
		expect(en(ordinal, { n: 2 })).toBe("2nd");
		expect(en(ordinal, { n: 3 })).toBe("3rd");
		expect(en(ordinal, { n: 11 })).toBe("11th");
	});

	it("selects on a plain value, falling back to other", () => {
		const select = "{g, select, female {her} male {his} other {their}}";

		expect(en(select, { g: "female" })).toBe("her");
		expect(en(select, { g: "unknown" })).toBe("their");
	});

	it("nests one inside another", () => {
		const nested =
			"{g, select, female {{n, plural, one {her guest} other {her # guests}}} other {none}}";

		expect(en(nested, { g: "female", n: 3 })).toBe("her 3 guests");
	});
});

describe("rosetta > escaping", () => {
	it("takes a quoted brace literally", () => {
		expect(en("'{'not an argument'}'")).toBe("{not an argument}");
	});

	it("takes a doubled quote as one quote", () => {
		expect(en("it''s here")).toBe("it's here");
	});

	it("leaves a lone quote alone outside a special sequence", () => {
		expect(en("it's fine")).toBe("it's fine");
	});
});

describe("rosetta > the rest of the skeleton vocabulary", () => {
	it("formats a measurement unit", () => {
		expect(en("{v, number, ::measure-unit/length-meter}", { v: 12 })).toBe(
			intl(12, { style: "unit", unit: "meter" }),
		);
		expect(
			en("{v, number, ::unit/length-kilometer unit-width-full-name}", {
				v: 12,
			}),
		).toBe(intl(12, { style: "unit", unit: "kilometer", unitDisplay: "long" }));
	});

	it("formats a rate, one unit per another", () => {
		expect(
			en(
				"{v, number, ::measure-unit/length-meter per-measure-unit/duration-second}",
				{
					v: 5,
				},
			),
		).toBe(intl(5, { style: "unit", unit: "meter-per-second" }));
	});

	it("pads the integer part to a minimum width", () => {
		// `000` asks for at least three digits — an invoice number that has to
		// line up in a column.
		expect(en("{v, number, ::integer-width/*000}", { v: 7 })).toBe(
			intl(7, { minimumIntegerDigits: 3 }),
		);
	});

	it("scales the value before formatting", () => {
		expect(en("{v, number, ::scale/100}", { v: 0.26 })).toBe(intl(26, {}));
	});

	it("takes a rounding mode", () => {
		// `half-up` rounds a tie away from zero, where `half-even` rounds to the
		// even neighbour — 2.5 is exactly the value that tells them apart.
		expect(
			en("{v, number, ::precision-integer rounding-mode-half-up}", { v: 2.5 }),
		).toBe("3");
		expect(
			en("{v, number, ::precision-integer rounding-mode-half-even}", {
				v: 2.5,
			}),
		).toBe("2");
	});

	it("rounds to an increment", () => {
		// Prices that always end in .05.
		expect(en("{v, number, ::precision-increment/0.05}", { v: 2.03 })).toBe(
			"2.05",
		);
	});

	it("names a stem it does not know instead of ignoring it", () => {
		// Ignoring an unknown stem is how a price loses its currency and nobody
		// notices until a customer does.
		expect(() => en("{v, number, ::invented-stem}", { v: 1 })).toThrow(
			/Unsupported ICU number skeleton token/,
		);
	});

	it("refuses a value that is not a number", () => {
		expect(() => en("{v, number, ::percent}", { v: "lots" })).toThrow();
	});

	it("formats a bigint without going through a float", () => {
		// Past 2^53 a float has already lost digits, so the value must never
		// become one.
		expect(en("{v, number, ::group-off}", { v: 9007199254740993n })).toBe(
			"9007199254740993",
		);
	});
});
