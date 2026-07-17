import {
	type CurrencyFormatOptions,
	type DateTimeValue,
	Formatter,
	normalizeLocale,
	type StringNumberFormat,
} from "./formatters/Formatter.js";
import {
	type FormatterFactory,
	IcuFormatter,
	type TranslationsFormatterContract,
} from "./formatters/IcuFormatter.js";
import { getNumberFormatter } from "./formatters/IntlFormatterCache.js";
import { createLocaleStorage } from "./locale-storage.js";

export type TranslationParams = Record<string, unknown>;
export type MessageValue = string | number | boolean | null;
export type MessageTree = { [key: string]: MessageValue | MessageTree };
export type MessageCatalog = Record<string, string>;
export type Translations = Record<string, MessageCatalog>;

export interface TranslateOptions {
	locale?: string;
	defaultValue?: string;
	/** Pre-resolved fallback used by locale-scoped instances. */
	fallbackLocale?: string;
}

/**
 * Declaration-merging slot for typed translation keys. Empty here; augment it
 * from your app and `t()` starts rejecting unknown keys and checking each
 * message's variables. Generate the augmentation from your catalogs with
 * `generateCatalogTypes` rather than writing it by hand.
 *
 * Same idiom as AdonisJS's `EventsList`:
 *
 * ```ts
 * declare module '@c9up/rosetta' {
 *   interface TranslationKeys {
 *     'messages.greeting': { name: string | number }
 *     'messages.items': { count: number }
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: the empty body IS the contract — consumers augment it, and `keyof` resolving to `never` is what keeps `t()` permissive until they do.
export interface TranslationKeys {}

/**
 * The keys `t()` accepts: every string while {@link TranslationKeys} is
 * un-augmented, the declared keys once it is. The `never` probe is what keeps
 * an un-augmented app compiling exactly as before.
 */
export type TranslationKey = [keyof TranslationKeys] extends [never]
	? string
	: keyof TranslationKeys & string;

/** The variables a given key needs — loose unless that key has been declared. */
export type ParamsFor<K extends string> = K extends keyof TranslationKeys
	? TranslationKeys[K]
	: TranslationParams;

/**
 * Payload passed to `onMissingTranslation`. Mirrors AdonisJS's
 * `i18n:missing:translation` event shape verbatim.
 */
export interface MissingTranslationEventPayload {
	locale: string;
	identifier: string;
	hasFallback: boolean;
}

export type MissingTranslationHandler = (
	payload: MissingTranslationEventPayload,
) => void;

export interface MissingTranslationEmitter {
	emit(
		event: "i18n:missing:translation",
		payload: MissingTranslationEventPayload,
	): unknown;
}

export type {
	CurrencyFormatOptions,
	DateTimeValue,
} from "./formatters/Formatter.js";

export interface LocaleResolverInput {
	header?: string | null;
	accepted?: string[];
}

export interface RosettaLoader {
	load(
		locale: string,
	): Promise<MessageTree | MessageCatalog | null | undefined>;
}

export interface TranslationsLoaderContract {
	load(): Promise<Record<string, MessageTree | MessageCatalog>>;
	loadAll?(): Promise<Record<string, MessageTree | MessageCatalog>>;
}

export type Loader = RosettaLoader | TranslationsLoaderContract;
export type LoaderFactory = (config: RosettaOptions) => Loader;

export interface RosettaOptions {
	defaultLocale?: string;
	supportedLocales?: string[];
	fallbackLocale?: string;
	fallbackLocales?: Record<string, string>;
	messages?: Record<string, MessageTree | MessageCatalog>;
	loaders?: Array<Loader | LoaderFactory>;
	formatter?: TranslationsFormatterContract | FormatterFactory;

	/**
	 * Called when `t()` cannot resolve an identifier in the requested
	 * (primary) locale — either it was missing everywhere
	 * (`hasFallback: false`) or resolved through the fallback chain
	 * (`hasFallback: true`). Mirrors AdonisJS's `i18n:missing:translation`
	 * event but stays framework-agnostic: pass a plain callback, or bridge it
	 * to a Ream emitter yourself
	 * (`(p) => emitter.emit('i18n:missing:translation', p)`). No `@adonisjs`
	 * import.
	 */
	onMissingTranslation?: MissingTranslationHandler;

	/**
	 * Controls what `t()` returns when an identifier is missing everywhere.
	 * Mirrors AdonisJS's `config.fallback`. When omitted, `t()` returns the
	 * Adonis-format string `"translation missing: <locale>, <identifier>"`. An
	 * inline `defaultValue` (passed to `t()`) still wins over this.
	 */
	fallback?: (identifier: string, locale: string) => string;
}

export interface BaseI18nConfig {
	defaultLocale: string;
	supportedLocales?: string[];
	fallbackLocales?: Record<string, string>;
	fallback?: (identifier: string, locale: string) => string;
}

export interface I18nManagerConfig extends RosettaOptions {
	defaultLocale: string;
	formatter: FormatterFactory;
	loaders: LoaderFactory[];
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

const DEFAULT_LOCALE = "en";

export class RosettaLocale extends Formatter {
	#manager: Rosetta;
	#emitter?: MissingTranslationEmitter;
	fallbackLocale: string;

	constructor(
		manager: Rosetta,
		locale: string,
		emitter?: MissingTranslationEmitter,
	);
	/** AdonisJS-compatible constructor. */
	constructor(
		locale: string,
		emitter: MissingTranslationEmitter,
		manager: Rosetta,
	);
	constructor(
		managerOrLocale: Rosetta | string,
		localeOrEmitter: string | MissingTranslationEmitter,
		emitterOrManager?: MissingTranslationEmitter | Rosetta,
	) {
		super(
			typeof managerOrLocale === "string"
				? managerOrLocale
				: (localeOrEmitter as string),
		);
		if (typeof managerOrLocale === "string") {
			this.#emitter = localeOrEmitter as MissingTranslationEmitter;
			this.#manager = emitterOrManager as Rosetta;
		} else {
			this.#manager = managerOrLocale;
			this.#emitter = emitterOrManager as MissingTranslationEmitter | undefined;
		}
		this.fallbackLocale = this.#manager.getFallbackLocaleFor(this.locale);
	}

	get localeTranslations(): MessageCatalog {
		return this.#manager.getTranslationsFor(this.locale);
	}

	get fallbackTranslations(): MessageCatalog {
		return this.#manager.getTranslationsFor(this.fallbackLocale);
	}

	getLocale(): string {
		return this.locale;
	}

	/** Switch this request-scoped instance in place, matching AdonisJS I18n. */
	override switchLocale(locale: string): void {
		super.switchLocale(locale);
		this.fallbackLocale = this.#manager.getFallbackLocaleFor(this.locale);
	}

	resolveIdentifier(
		identifier: string,
	): { message: string; isFallback: boolean } | null {
		const local = this.localeTranslations[identifier];
		if (local !== undefined) return { message: local, isFallback: false };
		const fallback = this.fallbackTranslations[identifier];
		return fallback !== undefined
			? { message: fallback, isFallback: true }
			: null;
	}

	hasMessage(identifier: string): boolean {
		return this.localeTranslations[identifier] !== undefined;
	}

	hasFallbackMessage(identifier: string): boolean {
		return this.fallbackTranslations[identifier] !== undefined;
	}

	has(key: string): boolean {
		return this.hasMessage(key) || this.hasFallbackMessage(key);
	}

	t<K extends TranslationKey>(key: K, fallbackMessage?: string): string;
	t<K extends TranslationKey>(
		key: K,
		params?: ParamsFor<K>,
		fallbackMessage?: string,
	): string;
	/** Backward-compatible Rosetta options form. */
	t<K extends TranslationKey>(
		key: K,
		params?: ParamsFor<K>,
		options?: Omit<TranslateOptions, "locale">,
	): string;
	t(
		key: string,
		paramsOrFallback?: TranslationParams | string,
		fallbackOrOptions?: string | Omit<TranslateOptions, "locale">,
	): string {
		return this.#translate(key, paramsOrFallback, fallbackOrOptions);
	}

	/**
	 * The untyped body behind `t()` and `formatMessage()`. Both narrow their key
	 * to {@link TranslationKey}, which a consumer's augmentation turns into a
	 * union — so the internal hop between them has to go through a signature
	 * that still accepts a plain string.
	 */
	#translate(
		key: string,
		paramsOrFallback?: TranslationParams | string,
		fallbackOrOptions?: string | Omit<TranslateOptions, "locale">,
	): string {
		const params =
			typeof paramsOrFallback === "string" ? undefined : paramsOrFallback;
		const inlineFallback =
			typeof paramsOrFallback === "string"
				? paramsOrFallback
				: typeof fallbackOrOptions === "string"
					? fallbackOrOptions
					: fallbackOrOptions?.defaultValue;
		if (this.#emitter) {
			const resolved = this.resolveIdentifier(key);
			if (!resolved || resolved.isFallback) {
				this.#emitter.emit("i18n:missing:translation", {
					locale: this.locale,
					identifier: key,
					hasFallback: resolved?.isFallback ?? false,
				});
			}
		}
		return this.#manager.t(key, params, {
			locale: this.locale,
			defaultValue: inlineFallback,
			fallbackLocale: this.fallbackLocale,
		});
	}

	formatMessage<K extends TranslationKey>(
		identifier: K,
		fallbackMessage?: string,
	): string;
	formatMessage<K extends TranslationKey>(
		identifier: K,
		data: ParamsFor<K>,
		fallbackMessage?: string,
	): string;
	formatMessage(
		identifier: string,
		dataOrFallback?: TranslationParams | string,
		fallbackMessage?: string,
	): string {
		return typeof dataOrFallback === "string"
			? this.#translate(identifier, dataOrFallback)
			: this.#translate(identifier, dataOrFallback, fallbackMessage);
	}

	formatRawMessage(message: string, data?: TranslationParams): string {
		return this.#manager.formatRawMessage(message, this.locale, data);
	}

	createMessagesProvider(prefix = "validator.shared"): I18nMessagesProvider {
		return new I18nMessagesProvider(prefix, this);
	}

	getNumberFormatData(): NumberFormatData {
		return this.#manager.getNumberFormatData(this.locale);
	}

	formatNumberString(
		value: string,
		options?: Intl.NumberFormatOptions,
	): string {
		return this.#manager.formatNumberString(value, options, this.locale);
	}
}

export interface ValidationFieldContext {
	name: string | number;
	wildCardPath: string;
}

/** VineJS-compatible messages provider without a runtime Vine dependency. */
export class I18nMessagesProvider {
	readonly #messagesPrefix: string;
	readonly #fieldsPrefix: string;

	constructor(
		prefix: string,
		private readonly i18n: RosettaLocale,
	) {
		this.#messagesPrefix = `${prefix}.messages`;
		this.#fieldsPrefix = `${prefix}.fields`;
	}

	/** Adonis/Vine contract. */
	getMessage(
		defaultMessage: string,
		rule: string,
		field: ValidationFieldContext | string,
		meta?: Record<string, unknown>,
	): string;
	/** Backward-compatible Rosetta 0.1 two-argument form. */
	getMessage(field: string, rule: string): string;
	getMessage(
		defaultMessageOrField: string,
		rule: string,
		field?: ValidationFieldContext | string,
		meta: Record<string, unknown> = {},
	): string {
		const legacy = field === undefined;
		const context: ValidationFieldContext =
			typeof field === "object"
				? field
				: {
						name: field ?? defaultMessageOrField,
						wildCardPath: field ?? defaultMessageOrField,
					};
		const defaultMessage = legacy
			? `${rule} validation failed for {field}`
			: defaultMessageOrField;
		const fieldName = this.translateField(context.name);

		// Vine reuses this metadata in its serialized error, so matching Adonis
		// requires translating these entries in place as well as in the message.
		if (meta.otherField !== undefined) {
			meta.otherField = this.translateField(meta.otherField as string | number);
		}
		if (meta.originalField !== undefined) {
			meta.originalField = this.translateField(
				meta.originalField as string | number,
			);
		}
		const data = { field: fieldName, ...meta };
		for (const identifier of [
			`${this.#messagesPrefix}.${context.wildCardPath}.${rule}`,
			`${this.#messagesPrefix}.${rule}`,
		]) {
			const message = this.i18n.resolveIdentifier(identifier);
			if (message) return this.i18n.formatRawMessage(message.message, data);
		}
		return interpolateValidationMessage(defaultMessage, data);
	}

	translateField(name: string | number): string | number {
		const message = this.i18n.resolveIdentifier(
			`${this.#fieldsPrefix}.${name}`,
		);
		return message ? this.i18n.formatRawMessage(message.message) : name;
	}
}

function interpolateValidationMessage(
	message: string,
	data: Record<string, unknown>,
): string {
	return message.replace(/\{\s*([\w.]+)\s*\}/g, (placeholder, path: string) => {
		let value: unknown = data;
		for (const segment of path.split(".")) {
			if (
				!value ||
				typeof value !== "object" ||
				!Object.hasOwn(value, segment)
			) {
				return placeholder;
			}
			value = (value as Record<string, unknown>)[segment];
		}
		return value === null || value === undefined ? "" : String(value);
	});
}

/**
 * Rosetta i18n manager.
 *
 * Framework-agnostic with request-scoped locale instances.
 */
export class Rosetta {
	#messages: Record<string, MessageCatalog> = Object.create(null);
	#initialMessages: Record<string, MessageTree | MessageCatalog>;
	#localeStorage = createLocaleStorage<string>();
	#defaultLocale: string;
	#fallbackLocale: string;
	#fallbackLocales: Record<string, string>;
	#supportedLocales?: Set<string>;
	#loaderEntries: Array<Loader | LoaderFactory>;
	#formatter?: TranslationsFormatterContract;
	#formatterFactory?: FormatterFactory;
	#hasCachedTranslations = false;
	#translationsLoadPromise?: Promise<void>;
	#numberFormatDataCache: Map<string, NumberFormatData> = new Map();
	#missingTranslationHandlers: MissingTranslationHandler[] = [];
	#fallback?: (identifier: string, locale: string) => string;
	#emitter?: MissingTranslationEmitter;
	readonly config: RosettaOptions;

	constructor(options?: RosettaOptions);
	/** AdonisJS-compatible I18nManager constructor. */
	constructor(emitter: MissingTranslationEmitter, config: I18nManagerConfig);
	constructor(
		optionsOrEmitter: RosettaOptions | MissingTranslationEmitter = {},
		managerConfig?: I18nManagerConfig,
	) {
		const options = managerConfig ?? (optionsOrEmitter as RosettaOptions);
		if (managerConfig) {
			this.#emitter = optionsOrEmitter as MissingTranslationEmitter;
		}
		this.config = options;
		this.#initialMessages = options.messages ?? {};
		this.#defaultLocale = normalizeLocale(
			options.defaultLocale ?? DEFAULT_LOCALE,
		);
		this.#fallbackLocale = normalizeLocale(
			options.fallbackLocale ?? this.#defaultLocale,
		);
		this.#fallbackLocales = normalizeFallbackMap(options.fallbackLocales ?? {});
		this.#supportedLocales = options.supportedLocales
			? new Set(options.supportedLocales.map(normalizeLocale))
			: undefined;
		this.#loaderEntries = options.loaders ?? [];
		const formatter = options.formatter;
		if (typeof formatter === "function") this.#formatterFactory = formatter;
		else this.#formatter = formatter ?? new IcuFormatter();
		if (options.onMissingTranslation) {
			this.#missingTranslationHandlers.push(options.onMissingTranslation);
		}
		this.#fallback = options.fallback;

		if (options.messages) {
			for (const [locale, catalog] of Object.entries(options.messages)) {
				this.loadMessages(locale, catalog);
			}
		}
	}

	async boot(): Promise<void> {
		await this.loadTranslations();
	}

	locale(locale = this.#defaultLocale): RosettaLocale {
		return new RosettaLocale(this, normalizeLocale(locale), this.#emitter);
	}

	loadMessages(locale: string, messages: MessageTree | MessageCatalog): this {
		mergeMessagesInto(this.#messages, locale, messages);
		return this;
	}

	async loadLocale(locale: string): Promise<this> {
		await this.#loadFromLoaders(normalizeLocale(locale));
		return this;
	}

	setLocale(locale: string): this {
		this.#localeStorage.enterWith(normalizeLocale(locale));
		return this;
	}

	getLocale(): string {
		return this.#localeStorage.getStore() ?? this.#defaultLocale;
	}

	/** Run legacy manager-level helpers inside an isolated locale context. */
	runWithLocale<T>(locale: string, callback: () => T): T {
		return this.#localeStorage.run(normalizeLocale(locale), callback);
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

	/**
	 * AdonisJS parity: the locales supported by the app. When
	 * `supportedLocales` is not configured, it is inferred from the default
	 * locale, the `fallbackLocales` keys, and every locale whose catalog has
	 * been loaded.
	 */
	supportedLocales(): string[] {
		if (this.#supportedLocales) {
			return Array.from(this.#supportedLocales);
		}
		const inferred = new Set<string>([this.#defaultLocale]);
		for (const key of Object.keys(this.#fallbackLocales)) {
			inferred.add(key);
		}
		for (const locale of Object.keys(this.#messages)) {
			inferred.add(locale);
		}
		return Array.from(inferred);
	}

	get defaultLocale(): string {
		return this.#defaultLocale;
	}

	get hasCachedTranslations(): boolean {
		return this.#hasCachedTranslations;
	}

	getTranslations(): Record<string, MessageCatalog> {
		return this.#messages;
	}

	getTranslationsFor(locale: string): MessageCatalog {
		return this.#messages[normalizeLocale(locale)] ?? {};
	}

	getFormatter(): TranslationsFormatterContract {
		if (!this.#formatter) {
			this.#formatter =
				this.#formatterFactory?.(this.config) ?? new IcuFormatter();
		}
		return this.#formatter;
	}

	getFallbackLocaleFor(locale: string): string {
		const normalized = normalizeLocale(locale);
		const explicit = this.#fallbackLocales[normalized];
		if (explicit) return explicit;
		let closest:
			| { locale: string; specificity: number; order: number }
			| undefined;
		for (const [order, candidate] of this.supportedLocales().entries()) {
			const candidateLocale = normalizeLocale(candidate);
			if (candidateLocale === normalized) continue;
			const specificity = languageMatchSpecificity(normalized, candidateLocale);
			if (specificity < 0) continue;
			if (
				!closest ||
				specificity > closest.specificity ||
				(specificity === closest.specificity && order < closest.order)
			) {
				closest = { locale: candidateLocale, specificity, order };
			}
		}
		if (closest) return closest.locale;
		return this.#fallbackLocale || this.#defaultLocale;
	}

	setOnMissingTranslation(
		handler: MissingTranslationHandler | undefined,
	): this {
		this.#missingTranslationHandlers = handler ? [handler] : [];
		return this;
	}

	onMissingTranslation(handler: MissingTranslationHandler): () => void {
		this.#missingTranslationHandlers.push(handler);
		return () => {
			this.#missingTranslationHandlers =
				this.#missingTranslationHandlers.filter(
					(candidate) => candidate !== handler,
				);
		};
	}

	setFallback(
		fallback: ((identifier: string, locale: string) => string) | undefined,
	): this {
		this.#fallback = fallback;
		return this;
	}

	getFallbackMessage(identifier: string, locale: string): string | undefined {
		return this.#fallback?.(identifier, normalizeLocale(locale));
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

	/**
	 * AdonisJS-compatible alias for {@link resolveLocale}. Accepts a raw
	 * `accept-language` string or an array of preferred languages and returns
	 * the best supported locale. Unlike Adonis (which returns `null` on no
	 * match), Rosetta falls back to the default-locale chain — matching
	 * `resolveLocale`'s always-resolve contract.
	 */
	getSupportedLocaleFor(userLanguage: string | string[]): string | null {
		return negotiateLanguage(
			Array.isArray(userLanguage) ? userLanguage.join(",") : userLanguage,
			this.supportedLocales(),
		);
	}

	has(key: string, locale = this.getLocale()): boolean {
		const normalizedLocale = normalizeLocale(locale);
		const chain = this.#localeChainFor(normalizedLocale);
		return chain.some(
			(candidate) => this.#messages[candidate]?.[key] !== undefined,
		);
	}

	t(
		key: string,
		params?: TranslationParams,
		options?: TranslateOptions,
	): string {
		const requestedLocale = normalizeLocale(
			options?.locale ?? this.getLocale(),
		);
		const chain = options?.fallbackLocale
			? uniqueLocales([requestedLocale, options.fallbackLocale])
			: this.#localeChainFor(requestedLocale);
		const status = this.#resolveStatus(key, chain);

		// AdonisJS parity: notify when the primary locale can't resolve the
		// identifier — either missing everywhere (`hasFallback: false`) or found
		// only through the fallback chain (`hasFallback: true`).
		if (status !== "primary") {
			const payload = {
				locale: requestedLocale,
				identifier: key,
				hasFallback: status === "fallback",
			};
			for (const handler of this.#missingTranslationHandlers) handler(payload);
		}

		// Missing everywhere with no inline `defaultValue`: honor the configured
		// `fallback` fn, else return Adonis's `"translation missing: …"` string.
		if (status === "missing" && options?.defaultValue === undefined) {
			const custom = this.#fallback?.(key, requestedLocale);
			if (custom !== undefined) return custom;
			return `translation missing: ${requestedLocale}, ${key}`;
		}

		for (const candidate of chain) {
			const message = this.#messages[candidate]?.[key];
			if (message !== undefined) {
				return this.getFormatter().format(message, requestedLocale, params);
			}
		}
		return options?.defaultValue ?? key;
	}

	formatRawMessage(
		message: string,
		locale = this.#defaultLocale,
		data?: TranslationParams,
	): string {
		return this.getFormatter().format(message, normalizeLocale(locale), data);
	}

	/**
	 * Value formatting is implemented once, in {@link Formatter}. These
	 * manager-level wrappers only bind the locale — a `Formatter` holds a single
	 * string and every `Intl.*` object behind it is memoized, so constructing
	 * one per call costs nothing next to the formatting itself.
	 */
	#formatterFor(locale: string): Formatter {
		return new Formatter(locale);
	}

	formatNumber(
		value: string | number | bigint,
		options?: Intl.NumberFormatOptions,
		locale = this.getLocale(),
	): string {
		return this.#formatterFor(locale).formatNumber(value, options);
	}

	formatCurrency(
		value: string | number | bigint,
		options: CurrencyFormatOptions,
		locale?: string,
	): string;
	/** @deprecated Prefer the options-bag form `formatCurrency(value, { currency })`. */
	formatCurrency(
		value: string | number | bigint,
		currency: string,
		options?: Intl.NumberFormatOptions,
		locale?: string,
	): string;
	formatCurrency(
		value: string | number | bigint,
		optionsOrCurrency: string | CurrencyFormatOptions,
		optionsOrLocale?: Intl.NumberFormatOptions | string,
		legacyLocale?: string,
	): string {
		if (typeof optionsOrCurrency === "string") {
			// Legacy positional form: (value, currency, options?, locale?).
			const options =
				typeof optionsOrLocale === "object" ? optionsOrLocale : undefined;
			const locale =
				legacyLocale ??
				(typeof optionsOrLocale === "string" ? optionsOrLocale : undefined) ??
				this.getLocale();
			return this.#formatterFor(locale).formatCurrency(
				value,
				optionsOrCurrency,
				options,
			);
		}
		const locale =
			typeof optionsOrLocale === "string" ? optionsOrLocale : this.getLocale();
		return this.#formatterFor(locale).formatCurrency(value, optionsOrCurrency);
	}

	formatDate(
		value: DateTimeValue,
		options?: Intl.DateTimeFormatOptions,
		locale = this.getLocale(),
	): string {
		return this.#formatterFor(locale).formatDate(value, options);
	}

	formatTime(
		value: DateTimeValue,
		options?: Intl.DateTimeFormatOptions,
		locale = this.getLocale(),
	): string {
		return this.#formatterFor(locale).formatTime(value, options);
	}

	formatRelativeTime(
		value: DateTimeValue,
		unit: Intl.RelativeTimeFormatUnit | "auto",
		options?: Intl.RelativeTimeFormatOptions,
		locale = this.getLocale(),
	): string {
		return this.#formatterFor(locale).formatRelativeTime(value, unit, options);
	}

	formatPlural(
		value: number | string,
		options?: Intl.PluralRulesOptions,
		locale = this.getLocale(),
	): string {
		return this.#formatterFor(locale).formatPlural(value, options);
	}

	formatList(
		list: Iterable<string>,
		options?: Intl.ListFormatOptions,
		locale = this.getLocale(),
	): string {
		return this.#formatterFor(locale).formatList(list, options);
	}

	formatDisplayNames(
		code: string,
		options: Intl.DisplayNamesOptions,
		locale = this.getLocale(),
	): string | undefined {
		return this.#formatterFor(locale).formatDisplayNames(code, options);
	}

	/**
	 * Resolve the numeric separators for `locale`, honoring the
	 * configured `fallbackLocales` chain. Returns the first locale
	 * in the chain that `Intl.NumberFormat` actually supports.
	 *
	 * Cached per resolved locale so the `formatToParts` work runs
	 * once per chain destination.
	 */
	getNumberFormatData(locale: string = this.getLocale()): NumberFormatData {
		const resolved = this.#resolveNumberLocale(locale);
		const cached = this.#numberFormatDataCache.get(resolved);
		if (cached) return cached;
		const formatter = getNumberFormatter(resolved);
		const negativeParts = formatter.formatToParts(-12345.6);
		const positiveParts = getNumberFormatter(resolved, {
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
		locale = this.getLocale(),
	): string {
		const resolved = this.#resolveNumberLocale(locale);
		const formatter = getNumberFormatter(
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

	async loadTranslations(): Promise<void> {
		if (this.#hasCachedTranslations) return;
		await this.reloadTranslations();
	}

	async reloadTranslations(): Promise<void> {
		if (this.#translationsLoadPromise) {
			await this.#translationsLoadPromise;
			return;
		}
		const loading = this.#reloadTranslations();
		this.#translationsLoadPromise = loading;
		try {
			await loading;
		} finally {
			if (this.#translationsLoadPromise === loading) {
				this.#translationsLoadPromise = undefined;
			}
		}
	}

	async #reloadTranslations(): Promise<void> {
		const translations = Object.create(null) as Record<string, MessageCatalog>;
		for (const [locale, messages] of Object.entries(this.#initialMessages)) {
			mergeMessagesInto(translations, locale, messages);
		}
		const translationsStack = await Promise.all(
			this.#createLoaders().map((loader) => this.#loadAllFromLoader(loader)),
		);
		for (const loadedTranslations of translationsStack) {
			mergeTranslationsInto(translations, loadedTranslations);
		}
		this.#messages = translations;
		this.#hasCachedTranslations = true;
	}

	async #loadFromLoaders(locale: string): Promise<void> {
		const messagesStack = await Promise.all(
			this.#createLoaders().map((loader) =>
				this.#loadLocaleFromLoader(loader, locale),
			),
		);
		const catalogs = messagesStack
			.filter(
				(messages): messages is MessageTree | MessageCatalog =>
					messages !== null && messages !== undefined,
			)
			.map(flattenMessages);
		if (catalogs.length === 0) return;

		const merged = { ...(this.#messages[locale] ?? {}) };
		for (const catalog of catalogs) Object.assign(merged, catalog);
		this.#messages[locale] = merged;
	}

	#createLoaders(): Loader[] {
		return this.#loaderEntries.map((loader) =>
			typeof loader === "function" ? loader(this.config) : loader,
		);
	}

	async #loadAllFromLoader(
		loader: Loader,
	): Promise<Record<string, MessageTree | MessageCatalog>> {
		if ("loadAll" in loader && loader.loadAll) return loader.loadAll();
		if (this.#supportedLocales && loader.load.length > 0) {
			const locales = Array.from(this.#supportedLocales);
			const messages = await Promise.all(
				locales.map((locale) => (loader as RosettaLoader).load(locale)),
			);
			const translations = Object.create(null) as Record<
				string,
				MessageTree | MessageCatalog
			>;
			for (let index = 0; index < locales.length; index++) {
				const localeMessages = messages[index];
				if (localeMessages) translations[locales[index]] = localeMessages;
			}
			return translations;
		}
		return (
			(await (loader as TranslationsLoaderContract).load()) ??
			Object.create(null)
		);
	}

	async #loadLocaleFromLoader(
		loader: Loader,
		locale: string,
	): Promise<MessageTree | MessageCatalog | null | undefined> {
		if ("loadAll" in loader && loader.loadAll) {
			const translations = await loader.loadAll();
			const matchingLocale = Object.keys(translations).find(
				(candidate) => normalizeLocale(candidate) === locale,
			);
			return matchingLocale ? translations[matchingLocale] : undefined;
		}
		return (loader as RosettaLoader).load(locale);
	}

	/**
	 * Classify an identifier's resolution against the locale chain, purely from
	 * the TS-side catalogs (the Rust engine is frozen and doesn't report
	 * hit/miss status). `"primary"` = found in the requested locale;
	 * `"fallback"` = found only later in the chain; `"missing"` = absent
	 * everywhere. Drives the `onMissingTranslation` payload's `hasFallback`.
	 */
	#resolveStatus(
		key: string,
		chain: string[],
	): "primary" | "fallback" | "missing" {
		if (this.#messages[chain[0]]?.[key] !== undefined) {
			return "primary";
		}
		for (let i = 1; i < chain.length; i++) {
			if (this.#messages[chain[i]]?.[key] !== undefined) {
				return "fallback";
			}
		}
		return "missing";
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
		push(this.getFallbackLocaleFor(locale));

		return chain;
	}
}

function normalizeFallbackMap(
	map: Record<string, string>,
): Record<string, string> {
	const normalized = Object.create(null) as Record<string, string>;
	for (const [from, to] of Object.entries(map)) {
		normalized[normalizeLocale(from)] = normalizeLocale(to);
	}
	return normalized;
}

function uniqueLocales(locales: readonly string[]): string[] {
	return Array.from(new Set(locales.map(normalizeLocale).filter(Boolean)));
}

function parseAcceptLanguage(header: string): string[] {
	return parseLanguagePreferences(header).map((entry) => entry.locale);
}

interface LanguagePreference {
	locale: string;
	quality: number;
	order: number;
}

function parseLanguagePreferences(header: string): LanguagePreference[] {
	return header
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
		.map((item, order) => {
			const [localePart, ...rest] = item.split(";");
			let quality = 1;
			for (const part of rest) {
				const trimmed = part.trim();
				if (trimmed.toLowerCase().startsWith("q=")) {
					quality = Number(trimmed.slice(2));
				}
			}
			return { locale: normalizeLocale(localePart), quality, order };
		})
		.filter(
			(entry) =>
				entry.locale.length > 0 && entry.quality > 0 && entry.quality <= 1,
		)
		.sort((a, b) => b.quality - a.quality || a.order - b.order);
}

function negotiateLanguage(
	header: string,
	supportedLocales: readonly string[],
): string | null {
	const supported = supportedLocales.map((locale, order) => ({
		original: locale,
		normalized: normalizeLocale(locale),
		order,
	}));
	let best:
		| {
				locale: string;
				quality: number;
				specificity: number;
				requestOrder: number;
				supportedOrder: number;
		  }
		| undefined;

	for (const requested of parseLanguagePreferences(header)) {
		for (const candidate of supported) {
			const specificity = languageMatchSpecificity(
				requested.locale,
				candidate.normalized,
			);
			if (specificity < 0) continue;
			const match = {
				locale: candidate.original,
				quality: requested.quality,
				specificity,
				requestOrder: requested.order,
				supportedOrder: candidate.order,
			};
			if (!best || compareLanguageMatches(match, best) > 0) best = match;
		}
	}
	return best?.locale ?? null;
}

function languageMatchSpecificity(
	requested: string,
	supported: string,
): number {
	if (requested === "*") return 0;
	if (requested === supported) return 2;
	if (
		requested.startsWith(`${supported}-`) ||
		supported.startsWith(`${requested}-`)
	) {
		return 1;
	}
	return -1;
}

function compareLanguageMatches(
	left: {
		quality: number;
		specificity: number;
		requestOrder: number;
		supportedOrder: number;
	},
	right: {
		quality: number;
		specificity: number;
		requestOrder: number;
		supportedOrder: number;
	},
): number {
	return (
		left.quality - right.quality ||
		left.specificity - right.specificity ||
		right.requestOrder - left.requestOrder ||
		right.supportedOrder - left.supportedOrder
	);
}

function flattenMessages(
	messages: MessageTree | MessageCatalog,
): MessageCatalog {
	const out = Object.create(null) as MessageCatalog;
	walkFlatten("", messages, out, 0, { keys: 0 });
	return out;
}

const MAX_CATALOG_DEPTH = 100;
const MAX_CATALOG_KEYS = 100_000;

function walkFlatten(
	prefix: string,
	value: MessageTree | MessageCatalog | MessageValue,
	out: MessageCatalog,
	depth: number,
	state: { keys: number },
): void {
	if (depth > MAX_CATALOG_DEPTH) {
		throw new RangeError(
			`Translation catalog exceeds ${MAX_CATALOG_DEPTH} nesting levels`,
		);
	}
	if (typeof value === "string") {
		setFlattenedMessage(out, prefix, value);
		return;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		setFlattenedMessage(out, prefix, String(value));
		return;
	}
	if (value === null || value === undefined) {
		return;
	}

	for (const [key, child] of Object.entries(value)) {
		state.keys += 1;
		if (state.keys > MAX_CATALOG_KEYS) {
			throw new RangeError(
				`Translation catalog exceeds the ${MAX_CATALOG_KEYS} key limit`,
			);
		}
		assertSafeMessageKey(key);
		const next = prefix ? `${prefix}.${key}` : key;
		walkFlatten(
			next,
			child as MessageTree | MessageCatalog | MessageValue,
			out,
			depth + 1,
			state,
		);
	}
}

function setFlattenedMessage(
	out: MessageCatalog,
	identifier: string,
	message: string,
): void {
	if (Object.hasOwn(out, identifier)) {
		throw new Error(`Duplicate flattened translation key '${identifier}'`);
	}
	out[identifier] = message;
}

const DANGEROUS_MESSAGE_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor",
]);

function assertSafeMessageKey(key: string): void {
	if (DANGEROUS_MESSAGE_KEYS.has(key)) {
		throw new Error(`Unsafe translation key '${key}'`);
	}
}

function mergeMessagesInto(
	target: Record<string, MessageCatalog>,
	locale: string,
	messages: MessageTree | MessageCatalog,
): void {
	const normalizedLocale = normalizeLocale(locale);
	const existing = target[normalizedLocale] ?? {};
	target[normalizedLocale] = { ...existing, ...flattenMessages(messages) };
}

function mergeTranslationsInto(
	target: Record<string, MessageCatalog>,
	translations: Record<string, MessageTree | MessageCatalog>,
): void {
	for (const [locale, messages] of Object.entries(translations)) {
		mergeMessagesInto(target, locale, messages);
	}
}
