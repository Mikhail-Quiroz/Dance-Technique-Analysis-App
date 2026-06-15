'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'

type Mode = 'signin' | 'signup'

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(searchParams.get('error'))
  const [info, setInfo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setInfo(null)

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
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    if (error) setError(error.message)
  }

  return (
    <div className="min-h-[calc(100vh-57px)] flex items-center justify-center bg-paper px-4 py-12">
      <div className="w-full max-w-md ink-card bg-surface p-8 shadow-[4px_4px_0_#1a1008]">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="font-anton text-4xl text-ink uppercase tracking-widest mb-1">
            Dance Platform
          </h1>
          <p className="font-elite text-sm text-ink opacity-60">
            {mode === 'signin' ? 'Sign in to your account' : 'Create your account'}
          </p>
        </div>

        {/* Info / error banners */}
        {info && (
          <div className="mb-4 border border-ink bg-paper px-4 py-2 font-elite text-sm text-ink">
            {info}
          </div>
        )}
        {error && (
          <div className="mb-4 border border-accent bg-paper px-4 py-2 font-elite text-sm text-accent-deep">
            {error}
          </div>
        )}

        {/* Email/password form */}
        <form onSubmit={handleEmailAuth} className="space-y-4">
          <div>
            <label htmlFor="email" className="block font-elite text-xs text-ink mb-1 uppercase tracking-wider">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border-2 border-ink bg-paper px-3 py-2 font-grotesk text-sm text-ink focus:border-accent focus:bg-white transition-colors"
              placeholder="your@email.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block font-elite text-xs text-ink mb-1 uppercase tracking-wider">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border-2 border-ink bg-paper px-3 py-2 font-grotesk text-sm text-ink focus:border-accent focus:bg-white transition-colors"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-accent text-paper font-anton tracking-widest py-3 uppercase text-sm hover:bg-accent-deep transition-colors disabled:opacity-50"
          >
            {loading ? '...' : mode === 'signin' ? 'Sign In' : 'Sign Up'}
          </button>
        </form>

        {/* Divider */}
        <div className="my-5 flex items-center gap-3">
          <div className="flex-1 border-t border-ink opacity-30" />
          <span className="font-elite text-xs text-ink opacity-50">or</span>
          <div className="flex-1 border-t border-ink opacity-30" />
        </div>

        {/* Google OAuth */}
        <button
          onClick={handleGoogle}
          className="w-full border-2 border-ink bg-paper text-ink font-elite text-sm py-3 uppercase tracking-wider hover:bg-ink hover:text-paper transition-colors flex items-center justify-center gap-2"
        >
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            <path fill="none" d="M0 0h48v48H0z"/>
          </svg>
          Sign in with Google
        </button>

        {/* Mode toggle */}
        <p className="mt-5 text-center font-elite text-xs text-ink opacity-60">
          {mode === 'signin' ? (
            <>
              No account?{' '}
              <button
                onClick={() => { setMode('signup'); setError(null); setInfo(null) }}
                className="underline hover:text-accent transition-colors"
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                onClick={() => { setMode('signin'); setError(null); setInfo(null) }}
                className="underline hover:text-accent transition-colors"
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
