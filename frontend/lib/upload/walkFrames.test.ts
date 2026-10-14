// The upload's frame walk against a stand-in <video>: every frame read in order, frames that go
// by without a callback stepped back to where the browser allows it, and never a hang - an iPhone
// froze on the first step back, because Safari does not report a seek made while paused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnalysisError, walkFrames, type WalkStats } from './analyzeVideo'

const FRAME_S = 1 / 30

type FrameCallback = (now: number, meta: { mediaTime: number }) => void

/**
 * A clip of `frames` frames. play() presents one frame every 1/30 s, and every sixth time two at
 * once (one frame goes by without a callback); pause() stops it. `seekReports`: whether a seek
 * while paused reports the frame it lands on, as Chrome does and Safari often does not. From frame
 * `stopAt` on, playback goes on but no frame is presented any more.
 */
class FakeVideo {
  paused = true
  ended = false
  readonly duration: number
  private time = 0
  private frame = 0
  private advances = 0
  private ticking = false
  private callbacks = new Map<number, FrameCallback>()
  private nextHandle = 1
  private onEnded: Array<() => void> = []

  constructor(readonly frames: number, readonly seekReports: boolean, readonly stopAt = Infinity) {
    this.duration = frames * FRAME_S
  }

  get currentTime() {
    return this.time
  }
  set currentTime(t: number) {
    this.time = t
    this.frame = Math.floor(t / FRAME_S + 1e-9)
    if (this.seekReports) setTimeout(() => this.present(), 10)
  }

  requestVideoFrameCallback(cb: FrameCallback) {
    const handle = this.nextHandle++
    this.callbacks.set(handle, cb)
    return handle
  }
  cancelVideoFrameCallback(handle: number) {
    this.callbacks.delete(handle)
  }

  play() {
    if (this.ended) return Promise.resolve()
    this.paused = false
    if (!this.ticking) {
      this.ticking = true
      setTimeout(() => this.tick(), FRAME_S * 1000)
    }
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }

  addEventListener(type: string, fn: () => void) {
    if (type === 'ended') this.onEnded.push(fn)
  }
  removeEventListener(type: string, fn: () => void) {
    if (type === 'ended') this.onEnded = this.onEnded.filter((f) => f !== fn)
  }

  private tick() {
    this.ticking = false
    if (this.paused || this.ended || this.frame >= this.stopAt) return
    this.advances += 1
    this.frame += this.advances % 6 === 0 ? 2 : 1
    if (this.frame >= this.frames) {
      this.ended = true
      this.paused = true
      this.time = this.duration
      for (const fn of this.onEnded) fn()
      return
    }
    this.time = this.frame * FRAME_S
    this.present()
    if (!this.paused && !this.ticking) {
      this.ticking = true
      setTimeout(() => this.tick(), FRAME_S * 1000)
    }
  }

  private present() {
    const due = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const cb of due) cb(0, { mediaTime: this.frame * FRAME_S })
  }
}

async function walk(video: FakeVideo) {
  const read: number[] = []
  const notes: string[] = []
  let result: { stats: WalkStats } | { error: unknown } | null = null
  walkFrames(video as unknown as HTMLVideoElement, (ms) => read.push(ms), undefined, (m) => notes.push(m)).then(
    (stats) => { result = { stats } },
    (error) => { result = { error } },
  )
  await vi.runAllTimersAsync()
  return { read, notes, result: result as { stats: WalkStats } | { error: unknown } | null }
}

const frameIndex = (ms: number) => Math.round(ms / (FRAME_S * 1000))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('walkFrames', () => {
  it('reads every frame in order where a seek reports its frame (Chrome)', async () => {
    const { read, result, notes } = await walk(new FakeVideo(60, true))
    expect(result).not.toBeNull()
    expect(result).toHaveProperty('stats')
    const { stats } = result as { stats: WalkStats }
    expect(stats.recovered).toBeGreaterThan(0)
    expect(stats.gaps).toBe(0)
    expect(read.map(frameIndex)).toEqual(Array.from({ length: read.length }, (_, i) => i))
    expect(read.length).toBeGreaterThanOrEqual(59)
    expect(notes).toEqual([])
  })

  it('still finishes where a seek while paused reports nothing (Safari)', async () => {
    const { read, result, notes } = await walk(new FakeVideo(60, false))
    expect(result).toHaveProperty('stats')
    const { stats } = result as { stats: WalkStats }
    expect(stats.recovered).toBe(0)
    expect(stats.gaps).toBeGreaterThan(0)
    // In order, each frame once, and every frame read or counted as a gap.
    const frames = read.map(frameIndex)
    expect(frames).toEqual([...new Set(frames)].sort((a, b) => a - b))
    expect(frames.length + stats.gaps).toBeGreaterThanOrEqual(58)
    // It found out once, then stopped stepping back.
    expect(notes.filter((n) => n.includes('reported no frame'))).toHaveLength(1)
  })

  it('gives up with an error when the video stops showing frames', async () => {
    const { read, result } = await walk(new FakeVideo(60, true, 30))
    expect(result).toHaveProperty('error')
    const { error } = result as { error: unknown }
    expect(error).toBeInstanceOf(AnalysisError)
    expect((error as AnalysisError).kind).toBe('stalled')
    expect(read.length).toBeGreaterThan(20)
  })
})
