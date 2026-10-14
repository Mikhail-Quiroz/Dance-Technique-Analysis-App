'use client'
// The backend's /sessions API and the token every call needs.
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase'
import { LOCAL_MODE, LOCAL_TOKEN } from '@/lib/local-mode'
import type { SessionReport } from '@/lib/upload/report'
export { displayTitle } from './sessionNames'

const CONFIGURED = (process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8000').replace(/\/$/, '')
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/

/**
 * Where the browser calls the backend. With the backend on this computer, a page opened any other
 * way than plain http://localhost - a phone on the Wi-Fi (where "localhost" is the phone itself), or
 * `npm run dev:phone`'s https - calls it through the dev server's same-origin /backend proxy
 * (next.config.ts), which needs no CORS and no mixed http.
 */
export const BACKEND =
  typeof window !== 'undefined' &&
  LOOPBACK.test(new URL(CONFIGURED).hostname) &&
  (window.location.protocol === 'https:' || !LOOPBACK.test(window.location.hostname))
    ? '/backend'
    : CONFIGURED

/** The local backend's own links (thumbnail, video, pose track) through that proxy as well. */
function reachable(url: string | null | undefined): string | null {
  if (!url || BACKEND !== '/backend') return url ?? null
  return url.replace(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/, '/backend')
}

export interface SessionSummary {
  id: string
  title: string
  created_at: string
  overall_score: number | null
  thumb_url: string | null
  duration_s?: number | null
  move_counts?: Record<string, number> | null
}

export interface SessionDetail extends SessionSummary {
  /** Raw from the server: old sessions hold the old pipeline's report. Read with normalizeReport. */
  report: unknown
  video_url: string | null
  pose_url?: string | null
}

/** The bearer token for the backend, once known; null when signed out. */
export function useAuthToken(): { token: string | null; ready: boolean } {
  const [state, setState] = useState<{ token: string | null; ready: boolean }>(
    LOCAL_MODE ? { token: LOCAL_TOKEN, ready: true } : { token: null, ready: false },
  )
  useEffect(() => {
    if (LOCAL_MODE) return
    let live = true
    createClient().auth.getSession().then(({ data }) => {
      if (live) setState({ token: data.session?.access_token ?? null, ready: true })
    })
    return () => { live = false }
  }, [])
  return state
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

export async function listSessions(token: string): Promise<SessionSummary[]> {
  const res = await fetch(`${BACKEND}/sessions`, { headers: auth(token) })
  if (!res.ok) throw new Error(`Could not load sessions (HTTP ${res.status})`)
  const list: SessionSummary[] = await res.json()
  return list.map((s) => ({ ...s, thumb_url: reachable(s.thumb_url) }))
}

export async function getSession(token: string, id: string): Promise<SessionDetail | null> {
  const res = await fetch(`${BACKEND}/sessions/${id}`, { headers: auth(token) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Could not load the session (HTTP ${res.status})`)
  const s: SessionDetail = await res.json()
  return { ...s, thumb_url: reachable(s.thumb_url), video_url: reachable(s.video_url), pose_url: reachable(s.pose_url) }
}

export async function renameSession(token: string, id: string, title: string): Promise<boolean> {
  const res = await fetch(`${BACKEND}/sessions/${id}`, {
    method: 'PATCH',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  return res.ok
}

export async function deleteSession(token: string, id: string): Promise<boolean> {
  const res = await fetch(`${BACKEND}/sessions/${id}`, { method: 'DELETE', headers: auth(token) })
  return res.ok
}

/**
 * Save a session the browser analysed: an upload (the original video) or a /live session (its
 * highlight reel, or no video when it was not recorded), with its report, a thumbnail and the
 * pose track.
 */
export async function saveSession(
  token: string,
  parts: { video: File | null; report: SessionReport; thumb: Blob | null; pose: Blob | null },
): Promise<SessionSummary> {
  const form = new FormData()
  if (parts.video) form.append('video', parts.video)
  form.append('report', JSON.stringify(parts.report))
  if (parts.thumb) form.append('thumb', parts.thumb, 'thumb.jpg')
  if (parts.pose) form.append('pose', parts.pose, 'pose.json.gz')
  const res = await fetch(`${BACKEND}/sessions`, { method: 'POST', headers: auth(token), body: form })
  let body: Record<string, unknown> = {}
  try { body = await res.json() } catch { /* not JSON */ }
  if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `Saving failed (HTTP ${res.status})`)
  const saved = body as unknown as SessionSummary
  return { ...saved, thumb_url: reachable(saved.thumb_url) }
}

export function formatDate(iso: string, long = false): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', long
      ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}
