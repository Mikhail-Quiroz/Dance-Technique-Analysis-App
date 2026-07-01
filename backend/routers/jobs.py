"""GET /jobs/{id} — poll job progress and fetch results.
   GET /jobs/{id}/video — stream the annotated video (fallback for jobs that
   completed before Supabase Storage was wired up in Slice 3).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import FileResponse
from supabase import Client

from core.auth import get_current_user, _admin_client
from core.config import settings
from core.pipeline import JOB_RESULTS_DIR

router = APIRouter()


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: str,
    user: dict = Depends(get_current_user),
    supabase: Client = Depends(_admin_client),
) -> dict:
    """Return job status, progress, and (when done) the full report + video URL."""
    if settings.local_mode:
        from core.local_store import get_job as get_local_job

        job = get_local_job(job_id)
        if not job or job.get("user_id") != user["id"]:
            raise HTTPException(404, "Job not found")

        result = None
        if job["status"] == "done":
            report_path = JOB_RESULTS_DIR / job_id / "report.json"
            if report_path.exists():
                report = json.loads(report_path.read_text(encoding="utf-8"))
                result = {
                    "report":     report,
                    "video_path": f"/jobs/{job_id}/video",
                }

        return {
            "status":  job["status"],
            "stage":   job.get("stage"),
            "percent": job.get("percent", 0),
            "error":   job.get("error"),
            "result":  result,
        }

    try:
        resp = (
            supabase.table("jobs")
            .select("*")
            .eq("id", job_id)
            .eq("user_id", user["id"])
            .single()
            .execute()
        )
    except Exception:
        raise HTTPException(404, "Job not found")

    job = resp.data
    if not job:
        raise HTTPException(404, "Job not found")

    result = None
    if job["status"] == "done":
        report_path = JOB_RESULTS_DIR / job_id / "report.json"
        if report_path.exists():
            report = json.loads(report_path.read_text(encoding="utf-8"))
            session_id = job.get("session_id")
            if session_id:
                try:
                    sess_resp = (
                        supabase.table("sessions")
                        .select("video_path")
                        .eq("id", session_id)
                        .single()
                        .execute()
                    )
                    if sess_resp.data:
                        signed = supabase.storage.from_("videos").create_signed_url(
                            sess_resp.data["video_path"], 3600
                        )
                        video_url = signed.get("signedURL") or signed.get("signed_url", "")
                        result = {
                            "report":     report,
                            "video_url":  video_url,
                            "session_id": session_id,
                        }
                except Exception:
                    pass
            if not result:
                # Fallback: session not yet saved or Storage lookup failed
                result = {
                    "report":     report,
                    "video_path": f"/jobs/{job_id}/video",
                }

    return {
        "status":  job["status"],
        "stage":   job.get("stage"),
        "percent": job.get("percent", 0),
        "error":   job.get("error"),
        "result":  result,
    }


@router.get("/jobs/{job_id}/video")
async def get_job_video(
    job_id: str,
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
    supabase: Client = Depends(_admin_client),
) -> FileResponse:
    """Stream the annotated video file (fallback for pre-Slice-3 jobs).

    Accepts auth via the standard Bearer header OR a ?token= query param so
    an HTML <video src="...?token=<jwt>"> element can request range-based
    streaming without custom fetch logic.
    """
    if settings.local_mode:
        from core.local_store import get_job as get_local_job

        job = get_local_job(job_id)
        if not job or job.get("status") != "done":
            raise HTTPException(404, "Job not found")

        video_path = JOB_RESULTS_DIR / job_id / "annotated.mp4"
        if not video_path.exists():
            raise HTTPException(404, "Video not available for this job")

        return FileResponse(
            str(video_path),
            media_type="video/mp4",
            headers={"Cache-Control": "private, max-age=3600"},
        )

    bearer = authorization[7:] if (authorization or "").startswith("Bearer ") else None
    actual_token = bearer or token
    if not actual_token:
        raise HTTPException(401, "Missing token")

    try:
        user_resp = supabase.auth.get_user(actual_token)
        user_id   = str(user_resp.user.id)
    except Exception:
        raise HTTPException(401, "Invalid or expired token")

    # Verify the job belongs to this user
    try:
        job_resp = (
            supabase.table("jobs")
            .select("user_id, status")
            .eq("id", job_id)
            .single()
            .execute()
        )
        job = job_resp.data
    except Exception:
        raise HTTPException(404, "Job not found")

    if not job or job["user_id"] != user_id:
        raise HTTPException(404, "Job not found")
    if job["status"] != "done":
        raise HTTPException(400, "Job not yet complete")

    video_path = JOB_RESULTS_DIR / job_id / "annotated.mp4"
    if not video_path.exists():
        raise HTTPException(404, "Video not available for this job")

    return FileResponse(
        str(video_path),
        media_type="video/mp4",
        headers={"Cache-Control": "private, max-age=3600"},
    )
