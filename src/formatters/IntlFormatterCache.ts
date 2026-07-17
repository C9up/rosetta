const MAX_FORMATTERS_PER_TYPE = 256;

class FormatterCache<T> {
	readonly #entries = new Map<string, T>();

	get(locale: string, options: object | undefined, create: () => T): T {
		const key = formatterKey(locale, options);
		if (key === null) return create();
		const cached = this.#entries.get(key);
		if (cached !== undefined) {
			this.#entries.delete(key);
			this.#entries.set(key, cached);
			return cached;
		}

		const formatter = create();
		if (this.#entries.size >= MAX_FORMATTERS_PER_TYPE) {
			const oldest = this.#entries.keys().next().value;
			if (oldest !== undefined) this.#entries.delete(oldest);
		}
		this.#entries.set(key, formatter);
		return formatter;
	}
}

function formatterKey(
	locale: string,
	options: object | undefined,
): string | null {
	if (!options) return JSON.stringify([locale, []]);
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) return null;

	const normalizedOptions: Array<[string, string]> = [];
	for (const [name, descriptor] of Object.entries(
		Object.getOwnPropertyDescriptors(options),
	)) {
		if (!("value" in descriptor)) return null;
		const value = descriptor.value;
		if (value === undefined) continue;
		if (
			value !== null &&
			!["string", "number", "boolean"].includes(typeof value)
		) {
			return null;
		}
		normalizedOptions.push([name, `${typeof value}:${String(value)}`]);
	}
	normalizedOptions.sort(([left], [right]) => left.localeCompare(right));
	return JSON.stringify([locale, normalizedOptions]);
}

const numberFormatters = new FormatterCache<Intl.NumberFormat>();
const dateTimeFormatters = new FormatterCache<Intl.DateTimeFormat>();
const relativeTimeFormatters = new FormatterCache<Intl.RelativeTimeFormat>();
const pluralRules = new FormatterCache<Intl.PluralRules>();
const listFormatters = new FormatterCache<Intl.ListFormat>();
const displayNamesFormatters = new FormatterCache<Intl.DisplayNames>();

export function getNumberFormatter(
	locale: string,
	options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
	return numberFormatters.get(
		locale,
		options,
		() => new Intl.NumberFormat(locale, options),
	);
}

export function getDateTimeFormatter(
	locale: string,
	options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
	return dateTimeFormatters.get(
		locale,
		options,
		() => new Intl.DateTimeFormat(locale, options),
	);
}

export function getRelativeTimeFormatter(
	locale: string,
	options?: Intl.RelativeTimeFormatOptions,
): Intl.RelativeTimeFormat {
	return relativeTimeFormatters.get(
		locale,
		options,
		() => new Intl.RelativeTimeFormat(locale, options),
	);
}

export function getPluralRules(
	locale: string,
	options?: Intl.PluralRulesOptions,
): Intl.PluralRules {
	return pluralRules.get(
		locale,
		options,
		() => new Intl.PluralRules(locale, options),
	);
}

export function getListFormatter(
	locale: string,
	options?: Intl.ListFormatOptions,
): Intl.ListFormat {
	return listFormatters.get(
		locale,
		options,
		() => new Intl.ListFormat(locale, options),
	);
}

export function getDisplayNamesFormatter(
	locale: string,
	options: Intl.DisplayNamesOptions,
): Intl.DisplayNames {
	return displayNamesFormatters.get(
		locale,
		options,
		() => new Intl.DisplayNames(locale, options),
	);
}
