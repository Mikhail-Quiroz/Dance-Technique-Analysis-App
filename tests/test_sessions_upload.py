"""POST /sessions: saving an upload the browser analysed (local mode).



The upload page runs the live move engine in the browser and sends the original video, the

version 2 report, a thumbnail and the pose track. These tests save one into a temporary

job_results folder and read every part back through the API.

"""



from __future__ import annotations



import gzip

import json

import os

import sys

from pathlib import Path

from unittest.mock import MagicMock



import pytest



ROOT = Path(__file__).parent.parent

sys.path.insert(0, str(ROOT))

sys.path.insert(0, str(ROOT / "backend"))



os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")

os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")



USER = {"id": "local-user", "email": "local@dev"}



REPORT = {

    "version": 2,

    "duration_s": 8.1,

    "overall_score": 94,

    "no_moves_detected": False,

    "counts": {"split": 1},

    "focus": None,

    "strongest": None,

    "moves": [{"move": "split", "label": "Split leap", "family": "leap", "start_s": 4.6, "end_s": 5.1,

               "detail": "480 ms airtime", "score": 94, "feedback": {"kind": "unassessable"},

               "metrics": {}, "metric_scores": {}}],

}





@pytest.fixture()

def local(tmp_path, monkeypatch):

    """Local mode, with sessions stored under a temporary folder."""

    from fastapi.testclient import TestClient

    from main import app

    from core import local_store

    from core.auth import _admin_client, get_current_user

    from core.config import settings

    from routers import sessions as sessions_router



    monkeypatch.setattr(settings, "local_mode", True)

    monkeypatch.setattr(sessions_router, "JOB_RESULTS_DIR", tmp_path)

    monkeypatch.setattr(local_store, "JOB_RESULTS_DIR", tmp_path)

    monkeypatch.setattr(local_store, "_INDEX_FILE", tmp_path / "sessions_index.json")



    async def fake_user():

        return USER



    app.dependency_overrides[get_current_user] = fake_user

    app.dependency_overrides[_admin_client] = lambda: MagicMock()

    yield TestClient(app, raise_server_exceptions=False), tmp_path

    app.dependency_overrides.clear()





def _post(client, *, name="clip.mp4", report=REPORT, thumb=b"\xff\xd8thumb", pose=None):

    files = {"video": (name, b"\x00\x00\x00\x18ftypmp42video-bytes", "video/mp4")}

    if thumb:

        files["thumb"] = ("thumb.jpg", thumb, "image/jpeg")

    if pose:

        files["pose"] = ("pose.json.gz", pose, "application/gzip")

    data = {"report": report if isinstance(report, str) else json.dumps(report)}

    return client.post("/sessions", files=files, data=data)





def test_save_and_read_back(local):

    client, root = local

    pose = gzip.compress(json.dumps({"version": 1, "t": [0, 33], "has": [0, 0], "lm": []}).encode())



    resp = _post(client, pose=pose)

    assert resp.status_code == 200, resp.text

    saved = resp.json()

    sid = saved["id"]

    assert saved["title"] == "Session 1"

    assert saved["overall_score"] == 94

    assert saved["move_counts"] == {"Split leap": 1}

    for name in ("video.mp4", "report.json", "thumb.jpg", "pose.json.gz"):

        assert (root / sid / name).exists(), name



    listed = client.get("/sessions").json()

    assert [s["id"] for s in listed] == [sid]



    detail = client.get(f"/sessions/{sid}").json()

    assert detail["report"]["moves"][0]["label"] == "Split leap"

    assert detail["video_url"].endswith(f"/sessions/{sid}/video")

    assert detail["pose_url"].endswith(f"/sessions/{sid}/pose")



    video = client.get(f"/sessions/{sid}/video")

    assert video.status_code == 200

    assert video.headers["content-type"] == "video/mp4"

    assert client.get(f"/sessions/{sid}/pose").content == pose

    assert client.get(f"/sessions/{sid}/thumb").status_code == 200



    assert client.delete(f"/sessions/{sid}").status_code == 200

    assert not (root / sid).exists()

    assert client.get("/sessions").json() == []





def test_mov_is_served_as_quicktime_and_pose_is_optional(local):

    client, _ = local

    sid = _post(client, name="clip.MOV", thumb=None).json()["id"]

    assert client.get(f"/sessions/{sid}/video").headers["content-type"] == "video/quicktime"

    assert client.get(f"/sessions/{sid}").json()["pose_url"] is None

    assert client.get(f"/sessions/{sid}/pose").status_code == 404





@pytest.mark.parametrize("kwargs, why", [

    ({"name": "clip.avi"}, "unsupported extension"),

    ({"report": "{not json"}, "invalid JSON"),

    ({"report": {"overall_score": 64, "moves": []}}, "an old-pipeline report"),

    ({"report": {"version": 2}}, "no moves list"),

])

def test_rejects_what_it_cannot_store(local, kwargs, why):

    client, root = local

    resp = _post(client, **kwargs)

    assert resp.status_code == 422, why

    assert client.get("/sessions").json() == []





def test_file_routes_only_take_session_ids(local):

    client, _ = local

    for route in ("video", "pose", "thumb"):

        assert client.get(f"/sessions/not-a-session-id/{route}").status_code == 404

        assert client.get(f"/sessions/..%2F..%2Fsecrets/{route}").status_code == 404





def test_live_session_without_a_recording(local):

    client, _ = local

    report = {**REPORT, "source": "live", "session_s": 240.0}

    resp = client.post("/sessions", data={"report": json.dumps(report)})

    assert resp.status_code == 200, resp.text

    saved = resp.json()

    assert saved["title"] == "Live session 1"

    detail = client.get(f"/sessions/{saved['id']}").json()

    assert detail["video_url"] is None

    assert detail["report"]["source"] == "live"

    assert client.get(f"/sessions/{saved['id']}/video").status_code == 404





def test_live_session_with_its_highlight_reel(local):

    client, _ = local

    report = {**REPORT, "source": "live"}

    files = {"video": ("reel.webm", b"\x1a\x45\xdf\xa3webm-bytes", "video/webm")}

    resp = client.post("/sessions", files=files, data={"report": json.dumps(report)})

    assert resp.status_code == 200, resp.text

    sid = resp.json()["id"]

    assert resp.json()["title"].startswith("Live session")

    assert client.get(f"/sessions/{sid}/video").headers["content-type"] == "video/webm"





def test_an_upload_still_needs_its_video(local):

    client, _ = local

    resp = client.post("/sessions", data={"report": json.dumps(REPORT)})

    assert resp.status_code == 422

    assert client.get("/sessions").json() == []





def test_each_kind_counts_on_from_its_highest_number(local):
    client, _ = local
    live = {**REPORT, "source": "live"}

    def post(report):
        return _post(client, report=report).json()["title"]

    assert [post(REPORT), post(live), post(REPORT), post(live)] == [
        "Session 1", "Live session 1", "Session 2", "Live session 2",
    ]
    ids = {s["title"]: s["id"] for s in client.get("/sessions").json()}
    # A deleted session's number is not reused while a higher one remains...
    client.delete(f"/sessions/{ids['Session 1']}")
    assert post(REPORT) == "Session 3"
    # ...and a session renamed by the dancer no longer counts.
    client.patch(f"/sessions/{ids['Session 2']}", json={"title": "Recital run"})
    assert post(REPORT) == "Session 4"
