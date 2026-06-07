import { describe, expect, it } from "vitest";
import { Rosetta } from "../../src/Rosetta.js";
import i18n, { getI18n, setI18n } from "../../src/services/main.js";

describe("rosetta > services/main singleton", () => {
	it("throws when the proxy is accessed before setI18n binds an instance", () => {
		// Module-level state: if a prior test in this file already bound an
		// instance the throw won't fire, so this case runs FIRST and the
		// setI18n tests follow.
		expect(getI18n()).toBeUndefined();
		expect(() => i18n.locale("en")).toThrow(/accessed before/);
	});

	it("getI18n returns undefined pre-boot", () => {
		// Still unbound at this point (the throw test above didn't bind).
		expect(getI18n()).toBeUndefined();
	});

	it("setI18n binds the instance and the proxy delegates to it", () => {
		const rosetta = new Rosetta({ defaultLocale: "en" });
		setI18n(rosetta);

		expect(getI18n()).toBe(rosetta);
		// Proxy now resolves real methods bound to the instance.
		const locale = i18n.locale("en");
		expect(locale).toBeDefined();
		expect(typeof locale.t).toBe("function");
	});

	it("proxy binds methods to the backing instance (no `this` loss)", () => {
		const rosetta = new Rosetta({
			defaultLocale: "en",
			messages: { en: { greeting: "Hello" } },
		});
		setI18n(rosetta);

		// Destructure a method off the proxy — the bind() in the getter
		// must keep it pointed at the real instance.
		const { locale } = i18n;
		const t = locale("en").t("greeting");
		expect(t).toBe("Hello");
	});
});
