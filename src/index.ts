/**
 * @c9up/rosetta — framework-agnostic internationalization module.
 */

export type { FileSystemLoaderOptions } from "./loaders/FileSystemLoader.js";
export { FileSystemLoader } from "./loaders/FileSystemLoader.js";
export { isNativeAvailable } from "./native.js";
export type {
	LocaleResolverInput,
	MessageCatalog,
	MessageTree,
	NumberFormatData,
	RosettaLoader,
	RosettaLocale,
	RosettaOptions,
	TranslateOptions,
	TranslationParams,
} from "./Rosetta.js";
export { Rosetta } from "./Rosetta.js";
export type { RosettaProviderConfig } from "./RosettaProvider.js";

import type { RosettaProviderConfig } from "./RosettaProvider.js";

/**
 * Author-time config helper for `config/i18n.ts` — AdonisJS i18n `defineConfig`
 * parity. Identity at runtime; the generic preserves literal types for inference.
 */
export function defineConfig<T extends RosettaProviderConfig>(config: T): T {
	return config;
}
