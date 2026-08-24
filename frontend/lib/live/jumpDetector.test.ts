import { describe, expect, it } from 'vitest'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { JumpRepDetector } from './jumpDetector'

const STANDING: Record<number, { x: number; y: number }> = {
  11: { x: 0.45, y: 0.2 }, 12: { x: 0.55, y: 0.2 },     // shoulders
  23: { x: 0.45, y: 0.5 }, 24: { x: 0.55, y: 0.5 },     // hips
  25: { x: 0.45, y: 0.7 }, 26: { x: 0.55, y: 0.7 },     // knees
  27: { x: 0.45, y: 0.9 }, 28: { x: 0.55, y: 0.9 },     // ankles
  29: { x: 0.45, y: 0.92 }, 30: { x: 0.55, y: 0.92 },   // heels
  31: { x: 0.45, y: 0.95 }, 32: { x: 0.55, y: 0.95 },   // foot index
}

function makeLandmarks(overrides: Record<number, { x: number; y: number }> = {}): NormalizedLandmark[] {
  const lm: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  for (const [id, p] of Object.entries(STANDING)) lm[Number(id)] = { x: p.x, y: p.y, z: 0, visibility: 1 }
  for (const [id, p] of Object.entries(overrides)) lm[Number(id)] = { x: p.x, y: p.y, z: 0, visibility: 1 }
  return lm
}

describe('JumpRepDetector', () => {
  it('detects a jump with plausible takeoff/apex/landing ordering and lands a plié reading', () => {
    const fps = 30
    const dt = 1000 / fps
    const det = new JumpRepDetector(fps)
    let event = null
    let t = 0

    // Warm up standing still so the rolling baseline + body scale settle.
    for (let i = 0; i < 90; i++) {
      event = det.pushFrame(makeLandmarks(), t)
      t += dt
    }
    expect(event).toBeNull()

    // Airborne: hips/knees/ankles rise together for 6 frames (well over the 4-frame
    // minimum), with a bit more lift mid-flight so there's a clear apex frame.
    for (let i = 0; i < 6; i++) {
      const lift = 0.10 + (i === 3 ? 0.03 : 0)
      event = det.pushFrame(
        makeLandmarks({
          23: { x: 0.45, y: 0.5 - lift }, 24: { x: 0.55, y: 0.5 - lift },
          25: { x: 0.45, y: 0.7 - lift }, 26: { x: 0.55, y: 0.7 - lift },
          27: { x: 0.45, y: 0.9 - lift }, 28: { x: 0.55, y: 0.9 - lift },
        }),
        t,
      )
      t += dt
      expect(event).toBeNull()   // never cues mid-flight
    }

    // Land, then hold standing through the landing tail window until the rep closes.
    for (let i = 0; i < 20; i++) {
      event = det.pushFrame(makeLandmarks(), t)
      t += dt
      if (event) break
    }

    expect(event).not.toBeNull()
    expect(event!.takeoffMs).toBeLessThan(event!.apexMs)
    expect(event!.apexMs).toBeLessThanOrEqual(event!.landingMs)
    expect(event!.metrics.land_plie).not.toBeNull()
    expect(event!.metrics.front_leg_ext).not.toBeNull()
    expect(event!.metrics.back_leg_ext).not.toBeNull()
  })

  it('ignores a brief hip wobble under the 4-frame minimum', () => {
    const fps = 30
    const dt = 1000 / fps
    const det = new JumpRepDetector(fps)
    let t = 0
    let event = null

    for (let i = 0; i < 90; i++) {
      event = det.pushFrame(makeLandmarks(), t)
      t += dt
    }

    // Only 2 airborne frames — below MIN_AIRBORNE_FRAMES.
    for (let i = 0; i < 2; i++) {
      event = det.pushFrame(
        makeLandmarks({ 23: { x: 0.45, y: 0.4 }, 24: { x: 0.55, y: 0.4 } }),
        t,
      )
      t += dt
    }
    for (let i = 0; i < 20; i++) {
      event = det.pushFrame(makeLandmarks(), t)
      t += dt
    }

    expect(event).toBeNull()
  })
})
