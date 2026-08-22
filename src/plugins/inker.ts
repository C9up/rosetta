import type {
	Rosetta,
	RosettaLocale,
	TranslateArgs,
	TranslationKey,
} from "../Rosetta.js";

/** The only surface the plugin needs — structural, so it binds to any engine
 * exposing `global()` without rosetta depending on one. */
interface TemplateEngineLike {
	global(name: string, value: unknown): void;
}

/** Publishes rosetta's translation helpers as template globals. */
export function inkerPluginI18n(
	manager: Rosetta,
): (engine: TemplateEngineLike) => void {
	return (engine) => {
		engine.global("i18n", manager.locale());
		// Templates are not typechecked, so this global exists to forward, not to
		// constrain: it carries `t()`'s own argument tuple verbatim so that a
		// consumer augmenting TranslationKeys does not break the plugin.
		engine.global("t", function <
			K extends TranslationKey,
		>(this: { i18n?: RosettaLocale }, identifier: K, ...rest: TranslateArgs<K>) {
			return (this.i18n ?? manager.locale()).t(identifier, ...rest);
		});
		engine.global("getDefaultLocale", () => manager.defaultLocale);
		engine.global("getSupportedLocales", () => manager.supportedLocales());
	};
}
