import { redirect } from 'next/navigation'
import { createServerSupabase } from '@/lib/supabase-server'
import { LOCAL_MODE } from '@/lib/local-mode'

export default async function Home() {
  if (LOCAL_MODE) {
    redirect('/analyze')
  }

  const supabase = await createServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    redirect('/analyze')
  } else {
    redirect('/auth')
  }
}
