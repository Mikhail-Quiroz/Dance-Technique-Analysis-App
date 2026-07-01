"""Local swap-in for the Supabase `jobs`/`sessions` tables.

Used when settings.local_mode is on (no reachable Supabase project). Job
progress lives in-memory (single dev process); session metadata is persisted
to a small JSON index next to the on-disk job artifacts, so it survives
`--reload` restarts. Report/video/thumb content is read from
job_results/{id}/ on demand rather than duplicated into the index.
"""

from __future__ import annotations

import shutil
import threading
from pathlib import Path
from typing import Any

from core.pipeline import JOB_RESULTS_DIR

_INDEX_FILE = JOB_RESULTS_DIR / "sessions_index.json"
_lock = threading.Lock()

_jobs: dict[str, dict[str, Any]] = {}


# ── Jobs (in-memory) ─────────────────────────────────────────────────────────

def create_job(job_id: str, user_id: str) -> None:
    _jobs[job_id] = {
        "id": job_id,
        "user_id": user_id,
        "status": "queued",
        "stage": "Queued",
        "percent": 0,
        "error": None,
        "session_id": None,
    }


def update_job(job_id: str, **fields: Any) -> None:
    job = _jobs.setdefault(job_id, {"id": job_id})
    job.update(fields)


def get_job(job_id: str) -> dict[str, Any] | None:
    return _jobs.get(job_id)


# ── Sessions (JSON index on disk) ────────────────────────────────────────────

def _load_index() -> list[dict[str, Any]]:
    if not _INDEX_FILE.exists():
        return []
    import json
    try:
        return json.loads(_INDEX_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_index(entries: list[dict[str, Any]]) -> None:
    import json
    JOB_RESULTS_DIR.mkdir(exist_ok=True)
    _INDEX_FILE.write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")


def add_session(entry: dict[str, Any]) -> None:
    with _lock:
        entries = _load_index()
        entries.insert(0, entry)  # newest first
        _save_index(entries)


def list_sessions(user_id: str) -> list[dict[str, Any]]:
    return [e for e in _load_index() if e.get("user_id") == user_id]


def get_session_meta(session_id: str) -> dict[str, Any] | None:
    for e in _load_index():
        if e.get("id") == session_id:
            return e
    return None


def rename_session(session_id: str, title: str) -> bool:
    with _lock:
        entries = _load_index()
        for e in entries:
            if e.get("id") == session_id:
                e["title"] = title
                _save_index(entries)
                return True
        return False


def delete_session(session_id: str) -> bool:
    with _lock:
        entries = _load_index()
        remaining = [e for e in entries if e.get("id") != session_id]
        found = len(remaining) != len(entries)
        _save_index(remaining)

    session_dir = JOB_RESULTS_DIR / session_id
    if session_dir.exists():
        shutil.rmtree(session_dir, ignore_errors=True)
    return found
