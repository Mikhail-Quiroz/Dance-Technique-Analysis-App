// Cuts a /live session's highlight reel in the browser: each segment of the recording
// (highlights.ts) is played into a canvas, and the canvas is recorded, paused while the next
// segment is found, so the reel holds the moves and nothing in between. It runs in real time,
// about as long as the reel lasts.
//
// The video element doing the playing must be on the page (the dancer sees it as a preview):
// browsers do not hand out the frames of a video element that is not.
import { fitBox, type Box, type ReelClock, type Segment } from './highlights'
import type { RecordedPart } from './recorder'

export interface Reel extends ReelClock {
  blob: Blob
  type: string
  width: number
  height: number
  /** Each recording's picture inside the reel's frame (letterboxed when its shape differs). */
  boxes: Box[]
  /** The frame at `thumbAtMs`, as a JPEG, when asked for. */
  thumb: Blob | null
}

const MAX_SIDE = 1280
const BITRATE = 2_500_000
const FPS = 30

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

function once(el: HTMLMediaElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for ${event}`)) }, timeoutMs)
    const ok = () => { cleanup(); resolve() }
    const bad = () => { cleanup(); reject(new Error('the recording could not be read')) }
    const cleanup = () => {
      clearTimeout(timer)
      el.removeEventListener(event, ok)
      el.removeEventListener('error', bad)
    }
    el.addEventListener(event, ok, { once: true })
    el.addEventListener('error', bad, { once: true })
  })
}

/** A recording's length. A browser's own webm recordings carry none until it has read to the end. */
async function mediaDurationS(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration)) return video.duration
  const seeked = once(video, 'seeked', 15_000)
  video.currentTime = 1e9
  await seeked
  return Number.isFinite(video.duration) ? video.duration : video.currentTime
}

/** The length a video file declares, in seconds (NaN when it declares none, or cannot be read). */
async function reportedLengthS(blob: Blob): Promise<number> {
  const v = document.createElement('video')
  const url = URL.createObjectURL(blob)
  try {
    v.preload = 'metadata'
    const loaded = once(v, 'loadedmetadata', 10_000)
    v.src = url
    await loaded
    return v.duration
  } catch {
    return NaN
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function cutReel(
  video: HTMLVideoElement,
  parts: readonly RecordedPart[],
  segments: readonly Segment[],
  type: string,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal; thumbAtMs?: number } = {},
): Promise<Reel> {
  if (!segments.length) throw new Error('nothing to cut')
  const first = parts[segments[0].part]
  const scale = Math.min(1, MAX_SIDE / Math.max(first.width, first.height))
  const width = even(first.width * scale)
  const height = even(first.height * scale)
  const boxes = parts.map((p) => fitBox(p.width, p.height, width, height))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const recorder = new MediaRecorder(canvas.captureStream(FPS), { mimeType: type, videoBitsPerSecond: BITRATE })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve() })

  const urls = new Map<number, string>()
  // Where each recording's media time 0 is on the session clock. Its recorder's start event is
  // no guide (Chrome fires it 150-300 ms late, and its mp4 and webm disagree on which moment
  // media time 0 is), so it is worked back from the end: the moment it was stopped, less its length.
  const mediaZero = new Map<number, number>()
  const total = segments.reduce((s, x) => s + (x.toMs - x.fromMs), 0)
  let done = 0
  let activeMs = 0
  let thumb: Promise<Blob | null> | null = null
  const starts: number[] = []

  // toBlob copies the canvas when called, so this is the frame on it now.
  const jpeg = () => new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85))

  const draw = (part: number) => {
    const b = boxes[part]
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(video, b.x * width, b.y * height, b.w * width, b.h * height)
  }

  try {
    video.muted = true
    video.playsInline = true
    for (let i = 0; i < segments.length; i++) {
      if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError')
      const seg = segments[i]
      const part = parts[seg.part]
      if (!urls.has(seg.part)) {
        urls.set(seg.part, URL.createObjectURL(part.blob))
      }
      const url = urls.get(seg.part)!
      if (video.src !== url) {
        const loaded = once(video, 'loadeddata', 15_000)
        video.src = url
        await loaded
        if (!mediaZero.has(seg.part)) mediaZero.set(seg.part, part.endMs - (await mediaDurationS(video)) * 1000)
      }
      const zero = mediaZero.get(seg.part) ?? part.startMs
      const fromS = Math.max(0, (seg.fromMs - zero) / 1000)
      const toS = (seg.toMs - zero) / 1000
      const seekT0 = performance.now()
      const seeked = once(video, 'seeked', 15_000)
      video.currentTime = fromS
      await seeked
      const seekMs = performance.now() - seekT0
      draw(seg.part)

      // The reel is recorded only while the picture moves. The recorder runs on the wall clock, so
      // every moment the playing stops - starting up, buffering, or the browser pausing a muted
      // video the dancer has scrolled away from or whose screen went dark - would be recorded as a
      // frozen picture. So the recorder resumes on a new frame and pauses when frames stop coming.
      starts.push(activeMs)
      let recordedMs = 0
      let since: number | null = null
      let frames = 0
      let holds = 0
      const record = () => {
        if (since !== null) return
        if (recorder.state === 'inactive') recorder.start(1000)
        else recorder.resume()
        since = performance.now()
      }
      const hold = () => {
        if (since === null) return
        recorder.pause()
        recordedMs += performance.now() - since
        since = null
        holds++
      }

      await new Promise<void>((resolve) => {
        let finished = false
        let rvfc = 0
        let raf = 0
        let lastMediaS = -1
        let lastAdvance = performance.now()
        const finish = () => {
          if (finished) return
          finished = true
          clearInterval(guard)
          if (rvfc && 'cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(rvfc)
          cancelAnimationFrame(raf)
          video.removeEventListener('ended', finish)
          resolve()
        }
        const onFrame = (mediaS: number) => {
          if (mediaS > lastMediaS) {
            lastMediaS = mediaS
            lastAdvance = performance.now()
            frames++
            record()
          }
          draw(seg.part)
          // The thumbnail: the first frame drawn at or after the moment asked for.
          if (!thumb && opts.thumbAtMs !== undefined && zero + mediaS * 1000 >= opts.thumbAtMs) thumb = jpeg()
          opts.onProgress?.(Math.min(1, (done + (mediaS - fromS) * 1000) / total))
          return mediaS >= toS
        }
        if ('requestVideoFrameCallback' in video) {
          const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
            if (finished) return
            if (onFrame(meta.mediaTime)) finish()
            else rvfc = video.requestVideoFrameCallback(tick)
          }
          rvfc = video.requestVideoFrameCallback(tick)
        } else {
          // Safari before 15.4: no frame callback, so poll on animation frames.
          const v: HTMLVideoElement = video
          const tick = () => {
            if (finished) return
            if (onFrame(v.currentTime)) finish()
            else raf = requestAnimationFrame(tick)
          }
          raf = requestAnimationFrame(tick)
        }
        // Belt and braces: a recording's last frames end the segment too. Frames that stop coming
        // pause the recording, and a video the browser paused is asked to play on.
        const guard = setInterval(() => {
          if (opts.signal?.aborted || video.currentTime >= toS || video.ended) finish()
          else if (performance.now() - lastAdvance > 250) {
            hold()
            if (video.paused) video.play().catch(() => {})
          }
        }, 100)
        video.addEventListener('ended', finish)
        video.play().catch(finish)
      })

      video.pause()
      hold()
      activeMs += recordedMs
      console.info(`[reel] segment ${i + 1}/${segments.length}: ${(toS - fromS).toFixed(2)} s of the recording -> ` +
        `${(recordedMs / 1000).toFixed(2)} s of reel, ${frames} frames, seek ${seekMs.toFixed(0)} ms, ` +
        `${holds > 1 ? `${holds - 1} stall(s)` : 'no stalls'}`)
      done += seg.toMs - seg.fromMs
      opts.onProgress?.(Math.min(1, done / total))
    }
    recorder.stop()
    await stopped
  } catch (e) {
    if (recorder.state !== 'inactive') recorder.stop()
    throw e
  } finally {
    video.removeAttribute('src')
    video.load()
    for (const u of urls.values()) URL.revokeObjectURL(u)
  }

  // Asked for a moment no segment reached: the reel's last frame will do.
  if (opts.thumbAtMs !== undefined && !thumb) thumb = jpeg()

  const blob = new Blob(chunks, { type })
  // A recorder that kept the time it was paused would leave frozen stretches between segments:
  // the file would run longer than what was recorded. Logged (with the segments above) to tell.
  void reportedLengthS(blob).then((s) => console.info(
    `[reel] ${segments.length} segment(s), recorded ${(activeMs / 1000).toFixed(2)} s; the file says ${Number.isFinite(s) ? `${s.toFixed(2)} s` : 'no length'}`,
  ))

  return {
    blob,
    type,
    width,
    height,
    boxes,
    thumb: thumb ? await thumb : null,
    segments: [...segments],
    starts,
    durationMs: activeMs,
  }
}
