// Mirrors tests/test_geometry.py's cases numerically so the TS port stays aligned
// with the Python original the upload pipeline uses.
import { describe, expect, it } from 'vitest'
import { angleAt, RollingBaseline, RunningBodyScale, TrailingSmoother } from './geometry'

describe('angleAt', () => {
  it('right angle', () => {
    expect(angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90, 1)
  })

  it('straight line', () => {
    expect(angleAt({ x: 0, y: 0 }, { x: -1, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(180, 1)
  })

  it('45 degrees', () => {
    expect(angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(45, 0)
  })

  it('collinear returns 180', () => {
    expect(angleAt({ x: 0, y: 0 }, { x: -2, y: 0 }, { x: 3, y: 0 })).toBeCloseTo(180, 0)
  })

  it('zero-length arm returns NaN', () => {
    expect(angleAt({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeNaN()
  })
})

describe('RollingBaseline', () => {
  it('flat signal baseline equals the signal', () => {
    const rb = new RollingBaseline(30, 2.0)
    let last = NaN
    for (let i = 0; i < 60; i++) last = rb.push(0.5)
    expect(last).toBeCloseTo(0.5, 6)
  })

  it('tracks a step after the window fills with the new value', () => {
    const rb = new RollingBaseline(30, 2.0)   // window = 60 samples
    for (let i = 0; i < 60; i++) rb.push(0.2)
    let last = NaN
    for (let i = 0; i < 60; i++) last = rb.push(0.8)
    expect(last).toBeCloseTo(0.8, 6)
  })
})

describe('RunningBodyScale', () => {
  it('returns 1.0 fallback with no samples', () => {
    const bs = new RunningBodyScale(30)
    expect(bs.value).toBe(1.0)
  })

  it('approximates shoulder-to-ankle distance', () => {
    const bs = new RunningBodyScale(30)
    // shoulder_mid = (0.5, 0.20), ankle_mid = (0.5, 1.00) -> dist = 0.80
    for (let i = 0; i < 30; i++) bs.push({ x: 0.5, y: 0.2 }, { x: 0.5, y: 1.0 })
    expect(bs.value).toBeCloseTo(0.8, 2)
  })
})

describe('TrailingSmoother', () => {
  it('constant signal is unchanged', () => {
    const sm = new TrailingSmoother(5)
    let last = { x: 0, y: 0 }
    for (let i = 0; i < 10; i++) last = sm.push({ x: 0.5, y: 0.5 })
    expect(last.x).toBeCloseTo(0.5, 6)
    expect(last.y).toBeCloseTo(0.5, 6)
  })
})
