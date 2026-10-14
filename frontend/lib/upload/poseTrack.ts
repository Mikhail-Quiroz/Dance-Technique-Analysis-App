// The skeleton an upload's results page draws over the video: one pose per analysed frame.
// Saved with the session as gzipped JSON in the same integer-delta form as the real-footage
// fixtures (scripts/extract_live_fixtures.py), which gzip packs about four times tighter than
// decimals. Only the image landmarks are kept - the drawing needs nothing else.
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

export interface PoseTrack {
  /** Frame times, ms from the start of the video, ascending. */
  t: number[]
  lm: Array<NormalizedLandmark[] | null>
}

interface EncodedTrack {
  version: 1
  scale: { lm: number; vis: number }
  /** ms deltas between frames */
  t: number[]
  has: number[]
  /** per posed frame, 33 x (x, y, visibility) as integer deltas from the previous posed frame */
  lm: number[]
}

const SCALE = { lm: 1000, vis: 100 }
const N = 33

export function encodeTrack(track: PoseTrack): EncodedTrack {
  const t: number[] = []
  const has: number[] = []
  const lm: number[] = []
  const prev = new Array<number>(N * 3).fill(0)
  let prevT = 0
  track.t.forEach((tMs, i) => {
    const ti = Math.round(tMs)
    t.push(ti - prevT)
    prevT = ti
    const pts = track.lm[i]
    if (!pts || pts.length < N) {
      has.push(0)
      return
    }
    has.push(1)
    for (let j = 0; j < N; j++) {
      const cur = [
        Math.round(pts[j].x * SCALE.lm),
        Math.round(pts[j].y * SCALE.lm),
        Math.round((pts[j].visibility ?? 0) * SCALE.vis),
      ]
      for (let k = 0; k < 3; k++) {
        lm.push(cur[k] - prev[j * 3 + k])
        prev[j * 3 + k] = cur[k]
      }
    }
  })
  return { version: 1, scale: SCALE, t, has, lm }
}

export function decodeTrack(raw: EncodedTrack): PoseTrack {
  const acc = new Array<number>(N * 3).fill(0)
  const t: number[] = []
  const lm: Array<NormalizedLandmark[] | null> = []
  let tMs = 0
  let li = 0
  for (let i = 0; i < raw.t.length; i++) {
    tMs += raw.t[i]
    t.push(tMs)
    if (!raw.has[i]) {
      lm.push(null)
      continue
    }
    for (let k = 0; k < acc.length; k++) acc[k] += raw.lm[li++]
    const pts: NormalizedLandmark[] = []
    for (let j = 0; j < N; j++) {
      pts.push({ x: acc[j * 3] / raw.scale.lm, y: acc[j * 3 + 1] / raw.scale.lm, z: 0, visibility: acc[j * 3 + 2] / raw.scale.vis })
    }
    lm.push(pts)
  }
  return { t, lm }
}

/** The pose for the frame on screen at `tMs`: the last analysed frame at or before it. */
export function poseAt(track: PoseTrack, tMs: number): NormalizedLandmark[] | null {
  const ts = track.t
  if (!ts.length || tMs < ts[0] - 50) return null
  let lo = 0
  let hi = ts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ts[mid] <= tMs) lo = mid
    else hi = mid - 1
  }
  // Past the last analysed frame by more than a couple of frames: nothing to draw.
  if (tMs - ts[lo] > 120) return null
  return track.lm[lo]
}

/** Gzipped JSON, for saving with the session. Browser only (CompressionStream). */
export async function trackToGzip(track: PoseTrack): Promise<Blob> {
  const json = new Blob([JSON.stringify(encodeTrack(track))], { type: 'application/json' })
  return new Response(json.stream().pipeThrough(new CompressionStream('gzip'))).blob()
}

export async function trackFromGzip(blob: Blob): Promise<PoseTrack> {
  const text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text()
  return decodeTrack(JSON.parse(text))
}
