import { FileSystemLoader } from "./loaders/FileSystemLoader.js";
import DetectUserLocaleMiddleware, {
	type RequestValidatorLike,
} from "./middleware.js";
import { edgePluginI18n } from "./plugins/edge.js";
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
			const edge = await this.#resolveOptional<{
				use?(
					plugin: (edge: {
						global(name: string, value: unknown): void;
					}) => void,
				): void;
				global?(name: string, value: unknown): void;
			}>("edge");
			if (edge) {
				const plugin = edgePluginI18n(rosetta);
				if (edge.use) edge.use(plugin);
				else if (edge.global)
					plugin(edge as { global(name: string, value: unknown): void });
			}
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
