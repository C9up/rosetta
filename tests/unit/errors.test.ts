import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { IcuFormatter } from "../../src/formatters/IcuFormatter.js";
import { errors as browserErrors } from "../../src/index.browser.js";
import { errors } from "../../src/index.js";

describe("rosetta > errors", () => {
	it("the entry exports the errors namespace, one flare Exception per code", () => {
		const error = new errors.E_ROSETTA_UNSAFE_KEY(["translation", "__proto__"]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_ROSETTA_UNSAFE_KEY",
			status: 500,
			message: "Unsafe translation key '__proto__'",
		});
	});

	it("the browser entry exports the same classes", () => {
		expect(browserErrors.E_ROSETTA_INVALID_ICU_MESSAGE).toBe(
			errors.E_ROSETTA_INVALID_ICU_MESSAGE,
		);
	});

	it("a refusal is an instance of its errors class", () => {
		expect(() => new IcuFormatter().format("{x", "en", { x: 1 })).toThrow(
			errors.E_ROSETTA_INVALID_ICU_MESSAGE,
		);
	});
});
