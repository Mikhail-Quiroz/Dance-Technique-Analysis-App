# Dance Platform V2 — Roadmap

## Phase 1 — Upload & analyze

| Slice | Description | Status |
|-------|-------------|--------|
| 0 | Scaffold + shared JSON refactor | ✅ Done |
| 1 | Auth end-to-end (Supabase + Next.js) | ✅ Done |
| 2 | Full upload path (FastAPI + background job + results UI) | ✅ Done |
| 3 | Persistence + session gallery (/session/[id], rename, delete, RLS) | ✅ Done |
| 4 | Polish (mobile, migration script) | 🔶 In progress |

## Phase 2 — Real-time live coaching (/live)

| Slice | Description | Status |
|-------|-------------|--------|
| 2a | /live page: camera + mirrored live skeleton overlay at real-time FPS | ✅ Done |
| 2b | Live rep detection (turns + jumps or selected move) + on-screen cue + rep tally | ⬜ Not started |
| 2c | Voice cues via SpeechSynthesis (cooldown rules, praise after clean reps, mute) | ⬜ Not started |
| 2d | Future: save live sessions to the library (MediaRecorder); Claude-phrased cues | ⬜ Future |

Setting the app up yourself? Jump to [Supabase setup](#supabase-setup-required-to-run-the-app).

---

## Slice 0 — Scaffold + shared JSON refactor ✅

**Gate:** `python -m pytest tests/` passes; `streamlit run legacy_streamlit/app.py` works.

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
├── backend/               ← FastAPI app
├── frontend/              ← Next.js app
├── legacy_streamlit/
│   └── app.py             ← original Streamlit app; run with:
│                              streamlit run legacy_streamlit/app.py
├── scripts/               ← time_pipeline.py (per-stage timing), regenerate_thumbnails.py
├── tests/
│   └── videos/test.mp4    ← fixture for the end-to-end pipeline test
└── [all existing packages: analysis/, pose/, knowledge/, render/, utils/, library/]
```

---

## Slice 1 — Auth end-to-end ✅

**Gate:** Sign in with Google → land on `/analyze` with user email in nav.

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
- `<Navbar>`: Analyze link + email display + Sign out
- `/` redirects → `/analyze` (signed in) or `/auth` (signed out)

---

## Slice 2 — Full upload path ✅

**Gate:** Upload a dance video in browser → see progress stages → see coaching cards.

### What was done
- [x] `POST /analyze`: validates file (.mp4/.mov, ≤200 MB, ≤90 s), saves to tempfile, inserts job row, returns `{job_id}`, kicks off `BackgroundTask`
- [x] `core/pipeline.py`: wraps the 4-stage analysis pipeline (pose → moves → metrics/feedback → render), updates the job row at each stage, deletes temp files in `finally`
- [x] `GET /jobs/{id}`: job status, stage, percent, error, and (when done) the full report + video URL
- [x] `GET /jobs/{id}/video`: streams the annotated video (Bearer header or `?token=` for `<video>` elements)
- [x] `/analyze` frontend page: upload form + move-type selector chips + 2-second polling progress bar + results display (score cards, annotated video, coaching corrections, per-move metrics)

---

## Slice 3 — Persistence + session gallery ✅

**Gate:** Full round-trip: upload → gallery shows new card → open session → rename → delete.

### What was done
- [x] Pipeline inserts a `sessions` row after successful analysis (runs in a background thread — see [post-plan fixes](#post-plan-fixes))
- [x] Thumbnail generation: duotone/halftone still from the apex frame of the highest-scoring move
- [x] `GET /sessions`: user's sessions newest-first, with signed thumbnail URLs
- [x] `GET /sessions/{id}`: full report + 1-hour signed URLs for video + thumb
- [x] `PATCH /sessions/{id}`: rename
- [x] `DELETE /sessions/{id}`: deletes row + Storage objects (idempotent; clears the `jobs` FK first)
- [x] Session gallery: responsive card grid with hover tilt, rename/delete/delete-all — lives on `/analyze` **below the current analysis**, not on a separate page. `/diary` simply redirects to `/analyze` (the nav needs only one destination).
- [x] `/session/[id]` detail view: video player + full report + rename/delete controls
- [x] `tests/test_sessions_auth_isolation.py`: user B cannot read/rename/delete user A's sessions
- [ ] `scripts/migrate_library.py`: import existing `library/` sessions — **not built yet, tracked under Slice 4**

---

## Post-plan fixes

Improvements made after the original slice plan:

- **ffmpeg video encoding** (`render/overlay.py`): annotated videos are encoded via an ffmpeg subprocess (libx264, `-preset veryfast`) with an OpenCV `VideoWriter` fallback when ffmpeg isn't installed
- **Non-blocking Supabase upload** (`core/pipeline.py`): the job is marked `done` as soon as results are ready; the Storage upload + `sessions` insert run in a background thread, so the results screen never waits on the upload
- **Timing instrumentation** (`scripts/time_pipeline.py`): per-stage timing probe to find pipeline bottlenecks
- **Upload normalization** (`core/pipeline.py`): oversized/high-fps uploads (e.g. 4K/60fps phone footage) are transcoded once to ≤960px / ≤30fps before analysis, and the pose cache is keyed by the original file's content hash — roughly 2.5× faster on phone videos, and re-analyzing the same video skips inference entirely
- **Local dev mode**: a `LOCAL_MODE` env flag runs the whole app without a Supabase project (stub auth, on-disk session store) for offline development; flipping the flag back restores the cloud path

---

## Slice 4 — Polish 🔶

**Gate:** All tests pass; README complete; app works on mobile viewport.

- [x] `tests/videos/test.mp4` fixture + `tests/test_pipeline_end_to_end.py` (full POST-/analyze-equivalent pipeline run)
- [x] Empty states (no sessions, no dance detected) + error states (failed job, upload validation, network retry during polling)
- [x] Full `README.md`: prerequisites, Supabase setup link, env vars, run commands
- [ ] Mobile responsiveness pass throughout
- [ ] `scripts/migrate_library.py`: import legacy `library/` sessions idempotently
- [ ] Final `python -m pytest tests/` pass before calling the slice done (currently 44/44 passing)

---

## Phase 2 — Live coaching details

In-browser real-time coaching on a new `/live` route (same auth protection as `/analyze`). Pose tracking runs entirely client-side with `@mediapipe/tasks-vision`; the dance thresholds and cue text come from the same `/shared` JSON files the upload pipeline uses — never duplicated in TypeScript.

### Slice 2a — camera + mirrored live skeleton ✅
- [x] `/live` route (auth-protected) + "Live" navbar link
- [x] Webcam via `getUserMedia`, PoseLandmarker (lite model) in VIDEO mode driven by `requestAnimationFrame` — synchronous `detectForVideo()` keeps the skeleton aligned with the frame on screen
- [x] Selfie mirroring: video preview flipped like a studio mirror; landmark data stays anatomical (only the draw step mirrors) so left/right cues stay correct
- [x] wasm runtime copied from the npm package + lite model auto-downloaded into `frontend/public/` on `npm run dev`/`build` (version-matched, no CDN at runtime)
- [x] Graceful states: camera explainer, permission denied, no camera, "can't see you" hint; approximate-feedback disclaimer
- [x] Dev-only FPS counter + console logging
- [x] Verified in-browser: 29–30 fps sustained (≈9 ms/detection after warmup), skeleton aligned over a mirrored test feed, permission-denied and mobile (380 px) states checked

### Slice 2b — live rep detection + cues (next)
- [ ] Port minimal geometry to TS (`angleAt`, streaming smoothing, rolling baseline, body scale) with unit tests against known values (90°, 180°, collinear)
- [ ] Import thresholds + cues from `/shared` JSON (single source of truth)
- [ ] Streaming rep detection (jumps + turns, or the selected move); rep START/END events — never cue mid-move
- [ ] Move selector chips (same pattern as `/analyze`), rep counter, current/last cue caption; top cue per rep via the existing `cue_priority` order

### Slice 2c — voice
- [ ] SpeechSynthesis: max one spoken cue per rep, no repeat within 8 s, praise after 3 clean reps, mute toggle; everything spoken also captioned

### Slice 2d — future (not being built yet)
- [ ] MediaRecorder capture that saves a live session to the library like an upload
- [ ] Backend Claude-generated natural phrasing for cues

> Note: `getUserMedia` requires a secure context — localhost is fine for dev; testing on a phone over LAN will need https (deferred to deployment).

---

## Supabase setup (required to run the app)

The README links here — these are the one-time steps to run the app against your own free Supabase project.

- [ ] Create a Supabase project; run the SQL below ([Supabase SQL](#supabase-sql-run-in-sql-editor)) for the `sessions` + `jobs` tables + RLS policies
- [ ] Create private Storage buckets: `videos`, `thumbs`
- [ ] Enable Google OAuth in Supabase Auth dashboard → add `http://localhost:3000/auth/callback` as a redirect URL
- [ ] Copy `backend/.env.example` → `backend/.env` and fill `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- [ ] Copy `frontend/.env.example` → `frontend/.env.local` and fill `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

> The service role key is backend-only — it must never appear in `frontend/` or be committed.

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
