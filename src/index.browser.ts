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

export { configure, stubsRoot } from "./configure.js";
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

export type DefinedI18nConfig = I18nManagerConfig &
	ResolvableConfig<I18nManagerConfig>;

export function defineConfig(
	config: Partial<Omit<I18nManagerConfig, "formatter" | "loaders">> & {
		formatter: ConfigValue<FormatterFactory>;
		loaders?: ConfigValue<LoaderFactory>[];
	},
): DefinedI18nConfig {
	if (!config.formatter) {
		throw new Error(
			'Cannot configure i18n manager. Missing property "formatter"',
		);
	}

	const defined = {
		defaultLocale: "en",
		loaders: [],
		...config,
	} as DefinedI18nConfig;
	Object.defineProperty(defined, "resolver", {
		enumerable: false,
		value: async (app: unknown): Promise<I18nManagerConfig> => ({
			...defined,
			formatter: await resolveFactory(defined.formatter, app),
			loaders: await Promise.all(
				defined.loaders.map((loader) => resolveFactory(loader, app)),
			),
		}),
	});
	return defined;
}

type ResolvableFactory<T> = T & Partial<ResolvableConfig<T>>;

async function resolveFactory<T>(factory: ResolvableFactory<T>, app: unknown) {
	return typeof factory.resolver === "function"
		? factory.resolver(app)
		: factory;
}

function withResolver<T extends object>(value: T): T & ResolvableConfig<T> {
	Object.defineProperty(value, "resolver", {
		enumerable: false,
		value: async () => value,
	});
	return value as T & ResolvableConfig<T>;
}

export const formatters = {
	icu(): FormatterFactory & ResolvableConfig<FormatterFactory> {
		return withResolver(() => new IcuFormatter());
	},
};

export const loaders = {
	fs(
		config: FileSystemLoaderOptions,
	): LoaderFactory & ResolvableConfig<LoaderFactory> {
		return withResolver(() => new FileSystemLoader(config));
	},
};
