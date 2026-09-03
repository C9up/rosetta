import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nManagerFactory } from "../../src/factories/main.js";
import {
	configure,
	defineConfig,
	FileSystemLoader,
	formatters,
	I18n,
	I18nManager,
	IcuFormatter,
	loaders,
	Rosetta,
	RosettaLocale,
	stubsRoot,
	type TranslationsLoaderContract,
} from "../../src/index.js";
import type { RequestValidatorLike } from "../../src/middleware.js";
import DetectUserLocaleMiddleware from "../../src/middleware.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}


describe("rosetta > AdonisJS i18n compatibility", () => {
	let root: string;

	beforeEach(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "rosetta-adonis-"));
	});

	afterEach(async () => {
		delete (Object.prototype as { polluted?: string }).polluted;
		await fsp.rm(root, { recursive: true, force: true });
	});

	it("accepts the Adonis defineConfig + formatter + fs loader shape", async () => {
		await fsp.mkdir(path.join(root, "en"), { recursive: true });
		await fsp.writeFile(
			path.join(root, "en", "messages.json"),
			JSON.stringify({ greeting: "Hello {name}" }),
		);
		const config = defineConfig({
			defaultLocale: "en",
			formatter: formatters.icu(),
			loaders: [loaders.fs({ location: pathToFileURL(`${root}/`) })],
		});
		const manager = new Rosetta(config);

		await manager.loadTranslations();

		expect(manager.supportedLocales()).toContain("en");
		expect(manager.locale().t("messages.greeting", { name: "John" })).toBe(
			"Hello John",
		);
	});

	it("supports the concrete Adonis I18nManager and I18n constructors", () => {
		const events: unknown[] = [];
		const emitter = {
			emit(event: string, payload: unknown) {
				events.push([event, payload]);
			},
		};
		const manager = new I18nManager(emitter, {
			defaultLocale: "en",
			formatter: () => new IcuFormatter(),
			loaders: [],
			messages: { en: { hello: "Hello" } },
		});
		const i18n = new I18n("fr", emitter, manager);

		expect(i18n.t("hello")).toBe("Hello");
		expect(events).toEqual([
			[
				"i18n:missing:translation",
				{ locale: "fr", identifier: "hello", hasFallback: true },
			],
		]);
	});

	it("exposes the Adonis getFallbackMessage manager method", () => {
		const manager = new Rosetta({
			fallback: (identifier, locale) => `${locale}:${identifier}`,
		});
		expect(manager.getFallbackMessage("missing", "FR_CA")).toBe(
			"fr-ca:missing",
		);
	});

	it("provides the Adonis factories merge/create/createMiddleware contract", () => {
		const factory = new I18nManagerFactory().merge({
			config: {
				defaultLocale: "fr",
				loaders: [],
				messages: { fr: { hello: "Bonjour" } },
			},
		});
		const manager = factory.create();

		expect(manager).toBeInstanceOf(I18nManager);
		expect(manager.defaultLocale).toBe("fr");
		expect(manager.locale().t("hello")).toBe("Bonjour");
		expect(factory.createMiddleware()).toBeInstanceOf(
			DetectUserLocaleMiddleware,
		);
	});

	it("validates and resolves defineConfig using the Adonis provider contract", async () => {
		expect(() => defineConfig({ loaders: [] } as never)).toThrow(
			'Missing property "formatter"',
		);
		const config = defineConfig({
			formatter: formatters.icu(),
			loaders: [loaders.fs({ location: root })],
		});
		const resolved = await config.resolver({});

		expect(config.defaultLocale).toBe("en");
		expect(Object.keys(config)).not.toContain("resolver");
		expect(resolved.formatter(resolved)).toBeInstanceOf(IcuFormatter);
		expect(defined(resolved.loaders[0])(resolved)).toBeInstanceOf(FileSystemLoader);
	});

	it("resolves custom non-callable config providers", async () => {
		const app = { marker: "app" };
		const config = defineConfig({
			formatter: {
				async resolver(received) {
					expect(received).toBe(app);
					return () => new IcuFormatter();
				},
			},
			loaders: [
				{
					async resolver(received) {
						expect(received).toBe(app);
						return () => ({
							async load() {
								return {};
							},
						});
					},
				},
			],
		});
		const resolved = await config.resolver(app);

		expect(resolved.formatter(resolved)).toBeInstanceOf(IcuFormatter);
		const loader = defined(resolved.loaders[0])(resolved) as TranslationsLoaderContract;
		expect(await loader.load()).toEqual({});
	});

	it("accepts the documented second and API third t() arguments as inline fallbacks", () => {
		const i18n = new Rosetta().locale("en");
		expect(i18n.t("missing", "SECOND")).toBe("SECOND");
		expect(i18n.t("missing", {}, "INLINE")).toBe("INLINE");
		expect(i18n.t("missing", { name: "John" }, "Hello {name}")).toBe(
			"Hello {name}",
		);
	});

	it("passes the manager config to loader and formatter factories", async () => {
		const seen: string[] = [];
		const config = defineConfig({
			defaultLocale: "fr",
			formatter: (received) => {
				seen.push(`formatter:${received.defaultLocale}`);
				return new IcuFormatter();
			},
			loaders: [
				(received) => {
					seen.push(`loader:${received.defaultLocale}`);
					return {
						async load() {
							return { fr: { hello: "Salut" } };
						},
					};
				},
			],
		});
		const manager = new Rosetta(config);
		await manager.loadTranslations();
		expect(manager.locale().t("hello")).toBe("Salut");
		expect(seen).toEqual(["loader:fr", "formatter:fr"]);
	});

	it("switchLocale mutates the locale-scoped instance", () => {
		const manager = new Rosetta({
			messages: { en: { hello: "Hello" }, fr: { hello: "Bonjour" } },
		});
		const i18n = manager.locale("en");
		i18n.switchLocale("fr");
		expect(i18n.locale).toBe("fr");
		expect(i18n.t("hello")).toBe("Bonjour");
	});

	it("honors an explicit regional fallback before the base language", () => {
		const manager = new Rosetta({
			defaultLocale: "en",
			fallbackLocales: { "fr-CH": "es" },
			messages: {
				en: { hello: "EN" },
				fr: { hello: "FR" },
				es: { hello: "ES" },
			},
		});
		expect(manager.locale("fr-CH").t("hello")).toBe("ES");
	});

	it("automatically falls back from a regional locale to its base locale", () => {
		const manager = new Rosetta({
			defaultLocale: "en",
			messages: { en: { hello: "EN" }, fr: { hello: "FR" } },
		});
		expect(manager.locale("fr-CH").fallbackLocale).toBe("fr");
		expect(manager.locale("fr-CH").t("hello")).toBe("FR");
	});

	it("uses a supported regional locale as the closest fallback for its base", () => {
		const manager = new Rosetta({
			defaultLocale: "fr",
			supportedLocales: ["fr", "en-US"],
			messages: { "en-US": { hello: "US" }, fr: { hello: "FR" } },
		});
		expect(manager.getFallbackLocaleFor("en")).toBe("en-us");
		expect(manager.locale("en").t("hello")).toBe("US");
	});

	it("matches parent/child locales but never sibling regional locales", () => {
		const manager = new Rosetta({
			defaultLocale: "en",
			messages: {
				en: { hello: "EN" },
				"en-us": { hello: "US" },
				"fr-fr": { hello: "FR" },
			},
		});
		expect(manager.locale("en").fallbackLocale).toBe("en-us");
		expect(manager.locale("fr-CH").fallbackLocale).toBe("en");
	});

	it("returns null for an unsupported or q=0 Accept-Language", () => {
		const manager = new Rosetta({ supportedLocales: ["en", "fr"] });
		expect(manager.getSupportedLocaleFor("fr;q=0")).toBeNull();
		expect(manager.getSupportedLocaleFor("de")).toBeNull();
	});

	it("matches Adonis negotiator quality and specificity ordering", () => {
		const manager = new Rosetta({
			supportedLocales: ["en", "fr", "it", "ca"],
		});
		expect(manager.getSupportedLocaleFor(["en-UK"])).toBe("en");
		expect(manager.getSupportedLocaleFor(["en-UK", "fr"])).toBe("fr");
		expect(manager.getSupportedLocaleFor(["en-UK;q=0.9", "fr;q=0.7"])).toBe(
			"en",
		);
	});

	it("reloadTranslations removes keys deleted from disk", async () => {
		await fsp.mkdir(path.join(root, "en"), { recursive: true });
		const file = path.join(root, "en", "messages.json");
		await fsp.writeFile(file, JSON.stringify({ keep: "K", stale: "S" }));
		const manager = new Rosetta({
			loaders: [loaders.fs({ location: root })],
		});
		await manager.loadTranslations();
		expect(manager.locale().t("messages.stale")).toBe("S");

		await fsp.writeFile(file, JSON.stringify({ keep: "K" }));
		await manager.reloadTranslations();
		expect(manager.locale().t("messages.stale")).toBe(
			"translation missing: en, messages.stale",
		);
	});

	it("keeps the previous cache when a reload fails", async () => {
		let fail = false;
		const manager = new Rosetta({
			loaders: [
				{
					async load() {
						if (fail) throw new Error("loader failed");
						return { en: { hello: "stable" } };
					},
				},
			],
		});
		await manager.loadTranslations();
		fail = true;
		await expect(manager.reloadTranslations()).rejects.toThrow("loader failed");
		expect(manager.locale().t("hello")).toBe("stable");
	});

	it("runs fresh loaders concurrently and merges results deterministically", async () => {
		let active = 0;
		let maxActive = 0;
		let instances = 0;
		const makeLoader = (value: string, delay: number) => () => {
			instances++;
			return {
				async load() {
					active++;
					maxActive = Math.max(maxActive, active);
					await new Promise((resolve) => setTimeout(resolve, delay));
					active--;
					return { en: { shared: value } };
				},
			};
		};
		const manager = new Rosetta({
			loaders: [makeLoader("first", 10), makeLoader("second", 1)],
		});

		await manager.loadTranslations();
		expect(maxActive).toBe(2);
		expect(manager.locale().t("shared")).toBe("second");
		expect(instances).toBe(2);

		await manager.reloadTranslations();
		expect(instances).toBe(4);
	});

	it("returns the active translations collection by reference", () => {
		const manager = new Rosetta({ messages: { en: { hello: "Hello" } } });
		defined(manager.getTranslations().en).hello = "Changed";
		expect(manager.locale().t("hello")).toBe("Changed");
	});

	it("formats documented ICU numbers, skeletons, dates, and CLDR plurals", () => {
		const manager = new Rosetta({
			messages: {
				en: {
					items: "{count, plural, one {# item} other {# items}}",
					price: "{amount, number, ::currency/USD}",
					length: "{value, number, ::measure-unit/length-meter}",
					date: "{value, date, medium}",
					exact: "{value, plural, =1.5 {exact} other {other}}",
				},
				"pt-pt": {
					items: "{count, plural, one {one} other {other}}",
				},
			},
		});
		const en = manager.locale("en");
		expect(en.t("items", { count: 1000 })).toContain("1,000");
		expect(en.t("price", { amount: 2.49 })).toMatch(/\$2\.49|US\$2\.49/);
		expect(en.t("length", { value: 5 })).toMatch(/5\s*m/);
		const date = new Date("2026-01-10T12:00:00Z");
		expect(en.t("date", { value: date })).toBe(
			new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date),
		);
		expect(en.t("exact", { value: 1.5 })).toBe("exact");
		expect(manager.locale("pt-PT").t("items", { count: 0 })).toBe("other");
	});

	it("matches every exact output in Adonis values_formatter's en-in corpus", () => {
		const formatter = new Rosetta().locale("en-in");
		expect(
			formatter.formatNumber("10", {
				style: "unit",
				unit: "liter",
				unitDisplay: "long",
			}),
		).toBe("10 litres");
		expect(
			formatter.formatNumber(10, {
				style: "unit",
				unit: "liter",
				unitDisplay: "short",
			}),
		).toBe("10 l");
		expect(
			formatter.formatCurrency("10", {
				currency: "INR",
				currencyDisplay: "name",
			}),
		).toBe("10.00 Indian rupees");
		expect(formatter.formatDate("2021-10-04")).toBe("4/10/2021");
		expect(formatter.formatTime("2021-10-04T10:00:00")).toBe("10:00:00 am");
		expect(formatter.formatRelativeTime(100, "hours")).toBe("in 100 hours");
		expect(formatter.formatRelativeTime(1000 * 100 * 3600, "auto")).toBe(
			"in 4 days",
		);
		expect(formatter.formatRelativeTime(3600, "auto")).toBe("in 3 seconds");
		expect(formatter.formatPlural(3, { type: "ordinal" })).toBe("few");
		expect(
			formatter.formatList(["Me", "myself", "I"], {
				type: "conjunction",
			}),
		).toBe("Me, myself and I");
		expect(formatter.formatDisplayNames("INR", { type: "currency" })).toBe(
			"Indian Rupee",
		);
		expect(formatter.formatDisplayNames("en-US", { type: "language" })).toBe(
			"American English",
		);
	});

	it("supports custom ICU formats without external dependencies", () => {
		IcuFormatter.addFormatFor("number", "euros", {
			style: "currency",
			currency: "EUR",
		});
		const manager = new Rosetta({
			messages: { fr: { price: "{n, number, euros}" } },
		});
		expect(manager.locale("fr").t("price", { n: 2 })).toContain("€");
		expect(() => IcuFormatter.addFormatFor("number", "__proto__", {})).toThrow(
			/Unsafe ICU custom format key/,
		);
	});

	it("supports Unicode number skeleton precision, grouping, sign, and notation", () => {
		const formatter = new IcuFormatter();
		const format = (style: string, value: number) =>
			formatter.format(`{value, number, ::${style}}`, "en", { value });

		expect(format(".00##", 1.2)).toBe("1.20");
		expect(format(".00/w", 1)).toBe("1");
		expect(format("group-off", 12_345)).toBe("12345");
		expect(format("sign-always", 12)).toBe("+12");
		expect(format("compact-short", 1_200)).toBe("1.2K");
		expect(format("precision-increment/0.05", 1.23)).toBe("1.25");
		expect(format("decimal-always", 12)).toBe("12.");
		expect(format("scientific/*ee/sign-always", 1_234)).toBe("1.234E+03");
	});

	it("uses ICU percent and permille input semantics", () => {
		const formatter = new IcuFormatter();
		expect(formatter.format("{n, number, ::percent}", "en", { n: 25 })).toBe(
			"25%",
		);
		expect(formatter.format("{n, number, ::%x100}", "en", { n: 0.25 })).toBe(
			"25%",
		);
		expect(formatter.format("{n, number, ::permille}", "en", { n: 25 })).toBe(
			"25‰",
		);
	});

	it("fails closed on unsupported number skeleton tokens", () => {
		expect(() =>
			new IcuFormatter().format("{n, number, ::unknown-token}", "en", {
				n: 1,
			}),
		).toThrow(/Unsupported ICU number skeleton token/);
		expect(() =>
			new IcuFormatter().format(
				"{n, number, ::currency/CHF precision-currency-cash}",
				"en",
				{ n: 1 },
			),
		).toThrow(/cash currency precision/);
	});

	it("supports per-measure-unit regardless of token order", () => {
		const output = new IcuFormatter().format(
			"{n, number, ::per-measure-unit/duration-second measure-unit/length-meter}",
			"en",
			{ n: 5 },
		);
		expect(output).toMatch(/5\s*m\/s/);
	});

	it("maps representable ICU date skeleton fields to Intl", () => {
		const date = new Date("2026-01-10T12:34:56.789Z");
		const actual = new IcuFormatter().format("{value, date, ::yMMMd}", "en", {
			value: date,
		});
		expect(actual).toBe(
			new Intl.DateTimeFormat("en", {
				year: "numeric",
				month: "short",
				day: "numeric",
			}).format(date),
		);
		expect(
			new IcuFormatter().format("{value, time, ::h:m a}", "en", {
				value: date,
			}),
		).toBe(
			new Intl.DateTimeFormat("en", {
				hour: "numeric",
				minute: "numeric",
				hour12: true,
			}).format(date),
		);
	});

	it("rejects unknown date styles and unrepresentable ICU fields", () => {
		const formatter = new IcuFormatter();
		expect(() =>
			formatter.format("{value, date, unknown}", "en", { value: Date.now() }),
		).toThrow(/Unsupported ICU date style/);
		expect(() =>
			formatter.format("{value, date, ::yQQQ}", "en", { value: Date.now() }),
		).toThrow(/Unsupported ICU date skeleton field/);
		expect(() =>
			formatter.format("{value, date, ::eee}", "en", { value: Date.now() }),
		).toThrow(/not supported by Intl/);
	});

	it("rejects malformed ICU select/plural blocks without an other branch", () => {
		const formatter = new IcuFormatter();
		expect(() =>
			formatter.format("{n, plural, one {one}}", "en", { n: 1 }),
		).toThrow(/other/);
		expect(() =>
			formatter.format("{kind, select, yes {yes}}", "en", { kind: "yes" }),
		).toThrow(/other/);
	});

	it("rejects duplicate ICU branches, misplaced offsets, and malformed skeletons", () => {
		const formatter = new IcuFormatter();
		expect(() =>
			formatter.format("{n, plural, one {a} one {b} other {c}}", "en", {
				n: 1,
			}),
		).toThrow(/Duplicate ICU option/);
		expect(() =>
			formatter.format("{n, plural, one {a} offset:1 other {c}}", "en", {
				n: 1,
			}),
		).toThrow(/must precede/);
		expect(() =>
			formatter.format("{n, number, ::sign-accounting-wat}", "en", {
				n: 1,
			}),
		).toThrow(/Unsupported ICU number skeleton token/);
		expect(() =>
			formatter.format("{n, number, ::integer-width/wat}", "en", { n: 1 }),
		).toThrow(/Invalid ICU integer width/);
	});

	it("limits ICU nesting depth", () => {
		let message = "done";
		for (let index = 0; index < 102; index++) {
			message = `{x, select, yes {${message}} other {no}}`;
		}
		expect(() =>
			new IcuFormatter().format(message, "en", { x: "yes" }),
		).toThrow(/nesting levels/);
	});

	it("rejects prototype-polluting translation keys", async () => {
		await fsp.writeFile(
			path.join(root, "en.json"),
			'{"__proto__":{"polluted":"yes"}}',
		);
		await expect(
			new FileSystemLoader({ location: root }).load("en"),
		).rejects.toThrow(/Unsafe translation key/);
		expect(({} as { polluted?: string }).polluted).toBeUndefined();
	});

	it("rejects unsafe keys from inline catalogs and custom loaders too", async () => {
		const polluted = JSON.parse('{"__proto__":{"polluted":"yes"}}');
		expect(() => new Rosetta({ messages: { en: polluted } })).toThrow(
			/Unsafe translation key/,
		);
		const manager = new Rosetta({
			loaders: [
				{
					async load() {
						return { en: polluted };
					},
				},
			],
		});
		await expect(manager.loadTranslations()).rejects.toThrow(
			/Unsafe translation key/,
		);
	});

	it("rejects ambiguous keys that collide after catalog flattening", () => {
		expect(
			() =>
				new Rosetta({
					messages: {
						en: { "app.title": "flat", app: { title: "nested" } },
					},
				}),
		).toThrow("Duplicate flattened translation key 'app.title'");
	});

	it("keeps loadLocale atomic when a later loader returns an unsafe catalog", async () => {
		const unsafe = JSON.parse('{"__proto__":{"polluted":"yes"}}');
		const manager = new Rosetta({
			messages: { en: { stable: "yes" } },
			loaders: [
				{
					async load() {
						return { added: "no" };
					},
				},
				{
					async load() {
						return unsafe;
					},
				},
			],
		});

		await expect(manager.loadLocale("en")).rejects.toThrow(
			/Unsafe translation key/,
		);
		expect(manager.getTranslationsFor("en")).toEqual({ stable: "yes" });
	});

	it("isolates legacy manager locales between concurrent async contexts", async () => {
		const manager = new Rosetta({
			messages: { en: { hello: "EN" }, fr: { hello: "FR" } },
		});
		const [en, fr] = await Promise.all([
			manager.runWithLocale("en", async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				return manager.t("hello");
			}),
			manager.runWithLocale("fr", async () => {
				await Promise.resolve();
				return manager.t("hello");
			}),
		]);
		expect([en, fr]).toEqual(["EN", "FR"]);
	});

	it("exposes a Vine-shaped messages provider", () => {
		const manager = new Rosetta({
			messages: {
				en: {
					validator: {
						shared: {
							fields: { email: "email address" },
							messages: { required: "Enter {field}" },
						},
					},
				},
			},
		});
		expect(
			manager
				.locale()
				.createMessagesProvider()
				.getMessage("The {field} is required", "required", {
					name: "email",
					wildCardPath: "email",
				}),
		).toBe("Enter email address");
	});

	it("uses fallback translations for Vine field names", () => {
		const manager = new Rosetta({
			defaultLocale: "en",
			messages: {
				en: { validator: { shared: { fields: { email: "email address" } } } },
				fr: {
					validator: { shared: { messages: { required: "Saisir {field}" } } },
				},
			},
		});
		expect(
			manager
				.locale("fr")
				.createMessagesProvider()
				.getMessage("The {field} is required", "required", {
					name: "email",
					wildCardPath: "email",
				}),
		).toBe("Saisir email address");
	});

	it("matches Vine wildcard priority and translates cross-field metadata", () => {
		const manager = new Rosetta({
			messages: {
				en: {
					validator: {
						shared: {
							fields: {
								"users.0.password": "Password",
								confirmation: "Password confirmation",
							},
							messages: {
								"users.*.password.confirmed":
									"The {originalField} and {otherField} must match",
							},
						},
					},
				},
			},
		});
		const meta: Record<string, unknown> = {
			originalField: "users.0.password",
			otherField: "confirmation",
		};
		const message = manager
			.locale("en")
			.createMessagesProvider()
			.getMessage(
				"The {field} is invalid",
				"confirmed",
				{ name: "users.0.password", wildCardPath: "users.*.password" },
				meta,
			);
		expect(message).toBe("The Password and Password confirmation must match");
		expect(meta).toEqual({
			originalField: "Password",
			otherField: "Password confirmation",
		});
	});

	it("interpolates Vine's default message when no translation exists", () => {
		const provider = new Rosetta().locale("en").createMessagesProvider();
		expect(
			provider.getMessage(
				"The {field} must have at least {min} characters",
				"minLength",
				{ name: "title", wildCardPath: "title" },
				{ min: 3 },
			),
		).toBe("The title must have at least 3 characters");
	});

	it("middleware shares a request-scoped locale", async () => {
		const manager = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en", "fr"],
			messages: { en: { scoped: "EN" }, fr: { scoped: "FR" } },
		});
		const context: {
			request: { header(name: string): string | undefined };
			i18n?: RosettaLocale;
			locale?: string;
		} = {
			request: { header: () => "fr, en;q=0.5" },
		};
		const scoped = await new DetectUserLocaleMiddleware(manager).handle(
			context,
			async () => {
				await Promise.resolve();
				return manager.t("scoped");
			},
		);
		expect(context.i18n?.locale).toBe("fr");
		expect(context.locale).toBe("fr");
		expect(scoped).toBe("FR");
		expect(manager.getLocale()).toBe("en");
	});

	it("middleware supports request.languages and its validation hook", async () => {
		const manager = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en", "fr"],
		});
		const context: {
			request: { languages(): string[] };
			i18n?: RosettaLocale;
		} = { request: { languages: () => ["fr", "en"] } };
		await new DetectUserLocaleMiddleware(manager).handle(
			context,
			async () => undefined,
		);
		const validator: RequestValidatorLike = {};
		DetectUserLocaleMiddleware.registerMessagesProvider(validator);
		expect(context.i18n?.locale).toBe("fr");
		expect(validator.messagesProvider?.(context)).toBeDefined();
	});

	it("middleware uses Ream request.language when available", async () => {
		const manager = new Rosetta({
			defaultLocale: "en",
			supportedLocales: ["en", "fr"],
		});
		const bindings = new Map<unknown, unknown>();
		const context: {
			request: { language(locales: string[]): string | null };
			i18n?: RosettaLocale;
			locale?: string;
			containerResolver: { bindValue(token: unknown, value: unknown): void };
		} = {
			request: {
				language(locales) {
					expect(locales).toEqual(["en", "fr"]);
					return "fr";
				},
			},
			containerResolver: {
				bindValue(token, value) {
					bindings.set(token, value);
				},
			},
		};
		await new DetectUserLocaleMiddleware(manager).handle(
			context,
			async () => undefined,
		);
		expect(context.i18n?.locale).toBe("fr");
		expect(context.locale).toBe("fr");
		expect(bindings.get(RosettaLocale)).toBe(context.i18n);
	});

	it("configure writes the Adonis-shaped config and middleware", async () => {
		const providers: string[] = [];
		const middleware: string[] = [];
		const files = new Map<string, string>();
		await configure({
			async addProvider(provider) {
				providers.push(provider);
			},
			async writeFile(filePath, content) {
				files.set(filePath, content);
			},
			async registerMiddleware(importPath, options) {
				expect(options).toEqual({ tier: "router" });
				middleware.push(importPath);
			},
		});
		expect(providers).toEqual(["@c9up/rosetta/i18n_provider"]);
		expect(middleware).toEqual(["#middleware/detect_user_locale_middleware"]);
		expect(files.get("config/i18n.ts")).toContain("formatters.icu()");
		expect(
			files.get("app/middleware/detect_user_locale_middleware.ts"),
		).toContain("declare module '@c9up/ream'");
		await expect(
			fsp.access(path.join(fileURLToPath(stubsRoot), "config/i18n.stub")),
		).resolves.toBeUndefined();
	});
});
