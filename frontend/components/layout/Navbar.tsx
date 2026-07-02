'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { LOCAL_MODE } from '@/lib/local-mode'

interface NavbarProps {
  email?: string | null
}

export default function Navbar({ email }: NavbarProps) {
  const router = useRouter()
  const supabase = createClient()

  const handleSignOut = async () => {
    if (!LOCAL_MODE) await supabase.auth.signOut()
    router.push('/auth')
    router.refresh()
  }

  return (
    <nav className="bg-surface shadow-card px-6 py-3 flex items-center justify-between">
      <Link
        href={email ? '/analyze' : '/'}
        className="font-anton text-xl text-accent uppercase tracking-widest hover:text-accent-deep transition-colors"
      >
        Dance Platform
      </Link>

      {email && (
        <div className="flex items-center gap-5">
          <Link
            href="/analyze"
            className="font-elite text-sm text-ink hover:text-accent transition-colors"
          >
            Analyze
          </Link>
          <Link
            href="/live"
            className="font-elite text-sm text-ink hover:text-accent transition-colors"
          >
            Live
          </Link>
          <span className="font-elite text-xs text-muted hidden sm:block">
            {email}
          </span>
          <button
            onClick={handleSignOut}
            className="font-elite text-sm border-2 border-ink text-ink px-4 py-1.5
                       hover:bg-ink hover:text-paper transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </nav>
  )
}
