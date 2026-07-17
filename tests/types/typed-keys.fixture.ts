/**
 * Compile-time gate for typed translation keys. Augmentation is global, so this
 * lives outside the main tsconfig: augmenting inside the unit suite would make
 * every other test's `t()` strict.
 *
 * Checked by `pnpm test:types`. `@ts-expect-error` is the assertion — if a line
 * stops being an error, tsc fails, which is exactly the regression we want.
 */
import { Rosetta } from "../../src/Rosetta.js";

declare module "../../src/Rosetta.js" {
	interface TranslationKeys {
		"messages.greeting": { name: string | number };
		"messages.items": { count: number };
		"messages.plain": Record<string, never>;
	}
}

const i18n = new Rosetta({ defaultLocale: "en" }).locale("en");

// --- accepted
i18n.t("messages.greeting", { name: "Hugo" });
i18n.t("messages.greeting", { name: 42 });
i18n.t("messages.items", { count: 2 });
i18n.t("messages.plain");
i18n.t("messages.greeting", { name: "Hugo" }, "fallback");

// --- rejected
// @ts-expect-error unknown key
i18n.t("messages.greetingg", { name: "Hugo" });
// @ts-expect-error `name` misspelled
i18n.t("messages.greeting", { nam: "Hugo" });
// @ts-expect-error a plural variable is a number, not a string
i18n.t("messages.items", { count: "2" });
// @ts-expect-error this message takes no variables
i18n.t("messages.plain", { count: 1 });
