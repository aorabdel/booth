"""Re-attach take files that exist on disk but are missing from the project.

Take files are named `NNNN_tNN.wav` after the line they belong to, so a
recording is never really lost even if its entry goes missing — which it could,
before the checker stopped writing the project file behind the server's back.

    python -m pipeline.reattach --dry-run
    python -m pipeline.reattach
"""

import argparse
import re
from pathlib import Path

from .dubkit import ff
from .dubkit.project import Project

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "project"
NAME = re.compile(r"^(\d{4})_t(\d+)\.wav$", re.I)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=str(PROJECT / "project.json"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--preroll", type=float, default=None,
                    help="cue offset to assume for recovered booth takes")
    args = ap.parse_args(argv)

    proj = Project.load(args.project)
    takes_dir = proj.root / "takes"
    if not takes_dir.exists():
        print("no takes folder at %s" % takes_dir)
        return 0

    known = {t["file"] for l in proj.lines for t in l["takes"]}
    cue = args.preroll if args.preroll is not None else proj.settings.get("preroll", 3.0)

    found, attached, orphan_lines = 0, 0, 0
    for path in sorted(takes_dir.glob("*.wav")):
        m = NAME.match(path.name)
        rel = "takes/%s" % path.name
        if not m or rel in known:
            continue
        found += 1
        n = int(m.group(1))
        ln = proj.by_n(n)
        if ln is None or ln["kind"] != "narration":
            orphan_lines += 1
            print("  ? %s has no line %d in this project" % (path.name, n))
            continue
        try:
            dur = ff.duration(path)
        except ff.FFError:
            print("  ! %s is unreadable, skipped" % path.name)
            continue
        ln["takes"].append({
            "file": rel, "origin": "recovered", "dur": round(dur, 3),
            "cue": cue, "recovered": True,
        })
        attached += 1
        print("  + line %-5d %-18s %.2fs" % (n, path.name, dur))

    # keep each line's takes in the order they were recorded
    for ln in proj.lines:
        ln["takes"].sort(key=lambda t: t.get("file", ""))
        if ln["takes"] and not ln.get("selected"):
            ln["selected"] = ln["takes"][-1]["file"]
            if ln.get("status") == "todo":
                ln["status"] = "recorded"

    print("\n%d take file(s) were missing from the project; %d re-attached"
          % (found, attached))
    if orphan_lines:
        print("%d belonged to line numbers this project does not have" % orphan_lines)
    if args.dry_run:
        print("dry run - nothing written")
        return 0
    if attached:
        proj.save()
        print("wrote %s" % proj.path)
        print("run `python -m pipeline.fit` to put them on the timeline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
