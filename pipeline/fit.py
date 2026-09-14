"""Place every recorded take on the film's timeline, and render the dub.

A take goes down exactly as it was recorded - pre-roll, breath, tail and all -
positioned so the moment the cue passed during recording lands on the line's
own start. Nothing is trimmed, absorbed or compressed on the fitter's own
initiative. Length only changes when someone drags an edge, and then the whole
clip is stretched with pitch and formants locked.

Automatic trimming was removed deliberately: cutting to the detected speech
lopped the tail off every read and sliced any word begun before the cue. The
speech extent is still measured, but only to label the clip.

Nothing is destructive: raw takes are untouched and every decision is recorded
per line in project.json so the editor can show and undo it.

    python -m pipeline.fit                 # assemble everything recorded so far
    python -m pipeline.fit --only 412 413  # re-fit just these lines
"""

import argparse
import csv
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from .dubkit import ff
from .dubkit.project import Project
from .dubkit.silence import find_speech_spans
from .dubkit.wav import read_wav, write_wav

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "project"

FADE_MS = 6.0          # at every join, to keep the splices inaudible


def fades(x, sr, ms=FADE_MS):
    n = min(int(sr * ms / 1000.0), len(x) // 2)
    if n > 0:
        ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
        x[:n] *= ramp
        x[-n:] *= ramp[::-1]
    return x


def rubberband(x, sr, tempo):
    """Time-stretch by `tempo` (>1 = faster) with pitch and formants locked."""
    if abs(tempo - 1.0) < 1e-3:
        return x
    with tempfile.TemporaryDirectory() as td:
        src, dst = Path(td) / "in.wav", Path(td) / "out.wav"
        write_wav(src, x, sr, bits=24)
        ff.run(["-i", str(src),
                "-af", "rubberband=tempo=%.6f:pitch=1:transients=crisp:"
                       "formant=preserved:pitchq=quality" % tempo,
                "-ac", "1", "-ar", str(sr), "-c:a", "pcm_s24le", str(dst)])
        y, _ = read_wav(dst)
    return y.astype(np.float32)


MANUAL_RMIN, MANUAL_RMAX = 0.55, 1.8   # how far a hand-sized clip may be pushed

# How quiet a whole take has to be before it is called empty. Nothing is cut on
# the strength of this - it only labels the clip.
EMPTY_PEAK_DBFS = -50.0


def measure_speech(x, sr, cue=None, early=0.8):
    """Where the speech sits inside a take. Reporting only - never a cut.

    Trimming a take to this was the single worst thing the fitter did: it
    clipped the tail of every read into an abrupt stop, and any word begun
    before the cue was sliced in half. The numbers are still useful as a
    length hint, so they are measured and shown; they just never touch audio.

    The window starts a little before the cue so the count-in beeps, which do
    reach the microphone, are not mistaken for the performance. Audio before
    that point is still kept in the clip - it simply is not measured.
    """
    a0 = max(0.0, float(cue) - early) if cue else 0.0
    i0 = int(a0 * sr)
    spans = find_speech_spans(x[i0:], sr, min_pause=0.14, pad=0.03, min_dur=0.06)
    if not spans:
        return None
    return spans[0][0] + a0, spans[-1][1] + a0, spans[-1][1] - spans[0][0]


def plan_take(proj, ln, x, sr, cue=None, edit=None):
    """Place a take on the timeline exactly as it was recorded.

    The clip is the entire recording - pre-roll, breath, tail and all. It is
    positioned so the moment the cue passed during recording lands on the
    line's own start, which puts the performance where the actor put it
    without removing a sample of it. Length is only ever changed when someone
    asks for it by dragging an edge.
    """
    edit = edit or {}
    info = {"verdict": "REC", "ratio": 1.0, "pause_scale": 1.0,
            "borrow_before": 0.0, "borrow_after": 0.0, "overrun": 0.0}
    if x.size == 0:
        info["verdict"] = "EMPTY"
        return None, None, info

    out = np.asarray(x, dtype=np.float32).copy()
    natural = len(out) / sr
    info["natural"] = round(natural, 3)

    peak_db = 20 * np.log10(float(np.abs(out).max()) + 1e-12)
    spoken = measure_speech(out, sr, cue)
    if spoken:
        info["speech"] = round(spoken[2], 3)
        info["speech_at"] = round(spoken[0], 3)
    if peak_db < EMPTY_PEAK_DBFS:
        info["verdict"] = "EMPTY"

    # Two independent things can change the audio, and they compose.
    #
    # A cut is a *window* into the recording - so much off the front, so much
    # off the back - not a single length. Storing it as one length plus the
    # edge that was dragged meant the second cut was applied to the raw take
    # and silently threw the first one away: trim the head, then trim the tail,
    # and the head came back. Head and tail are now tracked separately, so
    # dragging either edge composes with whatever the other one already did,
    # and dragging outwards restores audio up to the full recording.
    #
    # A stretch is then applied to whatever the window left.
    mode = (edit.get("mode") or "stretch").lower()
    target = edit.get("target_dur")
    head = max(0.0, float(edit.get("cut_head") or 0.0))
    tail = max(0.0, float(edit.get("cut_tail") or 0.0))

    if target and mode in ("cut", "trim") and not (head or tail):
        # An edit written before cuts were a window. Read it as one.
        keep = max(0.05, float(target))
        if keep < natural:
            if (edit.get("cut_edge") or "end").lower() == "start":
                head = natural - keep
            else:
                tail = natural - keep
        target = None

    cut_head = 0.0
    if head or tail:
        i0 = min(len(out) - 1, max(0, int(round(head * sr))))
        i1 = max(i0 + 1, len(out) - int(round(tail * sr)))
        i1 = min(len(out), i1)
        if i1 - i0 >= int(0.05 * sr) and (i0 > 0 or i1 < len(out)):
            out = out[i0:i1].copy()
            cut_head = i0 / sr
            fade = min(int(sr * 0.008), len(out) // 2)
            if fade > 0:
                if i0 > 0:
                    out[:fade] *= np.linspace(0.0, 1.0, fade, dtype=np.float32)
                if i1 < int(round(natural * sr)):
                    out[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
        info["cut_head"] = round(cut_head, 3)
        info["cut_tail"] = round(max(0.0, natural - cut_head - len(out) / sr), 3)
        info["cut_from"] = round(natural, 3)
        info["mode"] = "cut"
        info["verdict"] = "MANUAL"

    windowed = len(out) / sr
    if target:
        target = max(0.05, float(target))
        want = windowed / target
        ratio = float(np.clip(want, MANUAL_RMIN, MANUAL_RMAX))
        info["ratio"] = round(ratio, 4)
        if abs(want - ratio) > 1e-3:
            info["clamped"] = True
            info["wanted_ratio"] = round(want, 4)
        out = rubberband(out, sr, ratio)
        info["mode"] = "stretch"
        info["verdict"] = "MANUAL"

    dur = len(out) / sr
    # Where the line's own start fell inside the recording. A head cut removes
    # audio in front of it; a stretch then scales what is left.
    anchor = float(cue) if cue else 0.0
    if cut_head:
        anchor = max(0.0, anchor - cut_head)
    if target and windowed > 0:
        anchor *= dur / windowed

    if edit.get("place_at") is not None:
        # Dragged by hand: the clip goes exactly where it was put. Deriving the
        # position from the cue instead made a dragged clip jump by the whole
        # pre-roll on its next re-fit, because the offset was being measured
        # from the line's start rather than from where the anchor puts it.
        place = max(0.0, float(edit["place_at"]))
    else:
        place = max(0.0, ln["start"] - anchor + float(edit.get("offset") or 0.0))

    info["fitted"] = round(dur, 3)
    info["placed_at"] = round(place, 3)
    info["cue_in_take"] = round(anchor, 3)
    if edit.get("offset"):
        info["manual"] = {"offset": float(edit["offset"])}

    # Reported against the speech, not the whole clip: pre-roll and tail are
    # meant to run past the slot now, so measuring them would flag everything.
    if spoken:
        scale = (dur / windowed) if (target and windowed) else 1.0
        s_start = place + max(0.0, spoken[0] - cut_head) * scale
        s_end = place + min(max(0.0, spoken[1] - cut_head) * scale, dur)
        limit = ln["end"] + ln["slack_after"]
        info["overrun"] = round(max(0.0, s_end - limit), 3)
        info["speech_starts_at"] = round(s_start, 3)
        if info["verdict"] == "REC" and info["overrun"] > 0.25:
            info["verdict"] = "OVERRUN"
    return out, place, info


def fit_one(proj, ln, sr=None):
    """Plan and render a single line. Returns (audio, place, info).

    No canvas, no master file - just this clip. Editing is live per clip, so
    rebuilding a two-hour timeline to change two seconds of it is pure waste.
    """
    sr = sr or proj.settings["sample_rate"]
    if not ln.get("selected"):
        return None, None, {"verdict": "MISSING"}
    path = proj.root / ln["selected"]
    if not path.exists():
        return None, None, {"verdict": "MISSING"}

    x, _ = ff.decode_f32(path, sr=sr)
    take = next((t for t in ln["takes"] if t.get("file") == ln["selected"]), None)
    cue = take.get("cue") if take else None
    if not cue and take and take.get("origin") == "booth":
        # Recorded before the cue offset was stored. Every booth take rolls
        # from the pre-roll, so assume the setting rather than 0 - anchoring at
        # 0 would put the whole count-in inside the slot and the voice seconds
        # late. Salvaged takes are already trimmed and correctly anchor at 0.
        cue = proj.settings.get("preroll", 3.0)

    audio, place, info = plan_take(proj, ln, x, sr, cue, ln.get("edit") or {})
    info["take"] = ln["selected"]

    if audio is not None:
        info["placed_at"] = round(place, 3)
        dst = proj.root / "fitted" / ("%04d.wav" % ln["n"])
        dst.parent.mkdir(parents=True, exist_ok=True)
        write_wav(dst, audio, sr, bits=24)
        info["render"] = "fitted/%04d.wav" % ln["n"]
        # Every render reuses the same filename, so the page needs something
        # that changes to key its decoded-audio cache on. Without it a new take
        # renders correctly and plays back as the take before it.
        info["rev"] = int(dst.stat().st_mtime_ns // 1000000)
    ln["fit"] = info
    return audio, place, info


def run(proj, only=None, quiet=False):
    s = proj.settings
    sr = s["sample_rate"]
    total = proj.data["media"].get("duration") or proj.lines[-1]["end"]
    canvas = np.zeros(int(total * sr) + sr, dtype=np.float32)

    rows, counts = [], {}
    narration = proj.narration()
    targets = [l for l in narration if l["n"] in only] if only else narration

    # A partial run still writes the whole timeline, so every line that is not
    # being re-planned has to be laid back down from its stored render.
    # Without this, `--only` produced a dub containing that line and silence.
    if only:
        for ln in narration:
            if ln["n"] in only:
                continue
            fit = ln.get("fit") or {}
            render, at = fit.get("render"), fit.get("placed_at")
            if not render or at is None:
                continue
            src = proj.root / render
            if not src.exists():
                continue
            audio, _ = ff.decode_f32(src, sr=sr)
            i0 = max(0, int(at * sr))
            i1 = min(len(canvas), i0 + len(audio))
            if i1 > i0:
                canvas[i0:i1] += audio[:i1 - i0]

    for ln in targets:
        if not ln.get("selected") or not (proj.root / ln["selected"]).exists():
            ln["fit"] = None
            counts["MISSING"] = counts.get("MISSING", 0) + 1
            continue
        audio, place, info = fit_one(proj, ln, sr)
        counts[info["verdict"]] = counts.get(info["verdict"], 0) + 1
        if audio is not None:
            i0 = max(0, int(place * sr))
            i1 = min(len(canvas), i0 + len(audio))
            if i1 > i0:
                canvas[i0:i1] += audio[:i1 - i0]

        rows.append({
            "n": ln["n"], "start": round(ln["start"], 2),
            "slot": round(proj.slot(ln), 2),
            "slack": round(ln["slack_before"] + ln["slack_after"], 2),
            "take": ln["selected"],
            "natural": info.get("natural"), "fitted": info.get("fitted"),
            "pause_scale": info.get("pause_scale"), "ratio": info.get("ratio"),
            "borrow_before": info.get("borrow_before"),
            "borrow_after": info.get("borrow_after"),
            "overrun": info.get("overrun"), "verdict": info["verdict"],
            "text": ln["text"],
        })

    peak = float(np.abs(canvas).max()) if canvas.size else 0.0
    if peak > 0.99:
        canvas *= 0.99 / peak
        if not quiet:
            print("  (peak was %.2f, scaled down to -0.1 dBFS)" % peak)

    out_dir = proj.root / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    wav_path = out_dir / "dub_fitted.wav"
    write_wav(wav_path, canvas, sr, bits=24)

    if rows:
        with open(out_dir / "fit_report.csv", "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    proj.data.setdefault("media", {})["dub"] = "out/dub_fitted.wav"
    proj.save()
    return counts, rows, wav_path


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=str(PROJECT / "project.json"))
    ap.add_argument("--only", nargs="*", type=int, default=None,
                    help="re-fit only these line numbers")
    ap.add_argument("--list", default=None,
                    help="print the lines with this verdict (OVERRUN, STRETCH, ...)")
    args = ap.parse_args(argv)

    proj = Project.load(args.project)
    recorded = sum(1 for l in proj.narration() if l.get("selected"))
    if not recorded:
        print("nothing recorded yet - run the booth first.", file=sys.stderr)
        return 1

    only = set(args.only) if args.only else None
    if only:
        print("re-fitting %d line%s; the rest of the timeline is laid back down "
              "from its stored renders" % (len(only), "" if len(only) == 1 else "s"))
    else:
        print("fitting %d recorded line%s of %d ..."
              % (recorded, "" if recorded == 1 else "s", len(proj.narration())))
    counts, rows, wav_path = run(proj, only=only)

    order = ["REC", "MANUAL", "OVERRUN", "EMPTY", "MISSING"]
    parts = ["%s %d" % (k.lower(), counts[k]) for k in order if counts.get(k)]
    print("  " + "  |  ".join(parts))
    print("wrote %s (%.1f min timeline)" % (wav_path, ff.duration(wav_path) / 60))
    print("wrote %s" % (proj.root / "out" / "fit_report.csv"))

    if args.list:
        sel = [r for r in rows if r["verdict"] == args.list.upper()]
        print("\n%d %s lines:" % (len(sel), args.list.upper()))
        for r in sorted(sel, key=lambda r: -(r["overrun"] or 0)):
            print("  #%-5d %6.1fs  slot %.1f+%.1f  natural %.2f -> %.2f  "
                  "pauses x%.2f  tempo x%.3f  over %.2fs"
                  % (r["n"], r["start"], r["slot"], r["slack"], r["natural"],
                     r["fitted"], r["pause_scale"], r["ratio"], r["overrun"]))
            print("        %s" % r["text"][:90])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
