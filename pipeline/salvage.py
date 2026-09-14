"""Recover takes recorded outside the booth (e.g. in a DAW) and attach them to lines.

Long recording sessions leave continuous WAVs in which the actor punches in,
retries a line several times, moves on. This finds the real utterances by
energy gate, asks whisper which script line each one is, slices it out and
files it under that line. It also measures the actor's true speaking rate,
which is what preflight needs instead of a guessed 13 chars/sec.

    python -m pipeline.salvage --takes-dir <session wavs> --dry-run   # report only
    python -m pipeline.salvage --takes-dir <session wavs>             # slice and update
"""

import argparse
import csv
import os
import statistics
import sys
from pathlib import Path

from .dubkit import asr, ff
from .dubkit.arabic import best_match, tokens
from .dubkit.project import Project
from .dubkit.silence import find_speech_spans, measure
from .dubkit.wav import read_wav

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "project"


SPAN_PAD = 0.10  # added at each end of a span, so a span is 2*SPAN_PAD long


def take_spans(x, sr, min_pause=0.8, pad=SPAN_PAD, min_dur=0.4):
    return find_speech_spans(x, sr, min_pause=min_pause, pad=pad, min_dur=min_dur)


def scan_file(path, whisper, verbose=True):
    """-> (list of {start,end,dur,text}, signal measurements)

    Spans come from the energy gate, and each is transcribed on its own so a
    long whisper segment can never bleed its text across three utterances.
    """
    x, sr = ff.decode_f32(path)
    sig = measure(x, sr)
    spans = take_spans(x, sr)
    key = asr.file_key(path)
    out = []
    for a, b in spans:
        text = whisper.transcribe_span(x, sr, a, b, cache_key=key)
        out.append({"start": a, "end": b, "dur": b - a, "text": text})
    if verbose:
        print("  %-40s %6.1fs  %2d utterances  SNR %s dB  peak %s dBFS"
              % (os.path.basename(path), len(x) / sr, len(out),
                 sig["snr_db"], sig["peak_dbfs"]))
    return out, sig


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=str(PROJECT / "project.json"))
    ap.add_argument("--takes-dir", required=True,
                    help="folder of session WAVs to scan for takes")
    ap.add_argument("--model", default=None, help="ggml model (default: Arabic finetune)")
    ap.add_argument("--min-score", type=float, default=0.45)
    ap.add_argument("--margin", type=float, default=0.08,
                    help="required lead over the runner-up line; below this it is ambiguous")
    ap.add_argument("--limit", type=int, default=0, help="only scan the first N files")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if not asr.available():
        print("whisper-cli or the Arabic model was not found; set WHISPER_DIR.",
              file=sys.stderr)
        return 2

    proj = Project.load(args.project)
    narration = proj.narration()
    candidates = [(ln["n"], tokens(ln["text"])) for ln in narration]
    by_n = {ln["n"]: ln for ln in narration}

    files = sorted(Path(args.takes_dir).glob("*.wav"))
    if args.limit:
        files = files[:args.limit]
    if not files:
        print("no .wav files in %s" % args.takes_dir, file=sys.stderr)
        return 2
    print("scanning %d files from %s" % (len(files), args.takes_dir))

    cache_dir = proj.root / "cache" / "asr"
    rows, sigs, matched, ambiguous, unmatched = [], [], 0, 0, 0

    print("starting whisper-server (loads 1.6 GB once) ...")
    whisper = asr.Whisper(cache_dir, model=args.model)
    with whisper:
      for path in files:
        try:
            utts, sig = scan_file(path, whisper)
        except (ff.FFError, asr.AsrError) as e:
            print("  ! %s: %s" % (path.name, e))
            continue
        sigs.append(sig)
        for u in utts:
            n, score, second = best_match(u["text"], candidates, args.min_score)
            status = "matched"
            if n is None:
                status, unmatched = "unmatched", unmatched + 1
            elif score - second < args.margin:
                status, ambiguous = "ambiguous", ambiguous + 1
                n = None
            else:
                matched += 1
            rows.append({"source": path.name, "start": round(u["start"], 2),
                         "end": round(u["end"], 2), "dur": round(u["dur"], 2),
                         "n": n, "score": round(score, 3),
                         "runner_up": round(second, 3), "status": status,
                         "asr": u["text"],
                         "script": by_n[n]["text"] if n else ""})

    total = len(rows)
    print("\n%d utterances: %d matched, %d ambiguous, %d unmatched"
          % (total, matched, ambiguous, unmatched))
    if sigs:
        snr = [s["snr_db"] for s in sigs if s["snr_db"]]
        pk = [s["peak_dbfs"] for s in sigs if s["peak_dbfs"]]
        print("signal: median SNR %.1f dB, median peak %.1f dBFS, %d file(s) clipping"
              % (statistics.median(snr), statistics.median(pk),
                 sum(1 for s in sigs if s["clipped_samples"] > 0)))

    lines_hit = sorted({r["n"] for r in rows if r["n"]})
    print("covers %d of %d narration lines (%.0f%%)"
          % (len(lines_hit), len(narration), 100 * len(lines_hit) / len(narration)))

    # Speaking rate, from the tightest confident read of each line. Span
    # durations carry SPAN_PAD of silence at each end, so subtract it or the
    # rate comes out systematically slow and preflight over-reports rewrites.
    rates = []
    for n in lines_hit:
        mine = [r for r in rows if r["n"] == n and r["score"] >= 0.80]
        if not mine or by_n[n]["chars"] < 15:
            continue
        dur = min(r["dur"] for r in mine) - 2 * SPAN_PAD
        if dur > 0.6:
            rates.append(by_n[n]["chars"] / dur)
    if rates:
        rates.sort()
        print("measured speaking rate: median %.1f chars/sec "
              "(p25 %.1f, p75 %.1f, n=%d)"
              % (statistics.median(rates), rates[len(rates) // 4],
                 rates[3 * len(rates) // 4], len(rates)))

    out_csv = proj.root / "out" / "salvage.csv"
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with open(out_csv, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print("wrote %s" % out_csv)

    if args.dry_run:
        print("\ndry run - no audio sliced, project.json untouched")
        return 0

    takes_dir = proj.root / "takes"
    takes_dir.mkdir(parents=True, exist_ok=True)
    src_by_name = {p.name: p for p in files}

    # Salvage is re-run whenever the script changes, so it must replace its own
    # previous output rather than pile another copy on top of it. Takes
    # recorded in the booth are never touched.
    dropped = 0
    for ln in narration:
        keep = [t for t in ln["takes"] if t.get("origin") != "salvage"]
        for t in ln["takes"]:
            if t.get("origin") == "salvage":
                old = proj.root / t["file"]
                if old.exists():
                    old.unlink()
                dropped += 1
        if len(keep) != len(ln["takes"]):
            ln["takes"] = keep
            if ln.get("selected") and not any(t["file"] == ln["selected"] for t in keep):
                ln["selected"] = keep[-1]["file"] if keep else None
            if not keep and ln["status"] == "recorded":
                ln["status"] = "todo"
    if dropped:
        print("replaced %d take(s) from a previous salvage run" % dropped)

    written = 0
    for n in lines_hit:
        ln = by_n[n]
        mine = [r for r in rows if r["n"] == n]
        mine.sort(key=lambda r: (r["source"], r["start"]))
        for r in mine:
            idx = len(ln["takes"]) + 1
            name = "%04d_t%02d.wav" % (n, idx)
            dst = takes_dir / name
            ff.slice_wav(src_by_name[r["source"]], dst, r["start"], r["dur"],
                         sr=proj.settings["sample_rate"],
                         bits=proj.settings["bit_depth"])
            ln["takes"].append({
                "file": "takes/%s" % name,
                "origin": "salvage",
                "source": r["source"],
                "src_start": r["start"], "src_end": r["end"],
                "dur": r["dur"], "asr": r["asr"], "match_score": r["score"],
            })
            written += 1
        ln["selected"] = ln["takes"][-1]["file"]
        if ln["status"] == "todo":
            ln["status"] = "recorded"

    if rates:
        proj.settings["cps"] = round(statistics.median(rates), 2)
        proj.settings["cps_source"] = "measured from %d salvaged takes" % len(rates)
    proj.save()
    print("sliced %d takes into %s and updated project.json" % (written, takes_dir))
    print("cps set to %.2f - re-run preflight to refresh verdicts"
          % proj.settings["cps"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
