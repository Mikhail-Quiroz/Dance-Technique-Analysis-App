import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const errorParam = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  // Log every callback hit so we can see which branch fires
  console.log('[auth/callback] hit', {
    params: Object.fromEntries(searchParams),
    cookies: request.cookies.getAll().map((c) => c.name),
  })

  // GoTrue redirected here with an error (e.g. failed to exchange Google code server-side)
  if (errorParam) {
    console.error('[auth/callback] BRANCH=gotrueError', errorParam, errorDescription)
    return NextResponse.redirect(
      new URL(`/auth?error=${encodeURIComponent(errorDescription ?? errorParam)}`, origin),
    )
  }

  if (!code) {
    console.error('[auth/callback] BRANCH=noCode params:', Object.fromEntries(searchParams))
    return NextResponse.redirect(new URL('/auth?error=no_code', origin))
  }

  const redirectResponse = NextResponse.redirect(new URL('/analyze', origin))

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value, options }) =>
            redirectResponse.cookies.set(name, value, options),
          )
          Object.entries(headers).forEach(([key, value]) =>
            redirectResponse.headers.set(key, value),
          )
        },
      },
    },
  )

  const pkceVerifierCookies = request.cookies.getAll().filter((c) =>
    c.name.includes('code-verifier'),
  )
  console.log('[auth/callback] BRANCH=exchange pkceVerifierCookies:', pkceVerifierCookies.map((c) => c.name))

  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (!error) {
    console.log('[auth/callback] BRANCH=exchange SUCCESS — redirecting to /analyze')
    return redirectResponse
  }

  console.error('[auth/callback] BRANCH=exchangeError', error.message, error)
  return NextResponse.redirect(
    new URL(`/auth?error=${encodeURIComponent(error.message)}`, origin),
  )
}
