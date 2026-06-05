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
