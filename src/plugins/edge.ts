import type {
	Rosetta,
	RosettaLocale,
	TranslateArgs,
	TranslationKey,
} from "../Rosetta.js";

interface EdgeLike {
	global(name: string, value: unknown): void;
}

/** Edge-compatible plugin without a hard dependency on edge.js. */
export function edgePluginI18n(manager: Rosetta): (edge: EdgeLike) => void {
	return (edge) => {
		edge.global("i18n", manager.locale());
		// Templates are not typechecked, so this global exists to forward, not to
		// constrain: it carries `t()`'s own argument tuple verbatim so that a
		// consumer augmenting TranslationKeys does not break the plugin.
		edge.global("t", function <
			K extends TranslationKey,
		>(this: { i18n?: RosettaLocale }, identifier: K, ...rest: TranslateArgs<K>) {
			return (this.i18n ?? manager.locale()).t(identifier, ...rest);
		});
		edge.global("getDefaultLocale", () => manager.defaultLocale);
		edge.global("getSupportedLocales", () => manager.supportedLocales());
	};
}
