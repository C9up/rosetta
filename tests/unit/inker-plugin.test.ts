import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import { Templates } from "@c9up/inker";
import { buildCanonicalHelpers } from "@c9up/inker/provider";
import { describe, expect, it } from "vitest";
import { inkerPluginI18n } from "../../src/plugins/inker.js";
import { Rosetta, RosettaLocale } from "../../src/Rosetta.js";

/**
 * The real engine, not a stub: the bug lived in how inker resolves a callable
 * global against its own canonical `t` helper, which a stub cannot reproduce.
 */

interface RequestContext {
	readonly request: object;
	readonly response: {
		type(value: string): unknown;
		send(body: string): unknown;
	};
	readonly store: Map<string, unknown>;
	readonly locale: string;
}

const router = {
	urlFor: () => "/",
	makeUrl: () => "/",
	makeSignedUrl: () => "/",
};

function setup() {
	const rosetta = new Rosetta({
		defaultLocale: "en",
		supportedLocales: ["en", "fr"],
		messages: {
			en: { hello: "Hello {name}" },
			fr: { hello: "Bonjour {name}" },
		},
	});
	const als = new AsyncLocalStorage<RequestContext>();
	const templates = new Templates({
		root: tmpdir(),
		helpers: buildCanonicalHelpers(als, rosetta, router, undefined),
	});
	templates.use(inkerPluginI18n(rosetta));
	const ctx: RequestContext = {
		request: {},
		response: { type: () => undefined, send: () => undefined },
		store: new Map(),
		locale: "fr",
	};
	return { rosetta, als, templates, ctx };
}

describe("rosetta > inker plugin", () => {
	it("translates in the request locale on the ctx-based render path", () => {
		const { rosetta, als, templates, ctx } = setup();
		// What the locale middleware does around the rest of the request.
		const out = rosetta.runWithLocale("fr", () =>
			als.run(ctx, () =>
				templates.renderString("{{ t('hello', { name: 'x' }) }}", {}),
			),
		);
		expect(out).toBe("Bonjour x");
	});

	it("formats through the i18n global in the request locale", () => {
		const { rosetta, templates } = setup();
		const out = rosetta.runWithLocale("fr", () =>
			templates.renderString(
				"{{ i18n.locale }}|{{ i18n.formatNumber(1234.5) }}",
				{},
			),
		);
		expect(out).toBe(`fr|${new Intl.NumberFormat("fr").format(1234.5)}`);
	});

	it("uses the per-request i18n a renderer shared (the ctx.view path)", () => {
		const { rosetta, templates } = setup();
		// No ambient locale at all: the shared instance alone decides.
		const view = templates
			.createRenderer()
			.share({ i18n: rosetta.locale("fr") });
		expect(view.renderString("{{ t('hello', { name: 'x' }) }}")).toBe(
			"Bonjour x",
		);
		expect(view.renderString("{{ i18n.locale }}")).toBe("fr");
	});

	it("renders the default locale outside any request", () => {
		const { templates } = setup();
		expect(templates.renderString("{{ t('hello', { name: 'x' }) }}")).toBe(
			"Hello x",
		);
		expect(templates.renderString("{{ i18n.locale }}")).toBe("en");
	});

	it("keeps the i18n global a RosettaLocale and never mutates the shared one", () => {
		const { rosetta, templates } = setup();
		// Plugins run on the first render, not at `use()`.
		expect(templates.renderString("{{ i18n.locale }}")).toBe("en");
		expect(templates.globals.get("i18n")).toBeInstanceOf(RosettaLocale);
		// A template switching the global's locale must not leak into the next
		// render: the global belongs to every request.
		rosetta.runWithLocale("fr", () =>
			templates.renderString("{{ i18n.switchLocale('fr') }}"),
		);
		expect(templates.renderString("{{ i18n.locale }}")).toBe("en");
	});

	it("publishes the locale helpers", () => {
		const { templates } = setup();
		expect(
			templates.renderString(
				"{{ getDefaultLocale() }}|{{ getSupportedLocales().join(',') }}",
			),
		).toBe("en|en,fr");
	});
});
