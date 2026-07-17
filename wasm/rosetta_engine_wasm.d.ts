// Hand-written stub for the wasm-pack-generated glue file. Lets `tsc --noEmit`
// pass on a fresh checkout before `pnpm build:wasm` has been run. wasm-pack
// will overwrite this file with its real generated declarations on the next
// `build:wasm`; the runtime shape stays compatible.
//
// Story 52.1 review patch (2026-05-09): a) WASM artefact was previously
// emitted to `../../dist/wasm/` (sibling of the package, outside its
// tarball surface) while src/native.ts imported `../dist/wasm/...`. The
// artefact never landed in the published tarball — a browser consumer
// would hit `Cannot find module` at runtime. Same pattern as Epic 51 F3+F4
// (atom + chronos). Fixed: build:wasm out-dir is now `../../wasm` (lands
// inside the package), import path is `../wasm/...`, package.json files
// array now includes `wasm`. b) typecheck was also broken on a fresh
// checkout because tsc couldn't find this module before `build:wasm` had
// been run. This stub provides the minimum types needed.

export default function init(): Promise<unknown>;

export function parse_message(message: string): string;

export function parse_catalog(input: string, format: string): string;
