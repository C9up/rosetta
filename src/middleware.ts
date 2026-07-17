import {
	type I18nMessagesProvider,
	type Rosetta,
	RosettaLocale,
} from "./Rosetta.js";
import i18nManager from "./services/main.js";

export interface I18nHttpContext {
	request?: {
		header?(name: string): string | undefined;
		headers?: Record<string, string | string[] | undefined>;
		languages?(): string[];
		language?(locales: string[]): string | null;
	};
	i18n?: RosettaLocale;
	locale?: string;
	view?: { share?(values: Record<string, unknown>): unknown };
	containerResolver?: {
		bindValue(token: unknown, value: unknown): void;
	};
}

export interface RequestValidatorLike {
	messagesProvider?: (context: I18nHttpContext) => I18nMessagesProvider;
}

/** Request middleware equivalent to Adonis's generated locale detector. */
export default class DetectUserLocaleMiddleware {
	constructor(protected readonly manager: Rosetta = i18nManager) {}

	static messagesProvider(context: I18nHttpContext): I18nMessagesProvider {
		if (!context.i18n) {
			throw new Error(
				"Cannot create validation messages before locale detection",
			);
		}
		return context.i18n.createMessagesProvider();
	}

	static registerMessagesProvider(validator: RequestValidatorLike): void {
		validator.messagesProvider = DetectUserLocaleMiddleware.messagesProvider;
	}

	protected getRequestLocale(context: I18nHttpContext): string {
		const negotiated = context.request?.language?.(
			this.manager.supportedLocales(),
		);
		if (negotiated) return negotiated;

		const accepted = context.request?.languages?.();
		if (accepted?.length) {
			return (
				this.manager.getSupportedLocaleFor(accepted) ??
				this.manager.defaultLocale
			);
		}

		const raw =
			context.request?.header?.("accept-language") ??
			context.request?.headers?.["accept-language"];
		const header = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
		return (
			this.manager.getSupportedLocaleFor(header) ?? this.manager.defaultLocale
		);
	}

	async handle(
		context: I18nHttpContext,
		next: () => Promise<unknown>,
	): Promise<unknown> {
		const locale = this.getRequestLocale(context);
		context.i18n = this.manager.locale(locale);
		context.containerResolver?.bindValue(RosettaLocale, context.i18n);
		// Inker's canonical `t()` helper reads ctx.locale on every render.
		context.locale = locale;
		context.view?.share?.({ i18n: context.i18n });
		return this.manager.runWithLocale(locale, next);
	}
}
