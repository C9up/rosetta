import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TAG = '[rosetta:browser]'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'dist/index.browser.js')
const visited = new Set()

function inspect(file) {
  if (visited.has(file)) return
  visited.add(file)
  const source = readFileSync(file, 'utf8')
  const imports = source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g)
  for (const match of imports) {
    const specifier = match[1]
    if (specifier.startsWith('node:')) {
      throw new Error(`${TAG} Node.js builtin leaked into browser graph: ${specifier} from ${file}`)
    }
    if (specifier.startsWith('.')) inspect(resolve(dirname(file), specifier))
  }
}

inspect(entry)
console.log(`${TAG} static import graph verified (${visited.size} modules, zero Node.js builtins)`)

const nodeProcess = globalThis.process
const rejections = []
const onRejection = (reason) => {
  rejections.push(reason)
}
nodeProcess.on('unhandledRejection', onRejection)
try {
  globalThis.process = undefined
  const browser = await import(`${pathToFileURL(entry)}?browser-smoke`)
  const translated = new browser.Rosetta({
    messages: { en: { hello: 'Hello {name}' } },
  }).locale('en').t('hello', { name: 'Ada' })
  if (translated !== 'Hello Ada') {
    throw new Error(`${TAG} TypeScript fallback returned ${JSON.stringify(translated)}`)
  }

  let fileSystemRejected = false
  try {
    new browser.FileSystemLoader({ location: '.' })
  } catch (error) {
    fileSystemRejected = error instanceof Error && error.message.includes('only available')
  }
  if (!fileSystemRejected) {
    throw new Error(`${TAG} browser FileSystemLoader did not fail explicitly`)
  }

  // The emitter-form constructor with a listener that throws: the failure is
  // reported, and the report itself must not need a Node global.
  const reportError = console.error
  console.error = () => {}
  try {
    const missing = new browser.Rosetta(
      {
        emit() {
          throw new Error('listener down')
        },
      },
      { defaultLocale: 'en' },
    ).locale('en').t('missing.key')
    if (missing !== 'translation missing: en, missing.key') {
      throw new Error(`${TAG} missing key returned ${JSON.stringify(missing)}`)
    }
    // Let the report run while `process` is still gone.
    for (let i = 0; i < 10; i++) await Promise.resolve()
  } finally {
    console.error = reportError
  }
} finally {
  globalThis.process = nodeProcess
}
await new Promise((resolve) => setTimeout(resolve, 0))
nodeProcess.off('unhandledRejection', onRejection)
if (rejections.length > 0) {
  throw new Error(`${TAG} unhandled rejection in the browser runtime: ${rejections[0]}`)
}
console.log(`${TAG} runtime fallback smoke passed`)
