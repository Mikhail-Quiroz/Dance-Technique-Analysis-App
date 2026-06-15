# Dance Platform V2 — Roadmap

## Slice Status

| Slice | Description | Status |
|-------|-------------|--------|
| 0 | Scaffold + shared JSON refactor | ✅ Done |
| 1 | Auth end-to-end (Supabase + Next.js) | ✅ Done |
| 2 | Full upload path (FastAPI + background job + results UI) | ⬜ Not started |
| 3 | Persistence + diary (/diary, /session/[id], rename, delete, RLS) | ⬜ Not started |
| 4 | Polish (mobile, error states, smoke test, migration script, README) | ⬜ Not started |

---

## Slice 0 — Scaffold + shared JSON refactor ✅

**Gate:** `python -m pytest tests/` → 38 tests pass; `streamlit run legacy_streamlit/app.py` works.

### What was done
- Extracted all coaching cues into `shared/cues.json`
- Extracted all scoring thresholds, metric→cue map, and cue priority into `shared/thresholds.json`
- Refactored `knowledge/cues.py` to load CUES + CUE_PRIORITY from JSON (logic unchanged)
- Refactored `analysis/feedback.py` to load SCORE_CONFIG + METRIC_TO_CUE from JSON (logic unchanged)
- Created monorepo directory structure: `backend/`, `frontend/`, `shared/`, `legacy_streamlit/`, `scripts/`, `tests/videos/`
- Moved Streamlit app to `legacy_streamlit/app.py` with sys.path + ROOT fixes

### Directory structure
```
Dance Technique App/
├── ROADMAP.md
├── shared/
│   ├── cues.json          ← 25 coaching cues (cue/why/drill)
│   └── thresholds.json    ← 33 scoring entries + metric→cue map + priority list
├── backend/               ← FastAPI app (Slice 1+)
├── frontend/              ← Next.js app (Slice 1+)
├── legacy_streamlit/
│   └── app.py             ← original Streamlit app; run with:
│                              streamlit run legacy_streamlit/app.py
├── scripts/               ← migration script (Slice 4)
├── tests/
│   └── videos/            ← place test.mp4 here for smoke tests (Slice 4)
└── [all existing packages: analysis/, pose/, knowledge/, render/, utils/, library/]
```

---

## Slice 1 — Auth end-to-end ✅

**Gate:** Sign in with Google → land on blank `/analyze` with user email in nav.

### What was done
- Scaffolded FastAPI in `backend/`: `main.py`, `core/config.py`, `core/auth.py`, `routers/health.py` (`GET /health`)
- `get_current_user` FastAPI dependency: verifies Supabase Bearer JWT via `auth.get_user(token)`, returns `{id, email}`
- CORS locked to `frontend_origin` from `.env`
- Scaffolded Next.js 16 in `frontend/` with Tailwind 4 CSS-first config (`@theme` palette + `@theme inline` fonts)
- Zine palette wired: `bg-paper`, `bg-surface`, `text-ink`, `bg-accent`, `bg-accent-deep`, `text-dark-section`
- Google Fonts via `next/font/google` in `layout.tsx`: Anton, Special Elite, Space Grotesk, Yellowtail
- `/auth` page: email sign-in/sign-up + Google OAuth button; confirmation info banner; error banner
- `app/auth/callback/route.ts`: OAuth PKCE code exchange → session cookies → redirect `/analyze`
- `middleware.ts`: protects `/analyze`, `/diary`, `/session/*`; uses `getUser()` (not `getSession()` — verified JWT)
- `layout.tsx`: server-side `getUser()` → email passed to `<Navbar>`
- `<Navbar>`: Analyze / Diary links + email display + Sign out
- Placeholder `/analyze` shows signed-in email; placeholder `/diary` shows Yellowtail "Nothing here yet"
- `/` redirects → `/analyze` (signed in) or `/auth` (signed out)

### Supabase setup required (user action)
- [ ] Create Supabase project; run SQL for `sessions` + `jobs` tables + RLS policies (SQL in this file above)
- [ ] Create private Storage buckets: `videos`, `thumbs`
- [ ] Enable Google OAuth in Supabase Auth dashboard → add `http://localhost:3000/auth/callback` as redirect URL
- [ ] Copy `backend/.env.example` → `backend/.env` and fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
- [ ] Copy `frontend/.env.example` → `frontend/.env.local` and fill NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY

### Run commands
```bash
# Backend
cd backend && pip install -r requirements.txt
uvicorn main:app --reload   # runs on :8000

# Frontend
cd frontend && npm install
npm run dev                  # runs on :3000
```

### Supabase SQL (run in SQL editor)
```sql
-- sessions table
CREATE TABLE sessions (
  id            UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID    NOT NULL REFERENCES auth.users(id),
  title         TEXT    NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  duration_s    NUMERIC,
  overall_score NUMERIC,
  move_counts   JSONB   DEFAULT '{}',
  report        JSONB,
  video_path    TEXT,
  thumb_path    TEXT
);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own sessions" ON sessions FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- jobs table
CREATE TABLE jobs (
  id         UUID   DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID   NOT NULL REFERENCES auth.users(id),
  status     TEXT   NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued','running','done','failed')),
  stage      TEXT,
  percent    NUMERIC DEFAULT 0,
  session_id UUID   REFERENCES sessions(id),
  error      TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own jobs" ON jobs FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
```

---

## Slice 2 — Full upload path

**Gate:** Upload a dance video in browser → see progress stages → see coaching cards.

### To do
- [ ] `POST /analyze`: validate file (type, size ≤200 MB, duration ≤90 s), save to tempfile, insert job, return `{job_id}`, kick off `BackgroundTask`
- [ ] `core/pipeline.py`: wraps the 4-stage analysis pipeline, updates job row each stage, uploads results to Storage, deletes temp file in `finally`
- [ ] `GET /jobs/{id}`: reads job row from Supabase, returns `{stage, percent, status, session_id?, error?}`
- [ ] `/analyze` frontend page: upload form + move selector + 2-s polling progress bar + results display

---

## Slice 3 — Persistence + diary

**Gate:** Full round-trip: upload → diary shows new card → open session → rename → delete.

### To do
- [ ] Pipeline worker inserts `sessions` row after successful analysis
- [ ] `GET /sessions`: user's sessions newest-first
- [ ] `GET /sessions/{id}`: full report + 1-hour signed URLs for video + thumb
- [ ] `PATCH /sessions/{id}`: rename
- [ ] `DELETE /sessions/{id}`: delete row + Storage objects
- [ ] `/diary` page: responsive 3-col grid, `<SessionCard>` with hover tilt
- [ ] `/session/[id]` detail view: player + full report + rename/delete controls
- [ ] `tests/test_auth_isolation.py`: user B cannot read/modify user A's sessions
- [ ] `scripts/migrate_library.py`: import existing `library/` sessions idempotently

---

## Slice 4 — Polish

**Gate:** All tests pass; README complete; app works on mobile viewport.

### To do
- [ ] Mobile responsiveness throughout
- [ ] Empty states (no sessions, no dance detected) + error states (failed job, network loss)
- [ ] Place `tests/videos/test.mp4` and write `tests/test_pipeline_end_to_end.py`
- [ ] Full `README.md`: prerequisites, Supabase setup, env vars, run commands
- [ ] Final `python -m pytest tests/` pass
