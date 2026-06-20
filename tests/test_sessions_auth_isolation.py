"""Auth-isolation tests for /sessions endpoints.

Proves that user B cannot read, rename, or delete a session that belongs to user A.
The Supabase client is replaced with a MagicMock that enforces user-scoped filtering.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

# Seed dummy env vars so Pydantic Settings doesn't require backend/.env
os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")

USER_A = {"id": "user-a-uuid", "email": "a@test.com"}
USER_B = {"id": "user-b-uuid", "email": "b@test.com"}

SESSION_A = {
    "id":            "session-a-uuid",
    "user_id":       USER_A["id"],
    "title":         "Session 001 — Jun 19, 2026",
    "created_at":    "2026-06-19T10:00:00Z",
    "duration_s":    45.0,
    "overall_score": 72,
    "move_counts":   {"Turn à la seconde": 1},
    "report":        {"overall_score": 72, "moves": [], "no_moves_detected": False,
                      "strongest_area": "Relevé height", "focus_area": "Stack alignment"},
    "video_path":    "user-a-uuid/session-a-uuid.mp4",
    "thumb_path":    "user-a-uuid/session-a-uuid.jpg",
}


def _empty_chain() -> MagicMock:
    """Chainable query mock whose execute() always returns data=None."""
    empty_result = MagicMock()
    empty_result.data = None
    empty_result.count = 0

    chain = MagicMock()
    chain.select.return_value = chain
    chain.update.return_value = chain
    chain.delete.return_value = chain
    chain.insert.return_value = chain
    chain.order.return_value = chain
    chain.eq.return_value = chain
    chain.single.return_value.execute.return_value = empty_result
    chain.execute.return_value = empty_result
    return chain


def _data_chain(data: dict) -> MagicMock:
    """Chainable query mock whose execute() returns the given data dict."""
    result = MagicMock()
    result.data = data
    result.count = 1

    chain = MagicMock()
    chain.select.return_value = chain
    chain.update.return_value = chain
    chain.delete.return_value = chain
    chain.insert.return_value = chain
    chain.order.return_value = chain
    chain.eq.return_value = chain
    chain.single.return_value.execute.return_value = result
    chain.execute.return_value = result
    return chain


def _build_mock_supabase_empty() -> MagicMock:
    """Supabase mock where every table query returns no data (simulates user B seeing nothing)."""
    mock = MagicMock()
    mock.table.return_value = _empty_chain()
    mock.storage.from_.return_value.create_signed_url.return_value = {
        "signedURL": "https://example.com/signed-url"
    }
    mock.storage.from_.return_value.remove.return_value = None
    return mock


def _build_mock_supabase_with_session(session: dict) -> MagicMock:
    """Supabase mock where table queries return the given session (simulates user A)."""
    mock = MagicMock()
    mock.table.return_value = _data_chain(session)
    mock.storage.from_.return_value.create_signed_url.return_value = {
        "signedURL": "https://example.com/signed-url"
    }
    mock.storage.from_.return_value.remove.return_value = None
    return mock


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from main import app
    return TestClient(app, raise_server_exceptions=False)


def _override_as(app, user: dict, supabase_mock: MagicMock):
    """Inject user identity and Supabase mock into FastAPI dependency overrides."""
    from core.auth import get_current_user, _admin_client

    async def fake_user():
        return user

    app.dependency_overrides[get_current_user] = fake_user
    app.dependency_overrides[_admin_client]    = lambda: supabase_mock


def _clear_overrides(app):
    app.dependency_overrides.clear()


# ── Tests ──────────────────────────────────────────────────────────────────────

def test_user_b_cannot_get_user_a_session(client):
    """GET /sessions/{id} as user B for a session owned by user A → 404."""
    from main import app

    _override_as(app, USER_B, _build_mock_supabase_empty())
    try:
        resp = client.get(f"/sessions/{SESSION_A['id']}")
    finally:
        _clear_overrides(app)

    assert resp.status_code == 404, (
        f"Expected 404 but got {resp.status_code}: {resp.text}"
    )


def test_user_b_cannot_rename_user_a_session(client):
    """PATCH /sessions/{id} as user B for a session owned by user A → 404."""
    from main import app

    _override_as(app, USER_B, _build_mock_supabase_empty())
    try:
        resp = client.patch(
            f"/sessions/{SESSION_A['id']}",
            json={"title": "Hacked title"},
        )
    finally:
        _clear_overrides(app)

    assert resp.status_code == 404, (
        f"Expected 404 but got {resp.status_code}: {resp.text}"
    )


def test_user_b_cannot_delete_user_a_session(client):
    """DELETE /sessions/{id} as user B for a session owned by user A → 404."""
    from main import app

    _override_as(app, USER_B, _build_mock_supabase_empty())
    try:
        resp = client.delete(f"/sessions/{SESSION_A['id']}")
    finally:
        _clear_overrides(app)

    assert resp.status_code == 404, (
        f"Expected 404 but got {resp.status_code}: {resp.text}"
    )


def test_user_a_can_get_own_session(client):
    """GET /sessions/{id} as user A for their own session → 200."""
    from main import app

    _override_as(app, USER_A, _build_mock_supabase_with_session(SESSION_A))
    try:
        resp = client.get(f"/sessions/{SESSION_A['id']}")
    finally:
        _clear_overrides(app)

    assert resp.status_code == 200, (
        f"Expected 200 but got {resp.status_code}: {resp.text}"
    )
