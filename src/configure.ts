interface Codemods {
	addProvider(importPath: string): Promise<void>;
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
