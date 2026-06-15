"""Scoring and cue selection.

Converts raw metric values to 0-100 scores, selects top cues, and builds
move + session reports.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

from knowledge.cues import CUES, CUE_PRIORITY
from analysis.moves import JumpEvent, TurnEvent

# ---------------------------------------------------------------------------
# Scoring table — loaded from /shared/thresholds.json
# ---------------------------------------------------------------------------

_SHARED = Path(__file__).parent.parent / "shared"
_thresh = json.loads((_SHARED / "thresholds.json").read_text(encoding="utf-8"))

# Each entry: (excellent_threshold, poor_threshold, invert)
# invert=True means LOWER value is better (e.g. torso tilt, plié depth)
SCORE_CONFIG: dict[str, tuple[float, float, bool]] = {
    k: (v["excellent"], v["poor"], v["invert"])
    for k, v in _thresh["score_config"].items()
}

# Maps metric key → cue_id for cue selection
METRIC_TO_CUE: dict[str, str] = _thresh["metric_to_cue"]


def score_metric(value: float, excellent: float, poor: float, invert: bool = False) -> int:
    """Map a raw metric value to 0-100.

    100 at/above excellent, 0 at/below poor, linear in between.
    invert=True: direction is reversed (lower value is better).
    """
    if invert:
        # Lower is better: swap so the formula stays the same direction
        excellent, poor = poor, excellent
        # Now excellent > poor, and higher value → lower score
        if value >= excellent:
            return 0
        if value <= poor:
            return 100
        return int(round(100.0 * (excellent - value) / (excellent - poor)))
    else:
        if value >= excellent:
            return 100
        if value <= poor:
            return 0
        return int(round(100.0 * (value - poor) / (excellent - poor)))


# ---------------------------------------------------------------------------
# Report data structures
# ---------------------------------------------------------------------------

@dataclass
class CueEntry:
    cue_id: str
    cue:    str
    why:    str
    drill:  str
    score:  int   # the metric score that triggered this cue


@dataclass
class MoveReport:
    move_type:     str
    timestamp_str: str
    scores:        dict       # metric_key → int | None
    overall_score: int
    top_cues:      list[CueEntry] = field(default_factory=list)
    raw_metrics:   dict = field(default_factory=dict)


@dataclass
class SessionReport:
    overall_score:      int
    strongest_area:     str
    focus_area:         str
    move_reports:       list[MoveReport] = field(default_factory=list)
    no_moves_detected:  bool = False


# ---------------------------------------------------------------------------
# Build per-move report
# ---------------------------------------------------------------------------

def build_move_feedback(
    metrics: dict,
    move,
    move_type_override: str = None,
) -> MoveReport:
    """Convert raw metrics dict + move event → MoveReport with top 3 cues."""
    if move_type_override:
        move_type = move_type_override
    elif hasattr(move, "rotation_count"):
        rot         = move.rotation_count
        style       = metrics.get("_turn_style", "pirouette")
        style_label = "à la seconde" if style == "a_la_seconde" else "pirouette"
        move_type   = f"Turn {style_label} ({_rot_label(rot)})"
    elif hasattr(move, "peak_frame"):
        move_type = "Arabesque"
    else:
        move_type = getattr(move, "type", "Jump")
    ts_ms = (getattr(move, "apex_ts_ms", None)
             or getattr(move, "peak_ts_ms", None)
             or getattr(move, "start_ts_ms", 0))
    timestamp_str = _fmt_ts(ts_ms)

    scores: dict = {}
    cue_scores: dict[str, int] = {}   # cue_id → lowest score seen

    for metric_key, (excellent, poor, invert) in SCORE_CONFIG.items():
        val = metrics.get(metric_key)
        if val is None:
            scores[metric_key] = None
            continue
        s = score_metric(val, excellent, poor, invert)
        scores[metric_key] = s

        cue_id = METRIC_TO_CUE.get(metric_key)
        if cue_id:
            # Keep the lowest score for deduplication (worst performance)
            if cue_id not in cue_scores or s < cue_scores[cue_id]:
                cue_scores[cue_id] = s

    # Overall score = mean of available metric scores
    valid = [s for s in scores.values() if s is not None]
    overall = int(round(sum(valid) / len(valid))) if valid else 0

    # Top 3 cues: only for metrics below 80 (needs improvement),
    # ordered first by priority tier then by score (lowest first).
    NEEDS_IMPROVEMENT_THRESHOLD = 80

    def cue_sort_key(item):
        cue_id, sc = item
        try:
            priority = CUE_PRIORITY.index(cue_id)
        except ValueError:
            priority = len(CUE_PRIORITY)
        return (priority, sc)   # primary: priority tier; secondary: score (lower first)

    needs_work = {cid: sc for cid, sc in cue_scores.items() if sc < NEEDS_IMPROVEMENT_THRESHOLD}
    sorted_cues = sorted(needs_work.items(), key=cue_sort_key)[:3]
    top_cues = []
    for cue_id, sc in sorted_cues:
        if cue_id in CUES:
            c = CUES[cue_id]
            top_cues.append(CueEntry(
                cue_id=cue_id,
                cue=c["cue"],
                why=c["why"],
                drill=c["drill"],
                score=sc,
            ))

    return MoveReport(
        move_type=move_type,
        timestamp_str=timestamp_str,
        scores=scores,
        overall_score=overall,
        top_cues=top_cues,
        raw_metrics={k: v for k, v in metrics.items() if not k.startswith("_")},
    )


# ---------------------------------------------------------------------------
# Session summary
# ---------------------------------------------------------------------------

def build_session_report(move_reports: list[MoveReport]) -> SessionReport:
    """Aggregate per-move reports into a session summary."""
    if not move_reports:
        return SessionReport(
            overall_score=0,
            strongest_area="N/A",
            focus_area="N/A",
            no_moves_detected=True,
        )

    overall = int(round(sum(r.overall_score for r in move_reports) / len(move_reports)))

    # Strongest area: metric with highest mean score across all moves
    metric_totals: dict[str, list[int]] = {}
    for report in move_reports:
        for key, sc in report.scores.items():
            if sc is not None:
                metric_totals.setdefault(key, []).append(sc)

    if metric_totals:
        means = {k: sum(v) / len(v) for k, v in metric_totals.items()}
        strongest_key = max(means, key=lambda k: means[k])
        strongest_area = _metric_label(strongest_key)
    else:
        strongest_area = "N/A"

    # #1 focus: highest-priority cue that appears across most moves
    cue_counts: dict[str, int] = {}
    for report in move_reports:
        for cue in report.top_cues:
            cue_counts[cue.cue_id] = cue_counts.get(cue.cue_id, 0) + 1

    if cue_counts:
        def focus_key(item):
            cue_id, count = item
            try:
                priority = CUE_PRIORITY.index(cue_id)
            except ValueError:
                priority = len(CUE_PRIORITY)
            return (priority, -count)
        focus_cue_id = sorted(cue_counts.items(), key=focus_key)[0][0]
        focus_cue_text = CUES[focus_cue_id]["cue"] if focus_cue_id in CUES else focus_cue_id
        # Build one actionable sentence: cue + the move it applies to
        focus_area = focus_cue_text
        for report in move_reports:
            for cue in report.top_cues:
                if cue.cue_id == focus_cue_id:
                    focus_area = f"{focus_cue_text} — {report.move_type} ({report.timestamp_str})"
                    break
            else:
                continue
            break
    else:
        focus_area = "N/A"

    return SessionReport(
        overall_score=overall,
        strongest_area=strongest_area,
        focus_area=focus_area,
        move_reports=move_reports,
    )


# ---------------------------------------------------------------------------
# Report serialization
# ---------------------------------------------------------------------------

def report_to_markdown(session: SessionReport) -> str:
    if session.no_moves_detected:
        return (
            "# Dance Technique Analysis Report\n\n"
            "**Result:** No dance moves detected.\n\n"
            "We couldn't find any jumps, turns, or other technique elements in this video. "
            "Make sure the dancer's whole body is visible head-to-toe, the video is well lit, "
            "and there's actually dancing in the clip. Then try again.\n"
        )
    score_str = f"{session.overall_score}/100"
    lines = [
        "# Dance Technique Analysis Report\n",
        f"**Overall Session Score:** {score_str}  ",
        f"**Strongest Area:** {session.strongest_area}  ",
        f"**#1 Focus:** {session.focus_area}\n",
        "---\n",
    ]
    for i, move in enumerate(session.move_reports, 1):
        lines.append(f"## Move {i}: {move.move_type} @ {move.timestamp_str}\n")
        lines.append(f"**Score:** {move.overall_score}/100\n")
        lines.append("### Metrics\n")
        lines.append("| Metric | Value | Score |")
        lines.append("|--------|-------|-------|")
        for key, sc in move.scores.items():
            raw = move.raw_metrics.get(key)
            raw_str = f"{raw:.1f}" if isinstance(raw, float) else str(raw)
            sc_str  = str(sc) if sc is not None else "—"
            lines.append(f"| {_metric_label(key)} | {raw_str} | {sc_str} |")
        lines.append("")
        if move.top_cues:
            lines.append("### Top Corrections\n")
            for j, cue in enumerate(move.top_cues, 1):
                lines.append(f"**{j}. {cue.cue}**  ")
                lines.append(f"*Why:* {cue.why}  ")
                lines.append(f"*Drill:* {cue.drill}\n")
    return "\n".join(lines)


def report_to_dict(session: SessionReport) -> dict:
    """Convert to JSON-serialisable dict."""
    def _move_dict(m: MoveReport) -> dict:
        return {
            "move_type":     m.move_type,
            "timestamp":     m.timestamp_str,
            "overall_score": m.overall_score,
            "scores":        m.scores,
            "raw_metrics":   m.raw_metrics,
            "top_cues": [
                {"cue_id": c.cue_id, "cue": c.cue, "why": c.why,
                 "drill": c.drill, "score": c.score}
                for c in m.top_cues
            ],
        }
    return {
        "overall_score":     session.overall_score,
        "strongest_area":    session.strongest_area,
        "focus_area":        session.focus_area,
        "no_moves_detected": session.no_moves_detected,
        "moves":             [_move_dict(m) for m in session.move_reports],
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fmt_ts(ms: int) -> str:
    total_s = ms // 1000
    mins = total_s // 60
    secs = total_s % 60
    return f"{mins}:{secs:02d}"


def _rot_label(n: float) -> str:
    if n == int(n):
        return f"{int(n)} rotation{'s' if n != 1 else ''}"
    return f"{n} rotations"


_METRIC_LABELS: dict[str, str] = {
    "front_leg_ext":      "Front leg extension",
    "back_leg_ext":       "Back leg extension",
    "back_leg_height":    "Back leg height (level)",
    "point_feet":         "Foot point",
    "split_angle":        "Split angle",
    "torso_uprightness":  "Torso uprightness",
    "land_plie":          "Landing plié depth",
    "retire_dist":        "Retiré position",
    "working_knee_fold":  "Working knee fold",
    "releve_height":      "Relevé height",
    "vert_stack":         "Vertical alignment",
    "arabesque_height":   "Arabesque height (°)",
    "arabesque_knee_ext": "Working knee extension",
    "support_knee_ext":   "Standing knee extension",
    "arabesque_tilt":     "Torso tilt",
    "hold_duration_s":    "Hold duration (s)",
    # Grand battement
    "battement_height":    "Battement height (°)",
    "battement_knee_ext":  "Working knee extension",
    "battement_tilt":      "Torso tilt",
    # Plié
    "plie_depth":          "Plié depth (°)",
    "plie_back_vertical":  "Back vertical",
    # Relevé
    "ankle_wobble":        "Balance stability",
    # Chaîné
    "travel_distance":     "Lateral drift",
    # Piqué / fouetté
    "rotation_consistency": "Rotation consistency",
    "knee_oscillation":    "Fouetté action",
    "knee_extension_max":  "Leg extension",
    # Changement / Assemblé
    "feet_together":       "Feet together",
    "ankle_join":          "Ankles joined",
    # Tilt
    "tilt_angle":          "Tilt angle (°)",
    "tilt_hold_s":         "Tilt hold (s)",
    "tilt_leg_line":       "Leg line",
}


def _metric_label(key: str) -> str:
    return _METRIC_LABELS.get(key, key.replace("_", " ").title())
