import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Formatter } from "../../src/formatters/Formatter.js";
import { FileSystemLoader } from "../../src/loaders/FileSystemLoader.js";
import DetectUserLocaleMiddleware, {
	type I18nHttpContext,
} from "../../src/middleware.js";
import { Rosetta } from "../../src/Rosetta.js";

/**
 * Locales are matched case-insensitively, but the values the API hands back
 * are the ones the application configured: `pt-BR` stays `pt-BR`, so
 * `i18n.locale === 'pt-BR'`, a locale switcher and `<html lang>` agree with
 * the config.
 */
describe("rosetta > configured locale spelling", () => {
	const configured = ["en", "en-GB", "fr", "zh-Hant", "pt-BR"];

	function manager(): Rosetta {
		return new Rosetta({
			defaultLocale: "en",
			supportedLocales: configured,
			messages: { "pt-br": { hello: "Olá" }, en: { hello: "Hello" } },
		});
	}

	it("supportedLocales() returns the list as written", () => {
		const rosetta = manager();
		expect(rosetta.supportedLocales()).toEqual(configured);
		expect(rosetta.getSupportedLocales()).toEqual(configured);
	});

	it("negotiates to the configured spelling", () => {
		const rosetta = manager();
		expect(rosetta.getSupportedLocaleFor("pt")).toBe("pt-BR");
		expect(rosetta.getSupportedLocaleFor("pt-br")).toBe("pt-BR");
		expect(rosetta.getSupportedLocaleFor("ZH-hant-TW")).toBe("zh-Hant");
		expect(rosetta.resolveLocale("pt-br")).toBe("pt-BR");
		expect(rosetta.resolveLocale("en-gb")).toBe("en-GB");
	});

	it("keeps the locale a RosettaLocale was given, and still finds its catalog", () => {
		const rosetta = manager();
		const i18n = rosetta.locale("pt-BR");
		expect(i18n.locale).toBe("pt-BR");
		expect(i18n.getLocale()).toBe("pt-BR");
		expect(i18n.t("hello")).toBe("Olá");
		i18n.switchLocale("en-GB");
		expect(i18n.locale).toBe("en-GB");
		expect(i18n.t("hello")).toBe("Hello");
	});

	it("reports the configured default and fallback spellings", () => {
		const rosetta = new Rosetta({
			defaultLocale: "pt-BR",
			fallbackLocale: "en-GB",
			fallbackLocales: { "de-CH": "de-DE" },
			supportedLocales: ["pt-BR", "en-GB", "de-CH", "de-DE"],
		});
		expect(rosetta.defaultLocale).toBe("pt-BR");
		expect(rosetta.getDefaultLocale()).toBe("pt-BR");
		expect(rosetta.getFallbackLocale()).toBe("en-GB");
		expect(rosetta.getFallbackLocales()).toEqual({ "de-CH": "de-DE" });
		expect(rosetta.locale("de-CH").fallbackLocale).toBe("de-DE");
		expect(rosetta.getLocale()).toBe("pt-BR");
		expect(rosetta.runWithLocale("en-gb", () => rosetta.getLocale())).toBe(
			"en-GB",
		);
	});

	it("infers supported locales with their written spelling", () => {
		const rosetta = new Rosetta({
			defaultLocale: "en",
			messages: { "pt-BR": { a: "A" } },
		});
		expect(rosetta.supportedLocales()).toEqual(["en", "pt-BR"]);
	});

	it("hands the middleware's request the configured spelling", async () => {
		const rosetta = manager();
		const ctx: I18nHttpContext = { request: { header: () => "pt-br" } };
		await new DetectUserLocaleMiddleware(rosetta).handle(
			ctx,
			async () => undefined,
		);
		expect(ctx.locale).toBe("pt-BR");
		expect(ctx.i18n?.locale).toBe("pt-BR");
		expect(ctx.i18n?.t("hello")).toBe("Olá");
	});

	it("still formats with an underscore spelling", () => {
		const formatter = new Formatter("fr_FR");
		expect(formatter.locale).toBe("fr_FR");
		expect(formatter.formatNumber(1.5)).toBe(
			new Intl.NumberFormat("fr-FR").format(1.5),
		);
	});

	describe("with catalogs on disk", () => {
		let dir: string;

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "rosetta-casing-"));
		});

		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		it("finds a pt-BR.json file", async () => {
			writeFileSync(join(dir, "pt-BR.json"), JSON.stringify({ hi: "Oi" }));
			const rosetta = new Rosetta({
				defaultLocale: "pt-BR",
				supportedLocales: ["pt-BR"],
				loaders: [new FileSystemLoader({ rootDir: dir })],
			});
			await rosetta.boot();
			expect(rosetta.locale("pt-BR").t("hi")).toBe("Oi");
		});

		it("finds a pt-br/ directory", async () => {
			mkdirSync(join(dir, "pt-br"));
			writeFileSync(
				join(dir, "pt-br", "messages.json"),
				JSON.stringify({ hi: "Oi" }),
			);
			const rosetta = new Rosetta({
				defaultLocale: "pt-BR",
				supportedLocales: ["pt-BR"],
				loaders: [new FileSystemLoader({ rootDir: dir })],
			});
			await rosetta.boot();
			expect(rosetta.locale("pt-BR").t("messages.hi")).toBe("Oi");
		});
	});
});
