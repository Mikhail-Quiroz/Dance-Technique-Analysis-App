import { describe, expect, it } from 'vitest'
import {
  JOIN_MS, LEAD_MS, TAIL_MS, fitBox, highlightSegments, liveReport, nominalStarts, packPose, reelTrack,
  toReelMs, unpackPose, type PoseLog,
} from './highlights'
import type { MoveEvent } from './moveEngine'
import { loadFolder, replay } from './replay'

const move = (startMs: number, endMs: number) => ({ startMs, endMs })
const ONE = [{ startMs: 0, endMs: 60_000 }]

describe('highlight segments', () => {
  it('keeps each move with its run-up and its finish', () => {
    expect(highlightSegments([move(10_000, 10_600)], ONE)).toEqual([
      { part: 0, fromMs: 10_000 - LEAD_MS, toMs: 10_600 + TAIL_MS },
    ])
  })

  it('plays moves that nearly touch straight through, and cuts between ones further apart', () => {
    const near = 10_600 + TAIL_MS + JOIN_MS + LEAD_MS - 1 // the gap between the windows is under JOIN_MS
    const segs = highlightSegments([move(10_000, 10_600), move(near, near + 500), move(40_000, 41_000)], ONE)
    expect(segs).toEqual([
      { part: 0, fromMs: 10_000 - LEAD_MS, toMs: near + 500 + TAIL_MS },
      { part: 0, fromMs: 40_000 - LEAD_MS, toMs: 41_000 + TAIL_MS },
    ])
  })

  it('stays inside the recording, and leaves out moves nothing recorded', () => {
    const parts = [{ startMs: 5_000, endMs: 20_000 }]
    expect(highlightSegments([move(5_200, 5_700), move(19_500, 19_900), move(30_000, 31_000)], parts)).toEqual([
      { part: 0, fromMs: 5_000, toMs: 5_700 + TAIL_MS },
      { part: 0, fromMs: 19_500 - LEAD_MS, toMs: 20_000 },
    ])
  })

  it('takes each move from the recording it happened in, and never joins across recordings', () => {
    const parts = [{ startMs: 0, endMs: 12_000 }, { startMs: 12_400, endMs: 40_000 }]
    expect(highlightSegments([move(10_000, 10_500), move(13_000, 13_500)], parts)).toEqual([
      { part: 0, fromMs: 10_000 - LEAD_MS, toMs: 11_400 },
      { part: 1, fromMs: 12_400, toMs: 13_500 + TAIL_MS },
    ])
  })
})

describe('the reel clock', () => {
  const segs = [{ part: 0, fromMs: 1_000, toMs: 3_000 }, { part: 0, fromMs: 10_000, toMs: 11_000 }]

  it('puts the segments back to back', () => {
    const starts = nominalStarts(segs)
    expect(starts).toEqual([0, 2_000])
    expect(toReelMs(segs, starts, 1_500)).toBe(500)
    expect(toReelMs(segs, starts, 10_250)).toBe(2_250)
    expect(toReelMs(segs, starts, 5_000)).toBeNull()
  })

  it('places the skeleton on the reel, in order, inside each recording\'s box', () => {
    const log: PoseLog = {
      t: [500, 1_500, 2_000, 5_000, 10_500],
      lm: [packPose([{ x: 0.1, y: 0.1, z: 0, visibility: 1 }]), packPose([{ x: 0.5, y: 0.25, z: 0, visibility: 0.9 }]), null,
        packPose([{ x: 0.3, y: 0.3, z: 0, visibility: 1 }]), packPose([{ x: 1, y: 1, z: 0, visibility: 1 }])],
    }
    const box = fitBox(720, 1280, 1280, 720) // an upright phone recording in a landscape reel
    const track = reelTrack(log, { segments: segs, starts: [0, 2_100], durationMs: 3_100 }, [box])
    expect(track.t).toEqual([500, 1_000, 2_600])
    expect(track.lm[1]).toBeNull()
    expect(track.lm[0]![0].x).toBeCloseTo(box.x + 0.5 * box.w, 5)
    expect(track.lm[0]![0].y).toBeCloseTo(0.25, 5)
    expect(track.lm[0]![0].visibility).toBeCloseTo(0.9, 5)
    expect(track.lm[2]![0].x).toBeCloseTo(box.x + box.w, 5)
  })

  it('packs a pose to within a millionth (float32)', () => {
    const lm = [{ x: 0.25, y: 0.75, z: 0, visibility: 0.5 }, { x: 0.1, y: 0.9, z: 0, visibility: 1 }]
    const back = unpackPose(packPose(lm))
    expect(back).toHaveLength(2)
    back.forEach((p, i) => {
      expect(p.x).toBeCloseTo(lm[i].x, 6)
      expect(p.y).toBeCloseTo(lm[i].y, 6)
      expect(p.visibility).toBeCloseTo(lm[i].visibility, 6)
    })
  })
})

describe('live session report', () => {
  const ev = (move: MoveEvent['move'], startMs: number, endMs: number): MoveEvent => ({
    move, tMs: endMs, startMs, endMs, detail: '', metrics: {}, log: '', source: {},
  })

  it('without a recording, times run from the start of the session', () => {
    const r = liveReport([ev('jump', 10_000, 10_500)], { startMs: 4_000, endMs: 64_000 }, null)
    expect(r.source).toBe('live')
    expect(r.session_s).toBe(60)
    expect(r.duration_s).toBe(60)
    expect(r.moves[0].start_s).toBe(6)
  })

  it('with a reel, every move is placed on the reel, so the results page plays it', () => {
    const segments = highlightSegments([move(10_000, 10_500), move(30_000, 30_400)], ONE)
    const starts = nominalStarts(segments)
    const r = liveReport([ev('jump', 10_000, 10_500), ev('jump', 30_000, 30_400)], { startMs: 0, endMs: 60_000 },
      { segments, starts, durationMs: 5_000 })
    expect(r.duration_s).toBe(5)
    expect(r.session_s).toBe(60)
    expect(r.moves.map((m) => m.start_s)).toEqual([LEAD_MS / 1000, (2_600 + LEAD_MS) / 1000])
  })

  it('reports real footage the way an upload of it is reported', () => {
    // The same engine output either way: a live session over this clip, recorded from its first
    // frame, lists the same moves and the same feedback as the upload report does.
    const [fx] = loadFolder('pirouettes')
    if (!fx) return
    const { events } = replay(fx)
    const first = fx.frames[0].t
    const last = fx.frames[fx.frames.length - 1].t
    const segments = highlightSegments(events, [{ startMs: first, endMs: last }])
    const live = liveReport(events, { startMs: first, endMs: last }, { segments, starts: nominalStarts(segments), durationMs: 1 })
    expect(live.moves.map((m) => [m.move, m.feedback.kind])).toEqual(events.map((e) => [e.move, expect.any(String)]))
    expect(live.counts).toEqual(Object.fromEntries(Object.entries(
      events.reduce<Record<string, number>>((c, e) => ({ ...c, [e.move]: (c[e.move] ?? 0) + 1 }), {}))))
  })
})
