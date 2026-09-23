import { stubsRoot } from "./stubs.js";

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addMetaFile?(pattern: string, reloadServer?: boolean): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
	makeUsingStub(
		stubsRoot: string,
		stubPath: string,
		state?: Record<string, string | number | boolean>,
		options?: { force?: boolean },
	): Promise<{ path: string; contents: string }>;
	addMiddleware?(group: string, paths: string[]): Promise<void>;
	registerMiddleware?(
		importPath: string,
		options?: { tier?: "server" | "router" },
	): Promise<void>;
}

/** Configure Rosetta using the same file layout and names as AdonisJS i18n. */
export async function configure(codemods: Codemods): Promise<void> {
	await codemods.addProvider("@c9up/rosetta/i18n_provider");
	/**
	 * The translations, so the BUILD copies them.
	 *
	 * Without this a `dist/` boots and then answers every lookup with
	 * `translation missing`, because the loader points at a `resources/lang/`
	 * that was never emitted.
	 *
	 * `false`, matching upstream exactly: an edit does not restart the
	 * development server. Translations are read once, at boot, so the change is
	 * seen on the next start — which is what upstream does too, and the reason
	 * it passes the same flag.
	 *
	 * Optional on the interface because an older CLI has no `addMetaFile`;
	 * configuring against one then skips this rather than failing the install.
	 */
	await codemods.addMetaFile?.("resources/lang/**/*.{json,yaml,yml}", false);
	await codemods.makeUsingStub(stubsRoot, "config/i18n.stub");
	await codemods.makeUsingStub(
		stubsRoot,
		"middleware/detect_user_locale_middleware.stub",
	);
	if (codemods.registerMiddleware) {
		await codemods.registerMiddleware(
			"#middleware/detect_user_locale_middleware",
			{ tier: "router" },
		);
	} else {
		await codemods.addMiddleware?.("router", [
			"#middleware/detect_user_locale_middleware",
		]);
	}
}
