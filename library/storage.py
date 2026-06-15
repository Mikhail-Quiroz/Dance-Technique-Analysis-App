"""Session library: save, load, thumbnail generation, index management."""

import json, os, shutil, stat, uuid
from pathlib import Path
from datetime import datetime

import cv2
import numpy as np

try:
    from PIL import Image, ImageDraw
    _PIL_OK = True
except ImportError:
    _PIL_OK = False

LIBRARY_DIR = Path(__file__).parent
INDEX_FILE  = LIBRARY_DIR / "index.json"

ACCENT_PINK  = (232,  86, 143)
PAPER_PINK   = (245, 230, 224)
ACCENT_GREEN = ( 78, 140,  70)
PAPER_GREEN  = (242, 239, 226)

def load_index() -> list[dict]:
    if not INDEX_FILE.exists():
        return []
    try:
        return json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []

def save_index(entries: list[dict]):
    LIBRARY_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")

def next_session_number() -> int:
    entries = load_index()
    if not entries:
        return 1
    nums = []
    for e in entries:
        t = e.get("title", "")
        try:
            nums.append(int(t.split("Session")[1].split("—")[0].strip().lstrip("0") or "0"))
        except Exception:
            nums.append(0)
    return max(nums, default=0) + 1

def new_session_id() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:4]

def generate_thumbnail(
    video_path: str,
    apex_frame_idx: int,
    output_path: Path,
    theme: str = "pink",
) -> bool:
    """Extract apex frame, apply duotone+halftone, save as JPEG. Returns True on success."""
    if not _PIL_OK:
        return False
    try:
        cap = cv2.VideoCapture(str(video_path))
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, apex_frame_idx))
        ok, frame_bgr = cap.read()
        cap.release()
        if not ok:
            return False

        accent = ACCENT_PINK  if theme == "pink"  else ACCENT_GREEN
        paper  = PAPER_PINK   if theme == "pink"  else PAPER_GREEN

        # Resize to thumbnail
        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        img = Image.fromarray(frame_rgb).convert("L")
        img = img.resize((320, 240), Image.LANCZOS)
        gray = np.array(img, dtype=np.float32) / 255.0

        # Duotone: 0 (dark) → accent, 1 (light) → paper
        r = np.interp(gray, [0, 1], [accent[0], paper[0]])
        g = np.interp(gray, [0, 1], [accent[1], paper[1]])
        b = np.interp(gray, [0, 1], [accent[2], paper[2]])
        duotone = np.stack([r, g, b], axis=-1).astype(np.uint8)

        result = Image.fromarray(duotone).convert("RGBA")
        draw   = ImageDraw.Draw(result)

        # Halftone dot overlay
        h, w = gray.shape
        grid = 6
        for py in range(0, h, grid):
            for px in range(0, w, grid):
                brightness = float(gray[min(py, h-1), min(px, w-1)])
                max_r = grid * 0.45
                radius = max_r * (1.0 - brightness) * 1.4
                radius = min(radius, max_r)
                if radius > 0.6:
                    cx = px + grid // 2
                    cy = py + grid // 2
                    dot = tuple(max(0, int(c * 0.65)) for c in accent) + (160,)
                    draw.ellipse([cx-radius, cy-radius, cx+radius, cy+radius], fill=dot)

        result.convert("RGB").save(str(output_path), "JPEG", quality=85)
        return True
    except Exception:
        return False


def save_session(
    session_id: str,
    video_path: str,          # original uploaded video
    annotated_path: str,      # rendered annotated video
    report_json: dict,
    report_md: str,
    apex_frame_idx: int,      # for thumbnail
    move_counts: dict,
    overall_score: int,
    duration_s: float,
    theme: str = "pink",
) -> dict:
    """Copy artifacts into library/<session_id>/, generate thumbnail, update index."""
    session_dir = LIBRARY_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    # Copy files
    ann_dst = session_dir / "annotated.mp4"
    md_dst  = session_dir / "report.md"
    json_dst= session_dir / "report.json"
    thumb   = session_dir / "thumb.jpg"

    if annotated_path and Path(annotated_path).exists():
        shutil.copy2(annotated_path, ann_dst)
    if report_md:
        md_dst.write_text(report_md, encoding="utf-8")
    if report_json:
        json_dst.write_text(json.dumps(report_json, indent=2), encoding="utf-8")

    has_thumb = generate_thumbnail(video_path, apex_frame_idx, thumb, theme=theme)

    now = datetime.now()
    num = next_session_number()
    title = f"Session {num:03d} — {now.strftime('%b %d %Y')}"

    entry = {
        "id":            session_id,
        "title":         title,
        "date":          now.strftime("%Y-%m-%d"),
        "date_display":  now.strftime("%b %d, %Y"),
        "duration_s":    round(duration_s, 1),
        "overall_score": overall_score,
        "move_counts":   move_counts,
        "theme":         theme,
        "has_thumb":     has_thumb,
    }

    entries = load_index()
    entries.insert(0, entry)   # newest first
    save_index(entries)
    return entry


def _rmtree_robust(path: Path) -> None:
    """Delete a directory tree, clearing read-only bits on Windows errors."""
    def _handle(func, p, exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except Exception:
            pass  # best-effort; ignore if still locked

    try:
        shutil.rmtree(path, onexc=_handle)
    except Exception:
        pass


def delete_session(session_id: str):
    """Remove from index first (keeps UI consistent), then best-effort file cleanup."""
    entries = [e for e in load_index() if e["id"] != session_id]
    save_index(entries)
    session_dir = LIBRARY_DIR / session_id
    if session_dir.exists():
        _rmtree_robust(session_dir)


def delete_all_sessions():
    """Clear entire index first, then clean up all session directories."""
    entries = load_index()
    save_index([])
    for e in entries:
        session_dir = LIBRARY_DIR / e["id"]
        if session_dir.exists():
            _rmtree_robust(session_dir)


def prune_and_load() -> list[dict]:
    """Load index, silently drop orphaned entries (no report.json), persist cleaned list."""
    entries = load_index()
    valid = [e for e in entries if (LIBRARY_DIR / e["id"] / "report.json").exists()]
    if len(valid) < len(entries):
        save_index(valid)
    return valid


def rename_session(session_id: str, new_title: str):
    entries = load_index()
    for e in entries:
        if e["id"] == session_id:
            e["title"] = new_title
            break
    save_index(entries)
