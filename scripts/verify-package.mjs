import { existsSync, readFileSync, statSync } from 'node:fs'
import { arch, env, platform } from 'node:process'

const TAG = '[rosetta:package]'
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const root = new URL('../', import.meta.url)
const allNativeArtifacts = [
  'index.linux-x64-gnu.node',
  'index.linux-arm64-gnu.node',
  'index.darwin-x64.node',
  'index.darwin-arm64.node',
  'index.win32-x64-msvc.node',
]
const hostArtifacts = {
  'linux-x64': 'index.linux-x64-gnu.node',
  'linux-arm64': 'index.linux-arm64-gnu.node',
  'darwin-x64': 'index.darwin-x64.node',
  'darwin-arm64': 'index.darwin-arm64.node',
  'win32-x64': 'index.win32-x64-msvc.node',
}

function requireFile(path) {
  const url = new URL(path, root)
  if (!existsSync(url)) throw new Error(`${TAG} missing required file: ${path}`)
  if (statSync(url).size === 0) throw new Error(`${TAG} empty required file: ${path}`)
}

if (Object.keys(packageJson.dependencies ?? {}).length !== 0) {
  throw new Error(`${TAG} runtime dependencies are forbidden`)
}
if (Object.keys(packageJson.peerDependencies ?? {}).length !== 0) {
  throw new Error(`${TAG} peer dependencies are forbidden`)
}

for (const entry of Object.values(packageJson.publishConfig?.exports ?? {})) {
  requireFile(entry.import.replace(/^\.\//, ''))
  requireFile(entry.types.replace(/^\.\//, ''))
  if (entry.browser) requireFile(entry.browser.replace(/^\.\//, ''))
}

const nativeArtifacts = env.ROSETTA_REQUIRE_ALL_TARGETS === '1'
  ? allNativeArtifacts
  : [hostArtifacts[`${platform}-${arch}`]].filter(Boolean)
for (const artifact of nativeArtifacts) requireFile(artifact)

requireFile('wasm/rosetta_engine_wasm.js')
requireFile('wasm/rosetta_engine_wasm_bg.wasm')

console.log(
  `${TAG} publish shape verified (${nativeArtifacts.length} native artifact${nativeArtifacts.length === 1 ? '' : 's'}, zero runtime dependencies)`,
)
