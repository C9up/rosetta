import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Rosetta } from "../../src/Rosetta.js";
import RosettaProvider, {
	type RosettaAppContext,
	type RosettaProviderConfig,
} from "../../src/RosettaProvider.js";
import { clearI18n, getI18n } from "../../src/services/main.js";

/**
 * The engine's module singleton, stubbed.
 *
 * Mocked rather than imported for real because what is under test is the
 * CONTRACT — the provider pushes a plugin into the package's default export —
 * not what inker does with it afterwards. Importing the real one would also
 * pull a native binding into a unit test that has no use for it.
 */
const enginePlugins: Array<
	(engine: { global(n: string, v: unknown): void }) => void
> = [];

/**
 * What the engine module's default export IS, per test.
 *
 * The provider duck-types it: an engine with `use()` gets the plugin enqueued,
 * one that only publishes globals gets the plugin applied directly. Both shapes
 * are real — a plugin registrar and a live engine — so a fixed mock could only
 * ever exercise one of them. Read through a getter so a test can swap it after
 * the module is mocked.
 */
const PLUGGABLE_ENGINE = {
	use(plugin: (engine: { global(n: string, v: unknown): void }) => void) {
		enginePlugins.push(plugin);
	},
};
let engineModuleDefault: unknown = PLUGGABLE_ENGINE;

vi.mock("@c9up/inker", () => ({
	get default() {
		return engineModuleDefault;
	},
}));

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
	beforeEach(() => {
		enginePlugins.length = 0;
		engineModuleDefault = PLUGGABLE_ENGINE;
	});
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
		app.container.singleton("emitter", () => {
			throw new Error("emitter initialization failed");
		});
		const provider = new RosettaProvider(app);
		provider.register();
		await expect(provider.boot()).rejects.toThrow(
			"emitter initialization failed",
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
				repl: {
					addMethod() {
						throw new Error("repl binding failed");
					},
				},
			},
		);
		const provider = new RosettaProvider(app);
		provider.register();

		await expect(provider.boot()).rejects.toThrow("repl binding failed");
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
			},
		);
		app.usingInker = true;
		const provider = new RosettaProvider(app);
		provider.register();
		await provider.boot();

		const manager = await app.container.resolve<Rosetta>(Rosetta);
		manager.locale().t("missing");
		expect(events[0]?.name).toBe("i18n:missing:translation");
		expect(validator.messagesProvider).toBeTypeOf("function");
		// The plugin went to the engine's module singleton, and publishes the
		// globals when the engine runs it.
		expect(enginePlugins).toHaveLength(1);
		const engine = { global: (n: string, v: unknown) => globals.set(n, v) };
		enginePlugins[0]?.(engine);
		expect(globals.get("t")).toBeTypeOf("function");
	});

	it("pushes the plugin through the engine module, never the container", async () => {
		// The engine's container token is bound in register() and only
		// resolvable after start(), which every provider's boot() precedes.
		// Resolving it from here made boot order the contract; the module
		// singleton has no lifecycle to get wrong. A binding under that token
		// must therefore be left alone — this one throws if anything touches it.
		const app = buildApp({ defaultLocale: "en", messages: { en: {} } });
		app.container.singleton("inker", () => {
			throw new Error("the container was consulted for the engine");
		});
		app.usingInker = true;
		const provider = new RosettaProvider(app);
		provider.register();
		await provider.boot();
		expect(enginePlugins).toHaveLength(1);
	});

	it("publishes nothing when no template engine is installed", async () => {
		const app = buildApp({ defaultLocale: "en", messages: { en: {} } });
		const provider = new RosettaProvider(app);
		provider.register();
		await provider.boot();
		expect(enginePlugins).toHaveLength(0);
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

	it("applies the plugin directly to an engine that only publishes globals", async () => {
		// The other real shape: not a registrar with `use()`, but a live engine.
		// Handing it the plugin to enqueue would silently do nothing, so the
		// provider runs the plugin against it instead.
		const globals = new Map<string, unknown>();
		engineModuleDefault = {
			global: (name: string, value: unknown) => globals.set(name, value),
		};
		const app = buildApp({
			defaultLocale: "en",
			messages: { en: { hi: "Hi" } },
		});
		app.usingInker = true;
		const provider = new RosettaProvider(app);
		provider.register();
		await provider.boot();

		expect(enginePlugins).toHaveLength(0);
		expect(globals.get("t")).toBeTypeOf("function");
	});

	it("leaves an engine it does not recognise alone rather than throwing", async () => {
		// A future engine, or a half-loaded module. Publishing i18n globals is
		// not worth failing the whole application boot over.
		engineModuleDefault = { somethingElse: true };
		const app = buildApp({ defaultLocale: "en", messages: { en: {} } });
		app.usingInker = true;
		const provider = new RosettaProvider(app);
		provider.register();
		await expect(provider.boot()).resolves.toBeUndefined();
		expect(enginePlugins).toHaveLength(0);
	});

	it("does not reach for the engine module when no engine is installed", async () => {
		// `usingInker` unset: the import must not even be attempted.
		engineModuleDefault = undefined;
		const app = buildApp({ defaultLocale: "en", messages: { en: {} } });
		const provider = new RosettaProvider(app);
		provider.register();
		await expect(provider.boot()).resolves.toBeUndefined();
		expect(enginePlugins).toHaveLength(0);
	});

	it("swallows a rejection from an emitter that answers a promise", async () => {
		// The emitter contract allows a thenable. An unhandled rejection from a
		// missing-translation notice would take the process down over a
		// bookkeeping event, so the result is awaited and its failure dropped.
		const app = buildApp(
			{ defaultLocale: "en", messages: { en: {} } },
			{
				emitter: { emit: () => Promise.reject(new Error("listener blew up")) },
			},
		);
		const provider = new RosettaProvider(app);
		provider.register();
		await provider.boot();

		// Watch for the thing this is supposed to prevent, rather than asserting
		// that nothing happened.
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const manager = await app.container.resolve<Rosetta>(Rosetta);
			manager.locale().t("missing");
			// Two turns: one for the rejection, one for Node to decide nobody
			// handled it.
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(unhandled).toEqual([]);
	});
});
