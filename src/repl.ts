import type { Rosetta } from "./Rosetta.js";

export interface I18nReplContext {
	i18n?: Rosetta;
}

export interface I18nReplLike {
	addBinding?(name: string, value: unknown): void;
	addMethod?(
		name: string,
		callback: () => unknown,
		options?: { description?: string },
	): void;
	server?: { context?: I18nReplContext };
	notify?(message: string): void;
}

/** Register the same `i18n` convenience binding expected in an Adonis REPL. */
export function registerReplBindings(
	repl: I18nReplLike,
	manager: Rosetta,
): void {
	const bind = () => {
		if (repl.addBinding) repl.addBinding("i18n", manager);
		else if (repl.server?.context) repl.server.context.i18n = manager;
		repl.notify?.("i18n binding loaded");
		return manager;
	};

	repl.addMethod?.("loadI18n", bind, {
		description: "Load the i18n manager as `i18n`",
	});
	bind();
}
