'use client'
// Upload: the clip is analysed right here in the browser by the same pose model and MoveEngine
// /live runs (lib/upload/analyzeVideo.ts), so an upload gets exactly the moves and coaching the
// real-footage tests verify. The result is then saved to the user's sessions.
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'
import { createPoseLandmarker, delegateFor } from '@/lib/live/pose'
import {
  AnalysisError, MAX_DURATION_S, MAX_FILE_BYTES, analyzeVideo, captureFrame, loadVideo,
  type AnalysisProgress,
} from '@/lib/upload/analyzeVideo'
import { buildReport, type SessionReport } from '@/lib/upload/report'
import { trackToGzip, type PoseTrack } from '@/lib/upload/poseTrack'
import { listSessions, saveSession, useAuthToken, type SessionSummary } from '@/lib/sessions'
import { useWakeLock } from '@/lib/useWakeLock'
import Results from '@/components/results/Results'
import { drawPoseOver } from '@/components/results/SkeletonVideo'
import { useSessionActions } from '@/components/sessions/SessionCards'
import Icon from '@/components/ui/Icon'
import Mascot from '@/components/ui/Mascot'
import ScreenColor from '@/components/ui/ScreenColor'
import { CoachedMoves, LatestSession, PracticeStats, Tips, useToday } from './HomeParts'

type Stage = 'idle' | 'analyzing' | 'done' | 'error'
type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; id: string } | { kind: 'failed'; message: string }

const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i

function checkFile(f: File): string | null {
  if (!VIDEO_EXT.test(f.name) && !f.type.startsWith('video/')) return 'That doesn’t look like a video. Pick an .mp4, .mov or .webm file.'
  if (!VIDEO_EXT.test(f.name)) return 'Only .mp4, .mov, .m4v and .webm videos can be saved.'
  if (f.size > MAX_FILE_BYTES) return `That file is ${(f.size / 1024 / 1024).toFixed(0)} MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`
  return null
}

/** The moment that best shows the clip: the top-scoring move, else the first move, else 1 s in. */
function thumbTime(report: SessionReport): number {
  const scored = report.moves.filter((m) => m.score !== null)
  const pick = scored.length ? scored.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a)) : report.moves[0]
  return pick ? (pick.start_s + pick.end_s) / 2 : Math.min(1, report.duration_s / 2)
}

export default function AnalyzeClient() {
  const { token, ready } = useAuthToken()

  const [stage, setStage] = useState<Stage>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<AnalysisProgress | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [report, setReport] = useState<SessionReport | null>(null)
  const [track, setTrack] = useState<PoseTrack | null>(null)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [recent, setRecent] = useState<SessionSummary[]>([])
  const [recentLoading, setRecentLoading] = useState(true)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const today = useToday()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const pendingSave = useRef<{ thumb: Blob | null; pose: Blob | null } | null>(null)
  const actions = useSessionActions(token, setRecent)

  const refreshRecent = useCallback((tok: string) => {
    listSessions(tok)
      .then((all) => setRecent(all))
      .catch(() => { /* the row just stays empty */ })
      .finally(() => setRecentLoading(false))
  }, [])

  useEffect(() => {
    // A file picked before hydration finished: the input holds it, but React never saw onChange.
    const pre = fileInputRef.current?.files?.[0]
    if (pre) pickFile(pre)
  }, [])

  useEffect(() => {
    if (!ready) return
    if (token) refreshRecent(token)
    else setRecentLoading(false)
  }, [ready, token, refreshRecent])

  // Leaving the page mid-analysis stops it; the run then frees its model.
  useEffect(() => () => abortRef.current?.abort(), [])

  // A phone that locks its screen pauses the video, and the analysis with it.
  useWakeLock(stage === 'analyzing')

  // The object URL lives as long as the results that play it.
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl) }, [videoUrl])

  function pickFile(f: File | null) {
    setFileError(null)
    if (!f) {
      setFile(null)
      return
    }
    const problem = checkFile(f)
    if (problem) {
      setFile(null)
      setFileError(problem)
      return
    }
    setFile(f)
  }

  function drawPose(lm: NormalizedLandmark[] | null) {
    if (videoRef.current && canvasRef.current) drawPoseOver(canvasRef.current, videoRef.current, lm)
  }

  // The analysis runs once its video element is on the page: browsers only present frames - and
  // so only fire requestVideoFrameCallback - for a video in the document.
  useEffect(() => {
    if (stage !== 'analyzing' || !file || !videoRef.current) return
    const video = videoRef.current
    const abort = new AbortController()
    abortRef.current = abort
    const url = URL.createObjectURL(file)
    let cancelled = false

    // Each run owns its model: in development React runs this effect twice, and the first run
    // must not close the second's.
    let landmarker: PoseLandmarker | null = null
    ;(async () => {
      try {
        ;[landmarker] = await Promise.all([createPoseLandmarker(delegateFor('upload')), loadVideo(video, url)])
        if (abort.signal.aborted) throw new AnalysisError('aborted', 'Analysis canceled.')
        // In development a phone's console reaches the dev server's log, so how far an upload got,
        // and what the frame walk had to work around, can be read there.
        const dev = process.env.NODE_ENV === 'development'
        let loggedAt = -Infinity
        const result = await analyzeVideo(video, landmarker, {
          signal: abort.signal,
          onProgress: (p) => {
            setProgress(p)
            if (dev && performance.now() - loggedAt > 5000) {
              loggedAt = performance.now()
              console.log(`[upload] ${p.mediaS.toFixed(1)} s of ${p.durationS.toFixed(1)} s read, ${p.frames} frames`)
            }
          },
          onFrame: (lm) => drawPose(lm),
          onNote: dev ? (m) => console.log(`[upload] ${m}`) : undefined,
        })
        landmarker.close()
        landmarker = null
        const rep = buildReport(result.events, result.durationMs)
        if (process.env.NODE_ENV === 'development') {
          // What the analysis saw, for checking an upload against its footage (and for tests that
          // drive this page).
          ;(window as unknown as Record<string, unknown>).__uploadDebug = {
            report: rep,
            frames: result.frames,
            framesWithPose: result.framesWithPose,
            walk: result.walk,
            size: [result.width, result.height],
            delegate: delegateFor('upload'),
            dropped: result.dropped,
          }
          console.log(`[upload] ${result.frames} frames (${result.framesWithPose} with a pose), ` +
            `${result.walk.recovered} recovered, ${result.walk.gaps} gaps; ${rep.moves.length} moves`)
        }
        // The thumbnail and the pose track are made now, while this element still holds the video.
        const [thumb, pose] = await Promise.all([
          captureFrame(video, thumbTime(rep)).catch(() => null),
          trackToGzip(result.track).catch(() => null),
        ])
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        pendingSave.current = { thumb, pose }
        setReport(rep)
        setTrack(result.track)
        setVideoUrl(url)
        setStage('done')
      } catch (e) {
        ;(landmarker as PoseLandmarker | null)?.close()
        URL.revokeObjectURL(url)
        if (cancelled) return
        if (e instanceof AnalysisError && e.kind === 'aborted') {
          setStage('idle')
          return
        }
        setErrorMsg(e instanceof AnalysisError ? e.message : 'Something went wrong while analyzing the video. Please try again.')
        setStage('error')
        if (!(e instanceof AnalysisError)) console.error('[upload] analysis failed', e)
      }
    })()

    return () => {
      cancelled = true
      abort.abort()
    }
  }, [stage, file])

  // Save as soon as there is something to save.
  useEffect(() => {
    if (stage !== 'done' || !report || !file || save.kind !== 'idle' || !ready) return
    if (!token) {
      setSave({ kind: 'failed', message: 'Sign in to save this session.' })
      return
    }
    void doSave(token, file, report)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, report, file, token, ready])

  async function doSave(tok: string, f: File, rep: SessionReport) {
    setSave({ kind: 'saving' })
    try {
      const parts = pendingSave.current ?? { thumb: null, pose: null }
      const saved = await saveSession(tok, { video: f, report: rep, ...parts })
      setSave({ kind: 'saved', id: saved.id })
      refreshRecent(tok)
    } catch (e) {
      setSave({ kind: 'failed', message: e instanceof Error ? e.message : 'Saving failed.' })
    }
  }

  function start() {
    if (!file) return
    setErrorMsg(null)
    setProgress(null)
    setReport(null)
    setTrack(null)
    setSave({ kind: 'idle' })
    setStage('analyzing')
  }

  function reset() {
    abortRef.current?.abort()
    setStage('idle')
    setFile(null)
    setFileError(null)
    setProgress(null)
    setReport(null)
    setTrack(null)
    setVideoUrl(null)
    setSave({ kind: 'idle' })
    pendingSave.current = null
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // ── Results ─────────────────────────────────────────────────────────────────────────────
  if (stage === 'done' && report) {
    return (
      <div data-screen="cream" className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
        <ScreenColor color="#F8F3DE" />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="eyebrow">Results</p>
            <h1 className="font-display text-4xl font-extrabold tracking-tight sm:text-5xl">
              Your <span className="text-rose-deep">coaching</span>
            </h1>
            {file && <p className="mt-1 truncate text-muted">{file.name}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SaveStatus save={save} onRetry={() => token && file && doSave(token, file, report)} />
            <button onClick={reset} className="btn btn-dark btn-sm">
              <Icon name="upload" size={16} /> Analyze another
            </button>
          </div>
        </div>
        <Results report={report} videoSrc={videoUrl} track={track} />
      </div>
    )
  }

  // ── Analysing ───────────────────────────────────────────────────────────────────────────
  if (stage === 'analyzing') {
    const pct = Math.round((progress?.fraction ?? 0) * 100)
    return (
      <div data-screen="cream" className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <ScreenColor color="#F8F3DE" />
        <div className="card space-y-5 p-4 sm:p-6">
          <div className="flex items-end justify-between gap-4 px-1">
            <div>
              <p className="eyebrow">{progress ? 'Analyzing' : 'Getting ready'}</p>
              <h1 className="font-display text-2xl font-extrabold sm:text-3xl">Watching your dancing…</h1>
            </div>
            <p className="text-4xl font-extrabold">{pct}%</p>
          </div>
          <div
            className="h-3 overflow-hidden rounded-full bg-sunken"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Analysis progress"
          >
            <div className="h-full rounded-full bg-sun transition-[width] duration-200" style={{ width: `${pct}%` }} />
          </div>
          <p className="px-1 text-sm text-muted">
            {progress
              ? `${progress.mediaS.toFixed(1)} s of ${progress.durationS.toFixed(1)} s · ${progress.moves} move${progress.moves === 1 ? '' : 's'} found so far`
              : 'Loading the pose tracker…'}
          </p>
          <div className="relative overflow-hidden rounded-[1.25rem] bg-ink">
            <video ref={videoRef} muted playsInline className="block max-h-[60vh] w-full" />
            <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-1">
            <p className="flex items-center gap-2 text-sm text-muted">
              <Icon name="info" size={16} className="shrink-0" />
              It all happens in your browser. Keep this tab in front until it finishes.
            </p>
            <button onClick={() => abortRef.current?.abort()} className="btn btn-quiet btn-sm">Cancel</button>
          </div>
        </div>
      </div>
    )
  }

  // ── Home: hello, the practice numbers, and a clip to analyze ────────────────────────────
  return (
    <div data-screen="home" className="flex flex-1 flex-col">
      <ScreenColor color="#E76E84" />
      {actions.dialogs}

      {/* The rose header: hello, and the quickest way into Live. Pip sits on the sheet's edge. */}
      <header className="relative mx-auto w-full max-w-5xl px-5 pb-14 pt-2 sm:px-6 sm:pb-16 sm:pt-6">
        <p className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
          {today?.greeting ?? 'Hello'}{' '}
          <span aria-hidden className="inline-block origin-[70%_75%] animate-wave">👋</span>
        </p>
        <p className="mt-1 min-h-6 font-semibold">{today?.date ?? ''}</p>
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 pr-28 sm:pr-0">
          <Link href="/live" className="btn btn-dark">
            <span className="h-2.5 w-2.5 rounded-full bg-gold" aria-hidden /> Start live coaching
          </Link>
          <a href="#upload" className="flex items-center gap-1.5 text-sm font-bold underline-offset-4 hover:underline">
            Upload a clip <Icon name="arrowRight" size={16} />
          </a>
        </div>
        <Mascot color="sun" width={124} look={-0.7} className="absolute -bottom-1 right-3 animate-bob sm:right-8 sm:h-auto sm:w-[168px]" />
      </header>

      {/* The cream sheet over it, down to the bottom of the screen. */}
      <div className="sheet relative z-10 -mt-6 flex-1">
        <div className="mx-auto max-w-5xl space-y-6 px-4 pb-[calc(8rem+env(safe-area-inset-bottom))] sm:px-6 sm:pb-16">
          <section className="space-y-5 px-1">
            <h1 className="font-display text-5xl font-extrabold leading-[0.95] tracking-tight sm:text-6xl">
              Ready to <span className="text-rose-deep">dance?</span>
            </h1>
            <PracticeStats sessions={recent} loading={recentLoading} />
          </section>

          {stage === 'error' && errorMsg && (
            <div className="flex items-start gap-3 rounded-[var(--radius-card)] bg-blush p-5">
              <Icon name="info" size={22} className="mt-0.5 shrink-0 text-berry" />
              <div>
                <p className="font-bold text-berry">That didn&rsquo;t work</p>
                <p className="text-sm">{errorMsg}</p>
              </div>
            </div>
          )}

          {/* On a wide screen both columns stretch to the row, so the boxes end level. */}
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-stretch">
            {/* Analyze a clip: gold, like the reference's playful block. */}
            <section id="upload" className="relative scroll-mt-24 overflow-hidden rounded-[2rem] bg-gold p-5 sm:p-7" aria-label="Analyze a clip">
              <span aria-hidden className="absolute -right-12 -top-16 h-48 w-48 rounded-full bg-surface/25" />
              <span aria-hidden className="absolute -bottom-20 -left-12 h-40 w-40 rounded-full bg-rose/25" />
              <div className="relative space-y-5">
                <div className="flex items-center gap-4">
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-surface shadow-[0_6px_16px_rgba(42,34,36,0.12)]">
                    <Icon name="upload" size={24} />
                  </span>
                  <div>
                    <h2 className="font-display text-2xl font-extrabold leading-tight">Analyze a clip</h2>
                    <p className="text-sm">Every leap, turn and balance in it, coached move by move.</p>
                  </div>
                </div>

                <label
                  htmlFor="video-input"
                  onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragging(false)
                    pickFile(e.dataTransfer.files?.[0] ?? null)
                  }}
                  className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[1.5rem] border-2 border-dashed px-5 py-9 text-center transition-colors focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-ink ${
                    dragging ? 'border-ink bg-surface/90' : 'border-ink/25 bg-surface/55 hover:bg-surface/75'
                  }`}
                >
                  <span className="block font-display text-lg font-extrabold">Drop your video here</span>
                  <span className="text-sm">
                    or <span className="font-bold underline underline-offset-2">browse your files</span>
                  </span>
                  <span className="text-xs">MP4, MOV or WebM · up to {MAX_DURATION_S} seconds · {MAX_FILE_BYTES / 1024 / 1024} MB</span>
                  <input
                    id="video-input"
                    ref={fileInputRef}
                    type="file"
                    accept="video/mp4,video/quicktime,video/webm,video/*"
                    className="sr-only"
                    onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                  />
                </label>

                {file && (
                  <div className="flex items-center gap-3 rounded-full bg-surface py-2 pl-2 pr-2.5">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-soft text-rose-deep">
                      <Icon name="play" size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{file.name}</span>
                      <span className="text-xs text-muted">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                    </span>
                    <button onClick={() => { pickFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }} className="icon-btn h-9 w-9" aria-label="Remove this video">
                      <Icon name="x" size={18} />
                    </button>
                  </div>
                )}
                {fileError && (
                  <p className="flex items-start gap-2 rounded-2xl bg-surface px-3 py-2 text-sm font-semibold text-berry">
                    <Icon name="info" size={16} className="mt-0.5 shrink-0" /> {fileError}
                  </p>
                )}

                {/* Never a dead button: with no video yet, it opens the picker. */}
                {file ? (
                  <button onClick={start} className="btn btn-dark w-full py-4 text-base">
                    Analyze my dancing <Icon name="arrowRight" size={18} />
                  </button>
                ) : (
                  <button onClick={() => fileInputRef.current?.click()} className="btn btn-dark w-full py-4 text-base">
                    <Icon name="upload" size={18} /> Choose a video
                  </button>
                )}
              </div>
            </section>

            <div className="flex flex-col gap-6">
              <LatestSession session={recent[0]} loading={recentLoading} />
              <Tips className="lg:flex-1" />
            </div>
          </div>

          <CoachedMoves />
        </div>
      </div>
    </div>
  )
}

function SaveStatus({ save, onRetry }: { save: SaveState; onRetry: () => void }) {
  switch (save.kind) {
    case 'saving':
      return (
        <span className="chip bg-surface text-muted">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
          Saving…
        </span>
      )
    case 'saved':
      return (
        <Link href={`/session/${save.id}`} className="chip chip-btn bg-olive-soft text-olive-deep hover:brightness-95">
          <Icon name="check" size={14} strokeWidth={3} /> Saved to your sessions
        </Link>
      )
    case 'failed':
      return (
        <span className="chip bg-blush text-berry" title={save.message}>
          Not saved
          <button onClick={onRetry} className="underline underline-offset-2">Retry</button>
        </span>
      )
    default:
      return null
  }
}
