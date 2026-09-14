"""Build project.json from the translation workbook, and prepare media.

The video is supplied by hand - nothing here downloads it. Put it at
project/media/source.mp4 (or pass --video). If it is not there yet, ingest still
builds the full line list from the workbook so preflight can run; re-run with
--video and --force later to add the picture.
"""

import argparse
import os
import shutil
import sys
from pathlib import Path

from .dubkit import ff
from .dubkit.project import Project, new_line
from .dubkit.srt import fmt_ts, parse_ts, read_srt
from .dubkit.xlsx import read_sheet

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "project"


def parse_script(path):
    """Read the translation script. Accepts the .xlsx or a plain .srt."""
    path = Path(path)
    if path.suffix.lower() == ".srt":
        cues = read_srt(path)
        rows = [(c.start, c.end, c.text, c.idx) for c in cues if c.end > c.start]
        rows.sort(key=lambda x: (x[0], x[1]))
        lines = [new_line(i, a, b, t, row=r) for i, (a, b, t, r) in enumerate(rows, 1)]
        return lines, len(cues) - len(rows)
    return parse_workbook(path)


def parse_workbook(xlsx_path):
    """Rows -> line dicts, sorted by start time, numbered 1..N across all cues."""
    rows, skipped = [], 0
    for r in read_sheet(xlsx_path):
        start, end = parse_ts(r.get("A")), parse_ts(r.get("B"))
        if start is None or end is None:
            skipped += 1
            continue
        if end <= start:
            print("  ! row %d: end <= start (%s -> %s), skipped"
                  % (r["_row"], r.get("A"), r.get("B")))
            skipped += 1
            continue
        rows.append((start, end, r.get("C", ""), r["_row"]))
    rows.sort(key=lambda x: (x[0], x[1]))
    lines = [new_line(i, s, e, t, row=row) for i, (s, e, t, row) in enumerate(rows, 1)]
    return lines, skipped


def place_video(src, slot, link=True):
    """Get the video to project/media/source.mp4 so the booth can serve it.

    A hardlink costs nothing and needs no second copy of 2 GB; it only works
    within one volume, so a copy and then a plain reference are the fallbacks.
    """
    src, slot = Path(src), Path(slot)
    if src.resolve() == slot.resolve():
        return slot
    if slot.exists():
        if slot.stat().st_size == src.stat().st_size:
            return slot
        slot.unlink()
    if link:
        try:
            os.link(src, slot)
            print("linked %s -> project/media/source.mp4 (no extra disk used)" % src.name)
            return slot
        except OSError:
            pass
        try:
            print("copying %s into project/media (%.1f GB) ..."
                  % (src.name, src.stat().st_size / 1e9))
            shutil.copy2(src, slot)
            return slot
        except OSError as e:
            print("  ! could not place the video (%s); referencing it in place" % e)
    return src


CARRY_TOLERANCE = 0.25   # seconds; how far a cue may move and still be the same line


def carry_takes(new_lines, old_lines, tolerance=CARRY_TOLERANCE):
    """Move recordings from the old line list onto the rebuilt one.

    Rebuilding renumbers every cue, so takes cannot be matched by index - and
    matching by index is how a re-import used to lose a session's work. Cues
    are matched on their start time instead, which survives the edits a script
    revision actually makes (wording changes, a line split, a line added), and
    falls back to identical text for a cue that was nudged further than that.

    The per-line renders are deliberately not carried: they are named after the
    old numbering and are cheap to rebuild.
    """
    spare = [l for l in old_lines if l.get("takes")]
    if not spare:
        return 0, 0

    by_text = {}
    for l in spare:
        by_text.setdefault((l.get("text") or "").strip(), []).append(l)

    moved, orphaned = 0, 0
    used = set()
    for nl in new_lines:
        best, best_d = None, tolerance
        for ol in spare:
            if id(ol) in used:
                continue
            d = abs(ol["start"] - nl["start"])
            if d <= best_d:
                best, best_d = ol, d
        if best is None:
            for ol in by_text.get((nl.get("text") or "").strip(), []):
                if id(ol) not in used:
                    best = ol
                    break
        if best is None:
            continue
        used.add(id(best))
        nl["takes"] = best["takes"]
        nl["selected"] = best.get("selected")
        if best.get("edit"):
            nl["edit"] = best["edit"]
        if best.get("flag"):
            nl["flag"] = best["flag"]
        if nl["selected"]:
            nl["status"] = "recorded"
        moved += 1

    orphaned = sum(1 for l in spare if id(l) not in used)
    return moved, orphaned


def check_overlaps(lines):
    return [(lines[i]["n"], round(lines[i]["end"] - lines[i + 1]["start"], 3))
            for i in range(len(lines) - 1)
            if lines[i]["end"] > lines[i + 1]["start"] + 1e-6]


def write_srts(lines, out_dir):
    """Reference SRTs: narration only, and every cue (for QC against picture)."""
    def dump(path, sel):
        with open(path, "w", encoding="utf-8") as f:
            for i, ln in enumerate(sel, 1):
                body = ln["text"] or "[original audio]"
                f.write("%d\n%s --> %s\n%s\n\n"
                        % (i, fmt_ts(ln["start"]), fmt_ts(ln["end"]), body))
    nar = [l for l in lines if l["kind"] == "narration"]
    dump(out_dir / "narration.srt", nar)
    dump(out_dir / "all_cues.srt", lines)
    return len(nar)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xlsx", default=None,
                    help="translation script (.xlsx workbook or .srt); required unless --media-only")
    ap.add_argument("--video", default=None,
                    help="source video; default project/media/source.mp4")
    ap.add_argument("--audio-fallback", default=None,
                    help="audio file used for original.wav until the video is available")
    ap.add_argument("--title", default=None,
                    help="project title (default: the existing title, else the project folder name)")
    ap.add_argument("--proxy", action="store_true",
                    help="transcode a 720p proxy even when the source seeks fine")
    ap.add_argument("--no-link", action="store_true",
                    help="reference the video where it lies instead of linking it in")
    ap.add_argument("--force", action="store_true",
                    help="rebuild an existing project.json (discards take assignments)")
    ap.add_argument("--media-only", action="store_true",
                    help="refresh media references without rebuilding the line list")
    ap.add_argument("--project", default=None,
                    help="project.json to write (default: ./project/project.json). "
                         "Lets the app drive a project stored anywhere.")
    args = ap.parse_args(argv)

    PROJECT = Path(args.project).parent if args.project else (ROOT / "project")
    media = PROJECT / "media"
    media.mkdir(parents=True, exist_ok=True)
    pj_path = Path(args.project) if args.project else PROJECT / "project.json"
    if pj_path.exists() and not args.force and not args.media_only:
        print("%s already exists. Re-run with --force to rebuild "
              "(this discards take assignments)." % pj_path)
        return 1

    existing = None
    if pj_path.exists():
        try:
            existing = Project.load(pj_path)
        except Exception:
            existing = None

    if args.media_only:
        if existing is None or not existing.lines:
            print("nothing to keep - import a translation script to build the line list.")
            return 3
        lines, skipped = existing.lines, 0
        print("keeping the existing %d cues" % len(lines))
    else:
        if not args.xlsx:
            print("no translation script - pass --xlsx <script.xlsx|script.srt>",
                  file=sys.stderr)
            return 2
        xlsx = Path(args.xlsx)
        if not xlsx.exists():
            print("script not found: %s" % xlsx, file=sys.stderr)
            return 2
        print("reading %s" % xlsx.name)
        lines, skipped = parse_script(xlsx)
        if not lines:
            print("no usable cues in %s" % xlsx.name, file=sys.stderr)
            return 2

    if not args.media_only and existing is not None:
        moved, orphaned = carry_takes(lines, existing.lines)
        if moved:
            print("  kept the recordings on %d line(s) across the rebuild" % moved)
        if orphaned:
            print("  ! %d recorded line(s) had no match in the new script; their take "
                  "files are still on disk - `python -m pipeline.reattach` lists them"
                  % orphaned)

    nar = sum(1 for l in lines if l["kind"] == "narration")
    print("  %d cues (%d narration, %d original audio); %d rows without a usable timecode"
          % (len(lines), nar, len(lines) - nar, skipped))
    overlaps = check_overlaps(lines)
    if overlaps:
        print("  ! %d overlapping cues, e.g. %s (slack borrowing treats these as zero)"
              % (len(overlaps), overlaps[:5]))

    minfo = {}
    slot = media / "source.mp4"
    video = Path(args.video) if args.video else slot
    if video.exists():
        video = place_video(video, slot, link=not args.no_link)
        minfo = ff.media_info(video)
        print("video: %s  %.1fs  %sx%s @ %s fps"
              % (video.name, minfo["duration"], minfo["width"], minfo["height"], minfo["fps"]))
    else:
        print("no video at %s - continuing without picture." % video)
        print("  Save the download there, then re-run with --force.")

    # Picture and audio must come from the same file or the cues drift.
    if video.exists():
        src_for_audio = video
    else:
        src_for_audio = Path(args.audio_fallback) if args.audio_fallback else None
    wav = media / "original.wav"
    # Identity, not just the name: replacing the video keeps the filename
    # source.mp4, and a stale original.wav would silently stay behind.
    want_from = ("%s|%d" % (src_for_audio.name, src_for_audio.stat().st_size)
                 if src_for_audio and src_for_audio.exists() else None)
    have_from = None
    if pj_path.exists():
        try:
            have_from = Project.load(pj_path).data.get("media", {}).get("audio_from")
        except Exception:
            pass
    if wav.exists() and have_from == want_from:
        print("original.wav present (%.1fs, from %s)"
              % (ff.duration(wav), (have_from or "?").split("|")[0]))
    elif src_for_audio and src_for_audio.exists():
        why = ("re-extracting (source changed)" if wav.exists() else "extracting")
        print("%s original.wav from %s ..." % (why, src_for_audio.name))
        ff.to_mono_wav(src_for_audio, wav)
        print("  -> original.wav  %.1fs" % ff.duration(wav))
    else:
        print("  ! no audio source found; original.wav not built")

    booth_media = None
    proxy = media / "proxy.mp4"
    if video.exists():
        if args.proxy and not proxy.exists():
            print("building 720p proxy for the booth (a few minutes) ...")
            ff.make_proxy(video, proxy)
            print("  -> proxy.mp4")
        if proxy.exists():
            booth_media = "media/proxy.mp4"
        elif video.resolve() == slot.resolve():
            booth_media = "media/source.mp4"
        else:
            # Referenced where it lies, on another drive or outside the project.
            # The app streams it through /source instead of the media folder.
            booth_media = "source"
        print("booth will play %s (%s)"
              % (booth_media, "in the project" if booth_media != "source" else video))

    dur = minfo.get("duration")
    if not dur and wav.exists():
        dur = ff.duration(wav)
    if not dur:
        dur = lines[-1]["end"]
    if lines[-1]["end"] > dur + 1.0:
        print("  ! last cue ends at %s but media is %s long"
              % (fmt_ts(lines[-1]["end"]), fmt_ts(dur)))

    n_nar = write_srts(lines, PROJECT)
    print("wrote narration.srt (%d cues) and all_cues.srt (%d cues)" % (n_nar, len(lines)))

    settings = dict(existing.settings) if existing is not None else None
    title = args.title
    if existing is not None and existing.data.get("title") and (args.media_only or not title):
        title = existing.data["title"]
    if not title:
        title = pj_path.resolve().parent.parent.name or "Untitled dub"
    proj = Project.create(
        pj_path, title, lines,
        media={
            "source": str(video) if video.exists() else None,
            "proxy": booth_media,
            "audio_from": want_from,
            "original_wav": "media/original.wav" if wav.exists() else None,
            "bed": None,
            "duration": round(dur, 3),
            "fps": minfo.get("fps"),
        },
        settings=settings,
    )
    proj.save()
    print("wrote %s" % pj_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
