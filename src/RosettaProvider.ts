import "./augmentations.js";
import { FileSystemLoader } from "./loaders/FileSystemLoader.js";
import DetectUserLocaleMiddleware, {
	type RequestValidatorLike,
} from "./middleware.js";
import { inkerPluginI18n } from "./plugins/inker.js";
import { Rosetta, type RosettaOptions } from "./Rosetta.js";
import { type I18nReplLike, registerReplBindings } from "./repl.js";
import { clearI18n, setI18n } from "./services/main.js";

/**
 * Duck-typed host context — rosetta stays publishable without
 * importing `@c9up/ream`. Any framework that exposes a Container + a
 * config store satisfies the contract.
 */
interface RosettaContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): Promise<T>;
	has?(token: unknown): boolean;
}
interface RosettaConfigStore {
	get<T = unknown>(key: string): T | undefined;
}
export interface RosettaAppContext {
	container: RosettaContainer;
	config: RosettaConfigStore;
	/**
	 * Whether a template engine is installed. Set by `InkerProvider`'s
	 * constructor, so it is already true when this provider boots. Optional: a
	 * host without one simply never publishes the i18n globals.
	 */
	usingInker?: boolean;
}

export interface RosettaProviderConfig extends RosettaOptions {
	/**
	 * If set, a `FileSystemLoader` reading from this directory is
	 * appended to `options.loaders`. Most apps only need this and the
	 * `supportedLocales` list — the provider's `boot()` calls
	 * `rosetta.boot()` so catalogs are warm before the first request.
	 */
	rootDir?: string;
}

/**
 * RosettaProvider — registers a shared `Rosetta` instance under
 * `Rosetta` + `"i18n"` tokens, then awaits its boot so the configured
 * locale catalogs are loaded by the time the first request lands.
 *
 *   // reamrc.ts
 *   providers: [() => import('@c9up/rosetta/provider')]
 *
 *   // config/i18n.ts
 *   import { resolve } from 'node:path'
 *   export default {
 *     defaultLocale: 'en',
 *     supportedLocales: ['en', 'fr'],
 *     rootDir: resolve('./resources/lang'),
 *   }
 *
 *   // anywhere
 *   import i18n from '@c9up/rosetta/services/main'
 *   const t = i18n.locale('fr').t('greeting', { name: 'Alice' })
 */
/** All rosetta needs of a template engine: a way to publish a global. */
interface TemplateEngineLike {
	global(name: string, value: unknown): void;
}

/** An engine that takes plugins instead — it publishes the globals itself. */
interface PluggableEngine {
	use(plugin: (engine: TemplateEngineLike) => void): void;
}

function isPluggable(value: unknown): value is PluggableEngine {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "use") === "function"
	);
}

function publishesGlobals(value: unknown): value is TemplateEngineLike {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "global") === "function"
	);
}

export default class RosettaProvider {
	#booted = false;
	#bootPromise?: Promise<void>;
	#rosetta?: Rosetta;
	#unsubscribeMissing?: () => void;
	#validator?: RequestValidatorLike;
	#previousMessagesProvider?: RequestValidatorLike["messagesProvider"];

	constructor(protected app: RosettaAppContext) {}

	register(): void {
		this.app.container.singleton(Rosetta, async () => {
			const configured = this.app.config.get<
				RosettaProviderConfig & {
					resolver?(app: unknown): Promise<RosettaProviderConfig>;
				}
			>("i18n");
			if (!configured) {
				throw new Error(
					'Invalid or missing "config/i18n" export. Configure Rosetta with defineConfig().',
				);
			}
			const config = configured.resolver
				? await configured.resolver(this.app)
				: configured;
			const options: RosettaOptions = { ...config };
			if (config?.rootDir) {
				const fsLoader = new FileSystemLoader({ rootDir: config.rootDir });
				options.loaders = [...(options.loaders ?? []), fsLoader];
			}
			return new Rosetta(options);
		});
		// Namespaced by the package that owns it, the way upstream namespaces
		// `lucid.db`, `auth.manager` and `drive.manager` by theirs. The bare
		// token stays bound beside it: it is what every existing
		// `container.make(...)` asks for, and a token is not worth breaking an
		// application over.
		this.app.container.singleton("rosetta.i18n", async () =>
			this.app.container.resolve<Rosetta>(Rosetta),
		);
		this.app.container.singleton("i18n", async () =>
			this.app.container.resolve<Rosetta>(Rosetta),
		);
		// Inker resolves Rosetta structurally through these string tokens so it
		// can remain an optional peer without importing this package at runtime.
		this.app.container.singleton("rosetta", async () =>
			this.app.container.resolve<Rosetta>(Rosetta),
		);
	}

	async boot(): Promise<void> {
		if (this.#booted) return;
		if (this.#bootPromise) return this.#bootPromise;
		this.#bootPromise = this.#boot();
		try {
			await this.#bootPromise;
		} finally {
			this.#bootPromise = undefined;
		}
	}

	async #boot(): Promise<void> {
		const rosetta = await this.app.container.resolve<Rosetta>(Rosetta);
		await rosetta.boot();
		try {
			const emitter = await this.#resolveOptional<{
				emit(name: string, payload: unknown): unknown;
			}>("emitter");
			if (emitter) {
				this.#unsubscribeMissing = rosetta.onMissingTranslation((payload) => {
					const emitted = emitter.emit("i18n:missing:translation", payload);
					if (
						emitted &&
						typeof (emitted as PromiseLike<unknown>).then === "function"
					) {
						void Promise.resolve(emitted).catch(() => undefined);
					}
				});
			}
			const validator =
				await this.#resolveOptional<RequestValidatorLike>("requestValidator");
			if (validator) {
				this.#validator = validator;
				this.#previousMessagesProvider = validator.messagesProvider;
				DetectUserLocaleMiddleware.registerMessagesProvider(validator);
			}
			await this.#installTemplatePlugin(rosetta);
			const repl = await this.#resolveOptional<I18nReplLike>("repl");
			if (repl) registerReplBindings(repl, rosetta);
			setI18n(rosetta);
			this.#rosetta = rosetta;
			this.#booted = true;
		} catch (error) {
			this.#releaseOwnedHooks();
			clearI18n(rosetta);
			throw error;
		}
	}

	async shutdown(): Promise<void> {
		if (this.#bootPromise) await this.#bootPromise;
		this.#releaseOwnedHooks();
		clearI18n(this.#rosetta);
		this.#rosetta = undefined;
		this.#booted = false;
	}

	#releaseOwnedHooks(): void {
		this.#unsubscribeMissing?.();
		this.#unsubscribeMissing = undefined;
		if (this.#validator) {
			this.#validator.messagesProvider = this.#previousMessagesProvider;
		}
		this.#validator = undefined;
		this.#previousMessagesProvider = undefined;
	}

	/**
	 * Publish the i18n globals into the template engine.
	 *
	 * Through the engine package's MODULE SINGLETON, guarded by the host's
	 * `usingInker` flag — never through the container. Upstream's i18n provider
	 * does exactly this, and the reason shows up as a lifecycle knot the moment
	 * you do it the other way: the engine's container token is bound in
	 * `register()` and only resolvable after `start()`, which every provider's
	 * `boot()` precedes. Resolving it from here either threw or forced the
	 * engine to be built before its own peers were wired, and boot order became
	 * the contract. The singleton has no lifecycle to get wrong — its `use()`
	 * enqueues, and the plugin runs just before the first render.
	 *
	 * inker is an OPTIONAL peer, so the import has to be dynamic and the flag
	 * has to be checked first: an app without a template engine never reaches
	 * the import. What comes back is narrowed by a guard rather than trusted,
	 * the way this provider treats every other peer — it knows them by shape.
	 */
	async #installTemplatePlugin(rosetta: Rosetta): Promise<void> {
		if (this.app.usingInker !== true) return;

		// The specifier is built rather than written inline, the same way ream's
		// quasar bridge does it, and for the same reason: this package declares
		// ZERO runtime dependencies and `scripts/verify-package.mjs` proves it by
		// refusing to publish when an optional peer appears in the emitted
		// JavaScript. A literal `import("@c9up/inker")` is exactly that, and it
		// also makes a bundler try to resolve inker at build time for an
		// application that never installed it. Computed, it stays invisible to
		// static analysis and runs only behind the flag above.
		const specifier = "@c9up/inker";
		const module: unknown = await import(/* @vite-ignore */ specifier);
		const engine =
			typeof module === "object" && module !== null
				? Reflect.get(module, "default")
				: undefined;
		const plugin = inkerPluginI18n(rosetta);
		if (isPluggable(engine)) engine.use(plugin);
		else if (publishesGlobals(engine)) plugin(engine);
	}

	async #resolveOptional<T>(token: unknown): Promise<T | undefined> {
		if (this.app.container.has && !this.app.container.has(token))
			return undefined;
		try {
			return await this.app.container.resolve<T>(token);
		} catch (error) {
			if (this.app.container.has?.(token)) throw error;
			return undefined;
		}
	}
}
