import { existsSync, readFileSync, statSync } from 'node:fs'

const TAG = '[rosetta:package]'
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const root = new URL('../', import.meta.url)

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

console.log(`${TAG} publish shape verified (zero runtime dependencies)`)
