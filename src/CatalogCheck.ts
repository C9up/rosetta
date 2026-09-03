/**
 * Cross-locale catalog reconciliation — the i18n counterpart of Atlas's
 * `checkSchema`. Catalogs drift silently: a key is added to `en` and forgotten
 * in `fr`, a variable is renamed in one locale only, a message is edited into
 * invalid ICU. None of it fails until a user with that locale hits that key.
 *
 * This reads the loaded catalogs and reports the drift up front — in CI, or at
 * boot via {@link verifyCatalogs}.
 *
 * Not an AdonisJS API: `@adonisjs/i18n` only reports missing translations at
 * runtime, once the request is already being served.
 */

import {
	extractMessageParams,
	type MessageParam,
} from "./formatters/IcuFormatter.js";
import type { Translations } from "./Rosetta.js";

export type CatalogFindingKind =
	/** The reference locale has this key; this locale does not. */
	| "missing-in-locale"
	/** This locale has a key the reference locale does not — often a typo. */
	| "orphan-key"
	/** The key exists in both, but its ICU variables differ. */
	| "param-mismatch"
	/** The message is not valid ICU and will throw when formatted. */
	| "invalid-message";

export interface CatalogFinding {
	locale: string;
	key: string;
	kind: CatalogFindingKind;
	detail: string;
	/** A close key from the reference locale, for typo diagnostics. */
	suggestion?: string;
}

export interface CheckCatalogsOptions {
	/**
	 * The locale every other locale is compared against. Defaults to the first
	 * locale in `translations` — pass your `defaultLocale` to be explicit.
	 */
	referenceLocale?: string;
}

function levenshtein(a: string, b: string): number {
	let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current: number[] = [i];
		for (let j = 1; j <= b.length; j++) {
			current.push(
				Math.min(
					cell(previous, j) + 1,
					cell(current, j - 1) + 1,
					cell(previous, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1),
				),
			);
		}
		previous = current;
	}
	return cell(previous, b.length);
}

/**
 * One cell of a row that has already been filled.
 *
 * Rows are built left to right and every column is written before it is read,
 * so a miss cannot happen — this is where that invariant is stated rather than
 * asserted past.
 */
function cell(row: number[], index: number): number {
	const value = row[index];
	if (value === undefined) {
		throw new RangeError(
			`distance: column ${index} was read before it was written`,
		);
	}
	return value;
}

/** Closest candidate within edit distance 2 (typo suggestion), else undefined. */
export function suggestKey(
	name: string,
	candidates: string[],
): string | undefined {
	let best: string | undefined;
	let bestD = Number.POSITIVE_INFINITY;
	for (const c of candidates) {
		const d = levenshtein(name, c);
		if (d < bestD) {
			bestD = d;
			best = c;
		}
	}
	return bestD <= 2 ? best : undefined;
}

/** `count:plural` — the comparable identity of a variable. */
function paramSignature(param: MessageParam): string {
	return `${param.name}:${param.kind}`;
}

function describeParams(params: MessageParam[]): string {
	return params.length === 0 ? "(none)" : params.map(paramSignature).join(", ");
}

/**
 * Parse a message, turning a syntax error into a finding rather than a throw —
 * one bad message must not hide the rest of the report.
 */
function paramsOf(
	locale: string,
	key: string,
	message: string,
	findings: CatalogFinding[],
): MessageParam[] | null {
	try {
		return extractMessageParams(message);
	} catch (error) {
		findings.push({
			locale,
			key,
			kind: "invalid-message",
			detail:
				error instanceof Error ? error.message : "invalid ICU message syntax",
		});
		return null;
	}
}

/**
 * Reconcile every locale against the reference one. Returns findings, empty
 * when the catalogs agree.
 *
 * Catalogs are expected flat (`{ "messages.greeting": "Hello" }`), which is
 * what the loaders produce.
 */
export function checkCatalogs(
	translations: Translations,
	opts: CheckCatalogsOptions = {},
): CatalogFinding[] {
	const locales = Object.keys(translations);
	const reference = opts.referenceLocale ?? locales[0];
	if (reference === undefined) return [];

	const referenceCatalog = translations[reference];
	if (!referenceCatalog) {
		return [
			{
				locale: reference,
				key: "<catalog>",
				kind: "missing-in-locale",
				detail: `reference locale '${reference}' has no catalog loaded`,
			},
		];
	}

	const findings: CatalogFinding[] = [];
	const referenceKeys = Object.keys(referenceCatalog);
	const referenceParams = new Map<string, MessageParam[]>();

	// The reference locale is checked for ICU validity too — it is the source of
	// truth for variables, so a broken message there poisons every comparison.
	for (const key of referenceKeys) {
		const params = paramsOf(
			reference,
			key,
			referenceCatalog[key] ?? "",
			findings,
		);
		if (params) referenceParams.set(key, params);
	}

	for (const locale of locales) {
		if (locale === reference) continue;
		const catalog = translations[locale] ?? {};
		const localeKeys = new Set(Object.keys(catalog));

		for (const key of referenceKeys) {
			if (!localeKeys.has(key)) {
				findings.push({
					locale,
					key,
					kind: "missing-in-locale",
					detail: `present in '${reference}', missing here`,
				});
			}
		}

		for (const key of localeKeys) {
			const params = paramsOf(locale, key, catalog[key] ?? "", findings);

			if (!Object.hasOwn(referenceCatalog, key)) {
				findings.push({
					locale,
					key,
					kind: "orphan-key",
					detail: `not present in '${reference}'`,
					suggestion: suggestKey(key, referenceKeys),
				});
				continue;
			}

			const expected = referenceParams.get(key);
			if (!params || !expected) continue;

			const got = params.map(paramSignature).join("|");
			const want = expected.map(paramSignature).join("|");
			if (got !== want) {
				findings.push({
					locale,
					key,
					kind: "param-mismatch",
					detail: `expects ${describeParams(params)}, but '${reference}' declares ${describeParams(expected)}`,
				});
			}
		}
	}

	return findings;
}

export function formatCatalogFindings(findings: CatalogFinding[]): string {
	if (findings.length === 0) {
		return "[rosetta:check] catalogs OK — every locale agrees.";
	}
	const byLocale = new Map<string, CatalogFinding[]>();
	for (const f of findings) {
		const list = byLocale.get(f.locale) ?? [];
		list.push(f);
		byLocale.set(f.locale, list);
	}
	const lines: string[] = [
		`[rosetta:check] ${findings.length} catalog issue(s) found:`,
	];
	for (const [locale, list] of byLocale) {
		lines.push(`\n  ${locale}`);
		for (const f of list) {
			const hint = f.suggestion ? ` — did you mean \`${f.suggestion}\`?` : "";
			lines.push(`    ✗ ${f.key}: ${f.detail}${hint}`);
		}
	}
	return lines.join("\n");
}

/**
 * Boot-time guard: run {@link checkCatalogs} and either throw (fail-fast, for
 * CI / dev startup) or warn. Returns the findings.
 *
 * `mode` defaults to `"warn"`, not `"throw"` as in Atlas: a schema mismatch
 * corrupts data, whereas a missing translation degrades to the fallback locale
 * and still serves a page. Opt into `"throw"` where a partial translation is
 * unacceptable.
 */
export function verifyCatalogs(
	translations: Translations,
	opts: CheckCatalogsOptions & { mode?: "throw" | "warn" } = {},
): CatalogFinding[] {
	const findings = checkCatalogs(translations, opts);
	if (findings.length > 0) {
		const report = formatCatalogFindings(findings);
		if (opts.mode === "throw") throw new Error(report);
		console.warn(report);
	}
	return findings;
}

/**
 * Script body: run the check, print the report (or the OK line), and return the
 * process exit code (`0` = catalogs agree, `1` = drift).
 */
export function runCatalogCheck(
	translations: Translations,
	opts: CheckCatalogsOptions = {},
): number {
	const findings = checkCatalogs(translations, opts);
	console.log(formatCatalogFindings(findings));
	return findings.length > 0 ? 1 : 0;
}
