import { describe, expect, it } from "vitest";
import { IcuFormatter } from "../../src/formatters/IcuFormatter.js";
import {
	I18nMessagesProvider,
	Rosetta,
	type RosettaLoader,
	RosettaLocale,
} from "../../src/Rosetta.js";

/**
 * Values these entry points used to take on faith. Each was cast to the shape
 * it was supposed to have, so a wrong one failed later and elsewhere — or not
 * at all.
 */
describe("rosetta > argument shapes are checked, not assumed", () => {
	const emitter = { emit: () => undefined };
	const config = {
		defaultLocale: "en",
		formatter: () => new IcuFormatter(),
		loaders: [],
	};

	it("rejects the Adonis I18n constructor with its arguments swapped", () => {
		const manager = new Rosetta({ defaultLocale: "en" });
		expect(() =>
			Reflect.construct(RosettaLocale, ["fr", manager, emitter]),
		).toThrow(/expects an emitter and a manager/);
		expect(() => Reflect.construct(RosettaLocale, ["fr", emitter])).toThrow(
			/expects an emitter and a manager/,
		);
		expect(() => Reflect.construct(RosettaLocale, [manager, 42])).toThrow(
			/expects a locale string/,
		);
		expect(new RosettaLocale("fr", emitter, manager).locale).toBe("fr");
	});

	it("rejects an I18nManager built without an emitter", () => {
		expect(() =>
			Reflect.construct(Rosetta, [{ defaultLocale: "en" }, config]),
		).toThrow(/expects an emitter/);
		expect(new Rosetta(emitter, config).defaultLocale).toBe("en");
	});

	it("translates only field names in validation metadata", () => {
		const i18n = new Rosetta({
			defaultLocale: "en",
			messages: {
				en: { validator: { shared: { fields: { email: "e-mail" } } } },
			},
		}).locale("en");
		const provider = new I18nMessagesProvider("validator.shared", i18n);
		const values = { list: ["a"] };
		const meta: Record<string, unknown> = {
			otherField: "email",
			originalField: values,
		};
		provider.getMessage("{field} differs", "same", "password", meta);
		expect(meta.otherField).toBe("e-mail");
		expect(meta.originalField).toBe(values);
	});

	it("rejects a date-like value whose toJSDate is not a Date", () => {
		const rosetta = new Rosetta({
			defaultLocale: "en",
			messages: { en: { at: "{d, date, short}" } },
		});
		expect(() => rosetta.t("at", { d: { toJSDate: () => "2024" } })).toThrow(
			TypeError,
		);
		expect(
			rosetta.t("at", { d: { toMillis: () => Date.UTC(2024, 0, 15, 12) } }),
		).toBe("1/15/24");
	});

	it("loads the default locale from a per-locale loader when no list is configured", async () => {
		const asked: string[] = [];
		const loader: RosettaLoader = {
			async load(locale) {
				asked.push(locale);
				return { hello: `hello from ${locale}` };
			},
		};
		const rosetta = new Rosetta({ defaultLocale: "fr", loaders: [loader] });
		await rosetta.boot();
		expect(asked).toEqual(["fr"]);
		expect(rosetta.t("hello")).toBe("hello from fr");
	});
});
