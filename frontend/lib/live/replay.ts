// Replays real-footage fixtures (scripts/extract_live_fixtures.py) through the /live detectors,
// frame by frame, through the same MoveEngine LiveClient drives. Test-only: imports node:fs, so never import it from app code.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { MoveEngine, MoveEvent } from './moveEngine'
import { ClipAnalyzer } from './clip'

type Pt = [number, number, number, number]

export interface FixtureFrame {
  t: number
  lm: NormalizedLandmark[] | null
  world: Landmark[] | null
}

export interface Fixture {
  name: string
  label: string
  fps: number
  /** Frame width and height in pixels, when the extractor recorded them (all reference clips are 1280x720). */
  size?: [number, number]
  frames: FixtureFrame[]
}

export const FIXTURE_ROOT = join(__dirname, 'fixtures', 'real')

/**
 * The same reference clips read by three pose runtimes, at the same frames:
 *  - python: scripts/extract_live_fixtures.py (MediaPipe for Python), the set the critiques were
 *    checked against frame by frame;
 *  - browserCpu / browserGpu: scripts/extract-browser-fixtures.mjs, the browser's MediaPipe on the
 *    CPU (what an upload runs) and on the GPU (what /live runs).
 * Their landmarks differ by about half a percent of the frame, which is enough to tip a detector
 * sitting on a threshold - so identification is tested on all three.
 */
export const FIXTURE_SETS = {
  python: FIXTURE_ROOT,
  browserCpu: join(__dirname, 'fixtures', 'browser-cpu'),
  browserGpu: join(__dirname, 'fixtures', 'browser-gpu'),
} as const
export type FixtureSet = keyof typeof FIXTURE_SETS

const toLm = (pts: Pt[] | null) =>
  pts ? pts.map(([x, y, z, visibility]) => ({ x, y, z, visibility })) : null

export function loadFixture(path: string, name: string): Fixture {
  const raw = JSON.parse(gunzipSync(readFileSync(path)).toString('utf-8'))
  if (raw.version === 2) return decodeV2(raw, name)
  // Format 1: plain decimals per frame.
  const v1 = raw as { label: string; fps: number; frames: Array<{ t: number; lm: Pt[] | null; world: Pt[] | null }> }
  return {
    name,
    label: v1.label,
    fps: v1.fps,
    frames: v1.frames.map((f) => ({ t: f.t, lm: toLm(f.lm), world: toLm(f.world) })),
  }
}

/** Format 2 (scripts/extract_live_fixtures.py): integer frame-to-frame deltas. */
function decodeV2(raw: {
  label: string
  fps: number
  size?: [number, number]
  scale: { lm: number; world: number; vis: number }
  t: number[]
  has: number[]
  lm: number[]
  w: number[]
}, name: string): Fixture {
  const frames: FixtureFrame[] = []
  const lmAcc = new Array<number>(33 * 3).fill(0)
  const wAcc = new Array<number>(33 * 4).fill(0)
  let t = 0
  let li = 0
  let wi = 0
  for (let i = 0; i < raw.t.length; i++) {
    t += raw.t[i]
    if (!raw.has[i]) {
      frames.push({ t, lm: null, world: null })
      continue
    }
    for (let k = 0; k < lmAcc.length; k++) lmAcc[k] += raw.lm[li++]
    for (let k = 0; k < wAcc.length; k++) wAcc[k] += raw.w[wi++]
    const lm: NormalizedLandmark[] = []
    const world: Landmark[] = []
    for (let j = 0; j < 33; j++) {
      lm.push({ x: lmAcc[j * 3] / raw.scale.lm, y: lmAcc[j * 3 + 1] / raw.scale.lm, z: 0, visibility: lmAcc[j * 3 + 2] / raw.scale.vis })
      world.push({
        x: wAcc[j * 4] / raw.scale.world,
        y: wAcc[j * 4 + 1] / raw.scale.world,
        z: wAcc[j * 4 + 2] / raw.scale.world,
        visibility: wAcc[j * 4 + 3] / raw.scale.vis,
      })
    }
    frames.push({ t, lm, world })
  }
  return { name, label: raw.label, fps: raw.fps, ...(raw.size ? { size: raw.size } : {}), frames }
}

/** Every fixture in one folder (e.g. 'split_leap'), sorted by the number in the file name. */
export function loadFolder(folder: string, root: string = FIXTURE_ROOT): Fixture[] {
  const dir = join(root, folder)
  if (!existsSync(dir)) return []
  const num = (s: string) => Number(s.match(/(\d+)/)?.[1] ?? 0)
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json.gz'))
    .sort((a, b) => num(a) - num(b))
    .map((f) => loadFixture(join(dir, f), f.replace(/\.json\.gz$/, '')))
}

export interface ReplayResult {
  events: MoveEvent[]
  engine: MoveEngine
}

/**
 * Every frame through the same MoveEngine LiveClient runs, by way of the ClipAnalyzer the upload
 * page uses. A frame with no pose is skipped, as /live does. The clip's end is flushed, as an
 * upload's is; `flush: false` stops at the last frame, as /live would.
 */
export function replay(fx: Fixture, opts: { flush?: boolean } = {}): ReplayResult {
  const clip = new ClipAnalyzer(fx.size ? fx.size[0] / fx.size[1] : undefined)
  for (const f of fx.frames) clip.push(f.t, f.lm, f.world)
  if (opts.flush !== false) clip.finish()
  return { events: clip.events, engine: clip.engine }
}

/** The clip cut off at `endMs`, as a video trimmed tightly around the move would be. */
export function truncate(fx: Fixture, endMs: number): Fixture {
  return { ...fx, name: `${fx.name} cut at ${(endMs / 1000).toFixed(2)}s`, frames: fx.frames.filter((f) => f.t <= endMs) }
}

/**
 * The same clip as a slower camera would have delivered it: every `step`-th frame. A 30 fps
 * clip decimated by 2 is what a 15 fps laptop webcam sees of the same dance.
 */
export function decimate(fx: Fixture, step: number): Fixture {
  return { ...fx, name: `${fx.name} @${Math.round(fx.fps / step)}fps`, fps: fx.fps / step, frames: fx.frames.filter((_, i) => i % step === 0) }
}
