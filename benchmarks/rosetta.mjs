import { performance } from "node:perf_hooks";

import { isNativeAvailable, Rosetta } from "../dist/index.js";

const manager = new Rosetta({
	defaultLocale: "en",
	fallbackLocale: "fr",
	messages: {
		en: {
			literal: "Hello",
			interpolation: "Hello {name}",
			plural: "{count, plural, =0 {No items} one {One item} other {# items}}",
			amount: "{value, number, ::currency/EUR precision-integer group-min2}",
		},
		fr: {
			fallback: "Valeur de repli",
		},
	},
});

const locale = manager.locale("en");
const results = [];
let checksum = 0;

function bench(name, iterations, operation) {
	for (let index = 0; index < 2_000; index += 1)
		checksum += operation(index).length;

	const start = performance.now();
	for (let index = 0; index < iterations; index += 1) {
		checksum += operation(index).length;
	}
	const elapsedMs = performance.now() - start;
	const nsPerOp = (elapsedMs * 1_000_000) / iterations;
	const opsPerSecond = 1_000_000_000 / nsPerOp;
	results.push({ name, iterations, opsPerSecond, nsPerOp });
}

bench("t literal", 250_000, () => locale.t("literal"));
bench("t fallback locale", 250_000, () => locale.t("fallback"));
bench("t interpolation", 150_000, () =>
	locale.t("interpolation", { name: "Kaen" }),
);
bench("t ICU plural", 50_000, (index) =>
	locale.t("plural", { count: index % 5 }),
);
bench("t ICU number skeleton", 25_000, (index) =>
	locale.t("amount", { value: 1_000 + index }),
);
bench("formatNumber", 50_000, (index) => locale.formatNumber(1_000 + index));

console.log(
	`Rosetta benchmark (${process.version}, ${process.platform}-${process.arch})`,
);
console.log(`N-API parser: ${isNativeAvailable() ? "enabled" : "disabled"}`);
console.log("");
for (const result of results) {
	console.log(
		`${result.name.padEnd(25)} ${Math.round(result.opsPerSecond).toLocaleString("en-US").padStart(12)} ops/s  ${Math.round(result.nsPerOp).toLocaleString("en-US").padStart(9)} ns/op`,
	);
}

// Keep benchmark calls observable so optimizing runtimes cannot discard them.
console.log(`\nchecksum: ${checksum}`);
