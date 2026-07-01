"""One-time script: regenerate all session thumbnails with the current teal accent.

Usage (from repo root):
    python scripts/regenerate_thumbnails.py

Requires backend/.env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
Downloads each session video from Storage, extracts the apex frame, regenerates
the duotone thumbnail in teal (#047983), and re-uploads to replace the old one.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# Allow imports from repo root
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

# Load .env from backend/
from dotenv import load_dotenv
load_dotenv(ROOT / "backend" / ".env")

from supabase import create_client
from library.storage import generate_thumbnail

SUPABASE_URL              = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


def main() -> None:
    admin = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    resp = admin.table("sessions").select("id, video_path, thumb_path, report").execute()
    sessions = resp.data or []
    print(f"Found {len(sessions)} sessions to process.")

    ok = 0
    failed = 0

    for sess in sessions:
        sid         = sess["id"]
        video_path  = sess.get("video_path")
        thumb_path  = sess.get("thumb_path")
        report      = sess.get("report") or {}

        if not video_path:
            print(f"  [{sid}] SKIP — no video_path")
            continue

        # Determine apex frame from the report (highest-scoring move)
        moves = report.get("moves", [])
        if moves:
            best     = max(moves, key=lambda m: m.get("overall_score", 0))
            ts_parts = best.get("timestamp", "0:00").split(":")
            try:
                # Approximate FPS as 30 if not stored (pipeline saves it in metadata)
                fps = float(report.get("fps", 30))
                apex_idx = int((int(ts_parts[0]) * 60 + int(ts_parts[1])) * fps)
            except (ValueError, IndexError):
                apex_idx = 0
        else:
            apex_idx = 0

        print(f"  [{sid}] apex_frame={apex_idx} ...", end=" ", flush=True)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir    = Path(tmp)
            vid_local  = tmp_dir / "video.mp4"
            thumb_local = tmp_dir / "thumb.jpg"

            # Download video from Storage
            try:
                video_bytes = admin.storage.from_("videos").download(video_path)
                vid_local.write_bytes(video_bytes)
            except Exception as e:
                print(f"FAIL (download): {e}")
                failed += 1
                continue

            # Regenerate thumbnail with teal
            success = generate_thumbnail(str(vid_local), apex_idx, thumb_local, theme="blue")
            if not success or not thumb_local.exists():
                print("FAIL (generate_thumbnail returned False)")
                failed += 1
                continue

            # Re-upload thumbnail — replace existing if present
            upload_path = thumb_path or f"regen/{sid}.jpg"
            try:
                # Remove old file first (Storage upsert isn't always available)
                if thumb_path:
                    try:
                        admin.storage.from_("thumbs").remove([thumb_path])
                    except Exception:
                        pass  # OK if it didn't exist

                with open(thumb_local, "rb") as f:
                    admin.storage.from_("thumbs").upload(
                        upload_path, f, {"content-type": "image/jpeg"}
                    )

                # If thumb_path was null, persist it now
                if not thumb_path:
                    admin.table("sessions").update({"thumb_path": upload_path}).eq("id", sid).execute()

                print(f"OK → {upload_path}")
                ok += 1
            except Exception as e:
                print(f"FAIL (upload): {e}")
                failed += 1

    print(f"\nDone: {ok} regenerated, {failed} failed.")


if __name__ == "__main__":
    main()
