import {
	type Rosetta,
	RosettaLocale,
	type TranslateArgs,
	type TranslationKey,
} from "../Rosetta.js";

/** The only surface the plugin needs — structural, so it binds to any engine
 * exposing `global()` without rosetta depending on one. */
interface TemplateEngineLike {
	global(name: string, value: unknown): void;
}

/**
 * The `i18n` global: a locale instance that answers in the locale of the
 * request being rendered.
 *
 * A fixed default-locale instance is right only where every render shares a
 * per-request `i18n` over it, as `ctx.view` does. inker also renders from a
 * request context directly, where nothing shares one, so the global itself has
 * to follow the locale the middleware runs the request under. Each read
 * resolves a fresh instance, which also keeps a template's `switchLocale()` on
 * the global from leaking into other requests.
 */
function requestLocaleView(manager: Rosetta): RosettaLocale {
	return new Proxy(manager.locale(manager.defaultLocale), {
		get(_target, prop) {
			const current = manager.locale(manager.getLocale());
			const value = Reflect.get(current, prop, current);
			return typeof value === "function" ? value.bind(current) : value;
		},
		set(_target, prop, value) {
			return Reflect.set(manager.locale(manager.getLocale()), prop, value);
		},
	});
}

/** Publishes rosetta's translation helpers as template globals. */
export function inkerPluginI18n(
	manager: Rosetta,
): (engine: TemplateEngineLike) => void {
	return (engine) => {
		const requestI18n = requestLocaleView(manager);
		engine.global("i18n", requestI18n);
		// Templates are not typechecked, so this global exists to forward, not to
		// constrain: it carries `t()`'s own argument tuple verbatim so that a
		// consumer augmenting TranslationKeys does not break the plugin.
		engine.global("t", function <
			K extends TranslationKey,
		>(this: { i18n?: unknown } | undefined, identifier: K, ...rest: TranslateArgs<K>) {
			// The render state's `i18n`: one a renderer shared for the request, or
			// the global above.
			const shared = this?.i18n;
			const i18n = shared instanceof RosettaLocale ? shared : requestI18n;
			return i18n.t(identifier, ...rest);
		});
		engine.global("getDefaultLocale", () => manager.defaultLocale);
		engine.global("getSupportedLocales", () => manager.supportedLocales());
	};
}
