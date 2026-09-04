import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

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
// A peer is allowed only if it is optional AND nothing imports it at runtime.
// `augmentations.ts` needs `@c9up/ream` to declare what `container.make()`
// returns for rosetta's tokens — a types-only import, which leaves the built
// output free of it. A REQUIRED peer would be a runtime dependency by another
// name, so it stays forbidden.
const optionalPeers = packageJson.peerDependenciesMeta ?? {}
for (const name of Object.keys(packageJson.peerDependencies ?? {})) {
  if (optionalPeers[name]?.optional !== true) {
    throw new Error(`${TAG} required peer dependency is forbidden: ${name}`)
  }
}

for (const entry of Object.values(packageJson.publishConfig?.exports ?? {})) {
  requireFile(entry.import.replace(/^\.\//, ''))
  requireFile(entry.types.replace(/^\.\//, ''))
  if (entry.browser) requireFile(entry.browser.replace(/^\.\//, ''))
}

// Prove the claim rather than trust it: a peer that reached the emitted
// JavaScript is a runtime dependency, whatever the manifest calls it.
//
// Template literals are stripped first — `configure.js` carries stub file
// CONTENTS, imports and all, and a string that looks like an import is not
// one. What is left is this module's own syntax.
const peers = Object.keys(packageJson.peerDependencies ?? {})
if (peers.length > 0) {
  const emitted = readdirSync(new URL('dist/', root), { recursive: true }).filter(
    (entry) => typeof entry === 'string' && entry.endsWith('.js'),
  )
  for (const file of emitted) {
    const code = readFileSync(new URL(`dist/${file}`, root), 'utf8').replace(
      /`(?:\\.|[^`\\])*`/gs,
      '``',
    )
    for (const peer of peers) {
      const spec = `${peer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/[^'"]*)?`
      const importing = new RegExp(
        `(?:^|[^\\w.])(?:` +
          `(?:import|export)\\s+(?:[^'"();]*\\sfrom\\s*)?['"]${spec}['"]` +
          `|(?:require|import)\\s*\\(\\s*['"]${spec}['"]` +
          `)`,
        'm',
      )
      if (importing.test(code)) {
        throw new Error(`${TAG} dist/${file} imports ${peer} at runtime`)
      }
    }
  }
}

console.log(`${TAG} publish shape verified (zero runtime dependencies)`)
