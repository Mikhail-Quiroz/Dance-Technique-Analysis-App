"""Sessions CRUD endpoints.

GET    /sessions          — list current user's sessions, newest first
GET    /sessions/{id}     — full report + signed video_url + thumb_url
PATCH  /sessions/{id}     — rename (body: {title: str})
DELETE /sessions/{id}     — delete row and Storage objects
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from supabase import Client

from core.auth import _admin_client, get_current_user

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
    user: dict = Depends(get_current_user),
    supabase: Client = Depends(_admin_client),
) -> list[dict]:
    """Return the current user's sessions, newest first, with signed thumb URLs."""
    try:
        resp = (
            supabase.table("sessions")
            .select("id, title, created_at, overall_score, thumb_path")
            .eq("user_id", user["id"])
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
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
    user: dict = Depends(get_current_user),
    supabase: Client = Depends(_admin_client),
) -> dict:
    """Return a single session with full report and signed video + thumb URLs."""
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

    try:
        resp = (
            supabase.table("sessions")
            .update({"title": title})
            .eq("id", session_id)
            .eq("user_id", user["id"])
            .execute()
        )
    except Exception as exc:
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
    """Delete a session row and its Storage objects (video + thumb)."""
    # Fetch paths first (ownership check enforced by user_id filter)
    try:
        resp = (
            supabase.table("sessions")
            .select("video_path, thumb_path")
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

    # Delete Storage objects (best-effort — don't let Storage errors block row deletion)
    if row.get("video_path"):
        try:
            supabase.storage.from_("videos").remove([row["video_path"]])
        except Exception as exc:
            print(f"[sessions] video delete failed ({session_id}): {exc}")

    if row.get("thumb_path"):
        try:
            supabase.storage.from_("thumbs").remove([row["thumb_path"]])
        except Exception as exc:
            print(f"[sessions] thumb delete failed ({session_id}): {exc}")

    # Delete the DB row
    try:
        supabase.table("sessions").delete().eq("id", session_id).eq("user_id", user["id"]).execute()
    except Exception as exc:
        raise HTTPException(500, f"Delete failed: {exc}")

    return {"ok": True}
