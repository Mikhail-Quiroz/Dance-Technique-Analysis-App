"""Cut one long recording (several reps with pauses between them) into numbered reference clips.

    python scripts/cut_recording.py "videos/reference/<folder>/full recording/<file>.MOV" 8.5 13.6 15.9 ...

The times (seconds) are the cut points: the first clip runs from the first time to the second, and so
on. Pick them in the pauses between reps, leaving out the camera setup at the start and the reach for
the phone at the end. Clips are written next to the "full recording" folder as "<folder> N.mp4",
numbered after any clips already there; scripts/extract_live_fixtures.py skips "full recording/".

Each clip is H.264 with the original frame timing kept (phones record variable frame rate). An iPhone
films HDR (HLG) by default: it is tone-mapped to standard range, which is what a browser shows; read
as-is it comes out washed out. Needs ffmpeg: `pip install imageio-ffmpeg`, or ffmpeg on the PATH.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
from pathlib import Path

TONEMAP = ("zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,"
           "zscale=t=bt709:m=bt709:r=tv,format=yuv420p")


def ffmpeg() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        exe = shutil.which("ffmpeg")
        if not exe:
            raise SystemExit("ffmpeg not found: pip install imageio-ffmpeg")
        return exe


def is_hdr(ff: str, src: Path) -> bool:
    info = subprocess.run([ff, "-hide_banner", "-i", str(src)], capture_output=True, text=True).stderr
    return "arib-std-b67" in info or "smpte2084" in info


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("recording", type=Path)
    ap.add_argument("cuts", type=float, nargs="+")
    args = ap.parse_args()
    src: Path = args.recording
    if src.parent.name != "full recording":
        raise SystemExit('put the recording in "<folder>/full recording/" first')
    if len(args.cuts) < 2 or args.cuts != sorted(args.cuts):
        raise SystemExit("give at least two cut times, in order")
    folder = src.parent.parent
    ff = ffmpeg()
    vf = ["-vf", TONEMAP] if is_hdr(ff, src) else ["-pix_fmt", "yuv420p"]
    taken = [int(m.group(1)) for p in folder.glob("*.mp4") if (m := re.search(r"(\d+)\.mp4$", p.name))]
    n = max(taken, default=0)
    for start, end in zip(args.cuts[:-1], args.cuts[1:]):
        n += 1
        dst = folder / f"{folder.name} {n}.mp4"
        subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", str(src),
                        "-t", f"{end - start:.3f}", *vf, "-c:v", "libx264", "-crf", "18", "-preset", "fast",
                        "-fps_mode", "passthrough", "-an", "-movflags", "+faststart", str(dst)], check=True)
        print(f"wrote {dst.name}  {start:.1f}-{end:.1f} s")


if __name__ == "__main__":
    main()
