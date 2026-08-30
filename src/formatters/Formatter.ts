/**
 * Locale-bound value formatting on top of ECMA-402 (AdonisJS `Formatter`
 * parity). Usable standalone — `new Formatter('fr')` — and used as the base
 * class of `RosettaLocale`, which is why every method takes its locale from the
 * instance rather than a parameter.
 *
 * All the heavy `Intl.*` objects are memoized in `IntlFormatterCache`, so a
 * `Formatter` is a one-field object and constructing one per call is free
 * relative to the formatting itself.
 */

import {
	getDateTimeFormatter,
	getDisplayNamesFormatter,
	getListFormatter,
	getNumberFormatter,
	getPluralRules,
	getRelativeTimeFormatter,
} from "./IntlFormatterCache.js";

/**
 * A value acceptable wherever a date/time is expected: a native `Date`, an
 * epoch milliseconds number, an ISO string, or any Luxon-like object — matched
 * structurally, so no date library is a dependency.
 */
export type DateTimeValue =
	| Date
	| number
	| string
	| { toJSDate(): Date }
	| { toMillis(): number };

/**
 * Options for `formatCurrency`. `style` is implied and `unit`/`unitDisplay`
 * belong to unit formatting, so they are excluded; `currency` is required.
 */
export type CurrencyFormatOptions = Omit<
	Intl.NumberFormatOptions,
	"style" | "unit" | "unitDisplay"
> & {
	currency: string;
};

/** `Intl.NumberFormat.format` also accepts strings and bigints at runtime. */
export interface StringNumberFormat extends Intl.NumberFormat {
	format(value: number | bigint | string): string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

const RELATIVE_UNIT_MS: Record<Intl.RelativeTimeFormatUnit, number> = {
	year: YEAR_MS,
	years: YEAR_MS,
	quarter: YEAR_MS / 4,
	quarters: YEAR_MS / 4,
	month: YEAR_MS / 12,
	months: YEAR_MS / 12,
	week: 7 * DAY_MS,
	weeks: 7 * DAY_MS,
	day: DAY_MS,
	days: DAY_MS,
	hour: 60 * 60 * 1000,
	hours: 60 * 60 * 1000,
	minute: 60 * 1000,
	minutes: 60 * 1000,
	second: 1000,
	seconds: 1000,
};

/** Canonical form used as the cache key everywhere: `fr_CH` and ` FR-ch ` both become `fr-ch`. */
export function normalizeLocale(locale: string): string {
	return locale.trim().replace(/_/g, "-").toLowerCase();
}

function normalizeDateTimeValue(value: DateTimeValue): Date | number {
	if (value instanceof Date || typeof value === "number") return value;
	if (typeof value === "string") return new Date(value);
	if ("toJSDate" in value) return value.toJSDate();
	return value.toMillis();
}

/**
 * Pick the largest unit that still says something.
 *
 * `Math.floor` rounds a negative value AWAY from zero, so ninety minutes reads
 * "in 1 hour" ahead and "2 hours ago" behind — the same distance answered two
 * ways depending on its direction. That asymmetry is upstream's, kept
 * deliberately: the rounding decides user-visible strings, and a migrated
 * application whose timestamps started reading differently would have no way
 * of knowing why.
 */
function formatRelativeAuto(
	formatter: Intl.RelativeTimeFormat,
	diffMs: number,
): string {
	const abs = Math.abs(diffMs);
	const MINUTE = 60 * 1000;
	const HOUR = 60 * MINUTE;
	const MONTH = YEAR_MS / 12;
	if (abs < MINUTE)
		return formatter.format(Math.floor(diffMs / 1000), "seconds");
	if (abs < HOUR)
		return formatter.format(Math.floor(diffMs / MINUTE), "minutes");
	if (abs < DAY_MS) return formatter.format(Math.floor(diffMs / HOUR), "hours");
	if (abs < MONTH) return formatter.format(Math.floor(diffMs / DAY_MS), "days");
	if (abs < YEAR_MS)
		return formatter.format(Math.floor(diffMs / MONTH), "months");
	return formatter.format(Math.floor(diffMs / YEAR_MS), "years");
}

/** Locale-aware value formatting. Mirrors AdonisJS's `Formatter`. */
export class Formatter {
	#locale: string;

	constructor(locale: string) {
		this.#locale = normalizeLocale(locale);
	}

	/** The active locale, normalized. */
	get locale(): string {
		return this.#locale;
	}

	/** Point this instance at another locale, in place. */
	switchLocale(locale: string): void {
		this.#locale = normalizeLocale(locale);
	}

	formatNumber(
		value: string | number | bigint,
		options?: Intl.NumberFormatOptions,
	): string {
		const formatter = getNumberFormatter(
			this.#locale,
			options,
		) as StringNumberFormat;
		return formatter.format(value);
	}

	formatCurrency(
		value: string | number | bigint,
		options: CurrencyFormatOptions,
	): string;
	/** @deprecated Prefer the options-bag form `formatCurrency(value, { currency })`. */
	formatCurrency(
		value: string | number | bigint,
		currency: string,
		options?: Intl.NumberFormatOptions,
	): string;
	formatCurrency(
		value: string | number | bigint,
		optionsOrCurrency: string | CurrencyFormatOptions,
		legacyOptions?: Intl.NumberFormatOptions,
	): string {
		// Spread caller options FIRST so explicit `style: "currency"` and
		// `currency` always win — a caller's stray `{ style: "decimal" }`
		// must not silently disable currency formatting.
		if (typeof optionsOrCurrency === "string") {
			return this.formatNumber(value, {
				...legacyOptions,
				style: "currency",
				currency: optionsOrCurrency,
			});
		}
		const { currency, ...rest } = optionsOrCurrency;
		return this.formatNumber(value, { ...rest, style: "currency", currency });
	}

	formatDate(
		value: DateTimeValue,
		options?: Intl.DateTimeFormatOptions,
	): string {
		const date = new Date(normalizeDateTimeValue(value));
		return getDateTimeFormatter(this.#locale, options).format(date);
	}

	/**
	 * Format a value as a locale-aware time. Defaults to `timeStyle: "medium"`
	 * (AdonisJS parity) unless the caller supplies explicit `hour`/`minute`/
	 * `second` components.
	 */
	formatTime(
		value: DateTimeValue,
		options?: Intl.DateTimeFormatOptions,
	): string {
		let opts = options;
		if (!opts) {
			opts = { timeStyle: "medium" };
		} else if (!opts.hour && !opts.minute && !opts.second) {
			opts = { timeStyle: "medium", ...opts };
		}
		return this.formatDate(value, opts);
	}

	/**
	 * Format a relative time. Accepts a `Date`, an ISO string, or a number
	 * (a diff already expressed in `unit` — or in milliseconds when
	 * `unit === "auto"`). With `"auto"`, the largest sensible unit is chosen.
	 */
	formatRelativeTime(
		value: DateTimeValue,
		unit: Intl.RelativeTimeFormatUnit | "auto",
		options?: Intl.RelativeTimeFormatOptions,
	): string {
		const diff = this.#getTimeDiff(value, unit);
		const formatter = getRelativeTimeFormatter(this.#locale, options);
		if (unit === "auto") {
			return formatRelativeAuto(formatter, diff);
		}
		return formatter.format(
			typeof value === "number" ? diff : Math.floor(diff),
			unit,
		);
	}

	/**
	 * Format a numeric value to its CLDR plural category
	 * (`"zero" | "one" | "two" | "few" | "many" | "other"`).
	 */
	formatPlural(
		value: number | string,
		options?: Intl.PluralRulesOptions,
	): string {
		return getPluralRules(this.#locale, options).select(Number(value));
	}

	/** Format an iterable of strings into a locale-aware sentence list. */
	formatList(list: Iterable<string>, options?: Intl.ListFormatOptions): string {
		return getListFormatter(this.#locale, options).format(list);
	}

	/**
	 * Format a language / region / currency / script code to its localized
	 * display name.
	 */
	formatDisplayNames(
		code: string,
		options: Intl.DisplayNamesOptions,
	): string | undefined {
		return getDisplayNamesFormatter(this.#locale, options).of(code);
	}

	#getTimeDiff(
		value: DateTimeValue,
		unit: Intl.RelativeTimeFormatUnit | "auto",
	): number {
		// A number is already a diff expressed in `unit` (milliseconds for auto).
		if (typeof value === "number") {
			return value;
		}
		const date = new Date(normalizeDateTimeValue(value));
		const diffMs = date.getTime() - Date.now();
		if (unit === "auto") {
			return diffMs;
		}
		return diffMs / RELATIVE_UNIT_MS[unit];
	}
}
