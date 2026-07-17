/**
 * Compile-time gate for typed translation keys, checked by `pnpm test:types`.
 *
 * Augmentation is global, so this lives outside the main tsconfig: augmenting
 * inside the unit suite would make every other test's `t()` strict.
 *
 * The rejections are asserted at the type level rather than with
 * `@ts-expect-error`, so this file contains no diagnostic directives: `Accepts`
 * answers "would this call compile?" as a boolean, and `ExpectFalse` turns a
 * wrong answer into a compile error. Weakening the typing therefore breaks this
 * file, which is the regression the gate exists to catch.
 */

import type { TranslateArgs, TranslationKey } from "../../src/Rosetta.js";
import { Rosetta } from "../../src/Rosetta.js";

declare module "../../src/Rosetta.js" {
	interface TranslationKeys {
		"messages.greeting": { name: string | number };
		"messages.items": { count: number };
		"messages.plain": Record<string, never>;
	}
}

type Expect<T extends true> = T;
type ExpectFalse<T extends false> = T;

/** Would `t(key, ...args)` typecheck? */
type Accepts<K extends TranslationKey, A extends unknown[]> =
	A extends TranslateArgs<K> ? true : false;

/** Is this string a key `t()` will accept? */
type IsKey<K> = K extends TranslationKey ? true : false;

// ─── Keys ────────────────────────────────────────────────────────────
type _KnownKey = Expect<IsKey<"messages.greeting">>;
type _UnknownKeyRejected = ExpectFalse<IsKey<"messages.greetingg">>;
type _ArbitraryStringRejected = ExpectFalse<IsKey<"literally anything">>;

// ─── Variables ───────────────────────────────────────────────────────
type _CorrectParams = Expect<Accepts<"messages.greeting", [{ name: string }]>>;
type _NumberName = Expect<Accepts<"messages.greeting", [{ name: number }]>>;
type _PluralCount = Expect<Accepts<"messages.items", [{ count: number }]>>;

type _MisspelledParamRejected = ExpectFalse<
	Accepts<"messages.greeting", [{ nam: string }]>
>;
type _WrongParamTypeRejected = ExpectFalse<
	Accepts<"messages.items", [{ count: string }]>
>;

/**
 * The hole AdonisJS cannot close: its key is a bare `string`, so omitting a
 * message's variables always compiles. Here it must not.
 */
type _OmittedParamsRejected = ExpectFalse<Accepts<"messages.items", []>>;
type _FallbackIsNotParams = ExpectFalse<
	Accepts<"messages.items", ["fallback"]>
>;

// A message with no variables takes none, and still takes a fallback.
type _NoParamsNeeded = Expect<Accepts<"messages.plain", []>>;
type _NoParamsTakesFallback = Expect<Accepts<"messages.plain", ["fallback"]>>;
type _NoParamsRejectsParams = ExpectFalse<
	Accepts<"messages.plain", [{ count: number }]>
>;

// ─── Real call sites ─────────────────────────────────────────────────
const i18n = new Rosetta({ defaultLocale: "en" }).locale("en");

i18n.t("messages.greeting", { name: "Hugo" });
i18n.t("messages.greeting", { name: 42 });
i18n.t("messages.items", { count: 2 });
i18n.t("messages.plain");
i18n.t("messages.plain", "fallback");
i18n.t("messages.greeting", { name: "Hugo" }, "fallback");
i18n.t("messages.greeting", { name: "Hugo" }, { defaultValue: "fallback" });
i18n.formatMessage("messages.items", { count: 2 });
