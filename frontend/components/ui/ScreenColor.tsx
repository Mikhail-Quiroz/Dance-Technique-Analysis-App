'use client'
// Tints the phone's status bar (theme-color) to the screen's colour while it is shown: rose on
// Home, teal on Sessions, cream on results. The page colour itself is CSS (data-screen).
import { useEffect } from 'react'

export default function ScreenColor({ color }: { color: string }) {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (!meta) return
    const before = meta.content
    meta.content = color
    return () => { meta.content = before }
  }, [color])
  return null
}
