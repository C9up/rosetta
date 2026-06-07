import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rosetta } from "../../src/Rosetta.js";
import RosettaProvider, {
	type RosettaAppContext,
	type RosettaProviderConfig,
} from "../../src/RosettaProvider.js";
import { getI18n } from "../../src/services/main.js";

function buildApp(i18nConfig?: RosettaProviderConfig): RosettaAppContext {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	return {
		container: {
			singleton(token, factory) {
				bindings.set(token, factory);
			},
			resolve<T>(token: unknown): T {
				if (cache.has(token)) return cache.get(token) as T;
				const factory = bindings.get(token);
				if (!factory) throw new Error(`not registered: ${String(token)}`);
				const value = factory();
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
	it("register binds a Rosetta under both the class token and the 'i18n' alias", () => {
		const app = buildApp({ defaultLocale: "en" });
		const provider = new RosettaProvider(app);
		provider.register();

		const viaClass = app.container.resolve<Rosetta>(Rosetta);
		const viaAlias = app.container.resolve<Rosetta>("i18n");
		expect(viaClass).toBeInstanceOf(Rosetta);
		expect(viaAlias).toBe(viaClass);
	});

	it("boot resolves the instance, boots it, and publishes the services/main singleton", async () => {
		const app = buildApp({ defaultLocale: "en", supportedLocales: ["en"] });
		const provider = new RosettaProvider(app);
		provider.register();
		await provider.boot();

		const instance = app.container.resolve<Rosetta>(Rosetta);
		expect(getI18n()).toBe(instance);
	});

	it("tolerates a missing i18n config block (empty options)", () => {
		const app = buildApp(undefined);
		const provider = new RosettaProvider(app);
		provider.register();
		const instance = app.container.resolve<Rosetta>(Rosetta);
		expect(instance).toBeInstanceOf(Rosetta);
	});

	it("shutdown is a no-op that resolves", async () => {
		const app = buildApp({ defaultLocale: "en" });
		const provider = new RosettaProvider(app);
		await expect(provider.shutdown()).resolves.toBeUndefined();
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

			const instance = app.container.resolve<Rosetta>(Rosetta);
			const rendered = instance.locale("en").t("greeting", { name: "Alice" });
			expect(rendered).toBe("Hello Alice");
		});
	});
});
