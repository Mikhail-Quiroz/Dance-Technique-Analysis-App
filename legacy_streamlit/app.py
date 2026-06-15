"""🪷 Dance Platform — single-page Streamlit app (legacy fallback).

Run from the monorepo root:
    streamlit run legacy_streamlit/app.py
"""

import base64
import json
import os
import sys
from pathlib import Path
from datetime import datetime

# Ensure monorepo root is on sys.path so all packages resolve correctly
# when this file is run from legacy_streamlit/ or from the repo root.
_REPO_ROOT = Path(__file__).parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import pandas as pd
import streamlit as st

ROOT = _REPO_ROOT  # library/, outputs/, styles/ all live at the monorepo root

from pose.extractor import PoseExtractor
from utils.geometry import smooth_landmarks, compute_body_scale
from analysis.moves import (
    detect_jumps, detect_turns, detect_arabesques,
    detect_grand_battements, detect_tilts,
    detect_compound_jumps,
)
from knowledge.cues import CUE_PRIORITY
from analysis.metrics import (
    compute_jump_metrics, compute_turn_metrics,
    compute_arabesque_metrics, compute_developpe_metrics,
    compute_grand_battement_metrics,
    compute_tilt_metrics,
    compute_chaine_metrics, compute_pique_metrics,
    compute_fouette_metrics, compute_pirouette_metrics,
    compute_changement_metrics, compute_saut_de_chat_metrics,
    compute_switch_leap_metrics, compute_assemble_metrics,
    compute_toe_touch_metrics, compute_compound_jump_metrics,
)
from analysis.feedback import (
    build_move_feedback, build_session_report,
    report_to_markdown, report_to_dict, _fmt_ts,
    MoveReport, SessionReport, CueEntry,
)
from render.overlay import render_annotated_video
from library.storage import (
    load_index, save_session, delete_session, rename_session, new_session_id,
    prune_and_load, delete_all_sessions,
)
from styles.theme import css

OUTPUTS_DIR = ROOT / "outputs"
OUTPUTS_DIR.mkdir(exist_ok=True)

# ── Metric labels ──────────────────────────────────────────────────────────
_METRIC_LABELS = {
    "front_leg_ext":     "Front leg extension",
    "back_leg_ext":      "Back leg extension",
    "back_leg_height":   "Back leg height (level)",
    "point_feet":        "Foot point",
    "split_angle":       "Split angle",
    "torso_uprightness": "Torso uprightness",
    "land_plie":         "Landing plié depth",
    "retire_dist":       "Retiré position",
    "working_knee_fold": "Working knee fold",
    "releve_height":     "Relevé height",
    "vert_stack":        "Vertical alignment",
    "seconde_height":    "À la seconde height",
    "seconde_knee_ext":  "Working knee extension",
    "arabesque_height":  "Arabesque height (°)",
    "arabesque_knee_ext":"Working knee extension",
    "support_knee_ext":  "Standing knee extension",
    "arabesque_tilt":    "Torso tilt",
    "hold_duration_s":   "Hold duration (s)",
    "battement_height":  "Battement height (°)",
    "battement_knee_ext":"Working knee extension",
    "battement_tilt":    "Torso tilt",
    "plie_depth":        "Plié depth (°)",
    "plie_back_vertical":"Back vertical",
    "ankle_wobble":      "Balance stability",
    "travel_distance":   "Lateral drift",
    "rotation_consistency": "Rotation consistency",
    "knee_oscillation":  "Fouetté action",
    "knee_extension_max":"Leg extension",
    "feet_together":     "Feet together",
    "ankle_join":        "Ankles joined",
    "tilt_angle":        "Tilt angle (°)",
    "tilt_hold_s":       "Tilt hold (s)",
    "tilt_leg_line":     "Leg line",
}

def _metric_label(key: str) -> str:
    return _METRIC_LABELS.get(key, key.replace("_", " ").title())

# ── Sequence options (plié / relevé removed — never standalone scored moves) ─
_SEQUENCE_OPTIONS = [
    "Arabesque",
    "Développé (front)", "Développé (side)",
    "Grand Battement (front)", "Grand Battement (back)", "Grand Battement (side)",
    "Chaîné turns", "Piqué turns", "Fouetté turns",
    "Pirouette (passé/retiré)", "Pirouette (en dehors)", "Pirouette (en dedans)",
    "Turn à la seconde",
    "Jump / Sauté", "Leap / Grand Jeté",
    "Changement", "Saut de chat", "Switch leap", "Assemblé", "Toe touch (jazz)",
    "Tour jeté", "Tilt / layout", "Calypso leap", "Hitch kick",
]
_SEQ_MAP = {
    "Arabesque":                 ("arabesque",     "arabesque"),
    "Développé (front)":         ("arabesque",     "developpe_front"),
    "Développé (side)":          ("arabesque",     "developpe_side"),
    "Grand Battement (front)":   ("battement",     "battement_front"),
    "Grand Battement (back)":    ("battement",     "battement_back"),
    "Grand Battement (side)":    ("battement",     "battement_side"),
    "Chaîné turns":              ("turn",          "chaine"),
    "Piqué turns":               ("turn",          "pique"),
    "Fouetté turns":             ("turn",          "fouette"),
    "Pirouette (passé/retiré)":  ("turn",          "pirouette"),
    "Pirouette (en dehors)":     ("turn",          "pirouette_dehors"),
    "Pirouette (en dedans)":     ("turn",          "pirouette_dedans"),
    "Turn à la seconde":         ("turn",          "a_la_seconde"),
    "Jump / Sauté":              ("jump",          "jump"),
    "Leap / Grand Jeté":         ("jump",          "leap"),
    "Changement":                ("jump",          "changement"),
    "Saut de chat":              ("jump",          "saut_de_chat"),
    "Switch leap":               ("jump",          "switch_leap"),
    "Assemblé":                  ("jump",          "assemble"),
    "Toe touch (jazz)":          ("jump",          "toe_touch"),
    "Tour jeté":                 ("compound_jump", "tour_jete"),
    "Tilt / layout":             ("tilt",          "tilt"),
    "Calypso leap":              ("compound_jump", "calypso"),
    "Hitch kick":                ("battement",     "hitch_kick"),
}

# ── Page config (MUST be first st call) ───────────────────────────────────
st.set_page_config(
    page_title="Dance Platform",
    page_icon="🪷",
    layout="wide",
)

# ── Inject CSS (hardcoded Diary Pink) ─────────────────────────────────────
st.markdown(css("Diary Pink"), unsafe_allow_html=True)

# ── Sidebar — recording tips only ─────────────────────────────────────────
with st.sidebar:
    st.markdown("### Recording Tips")
    st.markdown("""
- **Landscape** orientation only
- Whole body **head-to-toe** visible throughout
- **One dancer** in frame
- **30+ FPS** recommended
- **Plain background** for best tracking
- **Side-on** camera for leaps/jumps
- **Front-on** camera for turns
""")
    st.markdown("---")
    st.caption(
        "⚠️ Form feedback from 2D video is approximate and not medical advice."
    )


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _render_cue_card(data: dict) -> None:
    cue   = data["entry"]
    times = ", ".join(data["timestamps"])
    st.markdown(f"""
<div class="cue-card">
  <span class="cue-chip">{cue.cue}</span>
  <p style="font-family:'Special Elite',monospace;font-size:0.72rem;opacity:.6;margin:.1rem 0 .3rem">Needed at: {times}</p>
  <p class="cue-why">{cue.why}</p>
  <p class="cue-drill">{cue.drill}</p>
</div>
""", unsafe_allow_html=True)


def _render_results(res: dict, key_prefix: str = "") -> None:
    """Render analysis results.

    Identical layout for both a live analysis and a saved diary session so the
    two views can never drift apart.  Layout:

        LEFT 40% : annotated video
        RIGHT 60%: session summary (stacked) → corrections → move metrics (inline)
        FULL WIDTH: download buttons
    """
    move_reports   = res["move_reports"]
    session        = res["session"]
    annotated_path = res["annotated_path"]
    md_text        = res["md_text"]
    json_data      = res["json_data"]

    if not move_reports:
        st.markdown("""
<div class="cue-card">
  <span class="cue-chip">No Dance Detected</span>
  <p class="cue-why">No dance moves detected. We couldn't find any jumps, turns, or other
  technique elements in this video.</p>
  <p class="cue-drill">Make sure the dancer's whole body is visible head-to-toe, the video
  is well lit, and there's actually dancing in the clip — then try again.</p>
</div>
""", unsafe_allow_html=True)
        _render_downloads(annotated_path, md_text, json_data, key_prefix=key_prefix)
        return

    col_video, col_right = st.columns([2, 3])

    with col_video:
        if annotated_path and Path(annotated_path).exists():
            with open(annotated_path, "rb") as vf:
                st.video(vf.read())
        else:
            st.markdown(
                '<div style="background:var(--dark-section);aspect-ratio:16/9;'
                'display:flex;align-items:center;justify-content:center;'
                'border:2px solid var(--ink);">'
                '<span style="color:rgba(255,255,255,0.4);font-family:Special Elite,monospace;'
                'font-size:0.8rem;">video not available</span></div>',
                unsafe_allow_html=True,
            )

    with col_right:
        # ── Session summary (stacked) ────────────────────────────────────
        st.metric("Overall Score", f"{session.overall_score}/100")
        st.metric("Strongest Area", session.strongest_area)
        st.metric("#1 Focus", session.focus_area)

        st.divider()

        # ── Corrections ─────────────────────────────────────────────────
        st.markdown('<p class="section-label">Corrections</p>', unsafe_allow_html=True)
        cue_map: dict = {}
        for report in move_reports:
            for cue in report.top_cues:
                if cue.cue_id not in cue_map:
                    cue_map[cue.cue_id] = {"entry": cue, "timestamps": []}
                cue_map[cue.cue_id]["timestamps"].append(report.timestamp_str)

        sorted_cues = sorted(
            cue_map.items(),
            key=lambda x: CUE_PRIORITY.index(x[0]) if x[0] in CUE_PRIORITY else len(CUE_PRIORITY),
        )

        if sorted_cues:
            top_3 = sorted_cues[:3]
            rest  = sorted_cues[3:]
            for _, data in top_3:
                _render_cue_card(data)
            if rest:
                with st.expander(
                    f"More corrections ({len(rest)} additional)",
                    expanded=False,
                ):
                    for _, data in rest:
                        _render_cue_card(data)
        else:
            st.info("No corrections — great technique throughout!")

        st.divider()

        # ── Per-move metrics (visible immediately, no outer expander) ───
        st.markdown('<p class="section-label">Move Metrics</p>', unsafe_allow_html=True)
        for i, report in enumerate(move_reports, 1):
            st.markdown(
                f'<p style="font-family:Anton,sans-serif;font-size:0.8rem;'
                f'text-transform:uppercase;letter-spacing:0.05em;margin:0.5rem 0 0.2rem;">'
                f'Move {i} · {report.move_type} &nbsp;<span style="color:var(--accent)">'
                f'{report.overall_score}/100</span> @ {report.timestamp_str}</p>',
                unsafe_allow_html=True,
            )
            if report.raw_metrics.get("accuracy_note"):
                st.caption(report.raw_metrics["accuracy_note"])
            rows = []
            for k, sc in report.scores.items():
                if sc is None:
                    continue
                rows.append({
                    "Metric": _metric_label(k),
                    "Score":  f"{sc}/100",
                })
            if rows:
                st.dataframe(rows, use_container_width=True, hide_index=True)

    # ── Downloads (full width) ───────────────────────────────────────────
    _render_downloads(annotated_path, md_text, json_data, key_prefix=key_prefix)


def _render_downloads(annotated_path: str, md_text: str, json_data: dict,
                      key_prefix: str = "") -> None:
    p = f"_{key_prefix}" if key_prefix else ""
    st.divider()
    dl1, dl2, dl3 = st.columns(3)
    if annotated_path and Path(annotated_path).exists():
        with open(annotated_path, "rb") as vf:
            dl1.download_button(
                "Download Video", data=vf.read(),
                file_name=Path(annotated_path).name, mime="video/mp4",
                key=f"dl_video{p}",
            )
    dl2.download_button("Download report.md", data=md_text,
                        file_name="report.md", mime="text/markdown",
                        key=f"dl_md{p}")
    dl3.download_button(
        "Download report.json",
        data=json.dumps(json_data, indent=2),
        file_name="report.json", mime="application/json",
        key=f"dl_json{p}",
    )


def _load_results_from_json(session_dir: Path) -> dict:
    """Reconstruct a results dict from a saved session directory.

    Returns the same shape as the live-analysis results dict so it can be
    passed directly to _render_results().
    """
    json_path = session_dir / "report.json"
    md_path   = session_dir / "report.md"
    ann_path  = session_dir / "annotated.mp4"

    if not json_path.exists():
        return {}

    rdata   = json.loads(json_path.read_text(encoding="utf-8"))
    md_text = md_path.read_text(encoding="utf-8") if md_path.exists() else ""

    move_reports: list[MoveReport] = []
    for m in rdata.get("moves", []):
        top_cues = [
            CueEntry(
                cue_id=c["cue_id"], cue=c["cue"],
                why=c["why"], drill=c["drill"], score=c["score"],
            )
            for c in m.get("top_cues", [])
        ]
        move_reports.append(MoveReport(
            move_type=m["move_type"],
            timestamp_str=m["timestamp"],
            scores=m.get("scores", {}),
            overall_score=m["overall_score"],
            top_cues=top_cues,
            raw_metrics=m.get("raw_metrics", {}),
        ))

    session = SessionReport(
        overall_score=rdata.get("overall_score", 0),
        strongest_area=rdata.get("strongest_area", "—"),
        focus_area=rdata.get("focus_area", "—"),
        move_reports=move_reports,
        no_moves_detected=rdata.get("no_moves_detected", len(move_reports) == 0),
    )

    return {
        "move_reports":   move_reports,
        "session":        session,
        "annotated_path": str(ann_path) if ann_path.exists() else "",
        "md_text":        md_text,
        "json_data":      rdata,
        "n_total":        len(move_reports),
    }


# ══════════════════════════════════════════════════════════════════════════
# ANALYZE SECTION
# ══════════════════════════════════════════════════════════════════════════

st.markdown("""
<div class="hero-band">
  <h1>🪷 Dance Platform</h1>
  <p>Upload a video · Get pose tracking · Receive coaching feedback</p>
</div>
""", unsafe_allow_html=True)

_res  = st.session_state.get("results_data")
_show = st.session_state.get("show_results", False)

if _res and _show:
    if st.button("← Back to upload"):
        st.session_state["show_results"] = False
        if "results_data" in st.session_state:
            del st.session_state["results_data"]
        st.rerun()

    n_total = _res.get("n_total", len(_res.get("move_reports", [])))
    if n_total > 0:
        st.success(f"Analysis complete — {n_total} move(s) detected. Saved to your Sessions.")
    else:
        st.info("No moves detected. Make sure the whole body is visible and try a clip with leaps or turns.")

    _render_results(_res, key_prefix="live")

else:
    uploaded = st.file_uploader(
        "Upload your video",
        type=["mp4", "mov"],
        help="MP4 or MOV, landscape, 30+ FPS, whole body visible",
    )

    st.markdown('<p class="section-label">Moves in this video — add them in order, then click Analyze</p>', unsafe_allow_html=True)
    if "seq_df" not in st.session_state:
        st.session_state.seq_df = pd.DataFrame({"Move": pd.Series([], dtype="object")})

    seq_df = st.data_editor(
        st.session_state.seq_df,
        column_config={
            "Move": st.column_config.SelectboxColumn(
                "Move type",
                options=_SEQUENCE_OPTIONS,
                required=True,
            )
        },
        num_rows="dynamic",
        use_container_width=True,
        hide_index=True,
        key="seq_editor",
    )
    st.session_state.seq_df = seq_df

    analyze_btn = st.button("Analyze", type="primary", disabled=uploaded is None)

    if analyze_btn and uploaded is not None:
        video_path = OUTPUTS_DIR / uploaded.name
        with open(video_path, "wb") as f:
            f.write(uploaded.getbuffer())

        stem = video_path.stem
        annotated_path   = OUTPUTS_DIR / f"{stem}_annotated.mp4"
        report_md_path   = OUTPUTS_DIR / "report.md"
        report_json_path = OUTPUTS_DIR / "report.json"

        progress_bar = st.progress(0, text="Starting…")

        # ── Stage 1: Pose extraction (0–60%) ────────────────────────────
        progress_bar.progress(0.01, text="TRACKING POSE…")

        def pose_progress(frac: float):
            progress_bar.progress(min(0.01 + frac * 0.59, 0.60),
                                  text=f"TRACKING POSE… {frac*100:.0f}%")

        try:
            extractor = PoseExtractor()
            pose_data = extractor.extract(str(video_path), progress_cb=pose_progress)
        except Exception as e:
            st.error(f"Pose extraction failed: {e}")
            st.stop()

        fps           = pose_data["fps"]
        image_lm_raw  = pose_data["image_lm"]
        world_lm_raw  = pose_data["world_lm"]
        timestamps_ms = pose_data["timestamps_ms"]

        if fps < 24:
            st.warning(f"Video FPS is {fps:.1f} — fast moves may be missed. 30+ FPS recommended.")

        image_lm   = smooth_landmarks(image_lm_raw)
        world_lm   = smooth_landmarks(world_lm_raw)
        body_scale = compute_body_scale(image_lm)

        if body_scale <= 0 or not (body_scale == body_scale):
            st.error("No dancer detected in the video. Make sure the whole body is visible.")
            st.stop()

        # ── Stage 2: Move detection (60–75%) ────────────────────────────
        progress_bar.progress(0.61, text="DETECTING MOVES…")

        jumps          = detect_jumps(image_lm, fps, body_scale, timestamps_ms, world_lm=world_lm)
        turns          = detect_turns(world_lm, fps, body_scale, image_lm, timestamps_ms)
        arabesques     = detect_arabesques(image_lm, world_lm, fps, body_scale, timestamps_ms)
        grand_battements = detect_grand_battements(image_lm, world_lm, fps, body_scale, timestamps_ms)
        tilts          = detect_tilts(image_lm, fps, body_scale, timestamps_ms)
        compound_jumps = detect_compound_jumps(image_lm, world_lm, fps, body_scale, timestamps_ms)

        progress_bar.progress(0.75, text="DETECTING MOVES… DONE")

        # ── Stage 3: Metrics + feedback (75–85%) ────────────────────────
        progress_bar.progress(0.76, text="COMPUTING METRICS…")

        _seq_entries      = [_SEQ_MAP[m] for m in seq_df["Move"].dropna().tolist() if m in _SEQ_MAP]
        _turn_styles      = [style for kind, style in _seq_entries if kind == "turn"]
        _jump_types       = [style for kind, style in _seq_entries if kind == "jump"]
        _arabesque_styles = [style for kind, style in _seq_entries if kind == "arabesque"]
        _battement_styles = [style for kind, style in _seq_entries if kind == "battement"]
        _tilt_styles      = [style for kind, style in _seq_entries if kind == "tilt"]
        _compound_styles  = [style for kind, style in _seq_entries if kind == "compound_jump"]

        # Only include non-major move types when the user explicitly selected them.
        # Plié and relevé events are NEVER standalone scored events.
        _all_events = (
            [("jump",          i, ev) for i, ev in enumerate(jumps)]                +
            [("turn",          i, ev) for i, ev in enumerate(turns)]                +
            ([("arabesque",    i, ev) for i, ev in enumerate(arabesques)]
             if _arabesque_styles else [])                                           +
            ([("battement",    i, ev) for i, ev in enumerate(grand_battements)]
             if _battement_styles else [])                                           +
            ([("tilt",         i, ev) for i, ev in enumerate(tilts)]
             if _tilt_styles else [])                                                +
            [("compound_jump", i, ev) for i, ev in enumerate(compound_jumps)]
        )

        def _ev_ts(kind, ev):
            if kind in ("jump", "compound_jump"):
                return ev.apex_ts_ms
            if kind == "turn":
                return ev.start_ts_ms
            return ev.peak_ts_ms

        _all_events.sort(key=lambda x: _ev_ts(x[0], x[2]))

        move_reports = []
        for kind, idx, event in _all_events:
            move_type_label = None
            if kind == "jump":
                j_style = _jump_types[idx] if idx < len(_jump_types) else "auto"
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
                style = _turn_styles[idx] if idx < len(_turn_styles) else "auto"
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
                    metrics = compute_turn_metrics(image_lm, world_lm, event, fps, body_scale, turn_style=style)

            elif kind == "arabesque":
                a_style = _arabesque_styles[idx] if idx < len(_arabesque_styles) else "arabesque"
                if a_style.startswith("developpe"):
                    metrics = compute_developpe_metrics(image_lm, world_lm, event, fps, body_scale)
                    direction = "front" if "front" in a_style else "side"
                    move_type_label = f"Développé ({direction})"
                else:
                    metrics = compute_arabesque_metrics(image_lm, world_lm, event, fps, body_scale)

            elif kind == "battement":
                b_style = _battement_styles[idx] if idx < len(_battement_styles) else "battement_front"
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
                c_style = _compound_styles[idx] if idx < len(_compound_styles) else "tour_jete"
                metrics = compute_compound_jump_metrics(image_lm, world_lm, event, fps, body_scale)
                move_type_label = "Calypso leap" if c_style == "calypso" else "Tour jeté"
                metrics["accuracy_note"] = "⚠️ 30 fps detection is approximate for this move."

            report = build_move_feedback(metrics, event, move_type_override=move_type_label)
            move_reports.append(report)

        session = build_session_report(move_reports)

        md_text   = report_to_markdown(session)
        json_data = report_to_dict(session)
        report_md_path.write_text(md_text, encoding="utf-8")
        report_json_path.write_text(json.dumps(json_data, indent=2), encoding="utf-8")

        progress_bar.progress(0.85, text="COMPUTING METRICS… DONE")

        # ── Stage 4: Render (85–99%) ────────────────────────────────────
        progress_bar.progress(0.86, text="RENDERING VIDEO…")

        def render_progress(frac: float):
            progress_bar.progress(min(0.86 + frac * 0.13, 0.99),
                                  text=f"RENDERING VIDEO… {frac*100:.0f}%")

        try:
            render_annotated_video(
                video_path=str(video_path),
                image_lm=image_lm, move_reports=move_reports,
                jumps=jumps, turns=turns, fps=fps,
                output_path=str(annotated_path),
                progress_cb=render_progress,
            )
        except Exception as e:
            st.warning(f"Video rendering failed ({e}) — report available without video.")
            annotated_path = None

        progress_bar.progress(1.0, text="DONE!")

        # ── Save to library ──────────────────────────────────────────────
        best_score = -1
        apex_frame_for_thumb = int(len(image_lm) * 0.20)  # fallback: 20% into video
        for ev_kind, ev_idx, ev in _all_events:
            ts = _ev_ts(ev_kind, ev)
            for mr in move_reports:
                if _fmt_ts(ts) == mr.timestamp_str and mr.overall_score > best_score:
                    best_score = mr.overall_score
                    if hasattr(ev, "apex_frame"):
                        apex_frame_for_thumb = ev.apex_frame
                    elif hasattr(ev, "peak_frame"):
                        apex_frame_for_thumb = ev.peak_frame
                    elif hasattr(ev, "start_frame"):
                        apex_frame_for_thumb = ev.start_frame

        n_total    = len(_all_events)
        move_counts = {
            "jumps": len(jumps),
            "turns": len(turns),
            "arabesques": len(arabesques) if _arabesque_styles else 0,
        }
        duration_s = float(len(image_lm)) / fps if fps > 0 else 0.0

        session_id = new_session_id()
        save_session(
            session_id=session_id,
            video_path=str(video_path),
            annotated_path=str(annotated_path) if annotated_path else "",
            report_json=json_data,
            report_md=md_text,
            apex_frame_idx=apex_frame_for_thumb,
            move_counts=move_counts,
            overall_score=session.overall_score,
            duration_s=duration_s,
            theme="pink",
        )

        st.session_state["results_data"] = {
            "move_reports":   move_reports,
            "session":        session,
            "annotated_path": str(annotated_path) if annotated_path else "",
            "md_text":        md_text,
            "json_data":      json_data,
            "n_total":        n_total,
        }
        st.session_state["show_results"] = True
        st.rerun()


# ══════════════════════════════════════════════════════════════════════════
# MY SESSIONS SECTION  (flows below Analyze on the same page)
# ══════════════════════════════════════════════════════════════════════════

st.divider()
st.markdown('<p class="diary-section-head">My Sessions</p>', unsafe_allow_html=True)

# Show post-delete success banner (set before st.rerun so it survives the rerun)
if st.session_state.pop("_del_all_ok", False):
    st.success("All sessions deleted.")

entries = prune_and_load()

if st.session_state.get("diary_detail"):
    # ── Detail view (same layout as live analysis via _render_results) ───
    sid   = st.session_state.diary_detail
    entry = next((e for e in entries if e["id"] == sid), None)

    if entry is None:
        st.error("Session not found.")
        if st.button("← Back to Sessions", key="back_sessions_missing"):
            st.session_state.diary_detail = None
            st.rerun()
    else:
        col_back, col_title = st.columns([1, 5])
        with col_back:
            if st.button("← Back to Sessions", key="back_sessions"):
                st.session_state.diary_detail = None
                st.rerun()
        with col_title:
            _diary_no_moves = sum(entry.get("move_counts", {}).values()) == 0
            _diary_score    = "—" if (_diary_no_moves and entry.get("overall_score", 0) == 0) \
                              else f'{entry["overall_score"]}/100'
            st.markdown(
                f'<p class="page-title">{entry["title"]}</p>',
                unsafe_allow_html=True,
            )
            st.markdown(
                f'<p class="section-label">{entry["date_display"]} &nbsp;·&nbsp; Score: {_diary_score}</p>',
                unsafe_allow_html=True,
            )

        session_dir = ROOT / "library" / sid
        res = _load_results_from_json(session_dir)

        if res:
            _render_results(res, key_prefix=sid)
        else:
            st.warning("Could not load report for this session.")

        # Rename / Delete controls (diary-specific, below the shared results)
        st.divider()
        r_col, d_col = st.columns(2)
        with r_col:
            new_name = st.text_input("Rename session", value=entry["title"], key=f"rename_{sid}")
            if st.button("Save name", key=f"savename_{sid}"):
                rename_session(sid, new_name)
                st.success("Renamed!")
                st.rerun()
        with d_col:
            if st.button("🗑 Delete session", key=f"del_{sid}"):
                st.session_state[f"confirm_del_{sid}"] = True
            if st.session_state.get(f"confirm_del_{sid}"):
                st.warning("This will permanently delete the session. Are you sure?")
                cc1, cc2 = st.columns(2)
                with cc1:
                    if st.button("Yes, delete", key=f"yes_{sid}"):
                        delete_session(sid)
                        st.session_state.diary_detail = None
                        st.session_state.pop(f"confirm_del_{sid}", None)
                        st.rerun()
                with cc2:
                    if st.button("Cancel", key=f"cancel_{sid}"):
                        st.session_state.pop(f"confirm_del_{sid}", None)
                        st.rerun()

elif not entries:
    st.markdown("""
<div class="empty-state">
  <span class="hello">* Hello..?</span>
  <p class="subtitle">Nothing here yet — analyze a video to add your first session.</p>
</div>
""", unsafe_allow_html=True)

else:
    # ── Delete All Sessions (starburst badge + confirmation) ─────────
    star_col, _gap = st.columns([1, 3])
    with star_col:
        if not st.session_state.get("confirm_del_all"):
            if st.button("Delete All Sessions", key="del_all_btn"):
                st.session_state["confirm_del_all"] = True
                st.rerun()
        else:
            st.warning("Delete ALL sessions — this cannot be undone.")
            ca1, ca2 = st.columns(2)
            with ca1:
                if st.button("Yes, delete all", key="yes_del_all"):
                    delete_all_sessions()
                    st.session_state.pop("confirm_del_all", None)
                    st.session_state["_del_all_ok"] = True
                    st.rerun()
            with ca2:
                if st.button("Cancel", key="cancel_del_all"):
                    st.session_state.pop("confirm_del_all", None)
                    st.rerun()

    st.divider()

    # ── Session grid ─────────────────────────────────────────────────
    cols_per_row = 3
    for row_start in range(0, len(entries), cols_per_row):
        row_entries = entries[row_start : row_start + cols_per_row]
        cols = st.columns(cols_per_row)
        for col, entry in zip(cols, row_entries):
            with col:
                thumb_path = ROOT / "library" / entry["id"] / "thumb.jpg"
                _raw_score = entry.get("overall_score", None)
                _no_moves  = sum(entry.get("move_counts", {}).values()) == 0
                score = "—" if (_raw_score == 0 and _no_moves) else (_raw_score if _raw_score is not None else "—")
                title_lines = entry["title"].replace("Session", "SESSION").split("—")
                title_html = " ".join(
                    f'<span style="background:var(--accent);color:#fff;font-family:Anton,sans-serif;'
                    f'display:inline-block;padding:0.1rem 0.4rem;margin:1px;border:1.5px solid var(--ink);'
                    f'font-size:0.82rem;letter-spacing:0.05em;">{w.strip()}</span>'
                    for w in title_lines if w.strip()
                )

                if thumb_path.exists():
                    with open(thumb_path, "rb") as f:
                        img_b64 = base64.b64encode(f.read()).decode()
                    img_html = (
                        f'<img src="data:image/jpeg;base64,{img_b64}" '
                        f'class="session-card-thumb" alt="{entry["title"]}">'
                    )
                else:
                    img_html = (
                        '<div class="session-card-thumb" style="background:var(--dark-section);'
                        'display:flex;align-items:center;justify-content:center;">'
                        '<span style="font-family:Ultra,serif;color:var(--accent);font-size:2rem;">♩</span></div>'
                    )

                st.markdown(f"""
<div class="session-card">
  <span class="score-sticker">{score} ★</span>
  {img_html}
  <div class="session-card-body">
    <p class="card-title">{title_html}</p>
    <p class="card-date">{entry.get("date_display", entry.get("date",""))}</p>
  </div>
</div>
""", unsafe_allow_html=True)
                if st.button("Open", key=f"open_{entry['id']}"):
                    st.session_state.diary_detail = entry["id"]
                    st.rerun()
