import sys
from pathlib import Path

# Make monorepo packages (analysis/, pose/, knowledge/, render/, utils/) importable
_ROOT = Path(__file__).parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from core.config import settings
from routers import health, analyze, jobs, sessions

app = FastAPI(title="Dance Platform API", version="0.1.0")

# Allow the configured origin plus its localhost/127.0.0.1 twin — the browser
# sends whichever hostname the user typed, and they are distinct origins.
_origins = {settings.frontend_origin}
_origins.add(settings.frontend_origin.replace("localhost", "127.0.0.1"))
_origins.add(settings.frontend_origin.replace("127.0.0.1", "localhost"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(analyze.router)
app.include_router(jobs.router)
app.include_router(sessions.router)
