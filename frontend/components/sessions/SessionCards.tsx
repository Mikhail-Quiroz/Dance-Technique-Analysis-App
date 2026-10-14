'use client'
// Session cards with rename / delete, and the dialogs they open. Used by the Sessions page and the
// "recent sessions" row on the upload page.
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { deleteSession, displayTitle, formatDate, renameSession, type SessionSummary } from '@/lib/sessions'
import Icon from '@/components/ui/Icon'
import Mascot from '@/components/ui/Mascot'

export function SessionCard({
  session,
  onRename,
  onDelete,
  tint = 'bg-surface',
}: {
  session: SessionSummary
  onRename?: (s: SessionSummary) => void
  onDelete?: (s: SessionSummary) => void
  /** The card's colour class (Sessions cycles rose, gold and teal tints). */
  tint?: string
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [thumbOk, setThumbOk] = useState(true)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const moves = Object.values(session.move_counts ?? {}).reduce((a, b) => a + b, 0)

  return (
    <div className={`group relative overflow-hidden rounded-[var(--radius-card)] p-2.5 transition-transform hover:-translate-y-0.5 ${tint}`}>
      {/* A row on a phone, so a list of them scans quickly; a picture card from 420 px up. */}
      <Link href={`/session/${session.id}`} className="flex items-center gap-3 rounded-[1.25rem] focus-visible:outline-3 focus-visible:outline-grape min-[420px]:block">
        <div className="relative aspect-square w-24 shrink-0 overflow-hidden rounded-[1.25rem] bg-sunken min-[420px]:aspect-[4/3] min-[420px]:w-auto">
          {session.thumb_url && thumbOk ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={session.thumb_url}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              onError={() => setThumbOk(false)}
            />
          ) : (
            <div className="flex h-full items-end justify-center">
              <Mascot color="sand" width={96} mood="sleepy" className="h-auto w-16 min-[420px]:w-24" />
            </div>
          )}
          {session.overall_score !== null && session.overall_score !== undefined && (
            <span className="absolute left-2 top-2 chip bg-surface font-extrabold" aria-label={`Score ${session.overall_score}`}>
              {session.overall_score}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 py-1 pr-12 min-[420px]:px-1.5 min-[420px]:pb-1 min-[420px]:pr-1.5 min-[420px]:pt-3">
          <p className="truncate font-bold">{displayTitle(session.title)}</p>
          <p className="text-sm text-muted">
            {formatDate(session.created_at)}
            {moves > 0 && ` · ${moves} move${moves === 1 ? '' : 's'}`}
          </p>
        </div>
      </Link>

      {(onRename || onDelete) && (
        <div ref={menuRef} className="absolute right-4 top-4">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="icon-btn h-9 w-9 bg-surface/90 backdrop-blur"
            aria-label={`Options for ${displayTitle(session.title)}`}
            aria-expanded={menuOpen}
          >
            <Icon name="more" size={18} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 z-20 mt-2 w-40 card p-1.5 shadow-[0_12px_32px_rgba(30,28,25,0.16)]">
              {onRename && (
                <button
                  onClick={() => { setMenuOpen(false); onRename(session) }}
                  className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-sm font-semibold hover:bg-sunken"
                >
                  <Icon name="pencil" size={16} /> Rename
                </button>
              )}
              {onDelete && (
                <button
                  onClick={() => { setMenuOpen(false); onDelete(session) }}
                  className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-sm font-semibold text-berry hover:bg-blush"
                >
                  <Icon name="trash" size={16} /> Delete
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="card w-full max-w-sm space-y-4 p-6"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-2xl font-extrabold">{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function RenameModal({ initial, onSave, onCancel }: {
  initial: string
  onSave: (title: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <Modal title="Rename session" onClose={onCancel}>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) onSave(value.trim()) }}
        className="field"
        aria-label="Session name"
      />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="btn btn-quiet">Cancel</button>
        <button onClick={() => onSave(value.trim())} disabled={!value.trim()} className="btn btn-sun">Save</button>
      </div>
    </Modal>
  )
}

export function ConfirmModal({ title, body, confirm, onConfirm, onCancel, busy }: {
  title: string
  body: string
  confirm: string
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="text-muted">{body}</p>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} disabled={busy} className="btn btn-quiet">Cancel</button>
        <button onClick={onConfirm} disabled={busy} className="btn bg-berry text-white hover:brightness-110">
          {busy ? 'Deleting…' : confirm}
        </button>
      </div>
    </Modal>
  )
}

/** Rename and delete for a list of sessions, with their dialogs. */
export function useSessionActions(
  token: string | null,
  setSessions: (fn: (s: SessionSummary[]) => SessionSummary[]) => void,
) {
  const [renaming, setRenaming] = useState<SessionSummary | null>(null)
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [busy, setBusy] = useState(false)

  const dialogs = (
    <>
      {renaming && (
        <RenameModal
          initial={displayTitle(renaming.title)}
          onCancel={() => setRenaming(null)}
          onSave={async (title) => {
            const target = renaming
            setRenaming(null)
            if (token && (await renameSession(token, target.id, title))) {
              setSessions((all) => all.map((s) => (s.id === target.id ? { ...s, title } : s)))
            }
          }}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Delete session?"
          body="This permanently deletes the session, its video and its coaching. It can't be undone."
          confirm="Delete"
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            if (!token) return
            setBusy(true)
            const target = deleting
            if (await deleteSession(token, target.id)) {
              setSessions((all) => all.filter((s) => s.id !== target.id))
            }
            setBusy(false)
            setDeleting(null)
          }}
        />
      )}
    </>
  )
  return { dialogs, rename: setRenaming, remove: setDeleting }
}
