import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSystemLoader } from "../../src/loaders/FileSystemLoader.js";
import { isNativeAvailable } from "../../src/native.js";
import type { MessageTree } from "../../src/Rosetta.js";
import { Rosetta } from "../../src/Rosetta.js";

describe("rosetta", () => {
	it("exposes native availability flag", () => {
		expect(typeof isNativeAvailable()).toBe("boolean");
	});

	it("translates with current locale", () => {
		const i18n = new Rosetta()
			.loadMessages("en", { hello: "Hello" })
			.loadMessages("fr", { hello: "Bonjour" })
			.setLocale("fr");

		expect(i18n.t("hello")).toBe("Bonjour");
	});

	it("falls back to fallback locale", () => {
		const i18n = new Rosetta({ defaultLocale: "fr", fallbackLocale: "en" })
			.loadMessages("en", { hello: "Hello" })
			.loadMessages("fr", {});

		expect(i18n.t("hello")).toBe("Hello");
	});

	it("returns defaultValue when key does not exist", () => {
		const i18n = new Rosetta();
		expect(i18n.t("missing.key", undefined, { defaultValue: "N/A" })).toBe(
			"N/A",
		);
	});

	it("returns key when translation and defaultValue are missing", () => {
		const i18n = new Rosetta();
		expect(i18n.t("missing.key")).toBe("missing.key");
	});

	it("interpolates placeholders", () => {
		const i18n = new Rosetta().loadMessages("en", {
			welcome: "Hello {name}, you have {count} messages",
		});

		expect(i18n.t("welcome", { name: "Kaen", count: 3 })).toBe(
			"Hello Kaen, you have 3 messages",
		);
	});

	it("replaces all occurrences of the same placeholder", () => {
		const i18n = new Rosetta().loadMessages("en", {
			repeated: "{name} says hi to {name}",
		});

		expect(i18n.t("repeated", { name: "Kaen" })).toBe("Kaen says hi to Kaen");
	});

	it("supports locale override in translate options", () => {
		const i18n = new Rosetta({ defaultLocale: "en" })
			.loadMessages("en", { hello: "Hello" })
			.loadMessages("fr", { hello: "Bonjour" });

		expect(i18n.t("hello", undefined, { locale: "fr" })).toBe("Bonjour");
	});

	it("has() checks key presence in a locale", () => {
		const i18n = new Rosetta().loadMessages("en", { hello: "Hello" });
		expect(i18n.has("hello")).toBe(true);
		expect(i18n.has("missing")).toBe(false);
	});

	it("supports nested message trees", () => {
		const nestedMessages = {
			auth: {
				login: {
					success: "Welcome {name}",
				},
			},
		} as const satisfies MessageTree;

		const i18n = new Rosetta().loadMessages("en", nestedMessages);

		expect(i18n.t("auth.login.success", { name: "Kaen" })).toBe("Welcome Kaen");
	});

	it("supports explicit regional fallback mapping", () => {
		const i18n = new Rosetta({
			defaultLocale: "en",
			fallbackLocales: { "fr-ch": "fr" },
		})
			.loadMessages("fr", { greeting: "Bonjour" })
			.loadMessages("en", { greeting: "Hello" })
			.setLocale("fr-CH");

		expect(i18n.t("greeting")).toBe("Bonjour");
	});

	it("supports automatic base-locale fallback", () => {
		const i18n = new Rosetta({ defaultLocale: "en" })
			.loadMessages("pt", { greeting: "Ola" })
			.loadMessages("en", { greeting: "Hello" })
			.setLocale("pt-BR");

		expect(i18n.t("greeting")).toBe("Ola");
	});

	it("resolves locale from accept-language header", () => {
		const i18n = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en", "fr", "de"],
		});

		const resolved = i18n.resolveLocale("de-CH,de;q=0.9,fr;q=0.8,en;q=0.7");
		expect(resolved).toBe("de");
	});

	it("creates locale-scoped instances", () => {
		const i18n = new Rosetta({ defaultLocale: "en" })
			.loadMessages("en", { greeting: "Hello" })
			.loadMessages("fr", { greeting: "Bonjour" });

		expect(i18n.locale("fr").t("greeting")).toBe("Bonjour");
		expect(i18n.locale("en").t("greeting")).toBe("Hello");
	});

	it("formats numbers and currency with locale", () => {
		const i18n = new Rosetta({ defaultLocale: "fr" });
		const number = i18n.formatNumber(12345.67);
		const currency = i18n.formatCurrency(1234.5, "EUR");

		expect(number.length).toBeGreaterThan(0);
		expect(currency.includes("€")).toBe(true);
	});

	it("formats relative time with locale", () => {
		const i18n = new Rosetta({ defaultLocale: "en" });
		expect(i18n.formatRelativeTime(-1, "day")).toContain("1 day ago");
	});

	it("loads messages through async loaders", async () => {
		const i18n = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en"],
			loaders: [
				{
					async load(locale) {
						if (locale === "en") return { greeting: "Loaded hello" };
						return null;
					},
				},
			],
		});

		await i18n.boot();
		expect(i18n.t("greeting")).toBe("Loaded hello");
	});

	it("supports ICU select (gender)", () => {
		const i18n = new Rosetta({ defaultLocale: "en" }).loadMessages("en", {
			greet:
				"{gender, select, male {Mr {name}} female {Ms {name}} other {Hello {name}}}",
		});

		expect(i18n.t("greet", { gender: "male", name: "Kaen" })).toBe("Mr Kaen");
		expect(i18n.t("greet", { gender: "female", name: "Kaen" })).toBe("Ms Kaen");
		expect(i18n.t("greet", { gender: "x", name: "Kaen" })).toBe("Hello Kaen");
	});

	it("supports ICU plural (CLDR categories)", () => {
		const i18n = new Rosetta({ defaultLocale: "en" }).loadMessages("en", {
			items: "{count, plural, =0 {No items} one {# item} other {# items}}",
		});

		expect(i18n.t("items", { count: 0 })).toBe("No items");
		expect(i18n.t("items", { count: 1 })).toBe("1 item");
		expect(i18n.t("items", { count: 3 })).toBe("3 items");
	});

	it("supports ICU plural with offset", () => {
		const i18n = new Rosetta({ defaultLocale: "en" }).loadMessages("en", {
			invites:
				"{count, plural, offset:1 =0 {Nobody joined} =1 {You joined} one {You and # other joined} other {You and # others joined}}",
		});

		expect(i18n.t("invites", { count: 0 })).toBe("Nobody joined");
		expect(i18n.t("invites", { count: 1 })).toBe("You joined");
		expect(i18n.t("invites", { count: 2 })).toBe("You and 1 other joined");
		expect(i18n.t("invites", { count: 5 })).toBe("You and 4 others joined");
	});

	it("supports ICU selectordinal", () => {
		const i18n = new Rosetta({ defaultLocale: "en" }).loadMessages("en", {
			rank: "{place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} place",
		});

		expect(i18n.t("rank", { place: 1 })).toBe("1st place");
		expect(i18n.t("rank", { place: 2 })).toBe("2nd place");
		expect(i18n.t("rank", { place: 3 })).toBe("3rd place");
		expect(i18n.t("rank", { place: 4 })).toBe("4th place");
	});

	it("supports ICU number/date/time formats", () => {
		const i18n = new Rosetta({ defaultLocale: "en" }).loadMessages("en", {
			price: "{amount, number, currency/USD}",
			pct: "{ratio, number, percent}",
			day: "{when, date, short}",
			hour: "{when, time, short}",
		});

		expect(i18n.t("price", { amount: 12.5 }).length).toBeGreaterThan(0);
		expect(i18n.t("pct", { ratio: 0.42 }).length).toBeGreaterThan(0);
		expect(
			i18n.t("day", { when: new Date("2026-01-01T12:00:00Z") }).length,
		).toBeGreaterThan(0);
		expect(
			i18n.t("hour", { when: new Date("2026-01-01T12:00:00Z") }).length,
		).toBeGreaterThan(0);
	});

	it("loads locale catalogs from filesystem JSON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rosetta-json-"));
		try {
			writeFileSync(
				join(dir, "en.json"),
				JSON.stringify({ hello: "Hello {name}" }, null, 2),
				"utf8",
			);
			const i18n = new Rosetta({
				defaultLocale: "en",
				supportedLocales: ["en"],
				loaders: [new FileSystemLoader({ rootDir: dir })],
			});
			await i18n.boot();
			expect(i18n.t("hello", { name: "Kaen" })).toBe("Hello Kaen");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads locale catalogs from filesystem YAML", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rosetta-yaml-"));
		try {
			writeFileSync(
				join(dir, "en.yaml"),
				["auth:", "  login:", '    success: "Welcome {name}"'].join("\n"),
				"utf8",
			);
			const i18n = new Rosetta({
				defaultLocale: "en",
				supportedLocales: ["en"],
				loaders: [new FileSystemLoader({ rootDir: dir })],
			});
			await i18n.boot();
			expect(i18n.t("auth.login.success", { name: "Kaen" })).toBe(
				"Welcome Kaen",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
