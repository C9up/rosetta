import { FileSystemLoader } from "./loaders/FileSystemLoader.js";
import { Rosetta, type RosettaOptions } from "./Rosetta.js";
import { setI18n } from "./services/main.js";

/**
 * Duck-typed host context — rosetta stays publishable without
 * importing `@c9up/ream`. Any framework that exposes a Container + a
 * config store satisfies the contract.
 */
interface RosettaContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): T;
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
	constructor(protected app: RosettaAppContext) {}

	register(): void {
		this.app.container.singleton(Rosetta, () => {
			const config = this.app.config.get<RosettaProviderConfig>("i18n");
			const options: RosettaOptions = { ...(config ?? {}) };
			if (config?.rootDir) {
				const fsLoader = new FileSystemLoader({ rootDir: config.rootDir });
				options.loaders = [...(options.loaders ?? []), fsLoader];
			}
			return new Rosetta(options);
		});
		this.app.container.singleton("i18n", () =>
			this.app.container.resolve<Rosetta>(Rosetta),
		);
	}

	async boot(): Promise<void> {
		const rosetta = this.app.container.resolve<Rosetta>(Rosetta);
		await rosetta.boot();
		setI18n(rosetta);
	}

	async shutdown(): Promise<void> {}
}
