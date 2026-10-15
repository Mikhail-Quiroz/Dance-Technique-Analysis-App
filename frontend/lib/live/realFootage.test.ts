// Real footage, replayed through the MoveEngine /live runs. Every clip under
// fixtures/real/<folder>/ is a rep (or a series) of one move, filmed on a laptop webcam and
// extracted with the lite model /live uses (scripts/extract_live_fixtures.py). The answer key is
// realFootageExpect.ts, from the dancer who filmed them: which move, and for turns how many
// rotations. The walk to and from the camera at either end of every clip is part of the test -
// nothing in it may be counted.
//
// Add clips by dropping videos into videos/reference/<folder>/, re-running the extractor and,
// for a new folder, adding it to FOLDER_EXPECT.
import { beforeEach, describe, expect, it } from 'vitest'
import { FIXTURE_SETS, decimate, loadFolder, replay, truncate, type Fixture, type FixtureSet } from './replay'
import { BLIND_KEY, BLIND_SCORE, FOLDER_EXPECT, KNOWN, clipNumber, expectedFor, type FolderExpectation } from './realFootageExpect'
import type { MoveEvent } from './moveEngine'
import { angleAt3 } from './geometry'
import { scoreMetric, selectFeedback } from './scoring'
import thresholds from './shared/thresholds.json'

// Minutes of synchronous replays: yielding to the event loop before each test lets vitest's worker
// answer its own progress calls, which otherwise time out after 60 s ("Timeout calling onTaskUpdate").
beforeEach(() => new Promise<void>((resolve) => setImmediate(resolve)))

/** Everything wrong with one clip's result, or [] if it matches the answer key. */
function problems(ex: FolderExpectation, name: string, events: MoveEvent[], tolerance: number): string[] {
  const out: string[] = []
  const moves = events.map((e) => e.move)
  const main = events.filter((e) => e.move === ex.move)
  if (!main.length) return [`no ${ex.move} (got [${moves.join(', ')}])`]
  if (!ex.series && main.length !== 1) out.push(`${main.length} × ${ex.move}`)
  const first = moves.indexOf(ex.move)
  const last = moves.lastIndexOf(ex.move)
  moves.forEach((m, i) => {
    if (m === ex.move) return
    if (i < first && ex.allowBefore?.includes(m)) return
    if (i > last && ex.allowAfter?.includes(m)) return
    out.push(`unexpected ${m}`)
  })
  const n = clipNumber(name)
  if (ex.rotations) {
    const want = ex.rotations[n - 1]
    if (Math.abs((main[0].count ?? 0) - want) > tolerance) out.push(`${main[0].count} rotations, expected ${want}`)
  }
  if (ex.secondeTurns) {
    const t = main[0].source.turn!
    const want = ex.secondeTurns[n - 1]
    if (Math.abs((t.secondeTurns ?? 0) - want) > tolerance) out.push(`${t.secondeTurns} second turns, expected ${want}`)
    const finishOk = ex.finishTurns!.some((f) => Math.abs((t.finishTurns ?? -9) - f) <= tolerance)
    if (!finishOk) out.push(`${t.finishTurns} finishing pirouettes, expected ${ex.finishTurns!.join(' or ')}`)
  }
  if (ex.floaters !== undefined) {
    const had = (main[0].source.turn?.floaters ?? 0) > 0
    if (had !== ex.floaters) out.push(ex.floaters ? 'no floaters' : 'floaters where there were none')
  }
  return out
}

// Identification is tested on three readings of the same frames: the Python fixtures the critiques
// were checked against, and the browser's own MediaPipe on the CPU (what an upload runs) and on the
// GPU (what /live runs) - see FIXTURE_SETS. The browser sets differ by about half a percent of the
// frame, enough to tip a detector sitting on a threshold, so they are what keeps the detectors
// honest about the runtime users actually have. Known misses are listed in realFootageExpect.ts.
//
for (const [set, root] of Object.entries(FIXTURE_SETS) as Array<[FixtureSet, string]>) {
  for (const [folder, ex] of Object.entries(FOLDER_EXPECT)) {
    const clips = loadFolder(folder, root)
    describe.skipIf(clips.length === 0)(`real footage (${set}) — ${folder}`, () => {
      for (const clip of clips) {
        const known = KNOWN[`${set} ${folder}/${clip.name}`]
        ;(known ? it.fails : it)(`${clip.name}: identified, counted, nothing else${known ? ` (known miss: ${known})` : ''}`, () => {
          expect(problems(expectedFor(ex, clip.name), clip.name, replay(clip).events, 0)).toEqual([])
        })
      }

      // The same clips as a 15 fps webcam would deliver them. Identification must hold; a count may
      // be off by one where the slower capture loses part of a turn (a five-turn pirouette whose
      // first turn the tracker garbled reads four at 15 fps).
      for (const clip of clips.filter((c) => c.fps >= 20)) {
        const known = KNOWN[`${set} ${folder}/${clip.name} @15fps`]
        ;(known ? it.fails : it)(`${clip.name} at 15 fps${known ? ` (known miss: ${known})` : ''}`, () => {
          const half = decimate(clip, 2)
          expect(problems(expectedFor(ex, half.name), half.name, replay(half).events, 1)).toEqual([])
        })
      }

      // An uploaded video is often trimmed tight. Cut 0.6 s after the move, the clip still counts it
      // (the end of the clip is flushed, as the upload page does). Jumps and turns need about that
      // long after the move to be decided by their detectors; a chaîné needed 1.5 s and an
      // arabesque up to 0.6 s before the flush.
      if (set === 'python') {
        const found = clips.filter((c) => !KNOWN[`python ${folder}/${c.name}`])
        it.each(found.map((c) => [c.name, c] as [string, Fixture]))('%s trimmed 0.6 s after the move', (_n, clip) => {
          const { move } = expectedFor(ex, clip.name)
          const main = replay(clip).events.find((e) => e.move === move)!
          const cut = truncate(clip, main.endMs + 600)
          expect(replay(cut).events.filter((e) => e.move === move).length, cut.name).toBe(1)
        })
      }
    })
  }
}

// The blind test: each video's moves against the key, in order. Longest common subsequence: the moves
// the app named in the order they were danced, and whatever it added besides.
function inOrder(key: readonly string[], got: readonly string[]): number {
  const dp = Array.from({ length: key.length + 1 }, () => new Array<number>(got.length + 1).fill(0))
  for (let i = 1; i <= key.length; i++) {
    for (let j = 1; j <= got.length; j++) {
      dp[i][j] = key[i - 1] === got[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[key.length][got.length]
}

for (const [set, root] of Object.entries(FIXTURE_SETS) as Array<[FixtureSet, string]>) {
  const videos = loadFolder('blind', root)
  describe.skipIf(videos.length === 0)(`blind test (${set})`, () => {
    for (const fx of videos) {
      const key = BLIND_KEY[fx.name]
      const want = BLIND_SCORE[`${set} ${fx.name}`] ?? { named: key.length, extra: 0, why: '' }
      it(`${fx.name}: ${want.named} of ${key.length} named in order, ${want.extra} added${want.why ? ` (${want.why})` : ''}`, () => {
        const got = replay(fx).events.map((e) => e.move)
        const named = inOrder(key, got)
        expect({ named, extra: got.length - named }, got.join(', ')).toEqual({ named: want.named, extra: want.extra })
      })
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Critiques that were checked against the footage itself.
// ---------------------------------------------------------------------------------------------

// Each clip is replayed once for all the critique checks below.
const replayed = new Map<string, MoveEvent[]>()
const eventsOf = (folder: string, clip: Fixture): MoveEvent[] => {
  const key = `${folder}/${clip.name}`
  if (!replayed.has(key)) replayed.set(key, replay(clip).events)
  return replayed.get(key)!
}
const mainEvent = (folder: string, n: number): MoveEvent => {
  const clip = loadFolder(folder).find((c) => clipNumber(c.name) === n)!
  return eventsOf(folder, clip).find((e) => e.move === expectedFor(FOLDER_EXPECT[folder], clip.name).move)!
}
const cues = (ev: MoveEvent): string[] => {
  const fb = selectFeedback(ev.metrics)
  return fb.kind === 'correction' ? [fb.cueId, ...fb.also.map((a) => a.cueId)] : [fb.kind]
}

describe.skipIf(loadFolder('pirouettes').length === 0)('real footage — critiques match what the video shows', () => {
  it('clean right-side pirouettes are praised, not corrected', () => {
    // The supporting foot stays down, the passé is at the knee and the axis is upright on the
    // footage of these four.
    for (const n of [2, 3, 4, 5]) expect(cues(mainEvent('pirouettes', n)), `pirouette ${n}`).toEqual(['praise'])
  })

  it('a connected passé is not told to connect', () => {
    // The working toe sits at the supporting knee in every front-facing frame of these clips.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(cues(mainEvent('pirouettes', n)), `pirouette ${n}`).not.toContain('connect_passe')
    }
  })

  it('chaînés: arms may open and close; none of these opens past second', () => {
    // Clip 3 keeps them in first; the rest open to second and close again, which is correct.
    for (let n = 1; n <= 10; n++) {
      expect(cues(mainEvent('chaine turns', n)), `chaîné ${n}`).not.toContain('chaine_dont_overopen')
    }
    expect(cues(mainEvent('chaine turns', 3))).toEqual(['praise'])
  })

  it('the two lower arabesques are told to lift the leg, the high ones are not', () => {
    for (const n of [9, 10]) expect(cues(mainEvent('arabesque', n)), `arabesque ${n}`).toContain('lift_arabesque_leg')
    for (const n of [1, 2, 3, 4, 7, 8]) expect(cues(mainEvent('arabesque', n)), `arabesque ${n}`).not.toContain('lift_arabesque_leg')
  })

  it('à la seconde: the leg below hip height is the correction, every time', () => {
    // On the footage the working leg sits at about 60-70 degrees, under hip height.
    for (let n = 1; n <= 10; n++) {
      expect(cues(mainEvent('a la seconde turns', n)), `à la seconde ${n}`).toContain('maintain_seconde_height')
    }
  })

  it('russians with visibly straight legs are not told to straighten them', () => {
    // A blurred leg puts a knee landmark at the hip in front-on straddles (russians 7 and 9);
    // knee straightness is not critiqued for the russian at all.
    for (let n = 1; n <= 10; n++) {
      expect(Object.keys(mainEvent('russian', n).metrics), `russian ${n}`).not.toContain('russian_knees')
    }
  })

  it('no live critique rests on a metric the footage showed to be unmeasurable', () => {
    const banned = ['releve_angle', 'spot_follow', 'retire_connection', 'arabesque_releve', 'arabesque_line', 'turn_hops',
      // The toe landmark sits on the ankle of a pointed jazz shoe; a turning body hides the hips;
      // a front-on chest pitch is depth.
      'point_feet', 'leap_point_feet', 'arabesque_point', 'calypso_hips', 'russian_chest']
    for (const folder of Object.keys(FOLDER_EXPECT)) {
      for (const clip of loadFolder(folder)) {
        for (const ev of eventsOf(folder, clip)) {
          for (const k of banned) expect(ev.metrics, `${clip.name} ${ev.move}`).not.toHaveProperty(k)
        }
      }
    }
  }, 120_000)
})

// A straight leg standing still is the calibration for every knee-extension threshold. On this
// camera and model it reads 155-172 degrees (median 162), NOT 175+: the old bar of 175 for full
// marks told every dancer to "straighten your standing leg" on a leg that was already straight.
describe.skipIf(loadFolder('split_leap').length === 0)('real footage — a straight leg reads as straight', () => {
  it('standing-still knees never trigger a straighten-the-leg cue', () => {
    const knees: number[] = []
    for (const fx of [...loadFolder('split_leap'), ...loadFolder('straight_jump')]) {
      const fr = fx.frames.filter((f) => f.lm && f.world)
      for (let i = 3; i < fr.length - 3; i++) {
        const torso = Math.abs(fr[i].lm![11].y - fr[i].lm![23].y)
        const still = [23, 24, 27, 28].every((id) => {
          const pts = [-3, -2, -1, 0, 1, 2, 3].map((d) => fr[i + d].lm![id])
          const dx = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x))
          const dy = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y))
          return Math.hypot(dx, dy) <= 0.06 * torso
        })
        if (!still || ![23, 24, 25, 26, 27, 28].every((id) => (fr[i].lm![id].visibility ?? 0) > 0.5)) continue
        const w = fr[i].world!
        knees.push(angleAt3(w[25], w[23], w[27]), angleAt3(w[26], w[24], w[28]))
      }
    }
    expect(knees.length).toBeGreaterThan(30)
    knees.sort((a, b) => a - b)
    const p10 = knees[Math.floor(0.1 * (knees.length - 1))]
    // 9 in 10 straight-leg readings must score as needing no correction.
    for (const key of ['support_knee_ext', 'arabesque_knee_ext', 'front_leg_ext', 'back_leg_ext', 'seconde_leg_knee', 'calypso_front_ext'] as const) {
      const c = (thresholds.score_config as Record<string, { excellent: number; poor: number; invert: boolean }>)[key]
      expect(scoreMetric(p10, c.excellent, c.poor, c.invert), key).toBeGreaterThanOrEqual(80)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Each of these was checked frame by frame against the clip it names.
// ---------------------------------------------------------------------------------------------

const cuesOf = (folder: string, n: number) => cues(mainEvent(folder, n))

describe.skipIf(loadFolder('split_leap').length === 0 || loadFolder('switch leap').length === 0)('real footage — leap critiques name the right leg', () => {
  it('split leaps whose back leg was at or above the hips are not told to lift it', () => {
    // The front leg (on the side the dancer faces) was the lower one in these.
    for (const n of [2, 3, 6, 8, 9, 10]) expect(cuesOf('split_leap', n), `split leap ${n}`).not.toContain('level_the_leap')
  })

  it('switch leaps are judged at the full split, after the switch - where the back leg is level', () => {
    // The split before the switch has the back leg hanging straight down by design, and the
    // full split opens on the fastest, blurriest frames. Read a frame early, all ten were told
    // their back leg had dropped; at the full split it sat within 13 degrees of level on each.
    for (let n = 1; n <= 10; n++) expect(cuesOf('switch leap', n), `switch leap ${n}`).not.toContain('level_the_leap')
  })

  it('knees are not judged off one smeared 15 fps frame', () => {
    for (let n = 1; n <= 10; n++) {
      expect(cuesOf('split_leap', n), `split leap ${n}`).not.toContain('straighten_front_leg')
      expect(cuesOf('split_leap', n), `split leap ${n}`).not.toContain('straighten_back_leg')
    }
  })

  it('a split leap whose legs the blur scrambled is not praised', () => {
    for (const n of [4, 5, 7]) expect(cuesOf('split_leap', n), `split leap ${n}`).toEqual(['unassessable'])
  })
})

describe.skipIf(loadFolder('calypso').length === 0)('real footage — calypso', () => {
  it('a back knee riding below the foot is told to lift', () => {
    for (const n of [2, 8]) expect(cuesOf('calypso', n), `calypso ${n}`).toContain('calypso_lift_knee')
  })

  it('the one calypso with no arch is encouraged to add it, the arched ones are not', () => {
    expect(cuesOf('calypso', 6)).toContain('calypso_arch')
    for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 10]) expect(cuesOf('calypso', n), `calypso ${n}`).not.toContain('calypso_arch')
  })

  it('front legs straight on the footage are never told to straighten', () => {
    for (let n = 1; n <= 10; n++) expect(cuesOf('calypso', n), `calypso ${n}`).not.toContain('calypso_straighten_front')
  })
})

describe.skipIf(loadFolder('russian').length === 0)('real footage — russian', () => {
  it('a lopsided straddle is told to even the legs; level ones are not', () => {
    for (const n of [1, 8]) expect(cuesOf('russian', n), `russian ${n}`).toContain('russian_even_legs')
    for (const n of [2, 3, 4, 5, 6, 9, 10]) expect(cuesOf('russian', n), `russian ${n}`).not.toContain('russian_even_legs')
  })

  it('wide, level straddles are praised', () => {
    for (const n of [2, 4, 5, 6, 10]) expect(cuesOf('russian', n), `russian ${n}`).toEqual(['praise'])
  })
})

describe.skipIf(loadFolder('pique turns').length === 0)('real footage — turns', () => {
  it('a standing leg hidden behind the passé is not told to straighten', () => {
    // Every piqué on the left leg used to be; the video shows all ten standing legs straight.
    for (let n = 1; n <= 10; n++) expect(cuesOf('pique turns', n), `piqué ${n}`).not.toContain('straighten_standing_leg')
  })

  it('hips the footage shows level are not told to level', () => {
    for (let n = 1; n <= 10; n++) expect(cuesOf('pirouettes', n), `pirouette ${n}`).not.toContain('level_hips')
  })

  it('à la seconde legs straight on the footage are not told to extend', () => {
    for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 10]) expect(cuesOf('a la seconde turns', n), `à la seconde ${n}`).not.toContain('extend_seconde_leg')
  })

  it('the sequence that drifts a torso-length across the floor is told to stay in place', () => {
    expect(cuesOf('a la seconde turns', 9)).toContain('seconde_stay_in_place')
  })
})

describe.skipIf(loadFolder('High Quality - Fan Kick').length === 0)('real footage — fan kicks (iPhone)', () => {
  it('a fan kick that drops flat after the top is told to finish the circle; round ones are not', () => {
    // On the footage, the right-leg fans in 9, 11 and 12 go up round and fall straight down; the
    // left-leg fans in 1, 2, 6, 10 and 13 come down the far side at full reach.
    for (const n of [9, 11, 12]) expect(cuesOf('High Quality - Fan Kick', n), `fan kick ${n}`).toContain('fan_full_circle')
    for (const n of [1, 2, 6, 10, 13]) expect(cuesOf('High Quality - Fan Kick', n), `fan kick ${n}`).not.toContain('fan_full_circle')
  })
})

describe.skipIf(loadFolder('High Quality - Switch Arabesque').length === 0)('real footage — switch arabesques (iPhone)', () => {
  it('a bent back knee in the air is told to straighten; straight ones are not', () => {
    // At the top of the flight the back leg is bent in 1 and 2 and straight in 3, 6 and 7.
    for (const n of [1, 2]) expect(cuesOf('High Quality - Switch Arabesque', n), `switch arabesque ${n}`).toContain('arabesque_leap_straight_back')
    for (const n of [3, 6, 7]) expect(cuesOf('High Quality - Switch Arabesque', n), `switch arabesque ${n}`).not.toContain('arabesque_leap_straight_back')
  })
})

describe.skipIf(loadFolder('arabesque').length === 0)('real footage — arabesque', () => {
  it('straight working legs are not told to straighten', () => {
    for (const n of [1, 2, 3, 4, 6, 8, 9]) expect(cuesOf('arabesque', n), `arabesque ${n}`).not.toContain('straighten_arabesque_leg')
  })

  it('the two chests pitched forward over the leg are told to lift', () => {
    for (const n of [5, 7]) expect(cuesOf('arabesque', n), `arabesque ${n}`).toContain('lift_chest')
  })
})


describe('real footage — russians are judged at webcam frame rates', () => {
  // A russian's straddle tops out for about 150-250 ms. /live delivers 15-23 fps, and on a webcam
  // the legs at the top are heavily blurred, so the straddle must be judged from what few frames
  // there are (see straddleMinFrames): a three-frame rule left 9 of 30 unjudged at 15 fps, and the
  // dancer was told too little of them was visible.
  const every = (fx: Fixture, k: number): Fixture => ({ ...fx, fps: (fx.fps * (k - 1)) / k, frames: fx.frames.filter((_, i) => i % k !== k - 1) })
  for (const [set, root] of Object.entries(FIXTURE_SETS) as Array<[FixtureSet, string]>) {
    const clips = loadFolder('russian', root)
    it.skipIf(clips.length === 0)(`${set}: every russian is judged at 20 fps, all but one at 15`, () => {
      const unjudged = (fxs: Fixture[]) => fxs.filter((fx) => {
        const ev = replay(fx).events.find((e) => e.move === 'russian')
        return !ev || selectFeedback(ev.metrics).kind === 'unassessable'
      }).map((fx) => fx.name)
      expect(unjudged(clips.map((c) => every(c, 3)))).toEqual([])
      expect(unjudged(clips.map((c) => decimate(c, 2))).length).toBeLessThanOrEqual(1)
    })
  }
})

describe('real footage — a phone held upright sees the same moves', () => {
  // Phones film upright: a 3:4 or 9:16 frame, where the dancer spans far more of the width. The
  // engine re-expresses every frame in the 16:9 units its thresholds were tuned in (MoveEngine's
  // REFERENCE_ASPECT), so the very same frames described as an upright crop - centred, or with the
  // dancer off to one side - must give the same moves and the same feedback. Before, 4 clips changed
  // answer as 3:4 crops (a switch leap read as a russian, a split leap went missing), and a turn's
  // travel depended on where in the frame the dancer stood.
  const crop = (fx: Fixture, width: number, left: number): Fixture => ({
    ...fx,
    size: [width, 720],
    frames: fx.frames.map((f) => ({ ...f, lm: f.lm ? f.lm.map((p) => ({ ...p, x: (p.x * 1280 - left) / width })) : null })),
  })
  const verdicts = (fx: Fixture) => replay(fx).events.map((e) => {
    const fb = selectFeedback(e.metrics)
    return `${e.move}: ${'cueId' in fb ? fb.cueId : fb.kind}`
  })
  // One test per folder: all of them in one ran past the 30 s limit once the iPhone clips came in.
  // The crops are in 1280x720 units, which suits any 16:9 fixture (the 1080p iPhone clips too).
  // Clips filmed upright already are what this simulates, so they are left out.
  const landscape16x9 = (fx: Fixture) => !fx.size || Math.abs(fx.size[0] / fx.size[1] - 16 / 9) < 0.01
  for (const [set, root] of Object.entries(FIXTURE_SETS) as Array<[FixtureSet, string]>) {
    for (const folder of Object.keys(FOLDER_EXPECT)) {
      const clips = loadFolder(folder, root).filter(landscape16x9)
      it.skipIf(clips.length === 0)(`${set} ${folder}: 3:4 and 9:16 crops, centred or off to one side`, () => {
        for (const fx of clips) {
          const landscape = verdicts({ ...fx, size: [1280, 720] })
          for (const [width, left] of [[540, 370], [405, 437.5], [540, 120]] as const) {
            expect(verdicts(crop(fx, width, left)), `${folder}/${fx.name} as ${width}x720 from x=${left}`).toEqual(landscape)
          }
        }
      })
    }
  }
})
