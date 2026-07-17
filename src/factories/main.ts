import { IcuFormatter } from "../formatters/IcuFormatter.js";
import { FileSystemLoader } from "../loaders/FileSystemLoader.js";
import DetectUserLocaleMiddleware from "../middleware.js";
import {
	type I18nManagerConfig,
	type MissingTranslationEmitter,
	Rosetta,
} from "../Rosetta.js";

export interface I18nManagerFactoryOptions {
	config?: Partial<I18nManagerConfig>;
	emitter?: MissingTranslationEmitter;
}

const nullEmitter: MissingTranslationEmitter = {
	emit() {},
};

/** Dependency-free equivalent of AdonisJS's I18nManagerFactory. */
export class I18nManagerFactory {
	#config: I18nManagerConfig = {
		defaultLocale: "en",
		formatter: () => new IcuFormatter(),
		loaders: [
			() =>
				new FileSystemLoader({
					location: "./resources/lang",
				}),
		],
	};
	#emitter?: MissingTranslationEmitter;

	merge(options: I18nManagerFactoryOptions): this {
		if (options.config) Object.assign(this.#config, options.config);
		if (options.emitter) this.#emitter = options.emitter;
		return this;
	}

	create(): Rosetta {
		return new Rosetta(this.#emitter ?? nullEmitter, this.#config);
	}

	createMiddleware(): DetectUserLocaleMiddleware {
		return new DetectUserLocaleMiddleware(this.create());
	}
}
