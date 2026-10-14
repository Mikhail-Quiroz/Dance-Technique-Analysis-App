// Records the camera through a /live session, for the highlight reel (reel.ts). Optional: the
// recording stays in this browser's memory and is only used to cut the reel; it leaves the device
// only if the dancer saves the session, and then only the reel goes.
//
// A camera switch or a turned phone changes the stream's shape, which a recorder cannot follow, so
// each starts a new part. Parts are stamped on the session clock (performance.now()), like the
// MoveEngine's events, so a move can be found in them.

export interface RecordedPart {
  blob: Blob
  /** Session clock, ms: when the part's first frame was recorded, and when it was stopped. */
  startMs: number
  endMs: number
  width: number
  height: number
}

/** Recording stops after this long, to keep memory in hand on a phone; coaching carries on. */
export const RECORD_LIMIT_MS = 15 * 60_000
const BITRATE = 2_000_000

/** The best format this browser records (mp4 plays everywhere; Chrome before 126 and Firefox only do webm). */
export function recordingType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? null
}

export const extensionFor = (type: string) => (type.startsWith('video/mp4') ? 'mp4' : 'webm')

interface Live {
  rec: MediaRecorder
  chunks: Blob[]
  startMs: number
  width: number
  height: number
  stopped: Promise<void>
}

export class SessionRecorder {
  private live: Live | null = null
  private parts: RecordedPart[] = []
  private pending: Array<Promise<void>> = []
  private doneMs = 0

  constructor(readonly type: string) {}

  /** Records this stream as a new part, ending the current one. False once the limit is reached. */
  start(stream: MediaStream, width: number, height: number): boolean {
    this.endPart()
    if (this.recordedMs() >= RECORD_LIMIT_MS) return false
    const rec = new MediaRecorder(stream, { mimeType: this.type, videoBitsPerSecond: BITRATE })
    const live: Live = { rec, chunks: [], startMs: NaN, width, height, stopped: Promise.resolve() }
    live.stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve()
      rec.onerror = () => resolve()
    })
    rec.ondataavailable = (e) => { if (e.data.size) live.chunks.push(e.data) }
    rec.onstart = () => { live.startMs = performance.now() }
    rec.start(1000)
    this.live = live
    return true
  }

  /** Ends the current part (before its stream's camera is switched off, so it closes cleanly). */
  endPart(): void {
    const live = this.live
    if (!live) return
    this.live = null
    const endMs = performance.now()
    if (Number.isFinite(live.startMs)) this.doneMs += endMs - live.startMs
    if (live.rec.state !== 'inactive') live.rec.stop()
    this.pending.push(live.stopped.then(() => {
      if (!live.chunks.length || !Number.isFinite(live.startMs)) return
      this.parts.push({ blob: new Blob(live.chunks, { type: this.type }), startMs: live.startMs, endMs, width: live.width, height: live.height })
    }))
  }

  get recording(): boolean {
    return this.live !== null
  }

  /** How long has been recorded so far, ms. */
  recordedMs(): number {
    const live = this.live
    return this.doneMs + (live && Number.isFinite(live.startMs) ? performance.now() - live.startMs : 0)
  }

  /** Every part, in order, once the last one has closed. */
  async finish(): Promise<RecordedPart[]> {
    this.endPart()
    await Promise.all(this.pending)
    return [...this.parts].sort((a, b) => a.startMs - b.startMs)
  }
}
