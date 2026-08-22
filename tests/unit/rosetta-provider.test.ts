import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rosetta } from "../../src/Rosetta.js";
import RosettaProvider, {
	type RosettaAppContext,
	type RosettaProviderConfig,
} from "../../src/RosettaProvider.js";
import { clearI18n, getI18n } from "../../src/services/main.js";

function buildApp(
	i18nConfig?: RosettaProviderConfig,
	services: Record<string, unknown> = {},
): RosettaAppContext {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	for (const [token, value] of Object.entries(services)) {
		bindings.set(token, () => value);
	}
	return {
		container: {
			has(token) {
				return bindings.has(token);
			},
			singleton(token, factory) {
				bindings.set(token, factory);
			},
			async resolve<T>(token: unknown): Promise<T> {
				if (cache.has(token)) return cache.get(token) as T;
				const factory = bindings.get(token);
				if (!factory) throw new Error(`not registered: ${String(token)}`);
				const value = await factory();
				cache.set(token, value);
				return value as T;
			},
		},
		config: {
			get<T>(key: string): T | undefined {
				return key === "i18n" ? (i18nConfig as T | undefined) : undefined;
			},
		},
	};
}

describe("rosetta > RosettaProvider", () => {
	afterEach(() => clearI18n());

	it("register binds the class and all Ream/Adonis aliases", async () => {
		const app = buildApp({ defaultLocale: "en" });
		const provider = new RosettaProvider(app);
		provider.register();

		const viaClass = await app.container.resolve<Rosetta>(Rosetta);
		const viaAlias = await app.container.resolve<Rosetta>("i18n");
		const viaInker = await app.container.resolve<Rosetta>("rosetta");
		expect(viaClass).toBeInstanceOf(Rosetta);
		expect(viaAlias).toBe(viaClass);
		expect(viaInker).toBe(viaClass);
	});

	it("boot resolves the instance, boots it, and publishes the services/main singleton", async () => {
		const app = buildApp({ defaultLocale: "en", supportedLocales: ["en"] });
		const provider = new RosettaProvider(app);
		provider.register();
		await provider.boot();

		const instance = await app.container.resolve<Rosetta>(Rosetta);
		expect(getI18n()).toBe(instance);
	});

	it("fails loudly when the i18n config block is missing", async () => {
		const app = buildApp(undefined);
		const provider = new RosettaProvider(app);
		provider.register();
		await expect(app.container.resolve<Rosetta>(Rosetta)).rejects.toThrow(
			/config\/i18n/,
		);
	});

	it("shutdown resolves before boot", async () => {
		const app = buildApp({ defaultLocale: "en" });
		const provider = new RosettaProvider(app);
		await expect(provider.shutdown()).resolves.toBeUndefined();
	});

	it("boots integrations once and releases owned hooks on shutdown", async () => {
		let eventCount = 0;
		const previousProvider = () => ({
			getMessage: () => "previous",
		});
		const validator: {
			messagesProvider?: (context: never) => unknown;
		} = { messagesProvider: previousProvider };
		const app = buildApp(
			{ defaultLocale: "en", messages: { en: {} } },
			{
				emitter: { emit: () => eventCount++ },
				requestValidator: validator,
			},
		);
		const provider = new RosettaProvider(app);
		provider.register();
		await Promise.all([provider.boot(), provider.boot()]);

		const manager = await app.container.resolve<Rosetta>(Rosetta);
		manager.locale().t("missing");
		expect(eventCount).toBe(1);
		expect(validator.messagesProvider).not.toBe(previousProvider);

		await provider.shutdown();
		expect(getI18n()).toBeUndefined();
		expect(validator.messagesProvider).toBe(previousProvider);
		manager.locale().t("still-missing");
		expect(eventCount).toBe(1);
	});

	it("does not hide failures from registered optional services", async () => {
		const app = buildApp({ defaultLocale: "en" });
		app.container.singleton("inker", () => {
			throw new Error("inker initialization failed");
		});
		const provider = new RosettaProvider(app);
		provider.register();
		await expect(provider.boot()).rejects.toThrow(
			"inker initialization failed",
		);
	});

	it("rolls back owned hooks when an integration fails during boot", async () => {
		let eventCount = 0;
		const previousProvider = () => ({ getMessage: () => "previous" });
		const validator: { messagesProvider?: (context: never) => unknown } = {
			messagesProvider: previousProvider,
		};
		const app = buildApp(
			{ defaultLocale: "en", messages: { en: {} } },
			{
				emitter: { emit: () => eventCount++ },
				requestValidator: validator,
				inker: {
					use() {
						throw new Error("inker plugin failed");
					},
				},
			},
		);
		const provider = new RosettaProvider(app);
		provider.register();

		await expect(provider.boot()).rejects.toThrow("inker plugin failed");
		expect(validator.messagesProvider).toBe(previousProvider);
		expect(getI18n()).toBeUndefined();

		const manager = await app.container.resolve<Rosetta>(Rosetta);
		manager.locale().t("missing");
		expect(eventCount).toBe(0);
	});

	it("connects optional emitter, request validator, and template services", async () => {
		const events: Array<{ name: string; payload: unknown }> = [];
		const globals = new Map<string, unknown>();
		const validator: { messagesProvider?: (context: never) => unknown } = {};
		const app = buildApp(
			{ defaultLocale: "en", messages: { en: {} } },
			{
				emitter: {
					emit(name: string, payload: unknown) {
						events.push({ name, payload });
					},
				},
				requestValidator: validator,
				inker: {
					global(name: string, value: unknown) {
						globals.set(name, value);
					},
				},
			},
		);
		const provider = new RosettaProvider(app);
		provider.register();
		await provider.boot();

		const manager = await app.container.resolve<Rosetta>(Rosetta);
		manager.locale().t("missing");
		expect(events[0]?.name).toBe("i18n:missing:translation");
		expect(validator.messagesProvider).toBeTypeOf("function");
		expect(globals.get("t")).toBeTypeOf("function");
	});

	it("reaches the engine through the renderer the provider registers", async () => {
		// `inker` is bound to an InkerRenderer, which publishes no globals of its
		// own — the engine it wraps does. Resolving a token nothing registers
		// meant the i18n globals never reached a template.
		const globals = new Map<string, unknown>();
		const app = buildApp(
			{ defaultLocale: "en", messages: { en: {} } },
			{
				inker: {
					render() {},
					_templates: {
						global(name: string, value: unknown) {
							globals.set(name, value);
						},
					},
				},
			},
		);
		const provider = new RosettaProvider(app);
		provider.register();
		await provider.boot();
		expect(globals.get("t")).toBeTypeOf("function");
		expect(globals.get("i18n")).toBeDefined();
	});

	it("registers the i18n REPL binding and load method", async () => {
		const bindings = new Map<string, unknown>();
		const methods = new Map<string, () => unknown>();
		const app = buildApp(
			{ defaultLocale: "en" },
			{
				repl: {
					addBinding(name: string, value: unknown) {
						bindings.set(name, value);
					},
					addMethod(name: string, callback: () => unknown) {
						methods.set(name, callback);
					},
				},
			},
		);
		const provider = new RosettaProvider(app);
		provider.register();
		await provider.boot();

		const manager = await app.container.resolve<Rosetta>(Rosetta);
		expect(bindings.get("i18n")).toBe(manager);
		expect(methods.get("loadI18n")?.()).toBe(manager);
	});

	describe("with a rootDir", () => {
		let langDir: string;

		beforeEach(() => {
			langDir = mkdtempSync(join(tmpdir(), "rosetta-lang-"));
			mkdirSync(langDir, { recursive: true });
			writeFileSync(
				join(langDir, "en.json"),
				JSON.stringify({ greeting: "Hello {name}" }),
			);
		});

		afterEach(() => {
			rmSync(langDir, { recursive: true, force: true });
		});

		it("appends a FileSystemLoader and loads catalogs from disk on boot", async () => {
			const app = buildApp({
				defaultLocale: "en",
				supportedLocales: ["en"],
				rootDir: langDir,
			});
			const provider = new RosettaProvider(app);
			provider.register();
			await provider.boot();

			const instance = await app.container.resolve<Rosetta>(Rosetta);
			const rendered = instance.locale("en").t("greeting", { name: "Alice" });
			expect(rendered).toBe("Hello Alice");
		});
	});
});
