import { createServerSupabase } from '@/lib/supabase-server'

export default async function AnalyzePage() {
  const supabase = await createServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="font-anton text-5xl text-ink uppercase tracking-widest mb-4">
        Analyze
      </h1>
      <div className="ink-card bg-surface p-6 shadow-[4px_4px_0_#1a1008]">
        <p className="font-elite text-ink mb-2">
          Signed in as{' '}
          <span className="text-accent-deep">{user?.email}</span>
        </p>
        <p className="font-grotesk text-sm text-ink opacity-60 mt-4">
          Video upload coming in Slice 2.
        </p>
      </div>
    </div>
  )
}
