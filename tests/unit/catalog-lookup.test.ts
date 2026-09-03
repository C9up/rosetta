/**
 * A catalog answers for the keys the application wrote down, and for nothing
 * else. Built out of plain object literals it also answers for every name
 * `Object.prototype` carries, which turns `has()` into a lie and hands
 * `resolveIdentifier` a native function through a signature promising a string.
 */
import { describe, expect, it } from "vitest";
import { checkCatalogs } from "../../src/CatalogCheck.js";
import { Rosetta } from "../../src/Rosetta.js";

const INHERITED = ["toString", "valueOf", "hasOwnProperty", "isPrototypeOf"];

function loaded(): Rosetta {
	return new Rosetta({
		defaultLocale: "en",
		supportedLocales: ["en", "fr"],
		messages: { en: { greeting: "Hello" } },
	});
}

describe("rosetta > a key every object already has", () => {
	it("is not a translation in a locale that has one loaded", () => {
		const locale = loaded().locale("en");
		for (const key of INHERITED) {
			expect([key, locale.has(key), locale.hasMessage(key)]).toEqual([
				key,
				false,
				false,
			]);
		}
	});

	it("is not a translation in a locale with no catalog at all", () => {
		const locale = loaded().locale("fr");
		for (const key of INHERITED) {
			expect([key, locale.has(key)]).toEqual([key, false]);
		}
	});

	it("reports missing rather than formatting a native function", () => {
		// The old answer was an empty string: the ICU formatter had been handed
		// `Object.prototype.toString` and stringified it into nothing, so a
		// missing key looked like a translated one that happened to be blank.
		expect(loaded().t("toString")).toBe("translation missing: en, toString");
	});

	it("resolves to nothing rather than to an inherited value", () => {
		expect(loaded().locale("en").resolveIdentifier("valueOf")).toBeNull();
	});

	it("still resolves the keys that were actually loaded", () => {
		const locale = loaded().locale("en");
		expect([locale.has("greeting"), locale.t("greeting")]).toEqual([
			true,
			"Hello",
		]);
	});

	it("can be a translation key when a catalog really declares it", () => {
		// Nothing here forbids the NAME — `flattenMessages` rejects the three
		// keys that reach the prototype chain, and `toString` is not one of them.
		const manager = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en"],
			messages: { en: { toString: "Printed" } },
		});
		expect([
			manager.locale("en").has("toString"),
			manager.t("toString"),
		]).toEqual([true, "Printed"]);
	});
});

describe("rosetta > checkCatalogs against inherited names", () => {
	it("reports a key the reference locale does not declare", () => {
		// `key in referenceCatalog` walks the prototype chain, so a locale that
		// invents `toString` was silently accepted as agreeing with the
		// reference — the one drift report the tool exists to produce.
		const findings = checkCatalogs(
			{ en: { greeting: "Hello" }, fr: { greeting: "Bonjour", toString: "?" } },
			{ referenceLocale: "en" },
		);
		expect(
			findings.map((f) => `${f.locale}/${f.key}/${f.kind}`).sort(),
		).toEqual(["fr/toString/orphan-key"]);
	});
});
