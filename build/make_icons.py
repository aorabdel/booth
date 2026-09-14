"""Generate the Windows .ico and PNG icon set from booth.png.

electron-builder wants build/icon.ico for the installer, the executable and the
window; a 512px PNG covers everything else. Rather than add an image library,
sizes are resampled with ffmpeg and packed into an ICO by hand - the format is
just a directory followed by embedded PNGs.

    python booth/build/make_icons.py
"""

import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SRC = ROOT / "booth.png"
SIZES = [16, 24, 32, 48, 64, 128, 256]


def resample(src, size, dst):
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-y", "-i", str(src),
         "-vf", "scale=%d:%d:flags=lanczos,format=rgba" % (size, size),
         "-frames:v", "1", str(dst)],
        check=True)


def pack_ico(pngs, dst):
    """pngs: [(size, bytes)] -> a Vista-style ICO with PNG-compressed entries."""
    count = len(pngs)
    offset = 6 + 16 * count
    header = struct.pack("<HHH", 0, 1, count)
    entries, blobs = [], []
    for size, data in pngs:
        entries.append(struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,   # 0 means 256
            0 if size >= 256 else size,
            0, 0, 1, 32, len(data), offset))
        blobs.append(data)
        offset += len(data)
    dst.write_bytes(header + b"".join(entries) + b"".join(blobs))


def main():
    if not SRC.exists():
        print("source icon not found: %s" % SRC, file=sys.stderr)
        return 2
    HERE.mkdir(parents=True, exist_ok=True)
    tmp = HERE / "_tmp"
    tmp.mkdir(exist_ok=True)

    pngs = []
    for size in SIZES:
        p = tmp / ("icon_%d.png" % size)
        resample(SRC, size, p)
        pngs.append((size, p.read_bytes()))
        print("  %4dx%-4d %6d bytes" % (size, size, len(pngs[-1][1])))

    pack_ico(pngs, HERE / "icon.ico")
    resample(SRC, 512, HERE / "icon.png")
    resample(SRC, 256, HERE / "icon_256.png")

    for p in tmp.iterdir():
        p.unlink()
    tmp.rmdir()
    print("wrote %s (%d bytes) and icon.png"
          % (HERE / "icon.ico", (HERE / "icon.ico").stat().st_size))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
