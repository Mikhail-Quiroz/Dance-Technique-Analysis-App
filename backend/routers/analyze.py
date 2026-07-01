"""POST /analyze — upload video, validate, start background job."""

from __future__ import annotations

import json
import tempfile
import uuid
from pathlib import Path

import cv2
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from supabase import Client

from core.auth import get_current_user, _admin_client
from core.config import settings
from core.pipeline import run_pipeline

router = APIRouter()

_MAX_BYTES    = 200 * 1024 * 1024   # 200 MB
_MAX_DURATION = 90                   # seconds
_ALLOWED_EXT  = {".mp4", ".mov"}


def _make_updater(job_id: str) -> callable:
    """Return a callable that updates the jobs row for job_id.

    Creates a fresh admin client on each call so the background thread is
    not sharing connection state with the request thread.
    """
    if settings.local_mode:
        from core.local_store import update_job

        def _update_local(jid: str, **kwargs) -> None:
            update_job(jid, **kwargs)
        return _update_local

    def _update(jid: str, **kwargs) -> None:
        try:
            _admin_client().table("jobs").update(kwargs).eq("id", jid).execute()
        except Exception as exc:
            print(f"[analyze] job update failed ({jid}): {exc}")
    return _update


@router.post("/analyze")
async def post_analyze(
    background_tasks: BackgroundTasks,
    video: UploadFile = File(...),
    moves: str = Form(default="[]"),
    user: dict = Depends(get_current_user),
    supabase: Client = Depends(_admin_client),
) -> dict:
    """Accept a dance video, validate it, and enqueue an analysis job.

    Returns {job_id} immediately; the client polls GET /jobs/{id} for progress.
    """
    # ── File validation ──────────────────────────────────────────────────────
    suffix = Path(video.filename or "").suffix.lower()
    if suffix not in _ALLOWED_EXT:
        raise HTTPException(
            422,
            f"Only .mp4 and .mov files are accepted"
            + (f" (got {suffix})" if suffix else " (no extension found)"),
        )

    data = await video.read()
    if len(data) > _MAX_BYTES:
        raise HTTPException(422, "Video too large — maximum is 200 MB.")

    # Write to a named temp file so OpenCV and the pipeline can open it by path
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.write(data)
    tmp.flush()
    tmp.close()
    video_path = Path(tmp.name)

    # Duration check via OpenCV (non-fatal if OpenCV can't read FPS — let pipeline handle it)
    try:
        cap = cv2.VideoCapture(str(video_path))
        fps_cv      = cap.get(cv2.CAP_PROP_FPS)
        frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        cap.release()
        if fps_cv > 0 and (frame_count / fps_cv) > _MAX_DURATION:
            video_path.unlink(missing_ok=True)
            raise HTTPException(
                422,
                f"Video too long — maximum is {_MAX_DURATION} seconds "
                f"(this clip is {frame_count / fps_cv:.0f} s).",
            )
    except HTTPException:
        raise
    except Exception:
        pass   # duration check failed → let the pipeline catch any real issues

    # ── Parse move labels ────────────────────────────────────────────────────
    try:
        move_labels: list[str] = json.loads(moves)
        if not isinstance(move_labels, list):
            move_labels = []
    except Exception:
        move_labels = []

    # ── Insert job row ───────────────────────────────────────────────────────
    job_id = str(uuid.uuid4())
    if settings.local_mode:
        from core.local_store import create_job
        create_job(job_id, user["id"])
    else:
        try:
            supabase.table("jobs").insert({
                "id":      job_id,
                "user_id": user["id"],
                "status":  "queued",
                "stage":   "Queued",
                "percent": 0,
            }).execute()
        except Exception as exc:
            video_path.unlink(missing_ok=True)
            raise HTTPException(500, f"Failed to create job: {exc}")

    # ── Kick off pipeline as background task ─────────────────────────────────
    updater = _make_updater(job_id)
    background_tasks.add_task(
        run_pipeline, job_id, user["id"], video_path, move_labels, updater,
    )

    return {"job_id": job_id}
