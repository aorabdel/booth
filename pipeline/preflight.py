"""Decide, before anyone books a booth, which lines can actually be spoken in time.

Every narration line gets one of four verdicts, cheapest first:

  GREEN    fits inside its own slot at the actor's measured rate
  BORROW   fits once it takes silence from the neighbouring gaps; the fitter
           does this automatically, the actor does nothing
  STRETCH  still long, but inside the transparent Rubber Band window
  REWRITE  cannot be spoken in time - the translation must be shortened, and
           `cut_chars` says roughly by how much

Writes project/out/preflight.csv and stores the verdict on each line.
"""

import argparse
import csv
import math
from pathlib import Path

from .dubkit.project import Project
from .dubkit.srt import fmt_ts

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "project"

VERDICTS = ("GREEN", "BORROW", "STRETCH", "REWRITE")


def classify(ln, cps, rmax, slot, eff):
    """-> (verdict, need_seconds, ratio_needed, cut_chars)"""
    need = ln["chars"] / cps if cps > 0 else 0.0
    ratio = need / eff if eff > 0 else float("inf")
    if need <= slot:
        return "GREEN", need, ratio, 0
    if need <= eff:
        return "BORROW", need, ratio, 0
    if need <= eff * rmax:
        return "STRETCH", need, ratio, 0
    speakable = eff * rmax * cps
    return "REWRITE", need, ratio, int(math.ceil(ln["chars"] - speakable))


def run(proj, cps=None, rmax=None, write_csv=True, quiet=False):
    s = proj.settings
    cps = cps or s["cps"]
    rmax = rmax or s["rmax"]
    counts = dict.fromkeys(VERDICTS, 0)
    rows = []

    for ln in proj.lines:
        if ln["kind"] != "narration":
            ln["verdict"] = None
            continue
        slot = proj.slot(ln)
        eff = proj.effective_slot(ln)
        verdict, need, ratio, cut = classify(ln, cps, rmax, slot, eff)
        ln["verdict"] = verdict
        ln["preflight"] = {
            "cps": round(cps, 2),
            "need": round(need, 3),
            "ratio_needed": round(ratio, 3),
            "cut_chars": cut,
        }
        if verdict == "REWRITE" and ln["status"] == "todo":
            ln["status"] = "needs_rewrite"
        elif verdict != "REWRITE" and ln["status"] == "needs_rewrite":
            ln["status"] = "todo"
        counts[verdict] += 1
        rows.append({
            "n": ln["n"], "nar_n": ln.get("nar_n"), "xlsx_row": ln["row"],
            "start": fmt_ts(ln["start"]), "end": fmt_ts(ln["end"]),
            "slot": round(slot, 2),
            "slack_before": ln["slack_before"], "slack_after": ln["slack_after"],
            "effective_slot": round(eff, 2),
            "chars": ln["chars"], "need_s": round(need, 2),
            "ratio_needed": round(ratio, 3),
            "verdict": verdict, "cut_chars": cut,
            "text": ln["text"],
        })

    if write_csv:
        out = proj.root / "out" / "preflight.csv"
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        if not quiet:
            print("wrote %s" % out)

    return counts, rows


def summarise(counts, label=""):
    total = sum(counts.values()) or 1
    parts = ["%s %d (%d%%)" % (v.lower(), counts[v], round(100 * counts[v] / total))
             for v in VERDICTS]
    print("%s%s" % (label, "  |  ".join(parts)))


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=str(PROJECT / "project.json"))
    ap.add_argument("--cps", type=float, default=None,
                    help="override the actor's chars/sec (default: project setting)")
    ap.add_argument("--set-cps", type=float, default=None,
                    help="write this cps into the project settings before running")
    ap.add_argument("--sweep", action="store_true",
                    help="show the verdict split across a range of speaking rates")
    ap.add_argument("--list", choices=VERDICTS, default=None,
                    help="print the lines with this verdict")
    args = ap.parse_args(argv)

    proj = Project.load(args.project)
    if args.set_cps:
        proj.settings["cps"] = args.set_cps

    if args.sweep:
        print("verdict split by speaking rate (chars/sec):")
        for cps in (11, 12, 13, 14, 15):
            counts, _ = run(proj, cps=cps, write_csv=False, quiet=True)
            summarise(counts, "  %2d cps:  " % cps)
        print()

    cps = args.cps or proj.settings["cps"]
    counts, rows = run(proj, cps=cps)
    n = sum(counts.values())
    print("%d narration lines at %.1f chars/sec" % (n, cps))
    summarise(counts, "  ")

    if args.list:
        sel = [r for r in rows if r["verdict"] == args.list]
        print("\n%d %s lines:" % (len(sel), args.list))
        for r in sorted(sel, key=lambda r: -r["ratio_needed"]):
            print("  #%-5d %s  slot %.1fs+%.1fs  %d chars  need %.1fs (x%.2f)  cut ~%d"
                  % (r["n"], r["start"], r["slot"],
                     r["slack_before"] + r["slack_after"], r["chars"],
                     r["need_s"], r["ratio_needed"], r["cut_chars"]))
            print("        %s" % r["text"])

    proj.save()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
