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

if (typeof binding.parseMessage !== 'function' || typeof binding.parseCatalog !== 'function') {
  throw new Error('[rosetta:napi] invalid exports: expected parseMessage() and parseCatalog()')
}

const ast = JSON.parse(binding.parseMessage('{count, plural, one {One} other {#}}'))
if (ast[0]?.type !== 'plural' || ast[0]?.options?.other?.[0]?.type !== 'pound') {
  throw new Error('[rosetta:napi] parseMessage smoke test failed')
}

const parsedCatalog = JSON.parse(binding.parseCatalog('app:\n  title: Hello', 'yaml'))
if (parsedCatalog.app?.title !== 'Hello') {
  throw new Error('[rosetta:napi] parseCatalog smoke test failed')
}

console.log('[rosetta:napi] smoke test passed')
