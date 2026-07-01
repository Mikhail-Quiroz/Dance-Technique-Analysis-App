from fastapi import Header, HTTPException, Depends
from supabase import create_client, Client
from .config import settings


def _admin_client() -> Client:
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


async def get_current_user(
    authorization: str | None = Header(None),
    supabase: Client = Depends(_admin_client),
) -> dict:
    """Verify Supabase JWT and return {id, email}. Raises 401 on failure.

    In local_mode (no Supabase project available), skips verification
    entirely and returns a fixed local dev user.
    """
    if settings.local_mode:
        return {"id": "local-user", "email": "local@dev"}
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization[7:]
    try:
        resp = supabase.auth.get_user(token)
        return {"id": resp.user.id, "email": resp.user.email}
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
