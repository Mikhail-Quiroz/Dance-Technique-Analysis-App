// Syncs the monorepo's /shared JSON (coaching cues + scoring thresholds) into the
// frontend so /live can import it as a typed, statically-bundled module instead of
// duplicating cue text or threshold values in TypeScript. Same precedent as
// copy-mediapipe-wasm.mjs: copied at predev/prebuild, gitignored, /shared stays the
// single source of truth.
import { cpSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))   // frontend/
const monorepoRoot = join(root, '..')

const src = join(monorepoRoot, 'shared')
const dst = join(root, 'lib', 'live', 'shared')

if (!existsSync(src)) {
  console.error('[shared-assets] /shared not found at monorepo root:', src)
  process.exit(1)
}
mkdirSync(dst, { recursive: true })
cpSync(join(src, 'cues.json'), join(dst, 'cues.json'))
cpSync(join(src, 'thresholds.json'), join(dst, 'thresholds.json'))
console.log('[shared-assets] cues.json + thresholds.json -> lib/live/shared/')
