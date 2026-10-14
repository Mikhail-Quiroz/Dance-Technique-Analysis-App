'use client'
// A video with the analysed skeleton drawn over it, frame for frame, from the saved pose track.
//
// The controls are our own rather than the browser's: the browser's full screen shows the <video>
// alone, without the skeleton canvas over it, and its control bar (with its dark shade) stayed up
// in full screen. Here full screen takes the whole player - video, skeleton and the skeleton
// switch - and the controls fade out after a moment without the pointer moving, in full screen
// even while paused. A phone without full screen for page elements (iPhone) fills the window instead.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { drawSkeleton } from '@/lib/live/pose'
import { poseAt, type PoseTrack } from '@/lib/upload/poseTrack'
import Icon from '@/components/ui/Icon'

/** Where a `vw` x `vh` picture lands inside a `W` x `H` box with object-fit: contain. */
export function containRect(W: number, H: number, vw: number, vh: number) {
  const scale = Math.min(W / vw, H / vh)
  const w = vw * scale
  const h = vh * scale
  return { x: (W - w) / 2, y: (H - h) / 2, w, h }
}

/**
 * Draw `lm` on a canvas laid over `video`, sized to the element at the screen's pixel density and
 * clipped to the picture: the tracker places limbs it cannot see past the frame's edge.
 * `lm` null just clears it.
 */
export function drawPoseOver(canvas: HTMLCanvasElement, video: HTMLVideoElement, lm: NormalizedLandmark[] | null) {
  const rect = video.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const cw = Math.round(rect.width * dpr)
  const ch = Math.round(rect.height * dpr)
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw
    canvas.height = ch
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, cw, ch)
  if (!lm || !video.videoWidth) return
  ctx.scale(dpr, dpr)
  const box = containRect(rect.width, rect.height, video.videoWidth, video.videoHeight)
  ctx.save()
  ctx.beginPath()
  ctx.rect(box.x, box.y, box.w, box.h)
  ctx.clip()
  drawSkeleton(ctx, lm, box.w, box.h, false, { x: box.x, y: box.y })
  ctx.restore()
}

/** Controls fade after this long without the pointer moving. */
const IDLE_MS = 2200
/** Slow motion steps, for watching a move closely. */
const SPEEDS = [1, 0.5, 0.25]

const clock = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${m}:${String(r).padStart(2, '0')}`
}

type Full = 'off' | 'screen' | 'window'

interface WebkitElement extends HTMLElement { webkitRequestFullscreen?: () => void }
interface WebkitDocument extends Document { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void }
interface LockableOrientation extends ScreenOrientation { lock?: (o: string) => Promise<void> }

export default function SkeletonVideo({
  src,
  track,
  videoRef,
}: {
  src: string
  track: PoseTrack | null
  videoRef?: RefObject<HTMLVideoElement | null>
}) {
  const ownRef = useRef<HTMLVideoElement | null>(null)
  const ref = videoRef ?? ownRef
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [show, setShow] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(0)
  const [muted, setMuted] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [full, setFull] = useState<Full>('off')
  const fullRef = useRef<Full>('off')
  const [controls, setControls] = useState(true)
  const idle = useRef(0)

  // The skeleton, drawn for every frame the video shows.
  useEffect(() => {
    const video = ref.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    let stopped = false
    let rvfc = 0
    let raf = 0

    const draw = (mediaMs?: number) => {
      drawPoseOver(canvas, video, show && track ? poseAt(track, mediaMs ?? video.currentTime * 1000) : null)
    }

    if ('requestVideoFrameCallback' in video) {
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (stopped) return
        draw(meta.mediaTime * 1000)
        rvfc = video.requestVideoFrameCallback(onFrame)
      }
      rvfc = video.requestVideoFrameCallback(onFrame)
    } else {
      const tick = () => {
        if (stopped) return
        draw()
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }
    const redraw = () => draw()
    video.addEventListener('seeked', redraw)
    video.addEventListener('loadeddata', redraw)
    const ro = new ResizeObserver(redraw)
    ro.observe(video)
    draw()

    return () => {
      stopped = true
      if (rvfc && 'cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(rvfc)
      cancelAnimationFrame(raf)
      video.removeEventListener('seeked', redraw)
      video.removeEventListener('loadeddata', redraw)
      ro.disconnect()
    }
  }, [ref, track, show, src])

  // The video's own state, for the controls.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const sync = () => {
      setPlaying(!v.paused && !v.ended)
      setTime(v.currentTime)
      setLength(Number.isFinite(v.duration) ? v.duration : 0)
      setMuted(v.muted)
      setSpeed(v.playbackRate)
    }
    const events = ['play', 'pause', 'ended', 'timeupdate', 'seeked', 'durationchange', 'loadedmetadata', 'volumechange', 'ratechange']
    events.forEach((e) => v.addEventListener(e, sync))
    // Development only: a picture that stops is easier to explain with the moments it waited.
    const dev = process.env.NODE_ENV !== 'production'
    const note = (e: Event) => console.info(`[video] ${e.type} at ${v.currentTime.toFixed(2)} s of ${v.duration.toFixed(2)} s`)
    if (dev) ['waiting', 'stalled'].forEach((e) => v.addEventListener(e, note))
    sync()
    return () => {
      events.forEach((e) => v.removeEventListener(e, sync))
      if (dev) ['waiting', 'stalled'].forEach((e) => v.removeEventListener(e, note))
    }
  }, [ref, src])

  /** Show the controls, and fade them again after a moment without the pointer moving. */
  const wake = useCallback(() => {
    setControls(true)
    window.clearTimeout(idle.current)
    idle.current = window.setTimeout(() => {
      const v = ref.current
      // Inline, they stay while the video is paused; in full screen they always get out of the way.
      if (fullRef.current !== 'off' || (v && !v.paused)) setControls(false)
    }, IDLE_MS)
  }, [ref])
  useEffect(() => () => window.clearTimeout(idle.current), [])
  // Paused inline: the controls come back.
  useEffect(() => {
    if (!playing && full === 'off') setControls(true)
  }, [playing, full])

  const setFullMode = useCallback((mode: Full) => {
    fullRef.current = mode
    setFull(mode)
  }, [])

  // Leaving full screen by the browser's own means (Esc, a back gesture).
  useEffect(() => {
    const doc = document as WebkitDocument
    const onChange = () => {
      const el = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
      if (el === boxRef.current) setFullMode('screen')
      else if (fullRef.current === 'screen') setFullMode('off')
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
  }, [setFullMode])

  // Filling the window (no full screen API): no page scrolling underneath, and Esc leaves.
  useEffect(() => {
    if (full !== 'window') return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullMode('off') }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [full, setFullMode])

  async function toggleFull() {
    const doc = document as WebkitDocument
    const box = boxRef.current as WebkitElement | null
    if (!box) return
    if (full === 'screen') {
      if (doc.exitFullscreen) await doc.exitFullscreen().catch(() => {})
      else doc.webkitExitFullscreen?.()
      return
    }
    if (full === 'window') {
      setFullMode('off')
      return
    }
    try {
      if (box.requestFullscreen) await box.requestFullscreen()
      else if (box.webkitRequestFullscreen) box.webkitRequestFullscreen()
      else throw new Error('no full screen')
      // A landscape video on a phone held upright: turn it, where the browser allows (Android).
      const v = ref.current
      if (v && v.videoWidth > v.videoHeight) await (screen.orientation as LockableOrientation).lock?.('landscape').catch(() => {})
    } catch {
      setFullMode('window')
    }
    wake()
  }

  function togglePlay() {
    const v = ref.current
    if (!v) return
    if (v.paused || v.ended) void v.play().catch(() => {})
    else v.pause()
  }

  function nextSpeed() {
    const v = ref.current
    if (!v) return
    v.playbackRate = SPEEDS[(SPEEDS.indexOf(v.playbackRate) + 1) % SPEEDS.length] ?? 1
  }

  function seek(s: number) {
    const v = ref.current
    if (!v) return
    v.currentTime = Math.min(Math.max(0, s), Number.isFinite(v.duration) ? v.duration : s)
  }

  function onKey(e: ReactKeyboardEvent) {
    const v = ref.current
    if (!v || (e.target as HTMLElement).tagName === 'INPUT') return
    if (e.key === ' ' || e.key === 'k') togglePlay()
    else if (e.key === 'f') void toggleFull()
    else if (e.key === 'ArrowLeft') seek(v.currentTime - 1)
    else if (e.key === 'ArrowRight') seek(v.currentTime + 1)
    else return
    e.preventDefault()
    wake()
  }

  const isFull = full !== 'off'
  const btn = 'flex h-9 w-9 items-center justify-center rounded-full text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white'

  return (
    <div
      ref={boxRef}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerMove={(e) => { if (e.pointerType === 'mouse') wake() }}
      onMouseLeave={() => { if (playing && !isFull) setControls(false) }}
      className={`overflow-hidden outline-none ${full === 'window' ? 'fixed inset-0 z-[100]' : 'relative'} ${
        isFull ? 'flex h-full w-full items-center justify-center bg-black' : 'rounded-[1.25rem] bg-ink'
      }`}
      style={isFull ? { cursor: controls ? 'auto' : 'none' } : undefined}
    >
      <video
        ref={ref}
        src={src}
        playsInline
        preload="metadata"
        className={isFull ? 'block h-full w-full object-contain' : 'block max-h-[70vh] w-full'}
      />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* A tap or click on the picture: play or pause (a tap first brings hidden controls back). */}
      <button
        type="button"
        aria-label={playing ? 'Pause' : 'Play'}
        className="absolute inset-0 h-full w-full cursor-pointer"
        onPointerUp={(e) => {
          if (e.pointerType !== 'mouse' && !controls) wake()
          else { togglePlay(); wake() }
        }}
        onDoubleClick={() => void toggleFull()}
      />
      {!playing && (
        <span className="pointer-events-none absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm">
          <Icon name="play" size={30} />
        </span>
      )}

      {track && (
        <button
          onClick={() => { setShow((s) => !s); wake() }}
          className={`absolute left-3 top-3 chip chip-btn bg-surface/90 text-ink backdrop-blur transition-opacity duration-300 hover:bg-surface ${
            isFull && !controls ? 'pointer-events-none opacity-0' : 'opacity-100'
          }`}
          style={isFull ? { top: 'max(0.75rem, env(safe-area-inset-top))', left: 'max(0.75rem, env(safe-area-inset-left))' } : undefined}
          aria-pressed={show}
        >
          <Icon name="bone" size={16} />
          {show ? 'Hide skeleton' : 'Show skeleton'}
        </button>
      )}

      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent px-3 pt-10 transition-opacity duration-300 ${
          controls ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        style={{ paddingBottom: isFull ? 'max(0.5rem, env(safe-area-inset-bottom))' : '0.4rem' }}
        onPointerDown={() => wake()}
      >
        <input
          type="range"
          aria-label="Position in the video"
          min={0}
          max={length || 0}
          step={0.01}
          value={Math.min(time, length || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          className="block h-5 w-full cursor-pointer accent-sun"
        />
        <div className="flex items-center gap-1 text-white">
          <button type="button" onClick={togglePlay} className={btn} aria-label={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={20} />
          </button>
          <span className="px-1 text-xs font-semibold tabular-nums">{clock(time)} / {clock(length)}</span>
          <span className="flex-1" />
          <button type="button" onClick={nextSpeed} className={`${btn} w-auto px-2.5 text-xs font-bold`} aria-label={`Speed ${speed} times, change`}>
            {speed === 1 ? '1×' : `${speed}×`}
          </button>
          <button type="button" onClick={() => { const v = ref.current; if (v) v.muted = !v.muted }} className={btn} aria-label={muted ? 'Sound on' : 'Mute'}>
            <Icon name={muted ? 'volumeOff' : 'volume'} size={20} />
          </button>
          <button type="button" onClick={() => void toggleFull()} className={btn} aria-label={isFull ? 'Leave full screen' : 'Full screen'}>
            <Icon name={isFull ? 'shrink' : 'expand'} size={20} />
          </button>
        </div>
      </div>
    </div>
  )
}
