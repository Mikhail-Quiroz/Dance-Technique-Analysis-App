'use client'

import { useEffect, useRef, useState } from 'react'
import type { PoseLandmarker } from '@mediapipe/tasks-vision'
import { createPoseLandmarker, delegateFor, drawSkeleton } from '@/lib/live/pose'
import type { JumpDebugState } from '@/lib/live/jumpDetector'
import type { ArabesqueDebugState } from '@/lib/live/arabesqueDetector'
import type { TurnDebugState } from '@/lib/live/turnDetector'
import { MoveEngine, type MoveEvent, type MoveKind } from '@/lib/live/moveEngine'
import type { RepFeedback } from '@/lib/live/scoring'
import { packPose, type PoseLog } from '@/lib/live/highlights'
import { RECORD_LIMIT_MS, SessionRecorder, recordingType } from '@/lib/live/recorder'
import { ALL_MOVES, MOVE_FAMILY, MOVE_LABEL, MOVE_TALLY, MOVE_VERB } from '@/lib/moves'
import { feedbackFor } from '@/lib/upload/report'
import { useWakeLock } from '@/lib/useWakeLock'
import { Feedback } from '@/components/results/Results'
import Icon from '@/components/ui/Icon'
import Mascot from '@/components/ui/Mascot'
import MoveIcon from '@/components/ui/MoveIcon'
import ScreenColor from '@/components/ui/ScreenColor'
import LiveSummary, { type LiveSessionData } from './LiveSummary'

const NO_TALLIES = Object.fromEntries(ALL_MOVES.map((k) => [k, 0])) as Record<MoveKind, number>

interface LiveCue {
  index: number
  move: MoveKind
  detail: string
  feedback: RepFeedback
  atMs: number
}

/** The feed keeps this many reps; a long session drops the oldest. */
const MAX_CUES = 40

const IS_DEV = process.env.NODE_ENV === 'development'
// The detector readout (and the fps chip) are for diagnosing a missed or false move, so they show
// only on a development server opened with ?debug - never in a dancer's way, even in development.
// How often that readout refreshes. The detector itself runs every
// frame; only the React render is throttled, so the panel can't cost us camera fps.
const DEBUG_HZ = 5
// Pose missing for longer than this counts as tracking lost (matches the detectors' trackingGapMs).
const TRACKING_LOST_MS = 400

type Stage = 'idle' | 'starting' | 'active' | 'summary' | 'error'

/** Remembers, on this device, whether the dancer wants a highlight reel recorded. */
const RECORD_PREF_KEY = 'live.recordReel'
type Facing = 'user' | 'environment'
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
    body: 'Browsers only allow camera access over https or on localhost. In development, open http://localhost:3000 on this computer, or the https address npm run dev:phone prints on a phone.',
  },
  init: {
    title: 'Could not start the pose tracker',
    body: 'Something went wrong loading the pose model. Reload the page and try again.',
  },
}

/** The camera at 720p: the front one unless the dancer switched to the back one. */
function openCamera(facing: Facing) {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  })
}

export default function LiveClient() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  // One engine runs every detector and decides which move it was - the same class the
  // real-footage tests replay, so what is tested is what runs here.
  const engineRef = useRef<MoveEngine | null>(null)
  const rafRef = useRef<number>(0)
  const lastVideoTimeRef = useRef(-1)
  const lastPoseAtRef = useRef(0)
  const fpsSamplesRef = useRef<number[]>([])
  const lastFpsLogRef = useRef(0)
  const lastDebugAtRef = useRef(0)
  const repIndexRef = useRef(0)
  const lastAraAttemptRef = useRef(0)
  const droppedSeenRef = useRef(0)
  const facingRef = useRef<Facing>('user')
  const showDebugRef = useRef(false)
  // The session so far, for its summary: every move the engine decided, and - when recording -
  // the camera recording and the poses read from it, for the highlight reel.
  const eventsRef = useRef<MoveEvent[]>([])
  const posesRef = useRef<PoseLog>({ t: [], lm: [] })
  const recorderRef = useRef<SessionRecorder | null>(null)
  const sessionStartRef = useRef(0)
  const startedAtRef = useRef(new Date())

  const [stage, setStage] = useState<Stage>('idle')
  const [errorKind, setErrorKind] = useState<ErrorKind>('init')
  const [noDancer, setNoDancer] = useState(false)
  const [fps, setFps] = useState(0)
  const [tallies, setTallies] = useState<Record<MoveKind, number>>(NO_TALLIES)
  // Every rep's feedback, newest first, so a cue is still there to read after the next move.
  // `index` and `detail` are what make a repeated cue legible as a NEW rep: two reps with the
  // same fault produce the same cue text.
  const [cues, setCues] = useState<LiveCue[]>([])
  // The frame's shape, so the preview keeps the camera's proportions (a phone held upright
  // films portrait) and the skeleton canvas stays exactly on top of it.
  const [frame, setFrame] = useState({ w: 16, h: 9 })
  const [facing, setFacing] = useState<Facing>('user')
  const [canFlip, setCanFlip] = useState(false)
  const [flipping, setFlipping] = useState(false)
  const [debug, setDebug] = useState<JumpDebugState | null>(null)
  const [araDebug, setAraDebug] = useState<ArabesqueDebugState | null>(null)
  const [turnDebug, setTurnDebug] = useState<TurnDebugState | null>(null)
  const [recordPref, setRecordPref] = useState(true)
  const [recordSupported, setRecordSupported] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordCapped, setRecordCapped] = useState(false)
  const [summary, setSummary] = useState<LiveSessionData | null>(null)
  const [showDebug, setShowDebug] = useState(false)

  useEffect(() => () => {
    void recorderRef.current?.finish()
    releaseCamera()
  }, [])

  useEffect(() => {
    showDebugRef.current = IS_DEV && new URLSearchParams(window.location.search).has('debug')
    setShowDebug(showDebugRef.current)
  }, [])

  // Whether this browser can record and cut a reel, and what the dancer chose last time.
  useEffect(() => {
    setRecordSupported(recordingType() !== null && typeof HTMLCanvasElement.prototype.captureStream === 'function')
    try {
      if (localStorage.getItem(RECORD_PREF_KEY) === 'off') setRecordPref(false)
    } catch { /* storage unavailable: keep the default */ }
  }, [])

  function chooseRecording(on: boolean) {
    setRecordPref(on)
    try { localStorage.setItem(RECORD_PREF_KEY, on ? 'on' : 'off') } catch { /* not remembered */ }
  }

  // The screen stays on while a session runs.
  useWakeLock(stage === 'active')

  /**
   * Commit one confirmed rep. The running index is kept here rather than read off a
   * detector's own tally, which resets along with its rolling windows whenever tracking
   * drops — and it is what lets a repeated cue still read as a new rep.
   */
  function recordRep(ev: MoveEvent) {
    eventsRef.current.push(ev)
    repIndexRef.current += 1
    const move = ev.move
    setTallies((t) => ({ ...t, [move]: t[move] + 1 }))
    const cue = { index: repIndexRef.current, move, detail: ev.detail, feedback: feedbackFor(ev), atMs: Date.now() }
    setCues((all) => [cue, ...all].slice(0, MAX_CUES))
  }

  /** The camera off and the pose tracker closed. */
  function releaseCamera() {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    landmarkerRef.current?.close()
    landmarkerRef.current = null
    engineRef.current = null
    lastVideoTimeRef.current = -1
    fpsSamplesRef.current = []
  }

  /** Stop: the camera off, then the session's summary (and its highlight reel, if recorded). */
  async function finishSession() {
    const endMs = performance.now()
    cancelAnimationFrame(rafRef.current)
    // A move still being held back - an arabesque waiting to see whether a turn follows - is
    // decided now rather than lost.
    const engine = engineRef.current
    if (engine) for (const ev of engine.flush(endMs)) recordRep(ev)
    // The recording is closed before its camera is switched off, so its last part is whole.
    const rec = recorderRef.current
    recorderRef.current = null
    const parts = rec ? await rec.finish() : []
    releaseCamera()
    setRecording(false)
    setSummary({
      events: [...eventsRef.current],
      poses: posesRef.current,
      parts,
      type: rec && parts.length ? rec.type : null,
      startMs: sessionStartRef.current,
      endMs,
      capped: recordCapped,
      startedAt: startedAtRef.current,
    })
    setStage('summary')
  }

  /** Everything back to the start screen, the session discarded. */
  function resetSession() {
    void recorderRef.current?.finish()
    recorderRef.current = null
    releaseCamera()
    eventsRef.current = []
    posesRef.current = { t: [], lm: [] }
    setRecording(false)
    setRecordCapped(false)
    setSummary(null)
    setNoDancer(false)
    setTallies(NO_TALLIES)
    setCues([])
    setDebug(null)
    setAraDebug(null)
    setTurnDebug(null)
    repIndexRef.current = 0
    lastAraAttemptRef.current = 0
    droppedSeenRef.current = 0
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
        openCamera(facingRef.current),
        createPoseLandmarker(delegateFor('live')),
      ])
      streamRef.current = stream
      landmarkerRef.current = landmarker

      const video = videoRef.current!
      video.srcObject = stream
      await video.play()

      const canvas = canvasRef.current!
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      if (video.videoWidth > 0 && video.videoHeight > 0) setFrame({ w: video.videoWidth, h: video.videoHeight })
      // Landmarks come normalised separately in x and y, so the engine needs the frame's real
      // proportions to measure critique angles truly (the camera may not honour the 16:9 ask).
      engineRef.current = new MoveEngine(
        video.videoWidth > 0 && video.videoHeight > 0 ? { aspect: video.videoWidth / video.videoHeight } : {},
      )

      eventsRef.current = []
      posesRef.current = { t: [], lm: [] }
      startedAtRef.current = new Date()
      sessionStartRef.current = performance.now()
      // The highlight reel's recording, when the dancer wants one and the browser can.
      const type = recordPref && recordSupported ? recordingType() : null
      if (type) {
        try {
          const rec = new SessionRecorder(type)
          if (rec.start(stream, video.videoWidth, video.videoHeight)) {
            recorderRef.current = rec
            setRecording(true)
          }
        } catch (e) {
          console.warn('[live] recording unavailable', e)
        }
      }

      lastPoseAtRef.current = performance.now()
      setStage('active')
      rafRef.current = requestAnimationFrame(loop)
      // Phones have a back camera too; offer the switch only where there is one.
      navigator.mediaDevices.enumerateDevices().then(
        (devices) => setCanFlip(devices.filter((d) => d.kind === 'videoinput').length > 1),
        () => {},
      )
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

  /** Front camera to back or back to front, mid-session; the tallies and the feed carry on. */
  async function flipCamera() {
    const video = videoRef.current
    if (!video || flipping) return
    const from = facingRef.current
    setFlipping(true)
    // The recording's part on this camera is closed first; the other camera starts the next.
    const rec = recorderRef.current
    const wasRecording = !!rec?.recording
    rec?.endPart()
    // Phones often cannot open one camera while the other is still running, so stop it first.
    streamRef.current?.getTracks().forEach((t) => t.stop())
    for (const want of [from === 'user' ? 'environment' : 'user', from] as Facing[]) {
      try {
        const stream = await openCamera(want)
        streamRef.current = stream
        facingRef.current = want
        setFacing(want)
        video.srcObject = stream
        await video.play()
        // A different view of the dancer, maybe a different frame shape: nothing measured on the
        // last camera carries over.
        const canvas = canvasRef.current
        if (canvas && video.videoWidth > 0 && video.videoHeight > 0) {
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          setFrame({ w: video.videoWidth, h: video.videoHeight })
          engineRef.current = new MoveEngine({ aspect: video.videoWidth / video.videoHeight })
        }
        if (wasRecording) rec!.start(stream, video.videoWidth, video.videoHeight)
        setFlipping(false)
        return
      } catch {
        // fall back to the camera we had
      }
    }
    setFlipping(false)
    resetSession()
    setErrorKind('nocamera')
    setStage('error')
  }

  function loop() {
    const video = videoRef.current
    const canvas = canvasRef.current
    const landmarker = landmarkerRef.current
    let engine = engineRef.current
    if (!video || !canvas || !landmarker || !engine) return

    // Only run detection when the camera delivered a new frame — rAF often
    // ticks at 60 Hz against a 30 fps camera.
    if (video.currentTime !== lastVideoTimeRef.current && video.videoWidth > 0) {
      lastVideoTimeRef.current = video.currentTime

      // A phone turned on its side, or the other camera: the frame changed shape. The overlay
      // follows, and the engine starts over at the new proportions (it measures angles in true
      // frame units); the session's tallies and feed are kept.
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        setFrame({ w: video.videoWidth, h: video.videoHeight })
        engine = engineRef.current = new MoveEngine({ aspect: video.videoWidth / video.videoHeight })
        // A recorder cannot follow a change of shape: the recording goes on in a new part.
        const rec = recorderRef.current
        if (rec?.recording && video.srcObject instanceof MediaStream) rec.start(video.srcObject, video.videoWidth, video.videoHeight)
      }

      const t0 = performance.now()
      const result = landmarker.detectForVideo(video, t0)
      const now = performance.now()

      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      const lm = result.landmarks?.[0]
      // The poses go with the recording, to draw the skeleton over the highlight reel.
      const rec = recorderRef.current
      if (rec?.recording) {
        posesRef.current.t.push(t0)
        posesRef.current.lm.push(lm && lm.length ? packPose(lm) : null)
        if (rec.recordedMs() >= RECORD_LIMIT_MS) {
          rec.endPart()
          setRecording(false)
          setRecordCapped(true)
        }
      }
      if (lm && lm.length > 0) {
        // Data stays anatomical; only the draw step mirrors (x' = 1 - x)
        // to line up with the CSS-mirrored preview of the front camera.
        drawSkeleton(ctx, lm, canvas.width, canvas.height, facingRef.current === 'user')
        lastPoseAtRef.current = now
        setNoDancer(false)

        // Detection runs on the same anatomical (unmirrored) landmarks. The engine returns a
        // move only once it is decided — after a landing, at the end of a turn, or a moment
        // after an arabesque is reached - so the cue below is only ever reached by a move the
        // engine has identified. Everything else stays silent.
        const worldLm = result.worldLandmarks?.[0]
        for (const ev of engine.pushFrame(lm, t0, worldLm)) {
          recordRep(ev)
          if (IS_DEV) {
            const m = Object.entries(ev.metrics)
              .map(([k, v]) => `${k}=${v === null || v === undefined ? 'n/a' : Math.abs(v) < 3 ? v.toFixed(2) : v.toFixed(0)}`)
              .join(' ')
            console.log(`[live] ${ev.log}${m ? ` | ${m}` : ''}`)
          }
        }
        if (IS_DEV) {
          // What was seen and deliberately not counted - a sashay, a hop in a turn, an arabesque
          // that was really a preparation. This is what to paste when a move is missed.
          const dropped = engine.dropped
          for (let i = Math.max(0, droppedSeenRef.current - (dropped.length >= 200 ? 1 : 0)); i < dropped.length; i++) {
            console.log(`[live] not counted: ${dropped[i]}`)
          }
          droppedSeenRef.current = dropped.length
          const att = engine.arabesque.lastAttempt
          if (att && att.seq !== lastAraAttemptRef.current) {
            lastAraAttemptRef.current = att.seq
            console.log(
              `[live] arabesque NOT counted (${att.reason}) leg=${att.workingLeg ?? '?'} ` +
              `peak=${att.peakDeg.toFixed(1)}deg above-entry=${att.heldMs.toFixed(0)}ms ` +
              `settled=${att.plateauMs.toFixed(0)}ms ` +
              `floorLift=${Number.isFinite(att.floorLift) ? att.floorLift.toFixed(2) : 'n/a'} ` +
              `supportGap=${att.supportGap.toFixed(2)}`,
            )
          }
        }
      } else {
        // No pose on this frame. A single dropped frame is normal under motion blur, and it
        // happens most at take-off: resetting on it threw away every leap where MediaPipe
        // blinked for one frame (2 of 10 real split leaps were lost exactly this way). So a
        // short dropout is simply skipped. A real loss of tracking still resets everything —
        // each detector does that itself when the next frame arrives more than its
        // trackingGapMs later, and this resets them too once the gap is clearly long, so a
        // baseline never bridges the dancer leaving and re-entering the frame.
        if (now - lastPoseAtRef.current > TRACKING_LOST_MS) engine.reset()
        if (now - lastPoseAtRef.current > 1000) setNoDancer(true)
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
        // Raw signal + state-machine state, so a false positive can be diagnosed
        // against footage instead of guessed at.
        const det = engine.jump.debug
        if (showDebugRef.current && now - lastDebugAtRef.current > 1000 / DEBUG_HZ) {
          lastDebugAtRef.current = now
          setDebug(det)
          setAraDebug(engine.arabesque.debug)
          setTurnDebug(engine.turn.debug)
        }
        ;(window as unknown as Record<string, unknown>).__liveDebug = {
          fps: Math.round(f),
          lastLandmarks: lm ?? null,
          canvasWidth: canvas.width,
          detector: det,
          arabesque: engine.arabesque.debug,
          turn: engine.turn.debug,
        }
      }
    }

    rafRef.current = requestAnimationFrame(loop)
  }

  // Only the moves that have happened, so the row stays short however many kinds there are.
  const tallied = ALL_MOVES.filter((k) => tallies[k] > 0)

  // The summary is a results page: cream, at the upload results' width (its charts and the reel need it).
  if (stage === 'summary' && summary) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
        <LiveSummary data={summary} onDone={resetSession} />
        <Disclaimer />
      </div>
    )
  }

  return (
    // Cream like a session's own page: the title on the page, the cards straight on it.
    <div data-screen="cream" className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
      <ScreenColor color="#F8F3DE" />
      {/* While dancing, a phone gives the title's room to the video. */}
      <header className={`${stage === 'active' ? 'hidden sm:flex' : 'flex'} flex-wrap items-end justify-between gap-3`}>
        <div>
          <p className="eyebrow">Practice with your camera</p>
          <h1 className="mt-1 font-display text-5xl font-extrabold leading-[0.95] tracking-tight">
            Live <span className="text-rose-deep">coaching</span>
          </h1>
          <p className="mt-2 max-w-md text-muted">A cue after every leap, turn, kick and arabesque, then a summary of the whole session.</p>
        </div>
        {showDebug && stage === 'active' && <span className="chip bg-surface text-muted">{fps} fps</span>}
      </header>

      {/* Idle: explainer + start */}
      {stage === 'idle' && (
        <div className="card relative overflow-hidden p-6 sm:p-8">
          <div className="relative z-10 max-w-md space-y-4">
            <p className="text-lg font-semibold leading-snug">
              Dance in front of your camera and get a cue after every leap, turn, kick and arabesque.
            </p>
            <p className="text-muted">
              Your camera turns on only while a session is running, and all the tracking happens right
              here in your browser. When you stop, you get a summary of every move.
            </p>
            <p className="flex items-center gap-2 text-sm text-muted">
              <Icon name="info" size={16} className="shrink-0" />
              Stand back far enough that your whole body is visible, head to toe.
            </p>
            {recordSupported && (
              <button
                type="button"
                role="switch"
                aria-checked={recordPref}
                onClick={() => chooseRecording(!recordPref)}
                className="flex w-full items-start gap-3 rounded-3xl bg-teal-soft p-4 text-left"
              >
                <span className={`mt-0.5 flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${recordPref ? 'bg-ink' : 'bg-line'}`}>
                  <span className={`h-5 w-5 rounded-full bg-surface transition-transform ${recordPref ? 'translate-x-5' : ''}`} />
                </span>
                <span>
                  <span className="block font-bold">Record a highlight reel</span>
                  <span className="block text-sm text-muted">
                    Just your moves, cut together when you stop. It stays on this device unless you save the session.
                  </span>
                </span>
              </button>
            )}
          </div>
          <div className="mt-6 flex items-end justify-between gap-4">
            <button onClick={startSession} className="btn btn-sun px-8 py-4 text-base">
              <Icon name="camera" size={20} /> Start
            </button>
            <Mascot color="sun" width={150} look={-1} className="-mb-8 -mr-2 animate-bob" />
          </div>
        </div>
      )}

      {/* Starting */}
      {stage === 'starting' && (
        <div className="card flex items-center gap-3 p-6 text-muted">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-ink border-t-transparent" />
          Waking up the camera…
        </div>
      )}

      {/* Error states */}
      {stage === 'error' && (
        <div className="space-y-4 rounded-[var(--radius-card)] bg-blush p-6">
          <p className="font-display text-xl font-extrabold text-berry">{ERROR_COPY[errorKind].title}</p>
          <p>{ERROR_COPY[errorKind].body}</p>
          <button onClick={startSession} className="btn btn-dark">Try again</button>
        </div>
      )}

      {/* Active: the camera (mirrored when it is the front one) + skeleton overlay */}
      <div className={stage === 'active' ? 'space-y-4' : 'hidden'}>
        {/* Up here rather than under the feed, which grows with every rep. */}
        <div className="flex items-start gap-2">
          <div className="flex min-h-11 flex-1 flex-wrap items-center gap-1.5">
            {tallied.length > 0 ? (
              tallied.map((k) => (
                <span key={k} className="chip bg-surface">
                  {MOVE_TALLY[k]} <span className="font-extrabold">{tallies[k]}</span>
                </span>
              ))
            ) : (
              <span className="chip bg-surface text-muted">Ready when you are — dance!</span>
            )}
          </div>
          {recording && (
            <span className="chip shrink-0 self-center bg-blush text-berry" title="Recording for your highlight reel">
              <span className="h-2 w-2 animate-pulse rounded-full bg-berry" aria-hidden />
              Rec
            </span>
          )}
          {canFlip && (
            <button
              onClick={flipCamera}
              disabled={flipping}
              className="icon-btn shrink-0 disabled:opacity-45"
              aria-label={facing === 'user' ? 'Use the back camera' : 'Use the front camera'}
              title={facing === 'user' ? 'Use the back camera' : 'Use the front camera'}
            >
              <Icon name="flip" size={20} />
            </button>
          )}
          <button onClick={finishSession} className="btn btn-outline shrink-0 py-2.5">
            Stop
          </button>
        </div>

        <div className="card p-2">
          {/* Sized to the camera's proportions and never taller than most of the screen, so on a
              phone held upright the whole frame (and the cue on it) is in view at once. */}
          <div
            className="relative mx-auto max-w-full overflow-hidden rounded-[1.25rem] bg-ink"
            style={{ aspectRatio: `${frame.w} / ${frame.h}`, width: `min(100%, calc(70svh * ${frame.w / frame.h}))` }}
          >
            {/* The front camera is mirrored like a dance-studio mirror — dancers expect this. */}
            <video
              ref={videoRef}
              playsInline
              muted
              className="absolute inset-0 h-full w-full"
              style={{ transform: facing === 'user' ? 'scaleX(-1)' : undefined }}
            />
            <canvas
              ref={canvasRef}
              className="pointer-events-none absolute inset-0 h-full w-full"
            />
            {/* On a phone the feed is below the fold, so the newest cue shows on the video for a
                few seconds. The feed under the video announces it to screen readers. */}
            {cues[0] && (
              <div key={cues[0].index} className="animate-flash absolute inset-x-3 top-3 sm:hidden" aria-hidden>
                <div className="rounded-2xl bg-surface/95 px-4 py-3 shadow-[0_8px_24px_rgba(30,28,25,0.25)]">
                  <p className="text-xs font-bold text-muted">
                    #{cues[0].index} · {MOVE_LABEL[cues[0].move]}{MOVE_VERB[cues[0].move]}
                  </p>
                  <p className="font-display text-lg font-extrabold leading-snug">{headline(cues[0].feedback)}</p>
                </div>
              </div>
            )}
            {noDancer && (
              <div className="absolute inset-x-0 bottom-4 flex justify-center">
                <span className="chip bg-sun px-4 py-2 text-sm font-bold">
                  Step back — I can&rsquo;t see you
                </span>
              </div>
            )}
          </div>
        </div>

        {cues.length > 0 && (
          <section className="space-y-3" aria-label="Feedback, newest first" aria-live="polite">
            <div className="flex items-baseline justify-between px-1">
              <h2 className="font-display text-xl font-extrabold">Feedback</h2>
              <span className="text-sm text-muted">Newest first</span>
            </div>
            {cues.map((cue, i) => (
              <LiveCueCard key={cue.index} cue={cue} latest={i === 0} />
            ))}
          </section>
        )}

        {/* Detector readout: raw signal + state machine, for diagnosing false positives against
            footage. Only on a development server opened with ?debug; never in production. */}
        {showDebug && debug && (
          <div className="overflow-x-auto rounded-2xl bg-ink p-3 font-mono text-[11px] leading-relaxed text-white">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>phase=<b className="text-sun">{debug.phase}</b></span>
              <span>reject={debug.lastReject ?? '—'}</span>
              <span>reps={debug.reps}</span>
              <span>cand={debug.candidateFrames}</span>
              <span>flight={debug.flightFrames}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              <span>hipRise={debug.hipRise.toFixed(4)}</span>
              <span>ankleRise={debug.ankleRise.toFixed(4)}</span>
              <span>
                ratio=
                <b className={debug.ankleRatio >= 0.7 ? 'text-sun' : ''}>
                  {debug.ankleRatio.toFixed(2)}
                </b>
                /0.70
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              <span>enter={debug.enterThreshold.toFixed(4)}</span>
              <span>exit={debug.exitThreshold.toFixed(4)}</span>
              <span>scale={Number.isFinite(debug.bodyScale) ? debug.bodyScale.toFixed(3) : 'n/a'}</span>
              <span>hips={debug.hipsVisible ? 'ok' : 'LOW'}</span>
              <span>ankles={debug.anklesVisible ? 'ok' : 'LOW'}</span>
            </div>
          </div>
        )}

        {showDebug && araDebug && (
          <div className="overflow-x-auto rounded-2xl bg-ink p-3 font-mono text-[11px] leading-relaxed text-white">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span className="text-sun">arabesque</span>
              <span>phase=<b className="text-sun">{araDebug.phase}</b></span>
              <span>reject={araDebug.lastReject ?? '—'}</span>
              <span>holds={araDebug.reps}</span>
              <span>leg={araDebug.workingLeg ?? '—'}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              <span>
                arabesque=
                <b className={araDebug.arabesqueDeg >= araDebug.enterDeg ? 'text-sun' : ''}>
                  {araDebug.arabesqueDeg.toFixed(0)}&deg;
                </b>
                /{araDebug.enterDeg.toFixed(0)}&deg;
              </span>
              <span>exit={araDebug.exitDeg.toFixed(0)}&deg;</span>
              <span>supportGap={araDebug.supportGap.toFixed(2)}</span>
              <span>held={Math.round(araDebug.heldMs)} ms</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              <span>torso={Number.isFinite(araDebug.bodyScale) ? araDebug.bodyScale.toFixed(3) : 'n/a'}</span>
              <span>legs={araDebug.legsVisible ? 'ok' : 'LOW'}</span>
              <span>floor={Number.isFinite(araDebug.floorLift) ? araDebug.floorLift.toFixed(2) : 'n/a'}</span>
              <span>plateau={Math.round(araDebug.plateauMs)} ms</span>
              <span>enter={araDebug.enteringFrames}</span>
              <span>hold={araDebug.holdFrames}</span>
            </div>
          </div>
        )}

        {showDebug && turnDebug && (
          <div className="overflow-x-auto rounded-2xl bg-ink p-3 font-mono text-[11px] leading-relaxed text-white">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span className="text-sun">turn</span>
              <span>phase=<b className="text-sun">{turnDebug.phase}</b></span>
              <span>reject={turnDebug.lastReject ?? '—'}</span>
              <span>turns={turnDebug.reps}</span>
              <span>omega={Math.round(turnDebug.omegaDegPerS)}&deg;/s</span>
              <span>rotated={Math.round(turnDebug.rotationDeg)}&deg;</span>
            </div>
          </div>
        )}
      </div>

      <Disclaimer />
    </div>
  )
}

function Disclaimer() {
  return (
    <p className="text-xs text-muted">
      Webcam form feedback is approximate and depends on lighting and camera angle.
      It&rsquo;s a practice aid, not medical or safety advice.
    </p>
  )
}

/** One rep's feedback in the Live feed. The newest one is marked, the rest stay readable. */
function LiveCueCard({ cue, latest }: { cue: LiveCue; latest: boolean }) {
  const praise = cue.feedback.kind === 'praise'
  return (
    <div className={`card p-5 ${praise ? 'ring-2 ring-olive' : ''}`}>
      <div className="flex items-start gap-4">
        <MoveIcon move={cue.move} family={MOVE_FAMILY[cue.move]} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-display text-lg font-extrabold">
              {MOVE_LABEL[cue.move]}
              {MOVE_VERB[cue.move]}
            </span>
            <span className="text-sm text-muted">#{cue.index} · {cue.detail}</span>
            {latest && <span className="chip bg-sun px-2.5 py-0.5 text-xs">Latest</span>}
          </p>
          <Feedback fb={cue.feedback} drill={false} />
        </div>
        {cue.feedback.kind === 'praise' && (
          <span className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-full bg-olive-soft">
            <span className="text-base font-extrabold leading-none">{cue.feedback.score}</span>
            <span className="text-[10px] font-semibold text-olive-deep">/100</span>
          </span>
        )}
      </div>
    </div>
  )
}

/** The one line of a rep's feedback that fits over the video on a phone. */
function headline(fb: RepFeedback): string {
  return fb.kind === 'unassessable' ? 'Counted, but too quick to judge' : fb.cue
}
