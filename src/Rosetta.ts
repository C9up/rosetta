import { createNativeEngine, type NativeRosettaEngine } from "./native.js";

export type TranslationParams = Record<
	string,
	string | number | boolean | Date | null | undefined
>;
export type MessageValue = string | number | boolean | null;
export type MessageTree = { [key: string]: MessageValue | MessageTree };
export type MessageCatalog = Record<string, string>;

export interface TranslateOptions {
	locale?: string;
	defaultValue?: string;
}

export interface LocaleResolverInput {
	header?: string | null;
	accepted?: string[];
}

export interface RosettaLoader {
	load(
		locale: string,
	): Promise<MessageTree | MessageCatalog | null | undefined>;
}

export interface RosettaOptions {
	defaultLocale?: string;
	supportedLocales?: string[];
	fallbackLocale?: string;
	fallbackLocales?: Record<string, string>;
	messages?: Record<string, MessageTree | MessageCatalog>;
	loaders?: RosettaLoader[];
}

/**
 * Numeric separators for a resolved locale. Returned by
 * `Rosetta.getNumberFormatData()` so consumers (e.g. `@c9up/atom`'s
 * `Decimal.parseLocale`) can honor Rosetta's `fallbackLocales`
 * chain when extracting group / decimal separators — without
 * importing `@c9up/rosetta` directly (structural typing).
 */
export interface NumberFormatData {
	decimal: string;
	group: string;
	minus: string;
	plusSign: string;
}

interface StringNumberFormat extends Intl.NumberFormat {
	format(value: number | bigint | string): string;
}

const DEFAULT_LOCALE = "en";

export class RosettaLocale {
	#manager: Rosetta;
	#locale: string;

	constructor(manager: Rosetta, locale: string) {
		this.#manager = manager;
		this.#locale = locale;
	}

	getLocale(): string {
		return this.#locale;
	}

	has(key: string): boolean {
		return this.#manager.has(key, this.#locale);
	}

	t(
		key: string,
		params?: TranslationParams,
		options?: Omit<TranslateOptions, "locale">,
	): string {
		return this.#manager.t(key, params, { ...options, locale: this.#locale });
	}

	formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
		return this.#manager.formatNumber(value, options, this.#locale);
	}

	formatCurrency(
		value: number,
		currency: string,
		options?: Intl.NumberFormatOptions,
	): string {
		return this.#manager.formatCurrency(value, currency, options, this.#locale);
	}

	formatDate(
		value: Date | number | string,
		options?: Intl.DateTimeFormatOptions,
	): string {
		return this.#manager.formatDate(value, options, this.#locale);
	}

	formatRelativeTime(
		value: number,
		unit: Intl.RelativeTimeFormatUnit,
		options?: Intl.RelativeTimeFormatOptions,
	): string {
		return this.#manager.formatRelativeTime(value, unit, options, this.#locale);
	}

	getNumberFormatData(): NumberFormatData {
		return this.#manager.getNumberFormatData(this.#locale);
	}

	formatNumberString(
		value: string,
		options?: Intl.NumberFormatOptions,
	): string {
		return this.#manager.formatNumberString(value, options, this.#locale);
	}
}

/**
 * Rosetta i18n manager.
 *
 * Framework-agnostic with request-scoped locale instances.
 */
export class Rosetta {
	#messages: Map<string, MessageCatalog> = new Map();
	#catalogsCache?: Record<string, MessageCatalog>;
	#catalogsCacheDirty = true;
	/** Stateful Rust engine (Story 37.9) — holds parsed catalogs in Rust memory. */
	#nativeEngine: NativeRosettaEngine | null = createNativeEngine();
	#locale: string;
	#defaultLocale: string;
	#fallbackLocale: string;
	#fallbackLocales: Record<string, string>;
	#supportedLocales?: Set<string>;
	#loaders: RosettaLoader[];
	#numberFormatDataCache: Map<string, NumberFormatData> = new Map();

	constructor(options: RosettaOptions = {}) {
		this.#defaultLocale = normalizeLocale(
			options.defaultLocale ?? DEFAULT_LOCALE,
		);
		this.#locale = this.#defaultLocale;
		this.#fallbackLocale = normalizeLocale(
			options.fallbackLocale ?? this.#defaultLocale,
		);
		this.#fallbackLocales = normalizeFallbackMap(options.fallbackLocales ?? {});
		this.#supportedLocales = options.supportedLocales
			? new Set(options.supportedLocales.map(normalizeLocale))
			: undefined;
		this.#loaders = options.loaders ?? [];

		if (options.messages) {
			for (const [locale, catalog] of Object.entries(options.messages)) {
				this.loadMessages(locale, catalog);
			}
		}
	}

	async boot(): Promise<void> {
		if (!this.#supportedLocales || this.#loaders.length === 0) {
			return;
		}
		for (const locale of this.#supportedLocales) {
			await this.#loadFromLoaders(locale);
		}
	}

	locale(locale: string): RosettaLocale {
		return new RosettaLocale(this, normalizeLocale(locale));
	}

	loadMessages(locale: string, messages: MessageTree | MessageCatalog): this {
		const normalizedLocale = normalizeLocale(locale);
		const existing = this.#messages.get(normalizedLocale) ?? {};
		const flattened = flattenMessages(messages);
		this.#messages.set(normalizedLocale, { ...existing, ...flattened });
		this.#catalogsCacheDirty = true;
		return this;
	}

	async loadLocale(locale: string): Promise<this> {
		await this.#loadFromLoaders(normalizeLocale(locale));
		return this;
	}

	setLocale(locale: string): this {
		this.#locale = normalizeLocale(locale);
		return this;
	}

	getLocale(): string {
		return this.#locale;
	}

	setDefaultLocale(locale: string): this {
		this.#defaultLocale = normalizeLocale(locale);
		// Invalidate the number-format-data cache: even though the
		// cache is keyed by the *resolved* locale (so most entries
		// stay correct across config changes), an entry produced by
		// the previous "ultimate fallback" path may now mismatch.
		this.#numberFormatDataCache.clear();
		return this;
	}

	getDefaultLocale(): string {
		return this.#defaultLocale;
	}

	setSupportedLocales(locales: string[]): this {
		this.#supportedLocales = new Set(locales.map(normalizeLocale));
		return this;
	}

	getSupportedLocales(): string[] | undefined {
		return this.#supportedLocales
			? Array.from(this.#supportedLocales)
			: undefined;
	}

	setFallbackLocale(locale: string): this {
		this.#fallbackLocale = normalizeLocale(locale);
		this.#numberFormatDataCache.clear();
		return this;
	}

	getFallbackLocale(): string {
		return this.#fallbackLocale;
	}

	setFallbackLocales(locales: Record<string, string>): this {
		this.#fallbackLocales = normalizeFallbackMap(locales);
		this.#numberFormatDataCache.clear();
		return this;
	}

	getFallbackLocales(): Record<string, string> {
		return { ...this.#fallbackLocales };
	}

	resolveLocale(input: string | LocaleResolverInput): string {
		const requested =
			typeof input === "string"
				? parseAcceptLanguage(input)
				: (input.accepted ?? parseAcceptLanguage(input.header ?? ""));

		for (const candidate of requested) {
			const normalized = normalizeLocale(candidate);
			const supported = this.#pickFirstSupported(
				this.#localeChainFor(normalized),
			);
			if (supported) {
				return supported;
			}
		}

		const fallback = this.#pickFirstSupported(
			this.#localeChainFor(this.#defaultLocale),
		);
		return fallback ?? this.#defaultLocale;
	}

	has(key: string, locale = this.#locale): boolean {
		const normalizedLocale = normalizeLocale(locale);
		const chain = this.#localeChainFor(normalizedLocale);

		if (!this.#nativeEngine) {
			throw new Error(
				"[ROSETTA_NAPI_REQUIRED] The Rust ICU engine is required. Build it with `cd packages/rosetta && pnpm build:napi`.",
			);
		}
		this.#syncNativeEngine();
		return this.#nativeEngine.has(key, JSON.stringify(chain));
	}

	t(
		key: string,
		params?: TranslationParams,
		options?: TranslateOptions,
	): string {
		const requestedLocale = normalizeLocale(options?.locale ?? this.#locale);
		const chain = this.#localeChainFor(requestedLocale);

		if (!this.#nativeEngine) {
			throw new Error(
				"[ROSETTA_NAPI_REQUIRED] The Rust ICU engine is required. Build it with `cd packages/rosetta && pnpm build:napi`.",
			);
		}
		this.#syncNativeEngine();
		// `bigint` makes a plain `JSON.stringify` THROW, crashing `t()` — serialise
		// it as its decimal string so it survives the boundary and renders/pluralises
		// correctly (RO7). `Date` already serialises to an ISO string via `toJSON`,
		// which the engine's date/time formatter now slices.
		const paramsJson = params
			? JSON.stringify(params, (_k, v) =>
					typeof v === "bigint" ? v.toString() : v,
				)
			: undefined;
		return this.#nativeEngine.translate(
			key,
			paramsJson,
			JSON.stringify(chain),
			options?.defaultValue,
		);
	}

	formatNumber(
		value: number,
		options?: Intl.NumberFormatOptions,
		locale = this.#locale,
	): string {
		return new Intl.NumberFormat(normalizeLocale(locale), options).format(
			value,
		);
	}

	formatCurrency(
		value: number,
		currency: string,
		options?: Intl.NumberFormatOptions,
		locale = this.#locale,
	): string {
		// Spread `options` FIRST so explicit `style: "currency"` and
		// `currency` always win — a caller's stray `{ style: "decimal" }`
		// must not silently disable currency formatting.
		return this.formatNumber(
			value,
			{ ...options, style: "currency", currency },
			locale,
		);
	}

	formatDate(
		value: Date | number | string,
		options?: Intl.DateTimeFormatOptions,
		locale = this.#locale,
	): string {
		const date = value instanceof Date ? value : new Date(value);
		return new Intl.DateTimeFormat(normalizeLocale(locale), options).format(
			date,
		);
	}

	formatRelativeTime(
		value: number,
		unit: Intl.RelativeTimeFormatUnit,
		options?: Intl.RelativeTimeFormatOptions,
		locale = this.#locale,
	): string {
		return new Intl.RelativeTimeFormat(normalizeLocale(locale), options).format(
			value,
			unit,
		);
	}

	/**
	 * Resolve the numeric separators for `locale`, honoring the
	 * configured `fallbackLocales` chain. Returns the first locale
	 * in the chain that `Intl.NumberFormat` actually supports.
	 *
	 * Cached per resolved locale so the `formatToParts` work runs
	 * once per chain destination.
	 */
	getNumberFormatData(locale: string = this.#locale): NumberFormatData {
		const resolved = this.#resolveNumberLocale(locale);
		const cached = this.#numberFormatDataCache.get(resolved);
		if (cached) return cached;
		const formatter = new Intl.NumberFormat(resolved);
		const negativeParts = formatter.formatToParts(-12345.6);
		const positiveParts = new Intl.NumberFormat(resolved, {
			signDisplay: "always",
		}).formatToParts(1);
		const data: NumberFormatData = {
			decimal: negativeParts.find((p) => p.type === "decimal")?.value ?? ".",
			group: negativeParts.find((p) => p.type === "group")?.value ?? ",",
			minus: negativeParts.find((p) => p.type === "minusSign")?.value ?? "-",
			plusSign: positiveParts.find((p) => p.type === "plusSign")?.value ?? "+",
		};
		this.#numberFormatDataCache.set(resolved, data);
		return data;
	}

	/**
	 * Format a string-valued number through `Intl.NumberFormat`'s
	 * string-accepting overload — preserves precision on 18+-digit
	 * values that would otherwise truncate via `Number()`.
	 *
	 * Locale resolution uses the same fallback chain as
	 * `getNumberFormatData`.
	 */
	formatNumberString(
		value: string,
		options?: Intl.NumberFormatOptions,
		locale = this.#locale,
	): string {
		const resolved = this.#resolveNumberLocale(locale);
		const formatter = new Intl.NumberFormat(
			resolved,
			options,
		) as StringNumberFormat;
		return formatter.format(value);
	}

	#resolveNumberLocale(locale: string): string {
		const chain = this.#localeChainFor(normalizeLocale(locale));
		for (const candidate of chain) {
			const supported = Intl.NumberFormat.supportedLocalesOf([candidate], {
				localeMatcher: "lookup",
			});
			if (supported.length > 0) return supported[0];
		}
		// Last-resort: the configured #defaultLocale itself may not be
		// Intl-supported (e.g. an invented private-use tag). Validate
		// it once so the cache key is always a real Intl locale.
		const defaultSupported = Intl.NumberFormat.supportedLocalesOf(
			[this.#defaultLocale],
			{ localeMatcher: "lookup" },
		);
		if (defaultSupported.length > 0) return defaultSupported[0];
		// Truly unresolvable — fall back to "en", which every Intl
		// implementation must support per ECMA-402.
		return "en";
	}

	async #loadFromLoaders(locale: string): Promise<void> {
		for (const loader of this.#loaders) {
			const messages = await loader.load(locale);
			if (messages) {
				this.loadMessages(locale, messages);
			}
		}
	}

	#pickFirstSupported(candidates: string[]): string | undefined {
		if (!this.#supportedLocales) {
			return candidates[0];
		}
		return candidates.find((candidate) =>
			this.#supportedLocales?.has(candidate),
		);
	}

	#localeChainFor(locale: string): string[] {
		const chain: string[] = [];
		const visited = new Set<string>();
		const push = (value: string) => {
			const normalized = normalizeLocale(value);
			if (!normalized || visited.has(normalized)) return;
			visited.add(normalized);
			chain.push(normalized);
		};

		push(locale);

		const localeParts = locale.split("-");
		if (localeParts.length > 1) {
			push(localeParts[0]);
		}

		const explicitFallback = this.#fallbackLocales[locale];
		if (explicitFallback) {
			push(explicitFallback);
			const explicitParts = explicitFallback.split("-");
			if (explicitParts.length > 1) {
				push(explicitParts[0]);
			}
		}

		push(this.#fallbackLocale);
		const fallbackParts = this.#fallbackLocale.split("-");
		if (fallbackParts.length > 1) {
			push(fallbackParts[0]);
		}
		push(this.#defaultLocale);
		const defaultParts = this.#defaultLocale.split("-");
		if (defaultParts.length > 1) {
			push(defaultParts[0]);
		}

		return chain;
	}

	/**
	 * Sync the Rust-resident catalog with the TS-side `#messages` map. Only
	 * performs JSON.stringify when the dirty flag is set (a locale was loaded or
	 * edited). On subsequent `t()` / `has()` calls with no changes, this is a
	 * no-op — the Rust engine already holds the parsed catalog in memory.
	 *
	 * Story 37.9: this replaces the old `#catalogsJson()` which serialized the
	 * entire catalog on EVERY `t()` call.
	 */
	#syncNativeEngine(): void {
		if (!this.#nativeEngine) return;
		if (!this.#catalogsCacheDirty && this.#catalogsCache) return;
		const cache: Record<string, MessageCatalog> = {};
		for (const [locale, catalog] of this.#messages.entries()) {
			cache[locale] = catalog;
		}
		// loadCatalogs may throw (malformed JSON, lock poisoned). The dirty flag
		// is only cleared AFTER a successful load so a retry on the next t()
		// call re-attempts instead of silently using a stale/empty catalog.
		this.#nativeEngine.loadCatalogs(JSON.stringify(cache));
		this.#catalogsCache = cache;
		this.#catalogsCacheDirty = false;
	}
}

function normalizeLocale(locale: string): string {
	return locale.trim().replace(/_/g, "-").toLowerCase();
}

function normalizeFallbackMap(
	map: Record<string, string>,
): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [from, to] of Object.entries(map)) {
		normalized[normalizeLocale(from)] = normalizeLocale(to);
	}
	return normalized;
}

function parseAcceptLanguage(header: string): string[] {
	return header
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
		.map((item) => {
			const [localePart, ...rest] = item.split(";");
			let quality = 1;
			for (const part of rest) {
				const trimmed = part.trim();
				if (trimmed.startsWith("q=")) {
					const n = Number(trimmed.slice(2));
					if (Number.isFinite(n)) quality = n;
				}
			}
			return { locale: normalizeLocale(localePart), quality };
		})
		.filter((entry) => entry.locale.length > 0)
		.sort((a, b) => b.quality - a.quality)
		.map((entry) => entry.locale);
}

function flattenMessages(
	messages: MessageTree | MessageCatalog,
): MessageCatalog {
	const out: MessageCatalog = {};
	walkFlatten("", messages, out);
	return out;
}

function walkFlatten(
	prefix: string,
	value: MessageTree | MessageCatalog | MessageValue,
	out: MessageCatalog,
): void {
	if (typeof value === "string") {
		out[prefix] = value;
		return;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		out[prefix] = String(value);
		return;
	}
	if (value === null || value === undefined) {
		return;
	}

	for (const [key, child] of Object.entries(value)) {
		const next = prefix ? `${prefix}.${key}` : key;
		walkFlatten(
			next,
			child as MessageTree | MessageCatalog | MessageValue,
			out,
		);
	}
}
