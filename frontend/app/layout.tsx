import type { Metadata } from 'next'
import { Anton, Special_Elite, Space_Grotesk, Yellowtail } from 'next/font/google'
import './globals.css'
import Navbar from '@/components/layout/Navbar'
import { createServerSupabase } from '@/lib/supabase-server'

const anton = Anton({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-nf-anton',
})
const specialElite = Special_Elite({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-nf-elite',
})
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-nf-grotesk',
})
const yellowtail = Yellowtail({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-nf-yellowtail',
})

export const metadata: Metadata = {
  title: 'Dance Platform',
  description: 'AI-powered ballet technique feedback',
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return (
    <html
      lang="en"
      className={`${anton.variable} ${specialElite.variable} ${spaceGrotesk.variable} ${yellowtail.variable} h-full`}
    >
      <body className="min-h-full flex flex-col bg-paper text-ink">
        <Navbar email={user?.email} />
        <main className="flex-1">{children}</main>
      </body>
    </html>
  )
}
