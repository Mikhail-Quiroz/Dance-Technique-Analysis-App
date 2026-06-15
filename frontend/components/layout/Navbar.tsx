'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'

interface NavbarProps {
  email?: string | null
}

export default function Navbar({ email }: NavbarProps) {
  const router = useRouter()
  const supabase = createClient()

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/auth')
    router.refresh()
  }

  return (
    <nav className="border-b-2 border-ink bg-paper px-6 py-3 flex items-center justify-between">
      <Link
        href={email ? '/analyze' : '/'}
        className="font-anton text-xl text-ink uppercase tracking-widest hover:text-accent transition-colors"
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
            href="/diary"
            className="font-elite text-sm text-ink hover:text-accent transition-colors"
          >
            Diary
          </Link>
          <span className="font-elite text-xs text-ink opacity-50 hidden sm:block">
            {email}
          </span>
          <button
            onClick={handleSignOut}
            className="font-elite text-sm border border-ink px-3 py-1 hover:bg-ink hover:text-paper transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </nav>
  )
}
