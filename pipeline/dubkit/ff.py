"""Thin ffmpeg / ffprobe wrappers. No shell, list args only."""

import json
import shutil
import subprocess

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"


class FFError(RuntimeError):
    pass


def run(args):
    cmd = [FFMPEG, "-hide_banner", "-nostdin", "-y"] + list(args)
    p = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if p.returncode != 0:
        tail = "\n".join((p.stderr or "").strip().splitlines()[-15:])
        raise FFError("ffmpeg failed (%d):\n%s" % (p.returncode, tail))
    return p.stderr or ""


def probe(path):
    cmd = [FFPROBE, "-v", "error", "-print_format", "json",
           "-show_format", "-show_streams", str(path)]
    p = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise FFError("ffprobe failed on %s: %s" % (path, (p.stderr or "").strip()))
    return json.loads(p.stdout)


def duration(path):
    return float(probe(path)["format"]["duration"])


def media_info(path):
    info = probe(path)
    out = {"duration": float(info["format"]["duration"]), "fps": None,
           "width": None, "height": None, "has_video": False}
    for s in info["streams"]:
        if s.get("codec_type") == "video" and not out["has_video"]:
            out["has_video"] = True
            out["width"], out["height"] = s.get("width"), s.get("height")
            r = s.get("avg_frame_rate") or s.get("r_frame_rate") or "0/1"
            try:
                num, den = (int(x) for x in r.split("/"))
                out["fps"] = round(num / den, 4) if den else None
            except ValueError:
                pass
    return out


def to_mono_wav(src, dst, sr=48000, bits=24):
    codec = {16: "pcm_s16le", 24: "pcm_s24le"}[bits]
    run(["-i", str(src), "-vn", "-ac", "1", "-ar", str(sr), "-c:a", codec, str(dst)])


def make_proxy(src, dst, height=720, crf=26):
    """Small, seek-friendly H.264 for the booth's <video> element."""
    run([
        "-i", str(src),
        "-vf", "scale=-2:%d" % height,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf),
        "-g", "50", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        "-movflags", "+faststart",
        str(dst),
    ])


def slice_wav(src, dst, start, dur, sr=48000, bits=24):
    codec = {16: "pcm_s16le", 24: "pcm_s24le"}[bits]
    run(["-ss", "%.3f" % start, "-t", "%.3f" % dur, "-i", str(src),
         "-vn", "-ac", "1", "-ar", str(sr), "-c:a", codec, str(dst)])


def decode_f32(path, sr=None, mono=True, start=None, dur=None):
    """Decode any audio file to (float32 numpy array, sample_rate) via ffmpeg.

    Fallback for formats Python's `wave` module rejects - FL Studio writes
    32-bit float WAV (format tag 3), which it will not open.
    """
    import numpy as np

    if sr is None:
        info = probe(path)
        sr = 48000
        for s in info["streams"]:
            if s.get("codec_type") == "audio":
                sr = int(s.get("sample_rate") or 48000)
                break
    args = [FFMPEG, "-hide_banner", "-nostdin", "-v", "error"]
    if start is not None:
        args += ["-ss", "%.3f" % start]
    if dur is not None:
        args += ["-t", "%.3f" % dur]
    args += ["-i", str(path),
             "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-ar", str(sr)]
    if mono:
        args += ["-ac", "1"]
    args += ["-"]
    p = subprocess.run(args, capture_output=True)
    if p.returncode != 0:
        raise FFError("ffmpeg decode failed on %s: %s"
                      % (path, p.stderr.decode("utf-8", "replace").strip()[-400:]))
    return np.frombuffer(p.stdout, dtype="<f4").copy(), sr
