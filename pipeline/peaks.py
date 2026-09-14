"""Precompute a waveform overview for the original audio.

The timeline draws the original under the clip lane, and decoding two hours of
audio in the page to do that is not viable. This writes a compact envelope
once: one unsigned byte per bucket, 50 buckets a second, which is ~350 kB for
this film and redraws instantly at any zoom the editor uses.

    python -m pipeline.peaks --project project/project.json
"""

import argparse
import sys
from pathlib import Path

import numpy as np

from .dubkit import ff
from .dubkit.project import Project

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "project"

RATE = 50            # buckets per second
CHUNK_SECONDS = 600  # decode in 10-minute pieces so memory stays flat


def build(src, dst, rate=RATE, sr=16000):
    total = ff.duration(src)
    out = []
    per_bucket = sr // rate
    pos = 0.0
    while pos < total:
        span = min(CHUNK_SECONDS, total - pos)
        x, _ = ff.decode_f32(src, sr=sr, mono=True, start=pos, dur=span)
        n = (len(x) // per_bucket) * per_bucket
        if n:
            b = x[:n].reshape(-1, per_bucket)
            # min/max per bucket, not abs-max: an envelope drawn from both
            # extremes reads as a waveform rather than a blob.
            out.append(np.stack([b.min(axis=1), b.max(axis=1)], axis=1))
        pos += span
    env = np.concatenate(out, axis=0) if out else np.zeros((0, 2), dtype=np.float32)
    q = np.clip(np.rint(env * 127.0), -127, 127).astype(np.int8)
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    Path(dst).write_bytes(q.tobytes())
    return len(q), total


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=str(PROJECT / "project.json"))
    ap.add_argument("--rate", type=int, default=RATE)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)

    proj = Project.load(args.project)
    media = proj.data.get("media") or {}
    src = proj.root / (media.get("original_wav") or "media/original.wav")
    if not src.exists():
        print("no original audio at %s" % src, file=sys.stderr)
        return 2

    dst = proj.root / "out" / "peaks.bin"
    if dst.exists() and not args.force and media.get("peaks_rate") == args.rate:
        print("peaks already built (%d bytes)" % dst.stat().st_size)
        return 0

    print("building the waveform overview ...")
    n, total = build(src, dst, rate=args.rate)
    media["peaks"] = "out/peaks.bin"
    media["peaks_rate"] = args.rate
    proj.data["media"] = media
    proj.save()
    print("wrote %s  (%d buckets, %.1f min at %d/s)" % (dst, n // 2, total / 60, args.rate))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
