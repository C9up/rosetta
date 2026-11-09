import { afterEach, describe, expect, it, vi } from "vitest";
import { IcuFormatter } from "../../src/formatters/IcuFormatter.js";
import { Rosetta } from "../../src/Rosetta.js";

/**
 * Rosetta.ts is part of the browser entry, where there is no `process`. A
 * failing missing-translation listener is reported, never escalated — and the
 * report itself must not reach for a Node global, or it throws inside the
 * `.catch` meant to contain the failure.
 */
describe("rosetta > failing missing-translation listener without Node globals", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("reports the failure and leaves no unhandled rejection", async () => {
		const realProcess = globalThis.process;
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => {
			rejections.push(reason);
		};
		realProcess.on("unhandledRejection", onRejection);
		const reports: unknown[][] = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			reports.push(args);
		});

		const manager = new Rosetta(
			{
				emit() {
					throw new Error("listener down");
				},
			},
			{
				defaultLocale: "en",
				supportedLocales: ["en"],
				formatter: () => new IcuFormatter(),
				loaders: [],
			},
		);
		vi.stubGlobal("process", undefined);
		try {
			expect(manager.locale("en").t("missing.key")).toBe(
				"translation missing: en, missing.key",
			);
			// The report runs a few microtasks later; keep `process` gone until then.
			for (let i = 0; i < 10; i++) await Promise.resolve();
		} finally {
			vi.unstubAllGlobals();
		}
		// An unhandled rejection is reported on the next turn of the loop.
		await new Promise((resolve) => setTimeout(resolve, 0));
		realProcess.off("unhandledRejection", onRejection);

		expect(rejections).toEqual([]);
		expect(reports.flat().join(" ")).toContain("listener down");
	});
});
