from fastapi import Header, HTTPException, Depends
from supabase import create_client, Client
from .config import settings


def _admin_client() -> Client:
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


async def get_current_user(
    authorization: str = Header(...),
    supabase: Client = Depends(_admin_client),
) -> dict:
    """Verify Supabase JWT and return {id, email}. Raises 401 on failure."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization[7:]
    try:
        resp = supabase.auth.get_user(token)
        return {"id": resp.user.id, "email": resp.user.email}
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
