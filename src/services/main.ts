/**
 * Default `Rosetta` singleton — mirror of Adonis's
 * `import i18n from '@adonisjs/i18n/services/main'` shape.
 *
 *   import i18n from '@c9up/rosetta/services/main'
 *
 *   const locale = i18n.locale(i18n.resolveLocale({ header: req.headers['accept-language'] }))
 *   locale.t('greeting', { name: user.name })
 *
 * Populated by `RosettaProvider.boot()` or by the app directly through
 * `setI18n(myRosetta)` when the i18n config has to be built outside
 * the provider flow.
 */

import type { Rosetta } from "../Rosetta.js";

let instance: Rosetta | undefined;

/** @internal Bind the singleton (called by RosettaProvider or the app). */
export function setI18n(value: Rosetta): void {
	instance = value;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function getI18n(): Rosetta | undefined {
	return instance;
}

/** @internal Clear a provider-owned singleton during application shutdown. */
export function clearI18n(value?: Rosetta): void {
	if (value === undefined || instance === value) instance = undefined;
}

const i18n: Rosetta = new Proxy({} as Rosetta, {
	get(_target, prop) {
		if (!instance) {
			throw new Error(
				"[rosetta] Rosetta singleton accessed before RosettaProvider.boot() ran " +
					"or `setI18n(myRosetta)` was called. Wire one of them first.",
			);
		}
		const value = Reflect.get(instance, prop, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default i18n;
