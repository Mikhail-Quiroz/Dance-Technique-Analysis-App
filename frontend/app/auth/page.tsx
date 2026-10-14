'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import Mascot from '@/components/ui/Mascot'
import ScreenColor from '@/components/ui/ScreenColor'
import Sticker from '@/components/ui/Sticker'

type Mode = 'signin' | 'signup'

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  // The sign-in callback sends failures back as ?error=. Read on arrival rather than with
  // useSearchParams, which would keep the whole page out of the production build's static HTML.
  useEffect(() => {
    const failed = new URLSearchParams(window.location.search).get('error')
    if (failed) setError(failed)
  }, [])

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setInfo(null)
    // Made on use, not on render: the page is also built ahead of time, where there are no keys.
    const supabase = createClient()

    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setError(error.message)
      } else {
        router.push('/analyze')
        router.refresh()
      }
    } else {
      const { error } = await supabase.auth.signUp({ email, password })
      if (error) {
        setError(error.message)
      } else {
        setInfo('Check your email to confirm your account, then sign in.')
        setMode('signin')
      }
    }

    setLoading(false)
  }

  const handleGoogle = async () => {
    setError(null)
    const { error } = await createClient().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    if (error) setError(error.message)
  }

  return (
    // The cover: the same rose screen as Home, so the app opens the way it looks inside.
    <div data-screen="home" className="mx-auto grid min-h-[calc(100vh-80px)] w-full max-w-5xl items-center gap-10 px-4 py-10 sm:px-6 md:grid-cols-2">
      <ScreenColor color="#E76E84" />
      {/* Greeting */}
      <div className="space-y-6">
        <h1 className="font-display text-6xl font-extrabold leading-[0.92] tracking-tight sm:text-7xl">
          Ready to <br />
          <span className="mt-2 inline-block -rotate-1 rounded-[1.25rem] bg-surface px-4 pb-0.5 pt-1 shadow-[0_8px_20px_rgba(42,34,36,0.12)]">dance?</span>
        </h1>
        <p className="max-w-sm text-lg font-medium">
          Technique coaching for your leaps, turns and balances, from a video or live from your camera.
        </p>
        <div className="relative hidden h-44 md:block" aria-hidden>
          <Sticker tone="blush" rotate={-8} className="absolute left-0 top-2">leap</Sticker>
          <Sticker tone="sun" rotate={6} className="absolute left-36 top-0">turn</Sticker>
          <Sticker tone="olive" rotate={-3} className="absolute left-12 top-20">hey!</Sticker>
          <Mascot color="sun" width={150} look={1} className="absolute bottom-0 right-6 animate-bob" />
        </div>
      </div>

      {/* Form */}
      <div className="card w-full space-y-5 p-6 sm:p-8">
        <div>
          <h2 className="font-display text-3xl font-extrabold">
            {mode === 'signin' ? 'Welcome back' : 'Create your account'}
          </h2>
          <p className="mt-1 text-muted">
            {mode === 'signin' ? 'Sign in to pick up where you left off.' : 'It takes a few seconds.'}
          </p>
        </div>

        {info && <p className="rounded-3xl bg-olive-soft px-4 py-3 text-sm text-olive-deep">{info}</p>}
        {error && <p className="rounded-3xl bg-blush px-4 py-3 text-sm text-berry">{error}</p>}

        <form onSubmit={handleEmailAuth} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="px-1 text-sm font-semibold">Email</label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field"
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password" className="px-1 text-sm font-semibold">Password</label>
            <input
              id="password"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field"
              placeholder="At least 6 characters"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            />
          </div>
          <button type="submit" disabled={loading} className="btn btn-dark w-full py-4 text-base">
            {loading ? '…' : mode === 'signin' ? "Let's go" : 'Sign up'}
          </button>
        </form>

        <div className="flex items-center gap-3 text-sm text-muted">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>

        <button onClick={handleGoogle} className="btn btn-outline w-full">
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            <path fill="none" d="M0 0h48v48H0z"/>
          </svg>
          Continue with Google
        </button>

        <p className="text-center text-sm text-muted">
          {mode === 'signin' ? (
            <>
              No account?{' '}
              <button
                onClick={() => { setMode('signup'); setError(null); setInfo(null) }}
                className="font-bold text-ink underline underline-offset-2"
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                onClick={() => { setMode('signin'); setError(null); setInfo(null) }}
                className="font-bold text-ink underline underline-offset-2"
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}
