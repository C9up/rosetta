import type {
	ParamsFor,
	Rosetta,
	RosettaLocale,
	TranslationKey,
} from "../Rosetta.js";

interface EdgeLike {
	global(name: string, value: unknown): void;
}

/** Edge-compatible plugin without a hard dependency on edge.js. */
export function edgePluginI18n(manager: Rosetta): (edge: EdgeLike) => void {
	return (edge) => {
		edge.global("i18n", manager.locale());
		edge.global("t", function <
			K extends TranslationKey,
		>(this: { i18n?: RosettaLocale }, identifier: K, data?: ParamsFor<K>, fallbackMessage?: string) {
			return (this.i18n ?? manager.locale()).t(
				identifier,
				data,
				fallbackMessage,
			);
		});
		edge.global("getDefaultLocale", () => manager.defaultLocale);
		edge.global("getSupportedLocales", () => manager.supportedLocales());
	};
}
