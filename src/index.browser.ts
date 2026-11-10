/** Browser/WASM entry point. It contains no eager Node.js builtin imports. */

export type {
	FileSystemLoaderOptions,
	FsLoaderOptions,
} from "./loaders/BrowserFileSystemLoader.js";
export {
	FileSystemLoader,
	FileSystemLoader as FsLoader,
} from "./loaders/BrowserFileSystemLoader.js";

import {
	FileSystemLoader,
	type FileSystemLoaderOptions,
} from "./loaders/BrowserFileSystemLoader.js";

export type {
	CatalogFinding,
	CatalogFindingKind,
	CheckCatalogsOptions,
} from "./CatalogCheck.js";
export {
	checkCatalogs,
	formatCatalogFindings,
	runCatalogCheck,
	suggestKey,
	verifyCatalogs,
} from "./CatalogCheck.js";
export type { GenerateCatalogTypesOptions } from "./CatalogTypes.js";
export { generateCatalogTypes } from "./CatalogTypes.js";
export { Formatter } from "./formatters/Formatter.js";
export type {
	FormatterFactory,
	MessageParam,
	MessageParamKind,
	NumberFormatOptions,
	TimeFormatOptions,
	TranslationsFormatterContract,
} from "./formatters/IcuFormatter.js";
export {
	extractMessageParams,
	IcuFormatter,
} from "./formatters/IcuFormatter.js";

import {
	type FormatterFactory,
	IcuFormatter,
} from "./formatters/IcuFormatter.js";
import type { I18nManagerConfig, LoaderFactory } from "./Rosetta.js";

export { configure } from "./configure.js";
export type { I18nHttpContext, RequestValidatorLike } from "./middleware.js";
export type {
	BaseI18nConfig,
	CurrencyFormatOptions,
	DateTimeValue,
	I18nManagerConfig,
	Loader,
	LoaderFactory,
	LocaleResolverInput,
	MessageCatalog,
	MessageTree,
	MessageTreeList,
	MissingTranslationEmitter,
	MissingTranslationEventPayload,
	MissingTranslationHandler,
	NumberFormatData,
	ParamsFor,
	RosettaLoader,
	RosettaOptions,
	TranslateOptions,
	TranslationKey,
	TranslationKeys,
	TranslationParams,
	Translations,
	TranslationsLoaderContract,
	ValidationFieldContext,
} from "./Rosetta.js";
export type { RosettaProviderConfig } from "./RosettaProvider.js";
export type { I18nReplContext, I18nReplLike } from "./repl.js";
export { registerReplBindings } from "./repl.js";

export interface I18nEvents {
	"i18n:missing:translation": import("./Rosetta.js").MissingTranslationEventPayload;
}
export {
	I18nMessagesProvider,
	Rosetta,
	Rosetta as I18nManager,
	RosettaLocale,
	RosettaLocale as I18n,
} from "./Rosetta.js";

export interface ResolvableConfig<T> {
	resolver(app: unknown): Promise<T>;
}

type ConfigValue<T> = T | ResolvableConfig<T>;

/**
 * What `defineConfig` returns: the config as written, defaults applied, and a
 * hidden `resolver` that turns provider-style values into factories. The
 * formatter and loaders keep their given types, so passing the result straight
 * to `new Rosetta()` type-checks only when they already are factories.
 */
export type DefinedI18nConfig<
	F extends ConfigValue<FormatterFactory> = FormatterFactory,
	L extends ConfigValue<LoaderFactory> = LoaderFactory,
> = Omit<I18nManagerConfig, "formatter" | "loaders"> & {
	formatter: F;
	loaders: L[];
} & ResolvableConfig<I18nManagerConfig>;

/** Factories given: the result is a ready `RosettaOptions` as well. */
export function defineConfig(
	config: Partial<Omit<I18nManagerConfig, "formatter" | "loaders">> & {
		formatter: FormatterFactory;
		loaders?: LoaderFactory[];
	},
): DefinedI18nConfig;
/** Provider-style values given: only `resolver()` yields usable options. */
export function defineConfig(
	config: Partial<Omit<I18nManagerConfig, "formatter" | "loaders">> & {
		formatter: ConfigValue<FormatterFactory>;
		loaders?: ConfigValue<LoaderFactory>[];
	},
): DefinedI18nConfig<ConfigValue<FormatterFactory>, ConfigValue<LoaderFactory>>;
export function defineConfig(
	config: Partial<Omit<I18nManagerConfig, "formatter" | "loaders">> & {
		formatter: ConfigValue<FormatterFactory>;
		loaders?: ConfigValue<LoaderFactory>[];
	},
): DefinedI18nConfig<
	ConfigValue<FormatterFactory>,
	ConfigValue<LoaderFactory>
> {
	if (!config.formatter) {
		throw new Error(
			'Cannot configure i18n manager. Missing property "formatter"',
		);
	}

	const { defaultLocale = "en", formatter, loaders = [], ...rest } = config;
	return withResolver(
		{ ...rest, defaultLocale, formatter, loaders },
		async (app: unknown): Promise<I18nManagerConfig> => ({
			...rest,
			defaultLocale,
			formatter: await resolveConfigValue<FormatterFactory>(formatter, app),
			loaders: await Promise.all(
				loaders.map((loader) => resolveConfigValue<LoaderFactory>(loader, app)),
			),
		}),
	);
}

function isResolvable<T>(value: ConfigValue<T>): value is ResolvableConfig<T> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof Reflect.get(value, "resolver") === "function"
	);
}

async function resolveConfigValue<T>(
	value: ConfigValue<T>,
	app: unknown,
): Promise<T> {
	return isResolvable(value) ? value.resolver(app) : value;
}

/** Attach `resolver` out of enumeration, so spreading the config drops it. */
function withResolver<T extends object, R>(
	value: T,
	resolver: (app: unknown) => Promise<R>,
): T & ResolvableConfig<R> {
	const resolvable = Object.assign(value, { resolver });
	Object.defineProperty(resolvable, "resolver", { enumerable: false });
	return resolvable;
}

export const formatters = {
	icu(): FormatterFactory & ResolvableConfig<FormatterFactory> {
		const factory: FormatterFactory = () => new IcuFormatter();
		return withResolver(factory, async () => factory);
	},
};

export const loaders = {
	fs(
		config: FileSystemLoaderOptions,
	): LoaderFactory & ResolvableConfig<LoaderFactory> {
		const factory: LoaderFactory = () => new FileSystemLoader(config);
		return withResolver(factory, async () => factory);
	},
};
