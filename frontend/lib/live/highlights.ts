// A /live session's summary and highlight reel: which stretches of the recording hold the moves,
// where each moment of the session lands in the reel, and the session report on the reel's clock.
// Pure, so it is unit-tested (highlights.test.ts). The browser side is recorder.ts (recording
// while the dancer dances) and reel.ts (cutting the reel).
//
// Everything here runs on the session clock: performance.now() milliseconds, the same clock the
// MoveEngine's events and the recording spans are stamped with.
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { MoveEvent } from './moveEngine'
import { buildReport, type SessionReport } from '../upload/report'
import type { PoseTrack } from '../upload/poseTrack'

/** One continuous recording. A camera switch or a turned phone starts the next one. */
export interface RecordingSpan {
  startMs: number
  endMs: number
}

/** A stretch of one recording (`part`, an index into the spans) that goes into the reel. */
export interface Segment {
  part: number
  fromMs: number
  toMs: number
}

/** Kept before a move starts: the preparation and run-up. */
export const LEAD_MS = 1200
/** Kept after a move ends: the landing or the finish. */
export const TAIL_MS = 900
/** Moves closer together than this play straight through instead of cutting between them. */
export const JOIN_MS = 800
/** Shorter than this, a stretch is not worth a cut. */
const MIN_SEGMENT_MS = 300

/**
 * The stretches of the recording that make the reel: every move with LEAD_MS before it and TAIL_MS
 * after, inside the recording it happened in, merged where they touch or nearly do. In order.
 */
export function highlightSegments(
  moves: ReadonlyArray<Pick<MoveEvent, 'startMs' | 'endMs'>>,
  parts: readonly RecordingSpan[],
): Segment[] {
  const raw: Segment[] = []
  for (const m of moves) {
    const from = m.startMs - LEAD_MS
    const to = m.endMs + TAIL_MS
    // The recording holding most of the move with its margins.
    let part = -1
    let best = 0
    parts.forEach((p, i) => {
      const overlap = Math.min(to, p.endMs) - Math.max(from, p.startMs)
      if (overlap > best) {
        best = overlap
        part = i
      }
    })
    if (part < 0) continue
    const p = parts[part]
    const seg = { part, fromMs: Math.max(from, p.startMs), toMs: Math.min(to, p.endMs) }
    if (seg.toMs - seg.fromMs >= MIN_SEGMENT_MS) raw.push(seg)
  }
  raw.sort((a, b) => a.part - b.part || a.fromMs - b.fromMs)
  const out: Segment[] = []
  for (const s of raw) {
    const last = out[out.length - 1]
    if (last && last.part === s.part && s.fromMs - last.toMs <= JOIN_MS) last.toMs = Math.max(last.toMs, s.toMs)
    else out.push({ ...s })
  }
  return out
}

/** Where each segment starts in the reel if every segment plays exactly once, back to back. */
export function nominalStarts(segments: readonly Segment[]): number[] {
  let at = 0
  return segments.map((s) => {
    const start = at
    at += s.toMs - s.fromMs
    return start
  })
}

/** Where a moment of the session is in the reel, or null when it was cut out. */
export function toReelMs(segments: readonly Segment[], starts: readonly number[], tMs: number): number | null {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (tMs >= s.fromMs && tMs <= s.toMs) return starts[i] + (tMs - s.fromMs)
  }
  return null
}

/** The reel itself, as reel.ts measured it: segment start times on its own clock, its length. */
export interface ReelClock {
  segments: Segment[]
  starts: number[]
  durationMs: number
}

/**
 * The session report for a live session. With a reel, every move is placed on the reel's clock,
 * so the results page's timeline and "play this move" seek the reel; without one, on the session's
 * own clock from its start. duration_s is the video's length then; session_s is always how long
 * the session ran.
 */
export function liveReport(
  events: readonly MoveEvent[],
  session: { startMs: number; endMs: number },
  reel: ReelClock | null,
): SessionReport {
  const sessionMs = Math.max(0, session.endMs - session.startMs)
  let placed: MoveEvent[]
  let durationMs: number
  if (reel) {
    // A move the reel missed (recording had stopped) goes at its end, so it is still listed.
    const at = (t: number) => toReelMs(reel.segments, reel.starts, t) ?? reel.durationMs
    placed = events.map((ev) => ({ ...ev, startMs: at(ev.startMs), endMs: Math.max(at(ev.startMs), at(ev.endMs)) }))
    durationMs = reel.durationMs
  } else {
    placed = events.map((ev) => ({ ...ev, startMs: ev.startMs - session.startMs, endMs: ev.endMs - session.startMs }))
    durationMs = sessionMs
  }
  return { ...buildReport(placed, durationMs), source: 'live', session_s: Math.round(sessionMs / 100) / 10 }
}

/** The poses /live read, kept compactly: per frame, 33 x (x, y, visibility), or null for no pose. */
export interface PoseLog {
  t: number[]
  lm: Array<Float32Array | null>
}

export function packPose(lm: readonly NormalizedLandmark[]): Float32Array {
  const out = new Float32Array(lm.length * 3)
  lm.forEach((p, i) => {
    out[3 * i] = p.x
    out[3 * i + 1] = p.y
    out[3 * i + 2] = p.visibility ?? 0
  })
  return out
}

export function unpackPose(packed: Float32Array): NormalizedLandmark[] {
  const out: NormalizedLandmark[] = []
  for (let i = 0; i < packed.length; i += 3) out.push({ x: packed[i], y: packed[i + 1], z: 0, visibility: packed[i + 2] })
  return out
}

/** A recording's picture inside the reel's frame, as fractions of it (letterboxed when shapes differ). */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** `src` (w x h) fitted inside `dst`, centered, as fractions of `dst`. */
export function fitBox(srcW: number, srcH: number, dstW: number, dstH: number): Box {
  const s = Math.min(dstW / srcW, dstH / srcH)
  const w = (srcW * s) / dstW
  const h = (srcH * s) / dstH
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

/**
 * The skeleton for the reel: the logged poses inside the segments, moved onto the reel's clock and
 * into the box each recording occupies in the reel's frame. In the PoseTrack the results page
 * draws (lib/upload/poseTrack.ts).
 */
export function reelTrack(log: PoseLog, reel: ReelClock, boxes: readonly Box[]): PoseTrack {
  const track: PoseTrack = { t: [], lm: [] }
  reel.segments.forEach((s, i) => {
    const box = boxes[s.part] ?? { x: 0, y: 0, w: 1, h: 1 }
    for (let k = 0; k < log.t.length; k++) {
      const t = log.t[k]
      if (t < s.fromMs || t > s.toMs) continue
      const reelMs = Math.round(reel.starts[i] + (t - s.fromMs))
      if (track.t.length && reelMs <= track.t[track.t.length - 1]) continue
      const packed = log.lm[k]
      track.t.push(reelMs)
      track.lm.push(packed
        ? unpackPose(packed).map((p) => ({ ...p, x: box.x + p.x * box.w, y: box.y + p.y * box.h }))
        : null)
    }
  })
  return track
}
