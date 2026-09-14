"""Re-judge every take already on disk with the current checker.

Verdicts are stored on the take when it is recorded, so they go stale whenever
the checker improves or the script timings change. This replays them all.

    python -m pipeline.recheck
"""

import argparse
from pathlib import Path

from .checkd import Checker
from .dubkit.project import Project

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "project"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=str(PROJECT / "project.json"))
    ap.add_argument("--no-asr", action="store_true")
    ap.add_argument("--preroll", type=float, default=None,
                    help="cue offset to assume for takes recorded before it was stored")
    args = ap.parse_args(argv)

    proj = Project.load(args.project)
    checker = Checker(args.project, use_asr=not args.no_asr)
    note = checker.start()
    if note:
        print(note)

    default_cue = args.preroll
    if default_cue is None:
        default_cue = proj.settings.get("preroll", 3.0)

    changed = counts = 0
    tally = {}
    try:
        for ln in proj.narration():
            for t in ln["takes"]:
                if not (proj.root / t["file"]).exists():
                    continue
                cue = t.get("cue")
                if cue is None and t.get("origin") == "booth":
                    cue = default_cue      # recorded before the cue was tracked
                res = checker.check(ln["n"], t["file"], cue=cue)
                counts += 1
                before = (t.get("check") or {}).get("verdict")
                t["check"] = {
                    "verdict": res["verdict"], "speech": res.get("speech"),
                    "headroom": res.get("headroom"), "message": res.get("message"),
                    "start_offset": res.get("start_offset"),
                    "warnings": res.get("warnings", []),
                }
                tally[res["verdict"]] = tally.get(res["verdict"], 0) + 1
                if before != res["verdict"]:
                    changed += 1
                    print("  %-22s %-7s -> %-7s  %s"
                          % (t["file"].split("/")[-1], before or "-",
                             res["verdict"], res.get("message", "")))
    finally:
        checker.stop()

    proj.save()
    print("\nre-checked %d take(s); %d verdict(s) changed" % (counts, changed))
    print("  " + "  |  ".join("%s %d" % (k.lower(), v)
                              for k, v in sorted(tally.items(), key=lambda kv: -kv[1])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
