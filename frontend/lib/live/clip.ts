// A recorded clip through the MoveEngine, frame by frame. The real-footage tests (replay.ts) and
// the upload page both run clips through this one class, so an uploaded video is analysed exactly
// the way the 100 reference clips are tested.
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { MoveEngine, type MoveEvent } from './moveEngine'

export class ClipAnalyzer {
  readonly engine: MoveEngine
  readonly events: MoveEvent[] = []
  private lastT = -Infinity

  /** `aspect` is the frame's width over its height (see MoveEngineConfig.aspect). */
  constructor(aspect?: number) {
    this.engine = new MoveEngine(aspect && Number.isFinite(aspect) && aspect > 0 ? { aspect } : {})
  }

  /** One frame, in order. A frame with no pose is skipped, as /live does. Returns the moves it decided. */
  push(tMs: number, lm: NormalizedLandmark[] | null | undefined, world?: Landmark[] | null): MoveEvent[] {
    this.lastT = Math.max(this.lastT, tMs)
    if (!lm || lm.length === 0) return []
    const out = this.engine.pushFrame(lm, tMs, world ?? undefined)
    this.events.push(...out)
    return out
  }

  /** The clip has ended: release what was only waiting for what came next (MoveEngine.flush). */
  finish(): MoveEvent[] {
    const out = this.engine.flush(Number.isFinite(this.lastT) ? this.lastT : 0)
    this.events.push(...out)
    return out
  }
}
