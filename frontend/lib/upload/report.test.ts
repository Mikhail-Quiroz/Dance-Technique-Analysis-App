import { describe, expect, it } from 'vitest'
import { loadFolder, replay } from '../live/replay'
import { FOLDER_EXPECT, KNOWN } from '../live/realFootageExpect'
import { selectFeedback } from '../live/scoring'
import type { MoveEvent } from '../live/moveEngine'
import { buildReport, feedbackFor, formatTime, normalizeReport } from './report'
import { decodeTrack, encodeTrack, poseAt, type PoseTrack } from './poseTrack'

const ev = (over: Partial<MoveEvent>): MoveEvent => ({
  move: 'split', tMs: 0, startMs: 1000, endMs: 1500, detail: '500 ms airtime', metrics: {}, log: '', source: {}, ...over,
})

describe('upload report', () => {
  it('an empty clip reports no moves and no score', () => {
    const r = buildReport([], 12_340)
    expect(r).toMatchObject({ version: 2, duration_s: 12.3, overall_score: null, no_moves_detected: true, moves: [], focus: null })
  })

  it('a move gets exactly the feedback /live gives it', () => {
    const metrics = { split_angle: 120, front_leg_ext: 175, back_leg_ext: 172, torso_uprightness: 10, land_plie: 120, leap_back_leg_drop: 5 }
    const r = buildReport([ev({ metrics })], 3000)
    expect(r.moves[0].feedback).toEqual(selectFeedback(metrics))
    expect(r.moves[0].label).toBe('Split leap')
    expect(r.moves[0].family).toBe('leap')
  })

  it('moves counted but not critiqued carry no score', () => {
    const r = buildReport([ev({ move: 'jump' }), ev({ move: 'turnUnsure', startMs: 3000, endMs: 4000 })], 5000)
    expect(r.moves.map((m) => m.score)).toEqual([null, null])
    expect(r.moves.map((m) => m.feedback.kind)).toEqual(['fixed', 'fixed'])
    expect(r.overall_score).toBeNull()
    expect(r.no_moves_detected).toBe(false)
  })

  it('moves are listed in the order they happened, whenever the engine decided them', () => {
    const r = buildReport([ev({ move: 'chaine', startMs: 5000, endMs: 7000 }), ev({ move: 'arabesque', startMs: 1000, endMs: 2000 })], 8000)
    expect(r.moves.map((m) => m.move)).toEqual(['arabesque', 'chaine'])
    expect(r.counts).toEqual({ arabesque: 1, chaine: 1 })
  })

  it('the focus is the most fundamental correction, with how often it came up', () => {
    // Two leaps with a low split, one with a bent front knee.
    const low = { split_angle: 100, front_leg_ext: 178, back_leg_ext: 178, torso_uprightness: 5, land_plie: 120, leap_back_leg_drop: 5 }
    const r = buildReport([ev({ metrics: low }), ev({ metrics: low, startMs: 4000, endMs: 4500 })], 6000)
    expect(r.focus?.times).toBe(2)
    expect(r.focus?.label).toBe('Split leap')
    expect(r.focus?.at_s).toBe(1)
    expect(r.focus?.cue).toBe((selectFeedback(low) as { cue: string }).cue)
  })
})

describe('upload report on real footage', () => {
  // Every reference clip, analyzed as an upload is: the report names the move the dancer did
  // (known misses aside).
  for (const [folder, ex] of Object.entries(FOLDER_EXPECT)) {
    const clips = loadFolder(folder).filter((c) => !KNOWN[`python ${folder}/${c.name}`])
    it.skipIf(clips.length === 0)(`${folder}: the report names the move, with /live's feedback`, () => {
      for (const clip of clips) {
        const { events } = replay(clip)
        const r = buildReport(events, clip.frames[clip.frames.length - 1].t)
        const main = r.moves.filter((m) => m.move === ex.move)
        expect(main.length, clip.name).toBeGreaterThan(0)
        for (const m of r.moves) expect(m.feedback, `${clip.name} ${m.label}`).toEqual(feedbackFor({ move: m.move!, metrics: m.metrics }))
        if (ex.move === 'jump') expect(main[0].score, clip.name).toBeNull()
        else expect(r.overall_score, clip.name).not.toBeNull()
      }
    })
  }
})

describe('pose track', () => {
  const clip = loadFolder('split_leap')[0]
  it.skipIf(!clip)('survives encoding to within the stored precision', () => {
    const track: PoseTrack = { t: clip.frames.map((f) => f.t), lm: clip.frames.map((f) => f.lm) }
    const back = decodeTrack(JSON.parse(JSON.stringify(encodeTrack(track))))
    expect(back.t).toEqual(track.t.map((t) => Math.round(t)))
    track.lm.forEach((pts, i) => {
      if (!pts) return expect(back.lm[i]).toBeNull()
      pts.forEach((p, j) => {
        expect(Math.abs(back.lm[i]![j].x - p.x)).toBeLessThan(0.0011)
        expect(Math.abs(back.lm[i]![j].y - p.y)).toBeLessThan(0.0011)
      })
    })
  })

  it('poseAt finds the frame on screen', () => {
    const p = [{ x: 0.5, y: 0.5, z: 0, visibility: 1 }]
    const track: PoseTrack = { t: [0, 33, 67, 100], lm: [p, null, p, p] }
    expect(poseAt(track, 50)).toBeNull()
    expect(poseAt(track, 70)).toBe(p)
    expect(poseAt(track, 400)).toBeNull()
  })
})

describe('old pipeline sessions', () => {
  it('are read into the same shape', () => {
    const legacy = {
      overall_score: 64,
      strongest_area: 'Relevé height',
      focus_area: 'Spot — Turn pirouette (0:12)',
      no_moves_detected: false,
      moves: [
        { move_type: 'Turn pirouette', timestamp: '0:12', overall_score: 58, top_cues: [{ cue_id: 'spot', cue: 'Spot', why: 'w', drill: 'd', score: 40 }], scores: { spot_follow: 40 }, raw_metrics: { spot_follow: 0.3, accuracy_note: 'x' } },
        { move_type: 'jump', timestamp: '1:05', overall_score: 90, top_cues: [], scores: {}, raw_metrics: {} },
      ],
    }
    const r = normalizeReport(legacy)!
    expect(r.legacy).toBe(true)
    expect(r.overall_score).toBe(64)
    expect(r.moves.map((m) => [m.label, m.family, m.start_s, m.feedback.kind])).toEqual([
      ['Turn pirouette', 'turn', 12, 'correction'],
      ['jump', 'leap', 65, 'unassessable'],
    ])
    expect(r.moves[0].metrics).toEqual({ spot_follow: 0.3 })
    expect(r.focus?.cue).toBe('Spot — Turn pirouette (0:12)')
  })

  it('a version 2 report passes through, and junk is rejected', () => {
    const r = buildReport([], 1000)
    expect(normalizeReport(r)).toBe(r)
    expect(normalizeReport(null)).toBeNull()
    expect(normalizeReport({ hello: 1 })).toBeNull()
  })

  it('a report saved while kicks had their own family reads them as balances & kicks', () => {
    const r = buildReport([], 1000)
    const old = { ...r, moves: [{ ...r.moves[0], label: 'Fan kick', move: 'fanKick', family: 'kick' }] }
    expect(normalizeReport(old)?.moves[0].family).toBe('hold')
  })

  it('formats times as m:ss', () => {
    expect(formatTime(65.4)).toBe('1:05')
    expect(formatTime(0)).toBe('0:00')
  })
})
