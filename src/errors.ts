/**
 * Rosetta errors, one per code, so a caller can test `error.code` or
 * `error instanceof errors.E_ROSETTA_...` rather than the message.
 */

import { createError } from "@c9up/flare";

/** `defineConfig()` was called without a formatter. */
export const E_ROSETTA_INVALID_CONFIG = createError(
	'Cannot configure i18n manager. Missing property "formatter"',
	"E_ROSETTA_INVALID_CONFIG",
);

/** `config/i18n` does not export what `defineConfig()` returns. */
export const E_ROSETTA_CONFIG_MISSING = createError(
	'Invalid or missing "config/i18n" export. Configure Rosetta with defineConfig().',
	"E_ROSETTA_CONFIG_MISSING",
);

/** The Rosetta singleton was read before the provider booted or `setI18n()` ran. */
export const E_ROSETTA_NOT_BOOTED = createError(
	"[rosetta] Rosetta singleton accessed before RosettaProvider.boot() ran " +
		"or `setI18n(myRosetta)` was called. Wire one of them first.",
	"E_ROSETTA_NOT_BOOTED",
);

/** A constructor or option received an argument of the wrong shape. */
export const E_ROSETTA_INVALID_ARGUMENT = createError<[string]>(
	"%s",
	"E_ROSETTA_INVALID_ARGUMENT",
);

/** The browser build was asked to read the filesystem. */
export const E_ROSETTA_UNSUPPORTED_RUNTIME = createError(
	"FileSystemLoader is only available in runtimes that provide the Node.js filesystem APIs",
	"E_ROSETTA_UNSUPPORTED_RUNTIME",
);

/** An ICU message does not parse, or uses a style Intl cannot render. */
export const E_ROSETTA_INVALID_ICU_MESSAGE = createError<[string]>(
	"%s",
	"E_ROSETTA_INVALID_ICU_MESSAGE",
);

/** An ICU message is longer, larger or deeper than the formatter accepts. */
export const E_ROSETTA_ICU_LIMIT_EXCEEDED = createError<[string]>(
	"ICU message exceeds %s",
	"E_ROSETTA_ICU_LIMIT_EXCEEDED",
);

/** A message names an ICU variable the call did not provide. */
export const E_ROSETTA_MISSING_VARIABLE = createError<[string, string]>(
	"The ICU variable '%s' was not provided for message '%s'",
	"E_ROSETTA_MISSING_VARIABLE",
);

/** A date/time argument is not a date Rosetta can format. */
export const E_ROSETTA_INVALID_DATE = createError<[string]>(
	"%s",
	"E_ROSETTA_INVALID_DATE",
);

/** A translation or custom-format key could reach the object prototype. */
export const E_ROSETTA_UNSAFE_KEY = createError<[string, string]>(
	"Unsafe %s key '%s'",
	"E_ROSETTA_UNSAFE_KEY",
);

/** Two catalog entries resolve to the same key. */
export const E_ROSETTA_DUPLICATE_KEY = createError<[string, string]>(
	"Duplicate %s key '%s'",
	"E_ROSETTA_DUPLICATE_KEY",
);

/** A catalog file or tree is larger or deeper than the loader accepts. */
export const E_ROSETTA_CATALOG_LIMIT_EXCEEDED = createError<[string, string]>(
	"Translation %s exceeds %s",
	"E_ROSETTA_CATALOG_LIMIT_EXCEEDED",
);

/** A catalog holds a value or a YAML construct Rosetta does not accept. */
export const E_ROSETTA_INVALID_CATALOG = createError<[string]>(
	"%s",
	"E_ROSETTA_INVALID_CATALOG",
);

/** A translation path is a symbolic link or resolves outside its root. */
export const E_ROSETTA_UNSAFE_PATH = createError<[string]>(
	"%s",
	"E_ROSETTA_UNSAFE_PATH",
);

/** A translation path is not the directory or file it should be. */
export const E_ROSETTA_INVALID_PATH = createError<[string, string]>(
	"Translation path is not a %s: %s",
	"E_ROSETTA_INVALID_PATH",
);

/** `verifyCatalogs({ mode: "throw" })` found locales that disagree. */
export const E_ROSETTA_CATALOG_MISMATCH = createError<[string]>(
	"%s",
	"E_ROSETTA_CATALOG_MISMATCH",
);

/** An internal invariant broke: a bug in Rosetta, not in the caller's input. */
export const E_ROSETTA_INTERNAL = createError<[string]>(
	"%s",
	"E_ROSETTA_INTERNAL",
);
