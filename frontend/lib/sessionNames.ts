// Session names, kept apart from the API client so they are testable on their own.

/**
 * How a session's name shows. Sessions are "Session 4" or "Live session 2"; ones saved before that
 * carry a padded number and their date ("Session 013 — Oct 05, 2026") and show the same way. A name
 * the dancer gave a session shows as given.
 */
export function displayTitle(title: string): string {
  const m = /^(Live session|Session) 0*(\d+)(?: — .*)?$/.exec(title)
  return m ? `${m[1]} ${m[2]}` : title
}
