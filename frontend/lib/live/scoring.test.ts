import { describe, expect, it } from 'vitest'
import { scoreMetric, selectTopCue, selectFeedback } from './scoring'
import thresholds from './shared/thresholds.json'

describe('scoreMetric', () => {
  it('at/above excellent scores 100 (not inverted)', () => {
    expect(scoreMetric(180, 168, 150, false)).toBe(100)
  })

  it('at/below poor scores 0 (not inverted)', () => {
    expect(scoreMetric(140, 168, 150, false)).toBe(0)
  })

  it('interpolates linearly (not inverted)', () => {
    expect(scoreMetric(159, 168, 150, false)).toBe(50)
  })

  it('at/below poor scores 100 (inverted)', () => {
    expect(scoreMetric(10, 12, 30, true)).toBe(100)
  })

  it('at/above excellent scores 0 (inverted)', () => {
    expect(scoreMetric(40, 12, 30, true)).toBe(0)
  })

  it('interpolates linearly (inverted)', () => {
    expect(scoreMetric(21, 12, 30, true)).toBe(50)
  })
})

describe('selectTopCue', () => {
  it('returns null when nothing needs improvement', () => {
    expect(selectTopCue({})).toBeNull()
  })

  it('surfaces the cue for a clearly poor metric', () => {
    // front_leg_ext: excellent 168, poor 150, invert false -> 140 scores 0
    const top = selectTopCue({ front_leg_ext: 140 })
    expect(top).not.toBeNull()
    expect(top!.cueId).toBe('straighten_front_leg')
    expect(top!.cue.length).toBeGreaterThan(0)
  })

  it('ignores metrics that already score well', () => {
    expect(selectTopCue({ front_leg_ext: 170 })).toBeNull()
  })

  it('picks the higher cue_priority tier when two metrics are both poor', () => {
    // land_through_plie (from land_plie) sits ahead of straighten_front_leg in cue_priority
    const top = selectTopCue({ front_leg_ext: 140, land_plie: 175 })
    expect(top!.cueId).toBe('land_through_plie')
  })
})

describe('selectFeedback', () => {
  /** A leap where every measured metric sits comfortably inside its target range. */
  const CLEAN_LEAP = {
    front_leg_ext: 178,
    back_leg_ext: 176,
    point_feet: 175,
    split_angle: 170,
    torso_uprightness: 4,
    back_leg_height: 0.10,
    land_plie: 130,
  }

  it('returns praise when every threshold is cleared comfortably', () => {
    const fb = selectFeedback(CLEAN_LEAP)
    expect(fb.kind).toBe('praise')
    if (fb.kind !== 'praise') return
    expect(fb.cue.length).toBeGreaterThan(0)
    expect(fb.score).toBeGreaterThanOrEqual(80)
    expect(fb.bestMetric).toBeTruthy()
  })

  it('praise names the metric the dancer scored best on', () => {
    // Every metric passes, but only the landing is perfect — the rest sit in the high
    // 80s/90s, just inside their target range. Praise should be about the landing.
    const fb = selectFeedback({
      front_leg_ext: 167,        // 96
      back_leg_ext: 164,         // 92
      point_feet: 158,           // 92
      split_angle: 155,          // 90
      torso_uprightness: 13,     // 94
      back_leg_height: -0.01,    // 96
      land_plie: 100,            // 100 — comfortably past 'excellent'
    })
    expect(fb.kind).toBe('praise')
    if (fb.kind !== 'praise') return
    expect(fb.bestMetric).toBe('land_plie')
    expect(fb.cueId).toBe('praise_landing')
  })

  it('returns a correction when any metric falls short', () => {
    const fb = selectFeedback({ ...CLEAN_LEAP, land_plie: 179 })
    expect(fb.kind).toBe('correction')
    if (fb.kind !== 'correction') return
    expect(fb.cueId).toBe('land_through_plie')
  })

  it('distinguishes "nothing to correct" from "nothing measurable"', () => {
    expect(selectFeedback({}).kind).toBe('unassessable')
    expect(selectFeedback({ front_leg_ext: null, land_plie: null }).kind).toBe('unassessable')
    // Both used to collapse to null and render as praise.
    expect(selectTopCue({})).toBeNull()
    expect(selectTopCue(CLEAN_LEAP)).toBeNull()
  })

  it('praises a clean arabesque using the arabesque metrics', () => {
    const fb = selectFeedback({
      arabesque_height: 85,
      arabesque_knee_ext: 179,
      support_knee_ext: 179,
      arabesque_tilt: 3,
      hold_duration_s: 3.0,
    })
    expect(fb.kind).toBe('praise')
  })

  it('every metric in metric_to_praise resolves to real praise text', () => {
    // Feed each praise-mapped metric its "excellent" value on its own, so it is both the
    // only metric present and the best one. Catches a dangling cue id in the shared JSON.
    const scoreConfig = thresholds.score_config as Record<string, { excellent: number }>
    const map = thresholds.metric_to_praise as Record<string, string>
    for (const metric of Object.keys(map)) {
      const cfg = scoreConfig[metric]
      expect(cfg, `${metric} has no score_config`).toBeTruthy()
      const fb = selectFeedback({ [metric]: cfg.excellent })
      expect(fb.kind, metric).toBe('praise')
      if (fb.kind !== 'praise') continue
      expect(fb.cueId, metric).toBe(map[metric])
      expect(fb.cue, metric).toBeTruthy()
      expect(fb.why, metric).toBeTruthy()
      expect(fb.drill, metric).toBeTruthy()
    }
  })
})

describe('selectFeedback — praise cannot be bought by hiding a metric', () => {
  it('refuses praise when a metric was offered but could not be measured', () => {
    // The regression: with the legs closed, one knee occludes the other, that leg's
    // extension drops to null, and only the straight leg is left — so a badly bent
    // pair of legs was praised for its "fully extended" line. A null metric is
    // skipped when scoring, so anything unmeasurable cannot count against the rep.
    const withHiddenKnee = {
      front_leg_ext: null,      // knee occluded behind the other leg
      back_leg_ext: 180,        // the leg we CAN see is straight
      point_feet: 175,
      torso_uprightness: 3,
      land_plie: 130,
    }
    const fb = selectFeedback(withHiddenKnee)
    expect(fb.kind).toBe('unassessable')
  })

  it('still praises the same rep once every metric is measurable', () => {
    const fullyVisible = {
      front_leg_ext: 179,
      back_leg_ext: 180,
      point_feet: 175,
      torso_uprightness: 3,
      land_plie: 130,
    }
    expect(selectFeedback(fullyVisible).kind).toBe('praise')
  })

  it('is monotonic: a bent leg is corrected, never praised', () => {
    // Sweeping extension from straight to badly bent must never improve the verdict. A leg is
    // corrected once it scores under 80: 20% of the way from 'excellent' down to 'poor'.
    const band = thresholds.score_config.front_leg_ext
    const correctedBelow = band.excellent - 0.2 * (band.excellent - band.poor)
    let sawCorrection = false
    for (const ext of [180, 170, 160, 140, 120, 90, 60]) {
      const fb = selectFeedback({
        front_leg_ext: ext,
        back_leg_ext: ext,
        point_feet: 175,
        torso_uprightness: 3,
        land_plie: 130,
      })
      if (ext < correctedBelow) {
        expect(fb.kind, `ext ${ext}`).toBe('correction')
        sawCorrection = true
      }
    }
    expect(sawCorrection).toBe(true)
  })

  it('a correction is still given even when some metrics are unmeasurable', () => {
    // Refusing praise must not mean going silent about something we DID measure.
    const fb = selectFeedback({ front_leg_ext: null, back_leg_ext: 100, point_feet: 175 })
    expect(fb.kind).toBe('correction')
  })
})
