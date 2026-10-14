'use client'
// The end of a /live session: the same results an upload gets (score, what to work on first, every
// move with its feedback), over a highlight reel of just the moves when the session was recorded.
// The reel is cut here in the browser (lib/live/reel.ts); nothing leaves the device until Save.
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MoveEvent } from '@/lib/live/moveEngine'
import { metricScores } from '@/lib/live/scoring'
import { highlightSegments, liveReport, reelTrack, type PoseLog } from '@/lib/live/highlights'
import { cutReel, type Reel } from '@/lib/live/reel'
import { RECORD_LIMIT_MS, extensionFor, type RecordedPart } from '@/lib/live/recorder'
import { trackToGzip, type PoseTrack } from '@/lib/upload/poseTrack'
import { saveSession, useAuthToken } from '@/lib/sessions'
import Results from '@/components/results/Results'
import Icon from '@/components/ui/Icon'
import Mascot from '@/components/ui/Mascot'
import ScreenColor from '@/components/ui/ScreenColor'

/** Everything a finished /live session leaves behind, on the session clock (performance.now()). */
export interface LiveSessionData {
  events: MoveEvent[]
  poses: PoseLog
  parts: RecordedPart[]
  /** The recording's format, or null when the session was not recorded. */
  type: string | null
  startMs: number
  endMs: number
  /** Recording stopped at RECORD_LIMIT_MS while the session went on. */
  capped: boolean
  startedAt: Date
}

type ReelState =
  | { kind: 'none' }
  | { kind: 'cutting'; progress: number }
  | { kind: 'ready'; reel: Reel; url: string; track: PoseTrack }
  | { kind: 'failed' }
type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; id: string } | { kind: 'failed'; message: string }

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/** The moment that best shows the session, for the thumbnail: the middle of its best-scored move. */
function bestMomentMs(events: readonly MoveEvent[]): number | undefined {
  let best: MoveEvent | undefined
  let bestScore = -1
  for (const ev of events) {
    const s = Object.values(metricScores(ev.metrics))
    const score = s.length ? mean(s) : 0
    if (!best || score > bestScore) {
      best = ev
      bestScore = score
    }
  }
  return best && (best.startMs + best.endMs) / 2
}

function formatSpan(s: number): string {
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return r ? `${m} min ${r} s` : `${m} min`
}

export default function LiveSummary({ data, onDone }: { data: LiveSessionData; onDone: () => void }) {
  const { token, ready } = useAuthToken()
  const previewRef = useRef<HTMLVideoElement>(null)
  const segments = useMemo(() => highlightSegments(data.events, data.parts), [data])
  const [reel, setReel] = useState<ReelState>(
    data.type && segments.length ? { kind: 'cutting', progress: 0 } : { kind: 'none' },
  )
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const reelUrl = reel.kind === 'ready' ? reel.url : null

  // Cut the reel once. React's development double-mount rehearses an unmount and comes straight
  // back, so the job is only abandoned if the component is still gone a tick later.
  const job = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    if (!job.current && reel.kind === 'cutting' && data.type) {
      const abort = new AbortController()
      job.current = abort
      const type = data.type
      cutReel(previewRef.current!, data.parts, segments, type, {
        signal: abort.signal,
        thumbAtMs: bestMomentMs(data.events),
        onProgress: (p) => { if (!abort.signal.aborted) setReel({ kind: 'cutting', progress: p }) },
      }).then(
        (r) => {
          if (abort.signal.aborted) return
          setReel({ kind: 'ready', reel: r, url: URL.createObjectURL(r.blob), track: reelTrack(data.poses, r, r.boxes) })
        },
        (e) => {
          if (abort.signal.aborted) return
          console.error('[live] the highlight reel could not be cut', e)
          setReel({ kind: 'failed' })
        },
      )
    }
    return () => {
      mounted.current = false
      setTimeout(() => { if (!mounted.current) job.current?.abort() }, 0)
    }
    // Once per session: `data` does not change while this is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => { if (reelUrl) URL.revokeObjectURL(reelUrl) }, [reelUrl])

  const report = useMemo(
    () => liveReport(data.events, data, reel.kind === 'ready' ? reel.reel : null),
    [data, reel],
  )
  const praised = report.moves.filter((m) => m.feedback.kind === 'praise').length

  async function doSave() {
    if (save.kind === 'saving' || save.kind === 'saved') return
    if (!ready || !token) {
      setSave({ kind: 'failed', message: 'Sign in to save this session.' })
      return
    }
    setSave({ kind: 'saving' })
    try {
      const day = data.startedAt.toISOString().slice(0, 10)
      const r = reel.kind === 'ready' ? reel : null
      const saved = await saveSession(token, {
        video: r ? new File([r.reel.blob], `live-highlights-${day}.${extensionFor(r.reel.type)}`, { type: r.reel.type }) : null,
        report,
        thumb: r?.reel.thumb ?? null,
        pose: r ? await trackToGzip(r.track).catch(() => null) : null,
      })
      setSave({ kind: 'saved', id: saved.id })
    } catch (e) {
      setSave({ kind: 'failed', message: e instanceof Error ? e.message : 'Saving failed.' })
    }
  }

  const when = data.startedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const moves = data.events.length

  if (moves === 0) {
    return (
      <div className="card flex flex-col items-start gap-6 p-6 sm:flex-row sm:items-center sm:p-8">
        <Mascot color="lilac" width={120} look={-1} mood="sleepy" />
        <div className="space-y-3">
          <h2 className="font-display text-2xl font-extrabold">No moves counted this time</h2>
          <p className="text-muted">
            I count split, switch, calypso, russian, firebird, tilt, switch tilt and switch arabesque leaps;
            pirouettes, à la seconde, changing-spot, chaîné and piqué turns; front and side battements, fan
            kicks and illusions; arabesques and straight jumps, with your whole body in frame, head to toe.
          </p>
          <button onClick={onDone} className="btn btn-sun">
            <Icon name="camera" size={18} /> Start a new session
          </button>
        </div>
      </div>
    )
  }

  return (
    <div data-screen="cream" className="space-y-6">
      <ScreenColor color="#F8F3DE" />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Live session · today at {when}</p>
          <h1 className="mt-1 font-display text-4xl font-extrabold leading-[0.95] tracking-tight sm:text-5xl">
            Session <span className="text-rose-deep">summary</span>
          </h1>
          <p className="mt-2 text-muted">
            Danced {formatSpan((data.endMs - data.startMs) / 1000)} · {moves} move{moves === 1 ? '' : 's'}
            {praised > 0 && ` · ${praised} with nothing to correct`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {save.kind === 'saved' ? (
            <Link href={`/session/${save.id}`} className="btn btn-dark">
              <Icon name="check" size={18} /> Saved · open in Sessions
            </Link>
          ) : (
            <button onClick={doSave} disabled={save.kind === 'saving' || reel.kind === 'cutting'} className="btn btn-sun">
              {save.kind === 'saving' ? 'Saving…' : 'Save to Sessions'}
            </button>
          )}
          {reel.kind === 'ready' && (
            <a
              href={reel.url}
              download={`live-highlights-${data.startedAt.toISOString().slice(0, 10)}.${extensionFor(reel.reel.type)}`}
              className="btn btn-outline"
            >
              Download reel
            </a>
          )}
          <button onClick={onDone} className="btn btn-quiet">New session</button>
        </div>
      </div>

      {save.kind === 'failed' && (
        <p className="rounded-3xl bg-blush px-4 py-3 text-sm text-berry">{save.message}</p>
      )}

      {reel.kind === 'cutting' && (
        <section className="card grid items-center gap-5 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:p-6" aria-live="polite">
          <div className="space-y-3">
            <p className="eyebrow">Highlight reel</p>
            <p className="font-display text-2xl font-extrabold">Cutting out the in-between…</p>
            <p className="text-muted">Only your moves go in, each with its run-up and its finish.</p>
            <div className="h-3 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(reel.progress * 100)}>
              <div className="h-full rounded-full bg-sun transition-[width]" style={{ width: `${Math.round(reel.progress * 100)}%` }} />
            </div>
          </div>
          <video ref={previewRef} muted playsInline className="max-h-52 w-full rounded-[1.25rem] bg-ink object-contain sm:w-72" />
        </section>
      )}

      {reel.kind === 'none' && !data.type && (
        <p className="flex items-start gap-2 rounded-3xl bg-surface px-4 py-3 text-sm text-muted">
          <Icon name="info" size={18} className="mt-0.5 shrink-0" />
          This session wasn&rsquo;t recorded, so there&rsquo;s no highlight reel. Switch on &ldquo;Record a highlight
          reel&rdquo; before you start to get one.
        </p>
      )}
      {reel.kind === 'failed' && (
        <p className="flex items-start gap-2 rounded-3xl bg-surface px-4 py-3 text-sm text-muted">
          <Icon name="info" size={18} className="mt-0.5 shrink-0" />
          The highlight reel couldn&rsquo;t be made in this browser. Your summary is all here.
        </p>
      )}
      {data.capped && reel.kind === 'ready' && (
        <p className="flex items-start gap-2 rounded-3xl bg-surface px-4 py-3 text-sm text-muted">
          <Icon name="info" size={18} className="mt-0.5 shrink-0" />
          Recording stops after {RECORD_LIMIT_MS / 60_000} minutes, so moves after that are listed but not in the reel.
        </p>
      )}

      {reel.kind !== 'cutting' && <Results report={report} videoSrc={reelUrl} track={reel.kind === 'ready' ? reel.track : null} />}
    </div>
  )
}
