'use client'

import { useEffect, useRef, useState } from 'react'
import type { PoseLandmarker } from '@mediapipe/tasks-vision'
import { createPoseLandmarker, drawSkeleton } from '@/lib/live/pose'

const IS_DEV = process.env.NODE_ENV === 'development'

type Stage = 'idle' | 'starting' | 'active' | 'error'
type ErrorKind = 'denied' | 'nocamera' | 'insecure' | 'init'

const ERROR_COPY: Record<ErrorKind, { title: string; body: string }> = {
  denied: {
    title: 'Camera access was blocked',
    body: 'Live coaching needs your camera to see your dancing. Click the camera icon in your browser’s address bar to allow access, then press Start again.',
  },
  nocamera: {
    title: 'No camera found',
    body: 'We couldn’t find a camera on this device. Plug one in or try another device, then press Start again.',
  },
  insecure: {
    title: 'Camera needs a secure connection',
    body: 'Browsers only allow camera access over https or on localhost. Open the app at http://localhost:3000 for development.',
  },
  init: {
    title: 'Could not start the pose tracker',
    body: 'Something went wrong loading the pose model. Reload the page and try again.',
  },
}

export default function LiveClient() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const rafRef = useRef<number>(0)
  const lastVideoTimeRef = useRef(-1)
  const lastPoseAtRef = useRef(0)
  const fpsSamplesRef = useRef<number[]>([])
  const lastFpsLogRef = useRef(0)

  const [stage, setStage] = useState<Stage>('idle')
  const [errorKind, setErrorKind] = useState<ErrorKind>('init')
  const [noDancer, setNoDancer] = useState(false)
  const [fps, setFps] = useState(0)

  useEffect(() => () => stopSession(), [])

  function stopSession() {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    landmarkerRef.current?.close()
    landmarkerRef.current = null
    lastVideoTimeRef.current = -1
    fpsSamplesRef.current = []
    setNoDancer(false)
    setStage('idle')
  }

  async function startSession() {
    setStage('starting')

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setErrorKind('insecure')
      setStage('error')
      return
    }

    try {
      // Camera + model load in parallel — both take a moment.
      const [stream, landmarker] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        }),
        createPoseLandmarker(),
      ])
      streamRef.current = stream
      landmarkerRef.current = landmarker

      const video = videoRef.current!
      video.srcObject = stream
      await video.play()

      const canvas = canvasRef.current!
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight

      lastPoseAtRef.current = performance.now()
      setStage('active')
      rafRef.current = requestAnimationFrame(loop)
    } catch (err: unknown) {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      const name = err instanceof DOMException ? err.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') setErrorKind('denied')
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') setErrorKind('nocamera')
      else setErrorKind('init')
      setStage('error')
    }
  }

  function loop() {
    const video = videoRef.current
    const canvas = canvasRef.current
    const landmarker = landmarkerRef.current
    if (!video || !canvas || !landmarker) return

    // Only run detection when the camera delivered a new frame — rAF often
    // ticks at 60 Hz against a 30 fps camera.
    if (video.currentTime !== lastVideoTimeRef.current && video.videoWidth > 0) {
      lastVideoTimeRef.current = video.currentTime

      const t0 = performance.now()
      const result = landmarker.detectForVideo(video, t0)
      const now = performance.now()

      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      const lm = result.landmarks?.[0]
      if (lm && lm.length > 0) {
        // Data stays anatomical; only the draw step mirrors (x' = 1 - x)
        // to line up with the CSS-mirrored video preview.
        drawSkeleton(ctx, lm, canvas.width, canvas.height, true)
        lastPoseAtRef.current = now
        setNoDancer(false)
      } else if (now - lastPoseAtRef.current > 1000) {
        setNoDancer(true)
      }

      // FPS over the last 30 detections (dev only)
      if (IS_DEV) {
        const samples = fpsSamplesRef.current
        samples.push(now)
        if (samples.length > 30) samples.shift()
        let f = 0
        if (samples.length >= 2) {
          f = ((samples.length - 1) / (now - samples[0])) * 1000
          setFps(Math.round(f))
          if (now - lastFpsLogRef.current > 2000) {
            lastFpsLogRef.current = now
            console.log(`[live] pose fps: ${f.toFixed(1)} (detect ${(now - t0).toFixed(1)} ms)`)
          }
        }
        ;(window as unknown as Record<string, unknown>).__liveDebug = {
          fps: Math.round(f),
          lastLandmarks: lm ?? null,
          canvasWidth: canvas.width,
        }
      }
    }

    rafRef.current = requestAnimationFrame(loop)
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="font-anton text-3xl text-ink uppercase tracking-widest">Live</h1>
        {IS_DEV && stage === 'active' && (
          <span className="font-elite text-xs text-muted">{fps} fps</span>
        )}
      </div>

      {/* Idle: explainer + start */}
      {stage === 'idle' && (
        <div className="bg-surface border-2 border-ink p-6 space-y-4">
          <p className="font-elite text-xs uppercase tracking-widest text-muted">
            Real-time coaching
          </p>
          <p className="font-grotesk text-sm text-ink">
            Practice in front of your camera and get live feedback on your technique.
            Your camera turns on only while a session is running, and the video never
            leaves your device — all tracking happens right here in your browser.
          </p>
          <p className="font-grotesk text-xs text-ink/60">
            Stand back far enough that your whole body is visible, head to toe.
          </p>
          <button
            onClick={startSession}
            className="w-full py-4 font-anton text-lg uppercase tracking-widest
                       bg-accent text-paper border-2 border-ink shadow-hard-lg
                       hover:bg-accent-deep transition-colors"
          >
            Start
          </button>
        </div>
      )}

      {/* Starting */}
      {stage === 'starting' && (
        <div className="bg-surface border-2 border-ink p-6 flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="font-elite text-xs text-muted uppercase tracking-widest">
            Waking up the camera…
          </span>
        </div>
      )}

      {/* Error states */}
      {stage === 'error' && (
        <div className="bg-surface border-2 border-ink p-6 space-y-4">
          <p className="font-elite text-sm uppercase tracking-widest text-accent-deep">
            {ERROR_COPY[errorKind].title}
          </p>
          <p className="font-grotesk text-sm text-ink">{ERROR_COPY[errorKind].body}</p>
          <button
            onClick={startSession}
            className="w-full py-3 font-anton text-base uppercase tracking-widest
                       bg-accent text-paper border-2 border-ink shadow-hard
                       hover:bg-accent-deep transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {/* Active: mirrored video + skeleton overlay */}
      <div className={stage === 'active' ? 'space-y-4' : 'hidden'}>
        <div className="relative bg-surface border-2 border-ink shadow-hard p-2">
          <div className="relative">
            {/* Mirrored like a dance-studio mirror — dancers expect this. */}
            <video
              ref={videoRef}
              playsInline
              muted
              className="w-full"
              style={{ transform: 'scaleX(-1)' }}
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
            />
            {noDancer && (
              <div className="absolute inset-x-0 bottom-3 flex justify-center">
                <span
                  className="bg-ink text-paper font-elite text-xs uppercase tracking-widest px-3 py-1.5"
                  style={{ transform: 'rotate(-1deg)' }}
                >
                  Step back — I can&rsquo;t see you
                </span>
              </div>
            )}
          </div>
        </div>

        <button
          onClick={stopSession}
          className="w-full py-3 font-anton text-base uppercase tracking-widest
                     border-2 border-ink text-ink hover:bg-ink hover:text-paper transition-colors"
        >
          Stop
        </button>
      </div>

      <p className="font-grotesk text-xs text-ink/50">
        Webcam form feedback is approximate and depends on lighting and camera angle.
        It&rsquo;s a practice aid, not medical or safety advice.
      </p>
    </div>
  )
}
