/**
 * Content negotiation against the exact answers AdonisJS gives.
 *
 * Every expectation here was read off upstream's `negotiator` — the library
 * behind `request.languages()` — for the same header and the same supported
 * list, not derived from this implementation.
 */
import { describe, expect, it } from "vitest";
import DetectUserLocaleMiddleware from "../../src/middleware.js";
import { Rosetta } from "../../src/Rosetta.js";

function manager(supportedLocales: string[]): Rosetta {
	return new Rosetta({ defaultLocale: supportedLocales[0], supportedLocales });
}

describe("rosetta > a header that refuses a language", () => {
	it("does not hand it back through the wildcard", () => {
		// `en;q=0, *` reads "anything but English". Dropping the refused entry
		// before matching leaves `*` free to pick English straight back up.
		expect(manager(["en", "fr"]).getSupportedLocaleFor("en;q=0, *")).toBe("fr");
	});

	it("still refuses it when the wildcard is not involved", () => {
		expect(manager(["en", "fr"]).getSupportedLocaleFor("en;q=0, fr")).toBe(
			"fr",
		);
		expect(manager(["en", "fr"]).getSupportedLocaleFor("fr;q=0")).toBeNull();
	});

	it("treats a malformed qvalue as a refusal, as upstream's parseFloat does", () => {
		expect(manager(["en", "fr"]).getSupportedLocaleFor("fr;q=junk, en")).toBe(
			"en",
		);
	});
});

describe("rosetta > a wildcard beside an explicit preference", () => {
	it("does not outbid the locale's own, lower quality", () => {
		// The client asked for English only if it must, and anything else by
		// preference. Comparing every (entry, locale) pair by quality first lets
		// `*;q=0.9` answer for `en` and win with a weight `en` never had.
		expect(
			manager(["en", "fr"]).getSupportedLocaleFor("en;q=0.1, *;q=0.9"),
		).toBe("fr");
	});

	it("still answers for the locales nothing else named", () => {
		expect(manager(["en", "fr"]).getSupportedLocaleFor("*")).toBe("en");
	});
});

describe("rosetta > a qvalue outside its range", () => {
	it("keeps the preference instead of dropping the entry", () => {
		// Above 1 is not a qvalue, but rejecting the entry loses exactly the
		// preference the client shouted loudest.
		expect(manager(["en", "fr"]).getSupportedLocaleFor("fr;q=2, en")).toBe(
			"fr",
		);
		expect(manager(["en", "fr"]).getSupportedLocaleFor("en, fr;q=2")).toBe(
			"fr",
		);
	});
});

describe("rosetta > which side of the match is the more specific one", () => {
	it("prefers narrowing the request over guessing a region", () => {
		// `en-GB` asked and `en` offered gives back the language the client
		// named; `fr` asked and `fr-CA` offered guesses at a region it never
		// mentioned. The two are not the same quality of match.
		expect(manager(["en", "fr-CA"]).getSupportedLocaleFor("fr, en-GB")).toBe(
			"en",
		);
	});

	it("still prefers an exact offer over a broader one", () => {
		// Normalized on the way out: `supportedLocales` is stored canonically.
		expect(manager(["en", "en-GB"]).getSupportedLocaleFor("en-GB")).toBe(
			"en-gb",
		);
	});
});

describe("rosetta > which source the locale middleware reads", () => {
	function context(request: Record<string, unknown>): {
		request: Record<string, unknown>;
		locale?: string;
	} {
		return { request };
	}

	it("prefers the raw header over a host's pre-digested list", async () => {
		// `languages()` has already spent the qvalues: `en;q=0, *` reaches it as
		// `["*"]`, and a bare wildcard answers with the one language the client
		// ruled out. The header still carries the refusal.
		const ctx = context({
			header: (name: string) =>
				name === "accept-language" ? "en;q=0, *" : undefined,
			languages: () => ["*"],
		});

		await new DetectUserLocaleMiddleware(manager(["en", "fr"])).handle(
			ctx,
			async () => undefined,
		);

		expect(ctx.locale).toBe("fr");
	});

	it("still falls back to the list when there is no header", async () => {
		const ctx = context({ languages: () => ["fr", "en"] });

		await new DetectUserLocaleMiddleware(manager(["en", "fr"])).handle(
			ctx,
			async () => undefined,
		);

		expect(ctx.locale).toBe("fr");
	});

	it("falls back to the default locale when the client said nothing", async () => {
		const ctx = context({});

		await new DetectUserLocaleMiddleware(manager(["en", "fr"])).handle(
			ctx,
			async () => undefined,
		);

		expect(ctx.locale).toBe("en");
	});
});
