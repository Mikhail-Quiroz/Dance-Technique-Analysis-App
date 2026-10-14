'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase'
import { LOCAL_MODE } from '@/lib/local-mode'
import Icon, { type IconName } from '@/components/ui/Icon'
import Mascot from '@/components/ui/Mascot'

interface NavbarProps {
  email?: string | null
}

// `pill`: the phone tab bar's colour for the tab you are on, each its own: Upload's rose (Home), Live's
// gold, Sessions' teal. Text contrast: ink on rose 5.2:1, ink on gold 9:1, white on teal 4.8:1 (ink on
// teal is only 3.2:1).
const LINKS: Array<{ href: string; label: string; icon: IconName; pill: string; match: (p: string) => boolean }> = [
  { href: '/analyze', label: 'Upload', icon: 'upload', pill: 'bg-rose text-ink', match: (p) => p.startsWith('/analyze') },
  { href: '/live', label: 'Live', icon: 'camera', pill: 'bg-sun text-ink', match: (p) => p.startsWith('/live') },
  { href: '/diary', label: 'Sessions', icon: 'grid', pill: 'bg-teal text-white', match: (p) => p.startsWith('/diary') || p.startsWith('/session/') },
]

export default function Navbar({ email }: NavbarProps) {
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [menuOpen])

  const handleSignOut = async () => {
    if (!LOCAL_MODE) {
      const supabase = createClient()
      await supabase.auth.signOut()
    }
    router.push('/auth')
    router.refresh()
  }

  const initial = (email ?? '?').trim().charAt(0).toUpperCase()

  return (
    <>
      <header className="px-4 sm:px-6 pt-[max(1rem,env(safe-area-inset-top))]">
        <nav className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <Link href={email ? '/analyze' : '/'} className="flex items-center gap-2.5 group" aria-label="Dance Platform home">
            <Mascot width={40} className="transition-transform group-hover:-translate-y-0.5" />
            <span className="font-display text-xl font-extrabold tracking-tight">Dance Platform</span>
          </Link>

          {email && (
            <div className="flex items-center gap-3">
              {/* Desktop links */}
              <div className="hidden sm:flex items-center gap-1 rounded-full bg-surface p-1.5">
                {LINKS.map((l) => {
                  const active = l.match(pathname)
                  return (
                    <Link
                      key={l.href}
                      href={l.href}
                      aria-current={active ? 'page' : undefined}
                      className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                        active ? 'bg-ink text-white' : 'text-ink hover:bg-sunken'
                      }`}
                    >
                      <Icon name={l.icon} size={18} />
                      {l.label}
                    </Link>
                  )
                })}
              </div>

              {/* Account */}
              <div ref={menuRef} className="relative">
                <button
                  onClick={() => setMenuOpen((o) => !o)}
                  className="w-11 h-11 rounded-full bg-lilac text-grape font-display text-lg font-extrabold flex items-center justify-center hover:brightness-95 transition"
                  aria-label="Account"
                  aria-expanded={menuOpen}
                >
                  {initial}
                </button>
                {menuOpen && (
                  <div className="absolute right-0 mt-2 w-60 card p-2 shadow-[0_12px_32px_rgba(30,28,25,0.14)] z-50">
                    <p className="px-3 py-2 text-xs text-muted truncate">{email}</p>
                    <button
                      onClick={handleSignOut}
                      className="w-full flex items-center gap-2 rounded-2xl px-3 py-2.5 text-sm font-semibold hover:bg-sunken transition-colors"
                    >
                      <Icon name="logout" size={18} />
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </nav>
      </header>

      {/* Phone tab bar: the tab you are on grows into a pill of its own colour with its name; the others are icons.
          The bar stays mounted across pages, so the change of tab animates. */}
      {email && (
        <nav
          className="sm:hidden fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] z-40 card flex items-center gap-1 p-1.5 shadow-[0_10px_30px_rgba(30,28,25,0.16)]"
          aria-label="Main"
        >
          {LINKS.map((l) => {
            const active = l.match(pathname)
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                aria-label={l.label}
                className={`flex h-12 min-w-0 basis-0 items-center justify-center rounded-full transition-[flex-grow,background-color,color] duration-300 ease-out ${
                  active ? `grow-[2] ${l.pill}` : 'grow text-muted active:bg-sunken'
                }`}
              >
                <Icon name={l.icon} size={22} strokeWidth={active ? 2.4 : 2} className="shrink-0" />
                <span
                  className={`overflow-hidden whitespace-nowrap text-sm font-bold transition-[max-width,opacity,margin] duration-300 ease-out ${
                    active ? 'ml-2 max-w-24 opacity-100' : 'ml-0 max-w-0 opacity-0'
                  }`}
                >
                  {l.label}
                </span>
              </Link>
            )
          })}
        </nav>
      )}
    </>
  )
}
