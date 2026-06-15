"""Coaching cue knowledge base — loaded from /shared/cues.json.

Each entry: cue_id -> {cue, why, drill}

Priority order for top-cue selection (safety → axis → leg lines → feet → amplitude)
is defined in /shared/thresholds.json under "cue_priority".
"""

import json
from pathlib import Path

_SHARED = Path(__file__).parent.parent / "shared"

CUES: dict[str, dict[str, str]] = json.loads(
    (_SHARED / "cues.json").read_text(encoding="utf-8")
)

_thresh = json.loads((_SHARED / "thresholds.json").read_text(encoding="utf-8"))
CUE_PRIORITY: list[str] = _thresh["cue_priority"]
