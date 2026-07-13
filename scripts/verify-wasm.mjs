import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Publish-time gate: the `wasm-pack build --target web` output (JS glue + the
// binary) MUST be in the package. Without it the browser loader
// (src/native.ts) fails at runtime — exactly the "stub-only tarball" failure
// this gate prevents. Only the hand-written `rosetta_engine_wasm.d.ts` typecheck
// stub is committed; the .js/.wasm are built.

const here = dirname(fileURLToPath(import.meta.url))
const wasmDir = join(here, '..', 'wasm')

const required = ['rosetta_engine_wasm.js', 'rosetta_engine_wasm_bg.wasm']
for (const name of required) {
  const p = join(wasmDir, name)
  if (!existsSync(p)) {
    throw new Error(
      `[rosetta:wasm] missing build artifact: wasm/${name} — run \`pnpm build:wasm\` (wasm-pack) before publishing`,
    )
  }
  if (statSync(p).size === 0) {
    throw new Error(`[rosetta:wasm] empty build artifact: wasm/${name}`)
  }
}

console.log('[rosetta:wasm] browser artifacts present')
