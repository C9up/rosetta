interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addMetaFile?(pattern: string, reloadServer?: boolean): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
	addMiddleware?(group: string, paths: string[]): Promise<void>;
	registerMiddleware?(
		importPath: string,
		options?: { tier?: "server" | "router" },
	): Promise<void>;
}

export const stubsRoot = new URL("../stubs/", import.meta.url);

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
	await codemods.writeFile(
		"config/i18n.ts",
		`import { defineConfig, formatters, loaders } from '@c9up/rosetta'

export default defineConfig({
  defaultLocale: 'en',
  formatter: formatters.icu(),
  loaders: [
    loaders.fs({ location: new URL('../resources/lang/', import.meta.url) }),
  ],
})
`,
	);
	await codemods.writeFile(
		"app/middleware/detect_user_locale_middleware.ts",
		`import DetectUserLocaleMiddleware from '@c9up/rosetta/middleware'
import type { RosettaLocale } from '@c9up/rosetta'

export default class extends DetectUserLocaleMiddleware {}

declare module '@c9up/ream' {
  export interface HttpContext {
    i18n: RosettaLocale
  }
}
`,
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
