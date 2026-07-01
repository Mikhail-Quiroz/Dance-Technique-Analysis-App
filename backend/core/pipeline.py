"""Analysis pipeline wrapper for the FastAPI background job system.

Runs the same 4-stage pipeline as the legacy Streamlit app (pose extraction →
move detection → metrics/feedback → video render) and saves results to a local
directory keyed by job_id.
"""

from __future__ import annotations

import json
import subprocess
import threading
import traceback
from pathlib import Path
from typing import Callable

# Job artefacts live at the REPO ROOT (not inside backend/) so that
# `uvicorn --reload` never watches them.  Writing .mp4/.json files inside
# backend/ triggers watchfiles reloads that kill the background thread.
JOB_RESULTS_DIR = Path(__file__).parent.parent.parent / "job_results"
JOB_RESULTS_DIR.mkdir(exist_ok=True)

# Move-label → (kind, style) — mirrors _SEQ_MAP in legacy_streamlit/app.py.
# Both the frontend chip labels and this mapping must stay in sync.
_SEQ_MAP: dict[str, tuple[str, str]] = {
    "Arabesque":                ("arabesque",     "arabesque"),
    "Développé (front)":        ("arabesque",     "developpe_front"),
    "Développé (side)":         ("arabesque",     "developpe_side"),
    "Grand Battement (front)":  ("battement",     "battement_front"),
    "Grand Battement (back)":   ("battement",     "battement_back"),
    "Grand Battement (side)":   ("battement",     "battement_side"),
    "Chaîné turns":             ("turn",          "chaine"),
    "Piqué turns":              ("turn",          "pique"),
    "Fouetté turns":            ("turn",          "fouette"),
    "Pirouette (passé/retiré)": ("turn",          "pirouette"),
    "Pirouette (en dehors)":    ("turn",          "pirouette_dehors"),
    "Pirouette (en dedans)":    ("turn",          "pirouette_dedans"),
    "Turn à la seconde":        ("turn",          "a_la_seconde"),
    "Jump / Sauté":             ("jump",          "jump"),
    "Leap / Grand Jeté":        ("jump",          "leap"),
    "Changement":               ("jump",          "changement"),
    "Saut de chat":             ("jump",          "saut_de_chat"),
    "Switch leap":              ("jump",          "switch_leap"),
    "Assemblé":                 ("jump",          "assemble"),
    "Toe touch (jazz)":         ("jump",          "toe_touch"),
    "Tour jeté":                ("compound_jump", "tour_jete"),
    "Tilt / layout":            ("tilt",          "tilt"),
    "Calypso leap":             ("compound_jump", "calypso"),
    "Hitch kick":               ("battement",     "hitch_kick"),
}

# Exported for the frontend chips (keep order matching app.py)
SEQUENCE_OPTIONS: list[str] = list(_SEQ_MAP.keys())

# Normalization targets for heavy uploads (phone footage is often 4K/60fps —
# decoding that at full resolution dominates pipeline wall time, twice: once
# for pose extraction and once for the render pass).
_NORM_MAX_SIDE = 960   # matches pose.extractor.MAX_SIDE — no accuracy change
_NORM_MAX_FPS  = 35.0  # cap to 30fps only above this, so ~30fps sources pass through


def _normalize_video(src: Path, dst_dir: Path) -> tuple[Path, str]:
    """Transcode heavy uploads once (≤960px long side, ≤30fps, H.264) so no
    downstream stage ever decodes full-resolution frames.

    Returns (video_to_process, pose_cache_key). The cache key is derived from
    the ORIGINAL file's content hash so re-uploading the same video hits the
    pose cache regardless of transcode byte differences. Falls back to the
    original file when ffmpeg is missing, the video is already light, or the
    transcode fails.
    """
    import cv2

    from pose.extractor import _content_hash
    from render.overlay import _FFMPEG_PATH

    orig_hash = _content_hash(str(src))

    cap = cv2.VideoCapture(str(src))
    w   = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h   = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.release()

    needs_scale = max(w, h) > _NORM_MAX_SIDE
    needs_fps   = fps > _NORM_MAX_FPS
    if _FFMPEG_PATH is None or not (needs_scale or needs_fps):
        return src, orig_hash

    vf = []
    if needs_scale:
        scale = _NORM_MAX_SIDE / max(w, h)
        tw = int(round(w * scale / 2) * 2)   # libx264 requires even dimensions
        th = int(round(h * scale / 2) * 2)
        vf.append(f"scale={tw}:{th}")
    if needs_fps:
        vf.append("fps=30")

    dst = dst_dir / "normalized.mp4"
    cmd = [
        _FFMPEG_PATH, "-y", "-i", str(src),
        "-vf", ",".join(vf),
        "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        str(dst),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except Exception as exc:
        print(f"[pipeline] video normalization failed, using original: {exc}")
        return src, orig_hash

    # Key includes the normalization signature so cached poses computed on a
    # normalized timeline are never reused for a differently-processed file.
    return dst, f"{orig_hash}_n{_NORM_MAX_SIDE}f30"


def _save_session_local(
    job_id: str,
    user_id: str,
    annotated_path: Path,
    json_data: dict,
    fps: float,
    timestamps_ms,
    update_job: Callable,
) -> str | None:
    """Local-mode equivalent of _save_to_supabase: no upload, just an index entry.

    Reuses job_id as session_id and job_results/{job_id}/ as the artifact
    location, since those files already exist on disk once the pipeline runs.
    """
    import datetime
    from collections import Counter

    from core.local_store import add_session
    from library.storage import generate_thumbnail

    try:
        result_dir = JOB_RESULTS_DIR / job_id
        session_id = job_id

        # Thumbnail — apex frame of highest-scoring move from the annotated video
        thumb_path = result_dir / "thumb.jpg"
        moves = json_data.get("moves", [])
        if moves:
            best = max(moves, key=lambda m: m["overall_score"])
            ts_parts = best["timestamp"].split(":")
            apex_idx = int((int(ts_parts[0]) * 60 + int(ts_parts[1])) * fps)
        else:
            apex_idx = 0
        generate_thumbnail(str(annotated_path), apex_idx, thumb_path, theme="blue")

        n = len(_load_local_session_count(user_id)) + 1
        today = datetime.date.today().strftime("%b %d, %Y")

        duration_s = float(timestamps_ms[-1]) / 1000.0 if len(timestamps_ms) > 0 else 0.0
        move_counts = dict(Counter(
            m["move_type"].split("(")[0].strip() for m in moves
        ))

        add_session({
            "id":            session_id,
            "user_id":       user_id,
            "title":         f"Session {n:03d} — {today}",
            "created_at":    datetime.datetime.now().isoformat(),
            "duration_s":    round(duration_s, 1),
            "overall_score": json_data.get("overall_score"),
            "move_counts":   move_counts,
        })

        update_job(job_id, session_id=session_id)
        return session_id

    except Exception as exc:
        print(f"[pipeline] local session save failed ({job_id}): {exc}")
        return None


def _load_local_session_count(user_id: str) -> list:
    from core.local_store import list_sessions
    return list_sessions(user_id)


def _save_to_supabase(
    job_id: str,
    user_id: str,
    annotated_path: Path,
    json_data: dict,
    fps: float,
    timestamps_ms,
    update_job: Callable,
) -> str | None:
    """Upload artifacts to Supabase Storage, insert sessions row, update job. Non-fatal."""
    import datetime
    import uuid
    from collections import Counter

    from supabase import create_client

    from core.config import settings
    from library.storage import generate_thumbnail

    try:
        admin = create_client(settings.supabase_url, settings.supabase_service_role_key)
        session_id = str(uuid.uuid4())

        # Thumbnail — apex frame of highest-scoring move from the annotated video
        thumb_path = annotated_path.parent / "thumb.jpg"
        moves = json_data.get("moves", [])
        if moves:
            best = max(moves, key=lambda m: m["overall_score"])
            ts_parts = best["timestamp"].split(":")
            apex_idx = int((int(ts_parts[0]) * 60 + int(ts_parts[1])) * fps)
        else:
            apex_idx = 0
        generate_thumbnail(str(annotated_path), apex_idx, thumb_path, theme="blue")

        # Upload annotated video
        vid_storage_path = f"{user_id}/{session_id}.mp4"
        with open(annotated_path, "rb") as f:
            admin.storage.from_("videos").upload(
                vid_storage_path, f, {"content-type": "video/mp4"}
            )

        # Upload thumbnail (non-fatal if thumbnail generation failed)
        thumb_storage_path = None
        if thumb_path.exists():
            thumb_storage_path = f"{user_id}/{session_id}.jpg"
            with open(thumb_path, "rb") as f:
                admin.storage.from_("thumbs").upload(
                    thumb_storage_path, f, {"content-type": "image/jpeg"}
                )

        # Count existing sessions for auto-title
        count_resp = (
            admin.table("sessions")
            .select("id", count="exact")
            .eq("user_id", user_id)
            .execute()
        )
        n = (count_resp.count or 0) + 1
        today = datetime.date.today().strftime("%b %d, %Y")

        duration_s = float(timestamps_ms[-1]) / 1000.0 if len(timestamps_ms) > 0 else 0.0
        move_counts = dict(Counter(
            m["move_type"].split("(")[0].strip() for m in moves
        ))

        admin.table("sessions").insert({
            "id":            session_id,
            "user_id":       user_id,
            "title":         f"Session {n:03d} — {today}",
            "duration_s":    round(duration_s, 1),
            "overall_score": json_data.get("overall_score"),
            "move_counts":   move_counts,
            "report":        json_data,
            "video_path":    vid_storage_path,
            "thumb_path":    thumb_storage_path,
        }).execute()

        update_job(job_id, session_id=session_id)
        return session_id

    except Exception as exc:
        print(f"[pipeline] session save failed ({job_id}): {exc}")
        return None


def _ev_ts(kind: str, ev) -> float:
    if kind in ("jump", "compound_jump"):
        return ev.apex_ts_ms
    if kind == "turn":
        return ev.start_ts_ms
    return ev.peak_ts_ms  # arabesque, battement, tilt


def run_pipeline(
    job_id: str,
    user_id: str,
    video_path: Path,
    move_labels: list[str],
    update_job: Callable,
) -> None:
    """Run the full 4-stage analysis pipeline synchronously.

    Called from a FastAPI BackgroundTask (Starlette runs sync background tasks
    in a thread-pool, so this does not block the event loop).

    Args:
        job_id:      UUID string of the job row in Supabase.
        user_id:     UUID string of the owning user.
        video_path:  Path to the temp input video (deleted in finally block).
        move_labels: List of move-type strings the user selected in the UI.
        update_job:  Callable(job_id, **fields) that persists progress to the
                     jobs table.  Injected so tests can pass an in-memory stub.
    """
    # Lazy imports keep this module importable even if mediapipe/cv2 are absent
    # (e.g. in a stripped CI environment that only runs unit tests).
    from pose.extractor import PoseExtractor
    from utils.geometry import smooth_landmarks, compute_body_scale
    from analysis.moves import (
        detect_jumps, detect_turns, detect_arabesques,
        detect_grand_battements, detect_tilts, detect_compound_jumps,
    )
    from analysis.metrics import (
        compute_jump_metrics, compute_turn_metrics,
        compute_arabesque_metrics, compute_developpe_metrics,
        compute_grand_battement_metrics, compute_tilt_metrics,
        compute_chaine_metrics, compute_pique_metrics,
        compute_fouette_metrics, compute_pirouette_metrics,
        compute_changement_metrics, compute_saut_de_chat_metrics,
        compute_switch_leap_metrics, compute_assemble_metrics,
        compute_toe_touch_metrics, compute_compound_jump_metrics,
    )
    from analysis.feedback import (
        build_move_feedback, build_session_report, report_to_dict,
    )
    from render.overlay import render_annotated_video

    result_dir = JOB_RESULTS_DIR / job_id
    result_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Parse move sequence hints from the user's selection
        seq_entries     = [_SEQ_MAP[m] for m in move_labels if m in _SEQ_MAP]
        turn_styles     = [s for k, s in seq_entries if k == "turn"]
        jump_types      = [s for k, s in seq_entries if k == "jump"]
        arabesque_styles = [s for k, s in seq_entries if k == "arabesque"]
        battement_styles = [s for k, s in seq_entries if k == "battement"]
        tilt_styles     = [s for k, s in seq_entries if k == "tilt"]
        compound_styles = [s for k, s in seq_entries if k == "compound_jump"]

        # ── Stage 1: Normalize + pose extraction (0 → 60%) ──────────────────
        update_job(job_id, stage="Preparing video", percent=1, status="running")

        work_video, pose_cache_key = _normalize_video(video_path, result_dir)

        extractor = PoseExtractor()

        def pose_progress(frac: float) -> None:
            update_job(job_id, stage="Tracking pose", percent=int(5 + frac * 55))

        update_job(job_id, stage="Tracking pose", percent=5)
        pose_data    = extractor.extract(
            str(work_video), progress_cb=pose_progress, cache_key=pose_cache_key,
        )
        fps          = pose_data["fps"]
        image_lm_raw = pose_data["image_lm"]
        world_lm_raw = pose_data["world_lm"]
        timestamps_ms = pose_data["timestamps_ms"]

        image_lm   = smooth_landmarks(image_lm_raw)
        world_lm   = smooth_landmarks(world_lm_raw)
        body_scale = compute_body_scale(image_lm)

        if body_scale <= 0 or body_scale != body_scale:   # NaN guard
            update_job(
                job_id,
                stage="No dancer detected",
                percent=100,
                status="failed",
                error="No dancer detected in the video. Make sure the whole body is visible head-to-toe.",
            )
            return

        # ── Stage 2: Move detection (60 → 75%) ──────────────────────────────
        update_job(job_id, stage="Detecting moves", percent=61)

        jumps           = detect_jumps(image_lm, fps, body_scale, timestamps_ms, world_lm=world_lm)
        turns           = detect_turns(world_lm, fps, body_scale, image_lm, timestamps_ms)
        arabesques      = detect_arabesques(image_lm, world_lm, fps, body_scale, timestamps_ms)
        grand_battements = detect_grand_battements(image_lm, world_lm, fps, body_scale, timestamps_ms)
        tilts           = detect_tilts(image_lm, fps, body_scale, timestamps_ms)
        compound_jumps  = detect_compound_jumps(image_lm, world_lm, fps, body_scale, timestamps_ms)

        update_job(job_id, stage="Detecting moves", percent=75)

        # ── Stage 3: Metrics + feedback (75 → 85%) ──────────────────────────
        update_job(job_id, stage="Computing metrics", percent=76)

        all_events = (
            [("jump",          i, ev) for i, ev in enumerate(jumps)]
            + [("turn",        i, ev) for i, ev in enumerate(turns)]
            + ([("arabesque",  i, ev) for i, ev in enumerate(arabesques)]
               if arabesque_styles else [])
            + ([("battement",  i, ev) for i, ev in enumerate(grand_battements)]
               if battement_styles else [])
            + ([("tilt",       i, ev) for i, ev in enumerate(tilts)]
               if tilt_styles else [])
            + [("compound_jump", i, ev) for i, ev in enumerate(compound_jumps)]
        )
        all_events.sort(key=lambda x: _ev_ts(x[0], x[2]))

        move_reports = []
        for kind, idx, event in all_events:
            move_type_label = None
            metrics: dict = {}

            if kind == "jump":
                j_style = jump_types[idx] if idx < len(jump_types) else "auto"
                if j_style == "changement":
                    metrics = compute_changement_metrics(image_lm, event, fps, body_scale)
                    move_type_label = "Changement"
                elif j_style == "saut_de_chat":
                    metrics = compute_saut_de_chat_metrics(image_lm, event, fps, body_scale)
                    move_type_label = "Saut de chat"
                elif j_style == "switch_leap":
                    metrics = compute_switch_leap_metrics(image_lm, event, fps, body_scale)
                    move_type_label = "Switch leap"
                elif j_style == "assemble":
                    metrics = compute_assemble_metrics(image_lm, event, fps, body_scale)
                    move_type_label = "Assemblé"
                elif j_style == "toe_touch":
                    metrics = compute_toe_touch_metrics(image_lm, event, fps, body_scale)
                    move_type_label = "Toe touch (jazz)"
                else:
                    if j_style == "leap":
                        event.type = "leap (jeté-type)"
                    elif j_style == "jump":
                        event.type = "jump (sauté-type)"
                    metrics = compute_jump_metrics(image_lm, event, fps, body_scale)

            elif kind == "turn":
                style = turn_styles[idx] if idx < len(turn_styles) else "auto"
                if style == "chaine":
                    metrics = compute_chaine_metrics(image_lm, world_lm, event, fps, body_scale)
                    move_type_label = "Chaîné turns"
                elif style == "pique":
                    metrics = compute_pique_metrics(image_lm, world_lm, event, fps, body_scale)
                    move_type_label = "Piqué turns"
                elif style == "fouette":
                    metrics = compute_fouette_metrics(image_lm, world_lm, event, fps, body_scale)
                    move_type_label = "Fouetté turns"
                elif style in ("pirouette_dehors", "pirouette_dedans"):
                    metrics = compute_pirouette_metrics(image_lm, world_lm, event, fps, body_scale)
                    direction = "en dehors" if style == "pirouette_dehors" else "en dedans"
                    move_type_label = f"Pirouette ({direction})"
                else:
                    metrics = compute_turn_metrics(
                        image_lm, world_lm, event, fps, body_scale, turn_style=style,
                    )

            elif kind == "arabesque":
                a_style = arabesque_styles[idx] if idx < len(arabesque_styles) else "arabesque"
                if a_style.startswith("developpe"):
                    metrics = compute_developpe_metrics(image_lm, world_lm, event, fps, body_scale)
                    direction = "front" if "front" in a_style else "side"
                    move_type_label = f"Développé ({direction})"
                else:
                    metrics = compute_arabesque_metrics(image_lm, world_lm, event, fps, body_scale)

            elif kind == "battement":
                b_style = battement_styles[idx] if idx < len(battement_styles) else "battement_front"
                metrics = compute_grand_battement_metrics(image_lm, world_lm, event, fps, body_scale)
                if b_style == "hitch_kick":
                    move_type_label = "Hitch kick"
                    metrics["accuracy_note"] = "⚠️ 30 fps detection is approximate for hitch kick."
                else:
                    direction = b_style.split("_")[-1] if "_" in b_style else "front"
                    move_type_label = f"Grand Battement ({direction})"

            elif kind == "tilt":
                metrics = compute_tilt_metrics(image_lm, fps, body_scale, event)
                move_type_label = "Tilt / layout"
                metrics["accuracy_note"] = "⚠️ 30 fps detection is approximate for tilts."

            else:  # compound_jump
                c_style = compound_styles[idx] if idx < len(compound_styles) else "tour_jete"
                metrics = compute_compound_jump_metrics(image_lm, world_lm, event, fps, body_scale)
                move_type_label = "Calypso leap" if c_style == "calypso" else "Tour jeté"
                metrics["accuracy_note"] = "⚠️ 30 fps detection is approximate for this move."

            report = build_move_feedback(metrics, event, move_type_override=move_type_label)
            move_reports.append(report)

        session  = build_session_report(move_reports)
        json_data = report_to_dict(session)

        (result_dir / "report.json").write_text(
            json.dumps(json_data, ensure_ascii=False), encoding="utf-8"
        )
        update_job(job_id, stage="Computing metrics", percent=85)

        # ── Stage 4: Render annotated video (85 → 99%) ──────────────────────
        update_job(job_id, stage="Rendering video", percent=86)
        annotated_path = result_dir / "annotated.mp4"

        def render_progress(frac: float) -> None:
            update_job(job_id, stage="Rendering video", percent=int(86 + frac * 13))

        try:
            render_annotated_video(
                video_path=str(work_video),
                image_lm=image_lm,
                move_reports=move_reports,
                jumps=jumps,
                turns=turns,
                fps=fps,
                output_path=str(annotated_path),
                progress_cb=render_progress,
            )
        except Exception as render_err:
            # Non-fatal: results available without the video overlay
            print(f"[pipeline] video render failed (job {job_id}): {render_err}")

        # ── Mark done immediately so the user sees results right away ───────
        # Supabase Storage upload (stage 5) runs in a daemon thread so it
        # never blocks the "done" status.  The diary grid refreshes once the
        # upload finishes and the sessions row is inserted.
        update_job(job_id, stage="Done", percent=100, status="done")

        # ── Stage 5: Persist session (non-blocking) ─────────────────────────
        try:
            from core.config import settings
            _local = settings.local_mode
        except Exception:
            _local = False
        persist_fn = _save_session_local if _local else _save_to_supabase
        threading.Thread(
            target=persist_fn,
            args=(job_id, user_id, annotated_path, json_data, fps, timestamps_ms, update_job),
            daemon=True,
        ).start()

    except Exception:
        traceback.print_exc()
        import sys
        exc = sys.exc_info()[1]
        update_job(
            job_id,
            stage="Failed",
            percent=0,
            status="failed",
            error=str(exc),
        )

    finally:
        # Always remove the temp input file and the normalized working copy
        try:
            video_path.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            (result_dir / "normalized.mp4").unlink(missing_ok=True)
        except Exception:
            pass
