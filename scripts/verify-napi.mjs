import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { arch, platform } from 'node:process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const suffixMap = {
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'win32-x64-msvc',
}

const suffix = suffixMap[`${platform}-${arch}`]
if (!suffix) {
  throw new Error(`[rosetta:napi] unsupported platform/arch: ${platform}-${arch}`)
}

const binary = join(root, `index.${suffix}.node`)
if (!existsSync(binary)) {
  throw new Error(`[rosetta:napi] binary missing: ${binary}`)
}

const require2 = createRequire(import.meta.url)
const binding = require2(binary)

if (typeof binding.translate !== 'function' || typeof binding.has !== 'function') {
  throw new Error('[rosetta:napi] invalid exports: expected translate() and has() functions')
}

const catalogs = JSON.stringify({ en: { hello: 'Hello {name}' } })
const chain = JSON.stringify(['en'])
const params = JSON.stringify({ name: 'Kaen' })

const translated = binding.translate(catalogs, 'hello', params, chain, undefined)
if (translated !== 'Hello Kaen') {
  throw new Error(`[rosetta:napi] translate smoke test failed: got "${translated}"`)
}

const hasKey = binding.has(catalogs, 'hello', chain)
if (hasKey !== true) {
  throw new Error('[rosetta:napi] has smoke test failed')
}

console.log('[rosetta:napi] smoke test passed')
