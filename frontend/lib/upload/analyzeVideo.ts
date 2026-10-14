// Analyses an uploaded video in the browser with the same pose model and MoveEngine /live runs,
// through the ClipAnalyzer the real-footage tests replay clips with. Browser only.
//
// Every frame is visited in order: the video plays, and on each new frame
// (requestVideoFrameCallback) it pauses while the pose is read, then plays on. Pausing is what
// stops frames being skipped while the model runs - the detectors are tested on every frame of
// the reference clips. The video element must be in the page: browsers do not present frames for
// a detached one.
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'
import { ClipAnalyzer } from '../live/clip'
import type { MoveEvent } from '../live/moveEngine'
import type { PoseTrack } from './poseTrack'

export const MAX_DURATION_S = 90
export const MAX_FILE_BYTES = 200 * 1024 * 1024

/**
 * The detectors are tested at 15 and 30 fps. Footage faster than this is analysed at about 30:
 * a 60 fps phone clip takes half the time and stays inside what was tested.
 */
const MIN_FRAME_GAP_MS = 1000 / 35

export type AnalysisErrorKind = 'decode' | 'too-long' | 'aborted' | 'stalled'

export class AnalysisError extends Error {
  constructor(readonly kind: AnalysisErrorKind, message: string) {
    super(message)
  }
}

export interface AnalysisProgress {
  /** 0..1 through the video. */
  fraction: number
  mediaS: number
  durationS: number
  frames: number
  moves: number
}

export interface VideoAnalysis {
  events: MoveEvent[]
  track: PoseTrack
  width: number
  height: number
  durationMs: number
  frames: number
  framesWithPose: number
  walk: WalkStats
  /** What the engine saw and deliberately did not count (MoveEngine.dropped). */
  dropped: string[]
}

/** Load `src` into the element and wait until its first frame can be read. */
export function loadVideo(video: HTMLVideoElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadeddata', onData)
      video.removeEventListener('error', onError)
    }
    const onData = () => {
      cleanup()
      if (!video.videoWidth || !video.videoHeight) {
        reject(new AnalysisError('decode', 'This video has no picture this browser can read.'))
        return
      }
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        reject(new AnalysisError('decode', 'This browser cannot tell how long this video is.'))
        return
      }
      if (video.duration > MAX_DURATION_S + 0.5) {
        reject(new AnalysisError('too-long', `This clip is ${Math.round(video.duration)} s long. Trim it to ${MAX_DURATION_S} s or less.`))
        return
      }
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new AnalysisError('decode', 'This browser cannot play this video. Try exporting it as an H.264 .mp4.'))
    }
    video.addEventListener('loadeddata', onData)
    video.addEventListener('error', onError)
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.src = src
    video.load()
  })
}

type FrameVisitor = (mediaMs: number) => void

const hasFrameCallback = () =>
  typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype

export interface WalkStats {
  /** Frames that went by without a callback and were read by stepping back to them. */
  recovered: number
  /** Gaps that stepping back could not fill (or a real gap in a variable-frame-rate video). */
  gaps: number
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/** How long the next frame may take to be reported before the walk stops waiting for it. */
const STALL_MS = 1500
/** Stalls in a row, with no frame read in between, before the walk gives up. */
const MAX_STALLS = 3

/**
 * Every presented frame, in order, pausing on each while `visit` runs.
 *
 * Now and then a frame goes by without a callback - the page was busy at the moment it was shown
 * (1-5% of frames in headless Chrome). Each such gap is filled by stepping back to the frame that
 * was missed: MediaPipe tracks from one frame to the next, and the detectors are tested on every
 * frame, so a skipped frame changes what they see. A seek while paused reports the frame it lands
 * on through the same callback - in Chrome. Safari often reports nothing for it, and waiting for
 * that callback froze the analysis on an iPhone: a seek that reports nothing turns stepping back
 * off for the rest of the walk, and any frame that is never reported is waited for only STALL_MS.
 */
export function walkFrames(
  video: HTMLVideoElement,
  visit: FrameVisitor,
  signal?: AbortSignal,
  note?: (message: string) => void,
): Promise<WalkStats> {
  return new Promise((resolve, reject) => {
    const stats: WalkStats = { recovered: 0, gaps: 0 }
    let finished = false
    let lastMs = -Infinity
    /** Recent frame-to-frame spacings, for the expected one. */
    const spacing: number[] = []
    /** The frame a gap was last stepped back from: each gap gets one try. */
    let triedFrom = -Infinity
    let seeking = false
    let started = false
    /** Whether a seek while paused reports its frame. Assumed until a seek reports nothing. */
    let seekReports = true
    let stalls = 0
    let handle = 0
    let watchdog = 0
    let grace = 0

    const end = (err?: unknown) => {
      if (finished) return
      finished = true
      window.clearTimeout(watchdog)
      window.clearTimeout(grace)
      if (handle) video.cancelVideoFrameCallback(handle)
      video.removeEventListener('ended', onEnded)
      signal?.removeEventListener('abort', onAbort)
      video.pause()
      if (err) reject(err)
      else resolve(stats)
    }
    // The last frame's callback can arrive just after 'ended': give it a moment before finishing.
    const onEnded = () => { grace = window.setTimeout(() => end(), 250) }
    const onAbort = () => end(new AnalysisError('aborted', 'Analysis canceled.'))
    // play() rejects with AbortError when a pause() lands before playback starts; that is ours.
    const play = () => video.play().catch((e: unknown) => {
      if (!(e instanceof DOMException && e.name === 'AbortError')) end(e)
    })
    /** Ask for the next frame, and stop waiting for it after STALL_MS. */
    const request = () => {
      if (handle) video.cancelVideoFrameCallback(handle)
      handle = video.requestVideoFrameCallback(step)
      window.clearTimeout(watchdog)
      watchdog = window.setTimeout(onStall, STALL_MS)
    }
    // No frame was reported. After a step back, this browser does not report paused seeks: the
    // frames it skips from now on are counted as gaps. Either way the video plays on from where it
    // is, which reports the next frame - unless it has truly stopped, which ends the walk.
    const onStall = () => {
      if (finished) return
      if (video.ended) {
        end()
        return
      }
      if (seeking) {
        seeking = false
        seekReports = false
        stats.gaps += 1
        note?.(`a seek to ${video.currentTime.toFixed(3)} s reported no frame; skipped frames are now counted, not stepped back to`)
      } else if (started) {
        stalls += 1
        note?.(`no frame for ${STALL_MS} ms at ${video.currentTime.toFixed(3)} s (${stalls} in a row)`)
        if (stalls >= MAX_STALLS) {
          end(new AnalysisError('stalled', 'The video stopped playing partway through. Try again, or try another browser.'))
          return
        }
      }
      request()
      play()
    }
    const step = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (finished) return
      handle = 0
      window.clearTimeout(watchdog)
      started = true
      stalls = 0
      video.pause()
      const t = meta.mediaTime * 1000
      const expected = spacing.length >= 3 ? median(spacing) : null
      if (seeking) {
        seeking = false
        if (t > lastMs) stats.recovered += 1
      } else if (expected !== null && t - lastMs > 1.5 * expected) {
        if (seekReports && triedFrom !== lastMs) {
          // Step back to the middle of the first frame that was missed, and read it first.
          triedFrom = lastMs
          seeking = true
          request()
          video.currentTime = (lastMs + 1.5 * expected) / 1000
          return
        }
        stats.gaps += 1
      }
      if (t > lastMs) {
        const d = t - lastMs
        if (Number.isFinite(d) && (expected === null || d <= 1.5 * expected)) {
          spacing.push(d)
          if (spacing.length > 30) spacing.shift()
        }
        lastMs = t
      }
      try {
        visit(t)
      } catch (e) {
        end(e)
        return
      }
      if (video.ended || video.duration - meta.mediaTime < 0.001) {
        end()
        return
      }
      request()
      play()
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort)
    video.addEventListener('ended', onEnded)
    // Seeking to the start presents the first frame through the callback, which then plays on.
    // Playing straight from the start would miss it: the first callback is the second frame. Where
    // the seek reports nothing, the stall timer starts playback instead.
    request()
    video.currentTime = 0
  })
}

/** Fallback without requestVideoFrameCallback: seek through the video at 30 fps. */
async function seekFrames(video: HTMLVideoElement, visit: FrameVisitor, signal?: AbortSignal): Promise<WalkStats> {
  const seekTo = (t: number) => new Promise<void>((resolve) => {
    video.addEventListener('seeked', () => resolve(), { once: true })
    video.currentTime = t
  })
  for (let t = 0; t < video.duration; t += 1 / 30) {
    if (signal?.aborted) throw new AnalysisError('aborted', 'Analysis canceled.')
    await seekTo(t)
    visit(video.currentTime * 1000)
  }
  return { recovered: 0, gaps: 0 }
}

export async function analyzeVideo(
  video: HTMLVideoElement,
  landmarker: PoseLandmarker,
  opts: {
    signal?: AbortSignal
    onProgress?: (p: AnalysisProgress) => void
    /** Each analysed frame's pose (null when none was found), e.g. to draw it. */
    onFrame?: (lm: NormalizedLandmark[] | null, mediaMs: number) => void
    /** What the frame walk had to work around in this browser, for the development log. */
    onNote?: (message: string) => void
  } = {},
): Promise<VideoAnalysis> {
  const width = video.videoWidth
  const height = video.videoHeight
  const durationMs = video.duration * 1000
  // Landmarks are normalised separately in x and y; the engine needs the true frame shape.
  const clip = new ClipAnalyzer(width / height)
  const track: PoseTrack = { t: [], lm: [] }
  let lastTs = -Infinity
  let framesWithPose = 0
  let lastProgressAt = 0

  const visit: FrameVisitor = (mediaMs) => {
    // Whole milliseconds, as the fixture extractor stamps them. MediaPipe's VIDEO mode needs them
    // strictly increasing, so a frame presented twice is read once, and footage faster than
    // ~35 fps has every other frame skipped.
    const ts = Math.round(mediaMs)
    if (ts - lastTs < MIN_FRAME_GAP_MS) return
    lastTs = ts
    const result = landmarker.detectForVideo(video, ts)
    const lm = result.landmarks?.[0] ?? null
    const world = result.worldLandmarks?.[0] ?? null
    if (lm) framesWithPose += 1
    track.t.push(ts)
    track.lm.push(lm ? lm.map(({ x, y, z, visibility }) => ({ x, y, z, visibility })) : null)
    clip.push(ts, lm, world)
    opts.onFrame?.(lm, ts)
    const now = performance.now()
    if (opts.onProgress && now - lastProgressAt > 250) {
      lastProgressAt = now
      opts.onProgress({
        fraction: Math.min(1, ts / durationMs),
        mediaS: ts / 1000,
        durationS: durationMs / 1000,
        frames: track.t.length,
        moves: clip.events.length,
      })
    }
  }

  const walk = hasFrameCallback()
    ? await walkFrames(video, visit, opts.signal, opts.onNote)
    : await seekFrames(video, visit, opts.signal)
  clip.finish()

  return {
    events: clip.events, track, width, height, durationMs, frames: track.t.length, framesWithPose, walk,
    dropped: [...clip.engine.dropped],
  }
}

/** A JPEG of the frame at `atS`, at most `maxWidth` wide - the session's thumbnail. */
export async function captureFrame(video: HTMLVideoElement, atS: number, maxWidth = 640): Promise<Blob | null> {
  await new Promise<void>((resolve) => {
    const t = Math.min(Math.max(0, atS), Math.max(0, video.duration - 0.05))
    if (Math.abs(video.currentTime - t) < 0.001) {
      resolve()
      return
    }
    video.addEventListener('seeked', () => resolve(), { once: true })
    video.currentTime = t
  })
  const scale = Math.min(1, maxWidth / video.videoWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85))
}
