import { describe, expect, it } from 'vitest'
import { scoreMetric, selectTopCue } from './scoring'

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
