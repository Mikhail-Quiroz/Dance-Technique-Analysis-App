"""Sessions CRUD endpoints.

GET    /sessions          — list current user's sessions, newest first
POST   /sessions          — save a session the browser analysed (video + report + thumb + pose)
GET    /sessions/{id}     — full report + signed video_url + thumb_url + pose_url
PATCH  /sessions/{id}     — rename (body: {title: str})
DELETE /sessions/{id}     — delete row and Storage objects
"""

from __future__ import annotations

import datetime
import json
import logging
import posixpath
import re
import uuid
from collections import Counter
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from supabase import Client

from core.auth import _admin_client, get_current_user
from core.config import settings
from core.pipeline import JOB_RESULTS_DIR

logger = logging.getLogger(__name__)
router = APIRouter()

_SIGNED_URL_TTL = 3600  # 1 hour

# Uploads are analysed in the browser by the same move engine /live runs, so anything the browser
# can play can be saved. These limits match the upload page's.
_MAX_VIDEO_BYTES  = 200 * 1024 * 1024
_MAX_REPORT_BYTES = 2 * 1024 * 1024
_MAX_THUMB_BYTES  = 2 * 1024 * 1024
_MAX_POSE_BYTES   = 20 * 1024 * 1024
_VIDEO_TYPES = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}

# Sessions saved by the old server pipeline keep their annotated video; browser-analysed ones keep
# the original upload (the skeleton is drawn over it from pose.json.gz).
_LOCAL_VIDEO_NAMES = ["annotated.mp4"] + [f"video{ext}" for ext in _VIDEO_TYPES]
_POSE_NAME = "pose.json.gz"


def _local_dir(session_id: str) -> Path:
    """The session's folder under job_results/. Ids are UUIDs, so a path in the URL never resolves."""
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(404, "Session not found")
    return JOB_RESULTS_DIR / session_id


def _local_video(session_id: str) -> Path | None:
    for name in _LOCAL_VIDEO_NAMES:
        path = _local_dir(session_id) / name
        if path.exists():
            return path
    return None


def _pose_storage_path(video_path: str | None) -> str | None:
    """The pose track sits next to the video in the videos bucket: <user>/<id>.pose.json.gz."""
    if not video_path:
        return None
    return posixpath.splitext(video_path)[0] + ".pose.json.gz"


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


async def _read_limited(upload: UploadFile | None, limit: int, what: str) -> bytes | None:
    if upload is None:
        return None
    data = await upload.read()
    if len(data) > limit:
        raise HTTPException(422, f"{what} too large — maximum is {limit // (1024 * 1024)} MB.")
    return data or None


_TITLE_NUMBER = re.compile(r"^(Live session|Session) 0*(\d+)")


def _next_title(kind: str, titles: list[str]) -> str:
    """`Session 4`, or `Live session 2`: each kind counts on from its highest number so far.

    Counting existing sessions would repeat a name after a delete; renamed sessions don't count.
    """
    numbers = [int(m.group(2)) for t in titles if (m := _TITLE_NUMBER.match(t or "")) and m.group(1) == kind]
    return f"{kind} {max(numbers, default=0) + 1}"


def _move_counts(report: dict) -> dict:
    return dict(Counter(str(m.get("label", "Move")) for m in report.get("moves", []) if isinstance(m, dict)))


@router.post("/sessions")
async def create_session(
    video: UploadFile | None = File(default=None),
    report: str = Form(...),
    thumb: UploadFile | None = File(default=None),
    pose: UploadFile | None = File(default=None),
    user: dict = Depends(get_current_user),
    supabase: Client = Depends(_admin_client),
) -> dict:
    """Save a session the browser analysed: an upload, or a /live session.

    The browser runs the MoveEngine itself, so the server only stores what it found: the video (an
    upload's original, a live session's highlight reel), the report, a thumbnail and the pose track
    the results page draws the skeleton from. A live session recorded without a reel has no video.
    """
    ext = Path(video.filename or "").suffix.lower() if video is not None else ""
    if video is not None and ext not in _VIDEO_TYPES:
        raise HTTPException(
            422,
            "Only .mp4, .mov, .m4v and .webm videos can be saved"
            + (f" (got {ext})" if ext else " (no extension found)"),
        )

    if len(report.encode("utf-8")) > _MAX_REPORT_BYTES:
        raise HTTPException(422, "Report too large.")
    try:
        report_data = json.loads(report)
    except Exception:
        raise HTTPException(422, "Report is not valid JSON.")
    if (
        not isinstance(report_data, dict)
        or report_data.get("version") != 2
        or not isinstance(report_data.get("moves"), list)
    ):
        raise HTTPException(422, "Report is not a version 2 session report.")
    live = report_data.get("source") == "live"
    if video is None and not live:
        raise HTTPException(422, "The video is missing.")

    video_bytes = await _read_limited(video, _MAX_VIDEO_BYTES, "Video")
    if video is not None and not video_bytes:
        raise HTTPException(422, "The video is empty.")
    thumb_bytes = await _read_limited(thumb, _MAX_THUMB_BYTES, "Thumbnail")
    pose_bytes  = await _read_limited(pose, _MAX_POSE_BYTES, "Pose track")

    session_id  = str(uuid.uuid4())
    duration_s  = report_data.get("duration_s")
    duration_s  = round(float(duration_s), 1) if isinstance(duration_s, (int, float)) else None
    score       = report_data.get("overall_score")
    score       = int(score) if isinstance(score, (int, float)) else None
    move_counts = _move_counts(report_data)
    kind        = "Live session" if live else "Session"

    if settings.local_mode:
        from core.local_store import add_session, list_sessions as list_local_sessions

        session_dir = JOB_RESULTS_DIR / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        if video_bytes:
            (session_dir / f"video{ext}").write_bytes(video_bytes)
        (session_dir / "report.json").write_text(json.dumps(report_data, ensure_ascii=False), encoding="utf-8")
        if thumb_bytes:
            (session_dir / "thumb.jpg").write_bytes(thumb_bytes)
        if pose_bytes:
            (session_dir / _POSE_NAME).write_bytes(pose_bytes)

        entry = {
            "id":            session_id,
            "user_id":       user["id"],
            "title":         _next_title(kind, [e.get("title", "") for e in list_local_sessions(user["id"])]),
            "created_at":    datetime.datetime.now().isoformat(),
            "duration_s":    duration_s,
            "overall_score": score,
            "move_counts":   move_counts,
        }
        add_session(entry)
        return entry

    vid_storage_path   = f"{user['id']}/{session_id}{ext}" if video_bytes else None
    thumb_storage_path = f"{user['id']}/{session_id}.jpg" if thumb_bytes else None
    if vid_storage_path:
        try:
            supabase.storage.from_("videos").upload(
                vid_storage_path, video_bytes, {"content-type": _VIDEO_TYPES[ext]}
            )
        except Exception as exc:
            logger.exception("POST /sessions: video upload failed for user %s", user["id"])
            raise HTTPException(500, f"Video upload failed: {exc}")

    # The thumbnail and the pose track are extras: a session without them still opens.
    if thumb_bytes:
        try:
            supabase.storage.from_("thumbs").upload(
                thumb_storage_path, thumb_bytes, {"content-type": "image/jpeg"}
            )
        except Exception:
            logger.exception("POST /sessions: thumbnail upload failed")
            thumb_storage_path = None
    # The pose track sits next to the video it is drawn over, so it needs one.
    if pose_bytes and vid_storage_path:
        try:
            supabase.storage.from_("videos").upload(
                _pose_storage_path(vid_storage_path), pose_bytes, {"content-type": "application/gzip"}
            )
        except Exception:
            logger.exception("POST /sessions: pose upload failed")

    try:
        titles_resp = (
            supabase.table("sessions")
            .select("title")
            .eq("user_id", user["id"])
            .execute()
        )
        row = {
            "id":            session_id,
            "user_id":       user["id"],
            "title":         _next_title(kind, [r.get("title", "") for r in (titles_resp.data or [])]),
            "duration_s":    duration_s,
            "overall_score": score,
            "move_counts":   move_counts,
            "report":        report_data,
            "video_path":    vid_storage_path,
            "thumb_path":    thumb_storage_path,
        }
        supabase.table("sessions").insert(row).execute()
    except Exception as exc:
        logger.exception("POST /sessions: insert failed for user %s", user["id"])
        raise HTTPException(500, f"Saving the session failed: {exc}")

    return {k: v for k, v in row.items() if k not in ("report", "video_path", "thumb_path")}


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
        has_pose = (JOB_RESULTS_DIR / session_id / _POSE_NAME).exists()
        return {
            **meta,
            "report": report,
            "video_url": f"{base}/sessions/{session_id}/video" if _local_video(session_id) else None,
            "thumb_url": f"{base}/sessions/{session_id}/thumb",
            "pose_url": f"{base}/sessions/{session_id}/pose" if has_pose else None,
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
        # Only browser-analysed sessions have one; signing a missing object returns None.
        "pose_url": _signed(supabase, "videos", _pose_storage_path(row.get("video_path"))),
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
            supabase.storage.from_("videos").remove([row["video_path"], _pose_storage_path(row["video_path"])])
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
    """Stream a locally-stored session video (local_mode only)."""
    if not settings.local_mode:
        raise HTTPException(404, "Not found")
    video_path = _local_video(session_id)
    if video_path is None:
        raise HTTPException(404, "Video not available for this session")
    return FileResponse(str(video_path), media_type=_VIDEO_TYPES.get(video_path.suffix.lower(), "video/mp4"))


@router.get("/sessions/{session_id}/pose")
async def get_session_pose_local(session_id: str) -> FileResponse:
    """Stream a locally-stored pose track (local_mode only)."""
    if not settings.local_mode:
        raise HTTPException(404, "Not found")
    pose_path = _local_dir(session_id) / _POSE_NAME
    if not pose_path.exists():
        raise HTTPException(404, "No pose track for this session")
    return FileResponse(str(pose_path), media_type="application/gzip")


@router.get("/sessions/{session_id}/thumb")
async def get_session_thumb_local(session_id: str) -> FileResponse:
    """Stream a locally-stored thumbnail (local_mode only)."""
    if not settings.local_mode:
        raise HTTPException(404, "Not found")
    thumb_path = _local_dir(session_id) / "thumb.jpg"
    if not thumb_path.exists():
        raise HTTPException(404, "Thumbnail not available for this session")
    return FileResponse(str(thumb_path), media_type="image/jpeg")
