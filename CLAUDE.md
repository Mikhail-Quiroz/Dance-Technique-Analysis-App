# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run all tests
python -m pytest tests/ -v

# Run a single test file
python -m pytest tests/test_pipeline_end_to_end.py -v

# Backend (from backend/)
uvicorn main:app --reload   # http://localhost:8000

# Frontend (from frontend/)
npm run dev                 # http://localhost:3000

# Legacy Streamlit app
streamlit run legacy_streamlit/app.py

# Disable pose-stride sampling (maximum accuracy)
POSE_INFERENCE_STRIDE=1 python ...
```

## Architecture

This is a monorepo: a Python analysis pipeline shared between a **legacy Streamlit app** (`legacy_streamlit/app.py`) and a **FastAPI + Next.js 16** web platform (`backend/`, `frontend/`).

### Python pipeline (`analysis/`, `pose/`, `render/`, `utils/`, `knowledge/`)

Four stages run in sequence:
1. **Pose extraction** (`pose/extractor.py`): MediaPipe PoseLandmarker → `(N, 33, 4)` arrays. Content-hash NPZ cache in `pose_cache/`; stride-2 sampling with linear interpolation for 2× speedup.
2. **Move detection** (`analysis/moves.py`): jumps, turns, arabesques, battements, tilts, compounds.
3. **Metrics + feedback** (`analysis/metrics.py`, `analysis/feedback.py`): joint angles → scores 0–100 → coaching cues selected by priority.
4. **Video render** (`render/overlay.py`): skeleton overlay + move labels → ffmpeg libx264 (primary) or OpenCV H264 (fallback). Output: 720px long side.

`shared/cues.json` and `shared/thresholds.json` are the single source of truth for all coaching cues and scoring thresholds. Do not hardcode cue text or threshold values elsewhere.

### Backend (`backend/`)

FastAPI. Entry point: `backend/main.py` (adds monorepo root to `sys.path`).

- `core/config.py`: Pydantic Settings loads `.env`
- `core/auth.py`: `get_current_user` FastAPI dependency — verifies Supabase Bearer JWT via service role client
- `core/pipeline.py`: `run_pipeline()` — sync 4-stage wrapper run via `BackgroundTasks`; saves results under `backend/job_results/{job_id}/`
- `routers/analyze.py`: `POST /analyze` — validates file (≤200 MB, ≤90 s, .mp4/.mov), inserts `jobs` row, kicks off background task
- `routers/jobs.py`: `GET /jobs/{id}` (progress + report), `GET /jobs/{id}/video` (stream local file; Slice 3 will replace with Supabase signed URL)

**Security**: `SUPABASE_SERVICE_ROLE_KEY` must stay backend-only (`backend/.env`). Never expose it to the frontend.

### Frontend (`frontend/`)

Next.js **16** + React 19 + Tailwind **4** (CSS-first, no tailwind.config.js). **Read `frontend/AGENTS.md` before editing frontend code** — this Next.js version has breaking API changes.

- `app/layout.tsx`: server component; reads Supabase user for `<Navbar>`
- `middleware.ts`: protects `/analyze`, `/diary`, `/session/*`; uses `getUser()` not `getSession()`
- `lib/supabase.ts`: browser client (`createBrowserClient`)
- `lib/supabase-server.ts`: server client (`createServerClient` with cookies)

**Env vars**:
- Frontend: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_BACKEND_URL` → `frontend/.env.local`
- Backend: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FRONTEND_ORIGIN` → `backend/.env`

**Zine design system**: palette is `bg-paper` (#f5e6e0), `bg-surface`, `text-ink` (#1a1008), `bg-accent` (#e8568f). Fonts via CSS variables: `font-anton`, `font-elite`, `font-grotesk`, `font-yellowtail`.

### Supabase schema

```sql
-- sessions: one row per completed analysis
id, user_id, title, created_at, duration_s, overall_score,
move_counts (JSONB), report (JSONB), video_path, thumb_path
RLS: user_id = auth.uid()

-- jobs: background job progress
id, user_id, status (queued/running/done/failed), stage, percent,
session_id (FK → sessions), error
RLS: user_id = auth.uid()
```

Storage buckets: `videos` (annotated mp4), `thumbs` (thumbnail jpg). Both private.

## Roadmap status

| Slice | Description | Status |
|-------|-------------|--------|
| 0 | Shared JSON + monorepo scaffold | Done |
| 1 | Auth (email + Google OAuth) | Done |
| 2 | Upload + background job + results UI | Done |
| 3 | Persistence + diary (/diary, /session/[id]) | Not started |
| 4 | Polish, mobile, migration script | Not started |

Slice 3 TODO: thumbnail generation (apex frame of highest-scoring move), Supabase Storage upload, `sessions` row insert in `pipeline.py`, `GET/PATCH/DELETE /sessions`, `/diary` grid, `/session/[id]` detail page, auth-isolation test.
