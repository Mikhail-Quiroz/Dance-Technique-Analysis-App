"""End-to-end pipeline test.

Covers the full POST /analyze flow: processes tests/videos/test.mp4 through
the real analysis pipeline and asserts the job reaches status='done' with a
valid report.json containing overall_score and a moves list.

The Supabase jobs table is replaced with an in-memory store so no live
credentials are required.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

TEST_VIDEO = ROOT / "tests" / "videos" / "test.mp4"


@pytest.mark.skipif(not TEST_VIDEO.exists(), reason="tests/videos/test.mp4 not found")
def test_pipeline_end_to_end(tmp_path: Path) -> None:
    """run_pipeline on test.mp4 → status='done' with a valid report.json."""
    import backend.core.pipeline as pipeline_mod

    # Redirect result storage to tmp_path so the test is self-contained
    original_dir = pipeline_mod.JOB_RESULTS_DIR
    pipeline_mod.JOB_RESULTS_DIR = tmp_path

    updates: dict[str, dict] = {}

    def update_job(jid: str, **kwargs: object) -> None:
        updates.setdefault(jid, {}).update(kwargs)

    job_id = "e2e-test-job"
    video_copy = tmp_path / "input.mp4"
    shutil.copy(TEST_VIDEO, video_copy)

    try:
        pipeline_mod.run_pipeline(
            job_id=job_id,
            user_id="test-user-id",
            video_path=video_copy,
            move_labels=[],          # auto-detect jumps / turns
            update_job=update_job,
        )
    finally:
        pipeline_mod.JOB_RESULTS_DIR = original_dir

    final = updates.get(job_id, {})

    assert final.get("status") == "done", (
        f"Pipeline did not reach 'done'. Final updates: {final}"
    )
    assert final.get("percent") == 100

    report_path = tmp_path / job_id / "report.json"
    assert report_path.exists(), "report.json was not written"

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert "overall_score" in report, "report missing overall_score"
    assert isinstance(report.get("moves"), list), "report.moves must be a list"

    # Video render is non-fatal; just check file is present if render ran
    annotated = tmp_path / job_id / "annotated.mp4"
    if annotated.exists():
        assert annotated.stat().st_size > 0, "annotated.mp4 is empty"
