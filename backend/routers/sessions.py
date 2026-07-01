"""Sessions CRUD endpoints.

GET    /sessions          — list current user's sessions, newest first
GET    /sessions/{id}     — full report + signed video_url + thumb_url
PATCH  /sessions/{id}     — rename (body: {title: str})
DELETE /sessions/{id}     — delete row and Storage objects
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from supabase import Client

from core.auth import _admin_client, get_current_user
from core.config import settings
from core.pipeline import JOB_RESULTS_DIR

logger = logging.getLogger(__name__)
router = APIRouter()

_SIGNED_URL_TTL = 3600  # 1 hour


def _signed(supabase: Client, bucket: str, path: str | None) -> str | None:
    if not path:
        return None
    try:
        result = supabase.storage.from_(bucket).create_signed_url(path, _SIGNED_URL_TTL)
        return result.get("signedURL") or result.get("signed_url")
    except Exception:
        return None


@router.get("/sessions")
async def list_sessions(
    request: Request,
    user: dict = Depends(get_current_user),
    supabase: Client = Depends(_admin_client),
) -> list[dict]:
    """Return the current user's sessions, newest first, with signed thumb URLs."""
    if settings.local_mode:
        from core.local_store import list_sessions as list_local_sessions

        base = str(request.base_url).rstrip("/")
        entries = list_local_sessions(user["id"])
        return [
            {**e, "thumb_url": f"{base}/sessions/{e['id']}/thumb"}
            for e in entries
        ]

    try:
        resp = (
            supabase.table("sessions")
            .select("id, title, created_at, overall_score, thumb_path")
            .eq("user_id", user["id"])
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        logger.exception("GET /sessions: fetch failed for user %s", user["id"])
        raise HTTPException(500, f"Failed to fetch sessions: {exc}")

    rows = resp.data or []
    return [
        {
            **{k: v for k, v in row.items() if k != "thumb_path"},
            "thumb_url": _signed(supabase, "thumbs", row.get("thumb_path")),
        }
        for row in rows
    ]


@router.get("/sessions/{session_id}")
async def get_session(
    session_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
    supabase: Client = Depends(_admin_client),
) -> dict:
    """Return a single session with full report and signed video + thumb URLs."""
    if settings.local_mode:
        from core.local_store import get_session_meta

        meta = get_session_meta(session_id)
        if not meta or meta.get("user_id") != user["id"]:
            raise HTTPException(404, "Session not found")

        report_path = JOB_RESULTS_DIR / session_id / "report.json"
        report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else None

        base = str(request.base_url).rstrip("/")
        video_path = JOB_RESULTS_DIR / session_id / "annotated.mp4"
        return {
            **meta,
            "report": report,
            "video_url": f"{base}/sessions/{session_id}/video" if video_path.exists() else None,
            "thumb_url": f"{base}/sessions/{session_id}/thumb",
        }

    try:
        resp = (
            supabase.table("sessions")
            .select("*")
            .eq("id", session_id)
            .eq("user_id", user["id"])
            .single()
            .execute()
        )
    except Exception:
        raise HTTPException(404, "Session not found")

    row = resp.data
    if not row:
        raise HTTPException(404, "Session not found")

    return {
        **{k: v for k, v in row.items() if k not in ("video_path", "thumb_path")},
        "video_url": _signed(supabase, "videos", row.get("video_path")),
        "thumb_url": _signed(supabase, "thumbs", row.get("thumb_path")),
    }


class RenameBody(BaseModel):
    title: str


@router.patch("/sessions/{session_id}")
async def rename_session(
    session_id: str,
    body: RenameBody,
    user: dict = Depends(get_current_user),
    supabase: Client = Depends(_admin_client),
) -> dict:
    """Rename a session title."""
    title = body.title.strip()
    if not title:
        raise HTTPException(422, "Title cannot be empty")

    if settings.local_mode:
        from core.local_store import get_session_meta, rename_session as rename_local_session

        meta = get_session_meta(session_id)
        if not meta or meta.get("user_id") != user["id"] or not rename_local_session(session_id, title):
            raise HTTPException(404, "Session not found")
        return {"ok": True, "title": title}

    try:
        resp = (
            supabase.table("sessions")
            .update({"title": title})
            .eq("id", session_id)
            .eq("user_id", user["id"])
            .execute()
        )
    except Exception as exc:
        logger.exception("PATCH /sessions/%s: rename failed", session_id)
        raise HTTPException(500, f"Rename failed: {exc}")

    if not resp.data:
        raise HTTPException(404, "Session not found")

    return {"ok": True, "title": title}


@router.delete("/sessions/{session_id}", status_code=200)
async def delete_session(
    session_id: str,
    user: dict = Depends(get_current_user),
    supabase: Client = Depends(_admin_client),
) -> dict:
    """Delete a session row and its Storage objects (video + thumb).

    Idempotent: returns 200 if the session was already deleted.

    Order of operations matters:
    1. Fetch paths (ownership check via user_id filter).
    2. Nullify jobs.session_id FK — the FK has no ON DELETE action so the
       session DELETE would fail with a 23503 FK violation without this step.
    3. Remove Storage objects (best-effort; "already gone" is not an error).
    4. Delete the session row.
    """
    if settings.local_mode:
        from core.local_store import get_session_meta, delete_session as delete_local_session

        meta = get_session_meta(session_id)
        if not meta or meta.get("user_id") != user["id"]:
            # Doesn't exist (or belongs to another user) — treat as already deleted.
            return {"ok": True}
        delete_local_session(session_id)
        return {"ok": True}

    # ── 1. Fetch storage paths (ownership enforced by user_id filter) ──────────
    try:
        resp = (
            supabase.table("sessions")
            .select("video_path, thumb_path")
            .eq("id", session_id)
            .eq("user_id", user["id"])
            .limit(1)
            .execute()
        )
    except Exception as exc:
        logger.exception("DELETE /sessions/%s: SELECT failed", session_id)
        raise HTTPException(500, f"Failed to fetch session: {exc}")

    rows = resp.data or []
    if not rows:
        # Session doesn't exist (or belongs to another user) — treat as already deleted.
        return {"ok": True}

    row = rows[0]

    # ── 2. Nullify jobs FK before deleting the session row ────────────────────
    # jobs.session_id references sessions.id with no ON DELETE cascade/set-null,
    # so we must clear it first to avoid a FK violation (PostgreSQL error 23503).
    try:
        supabase.table("jobs").update({"session_id": None}).eq("session_id", session_id).execute()
    except Exception as exc:
        logger.exception("DELETE /sessions/%s: jobs FK nullify failed", session_id)
        raise HTTPException(500, f"Failed to unlink jobs: {exc}")

    # ── 3. Remove Storage objects (best-effort) ────────────────────────────────
    if row.get("video_path"):
        try:
            supabase.storage.from_("videos").remove([row["video_path"]])
        except Exception:
            logger.exception("DELETE /sessions/%s: video Storage remove failed", session_id)

    if row.get("thumb_path"):
        try:
            supabase.storage.from_("thumbs").remove([row["thumb_path"]])
        except Exception:
            logger.exception("DELETE /sessions/%s: thumb Storage remove failed", session_id)

    # ── 4. Delete the DB row ───────────────────────────────────────────────────
    try:
        supabase.table("sessions").delete().eq("id", session_id).eq("user_id", user["id"]).execute()
    except Exception as exc:
        logger.exception("DELETE /sessions/%s: DB delete failed", session_id)
        raise HTTPException(500, f"Delete failed: {exc}")

    return {"ok": True}


@router.get("/sessions/{session_id}/video")
async def get_session_video_local(session_id: str) -> FileResponse:
    """Stream a locally-stored annotated video (local_mode only)."""
    if not settings.local_mode:
        raise HTTPException(404, "Not found")
    video_path = JOB_RESULTS_DIR / session_id / "annotated.mp4"
    if not video_path.exists():
        raise HTTPException(404, "Video not available for this session")
    return FileResponse(str(video_path), media_type="video/mp4")


@router.get("/sessions/{session_id}/thumb")
async def get_session_thumb_local(session_id: str) -> FileResponse:
    """Stream a locally-stored thumbnail (local_mode only)."""
    if not settings.local_mode:
        raise HTTPException(404, "Not found")
    thumb_path = JOB_RESULTS_DIR / session_id / "thumb.jpg"
    if not thumb_path.exists():
        raise HTTPException(404, "Thumbnail not available for this session")
    return FileResponse(str(thumb_path), media_type="image/jpeg")
