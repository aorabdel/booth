"""Export the dub: the voice track, a mix, or the finished video.

    python -m pipeline.export --what dub   --out vo.wav
    python -m pipeline.export --what mix   --out mix.wav
    python -m pipeline.export --what video --out dubbed_ar.mp4

`dub` is the narration alone on the film's timeline - the stem to hand a mixer.
`mix` lays it over the original with the original ducked underneath, which is
what a documentary dub sounds like. `video` is the same mix muxed back to
picture.

Ducking is sidechained from the narration rather than a static level, so the
bed drops only while the actor speaks and lifts again in the gaps. Loudness is
normalised to the project's target (-23 LUFS = EBU R128).
"""

import argparse
import sys
from pathlib import Path

from .dubkit import ff
from .dubkit.project import Project

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "project"

WHAT = ("dub", "mix", "video")


def build_mix_filter(duck_db, lufs, bed_gain_db=0.0, bed_in=0, vo_in=1):
    """original (ducked by the VO) + VO, then loudness-normalised.

    Input indices are explicit because the video export feeds the same graph
    from different streams.
    """
    return (
        "[%d:a]aformat=channel_layouts=stereo,volume=%.2fdB[bed];"
        "[%d:a]aformat=channel_layouts=stereo[vo];"
        "[vo]asplit=2[vo_mix][vo_key];"
        "[bed][vo_key]sidechaincompress="
        "threshold=0.03:ratio=%0.1f:attack=15:release=350:makeup=1[ducked];"
        "[ducked][vo_mix]amix=inputs=2:duration=longest:normalize=0[mixed];"
        "[mixed]loudnorm=I=%.1f:TP=-1.5:LRA=11[out]"
        % (bed_in, bed_gain_db, vo_in, max(1.5, duck_db / 3.0), lufs)
    )


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=str(PROJECT / "project.json"))
    ap.add_argument("--what", choices=WHAT, default="dub")
    ap.add_argument("--out", required=True, help="file to write")
    ap.add_argument("--duck", type=float, default=12.0,
                    help="how hard the original ducks under the narration, in dB")
    ap.add_argument("--lufs", type=float, default=None,
                    help="loudness target (default: the project's, -23 for EBU R128)")
    ap.add_argument("--range", dest="rng", choices=("full", "recorded"), default="full",
                    help="the whole film, or trimmed to the recorded span")
    ap.add_argument("--bed-gain", type=float, default=0.0,
                    help="trim the original before ducking, in dB")
    args = ap.parse_args(argv)

    proj = Project.load(args.project)
    lufs = args.lufs if args.lufs is not None else proj.settings.get("lufs", -23.0)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    dub = proj.root / "out" / "dub_fitted.wav"
    if not dub.exists():
        print("no assembled dub yet - run `python -m pipeline.fit` first.", file=sys.stderr)
        return 1

    done = [l for l in proj.narration() if l.get("selected")]
    total = len(proj.narration())
    print("exporting %s (%d of %d lines recorded)" % (args.what, len(done), total))

    # Trim to what actually exists, with a little air either side, so a
    # part-finished dub is a short file rather than two hours of mostly silence.
    clip = None
    if args.rng == "recorded" and done:
        starts, ends = [], []
        for l in done:
            f = l.get("fit") or {}
            a = f.get("placed_at", l["start"])
            starts.append(a)
            ends.append(a + (f.get("fitted") or (l["end"] - l["start"])))
        clip = (max(0.0, min(starts) - 1.0), max(ends) + 1.0)
        print("  trimmed to %.1f-%.1f min" % (clip[0] / 60, clip[1] / 60))

    def window(args_list):
        if not clip:
            return args_list
        return ["-ss", "%.3f" % clip[0], "-t", "%.3f" % (clip[1] - clip[0])] + args_list

    if args.what == "dub":
        # the narration stem, on the film's timeline, nothing else touched
        ff.run(window(["-i", str(dub)]) + ["-c:a", "pcm_s24le", "-ar",
                str(proj.settings["sample_rate"]), str(out)])
        print("wrote %s  (%.1f min)" % (out, ff.duration(out) / 60))
        return 0

    media = proj.data.get("media") or {}
    original = proj.root / (media.get("original_wav") or "media/original.wav")
    if not original.exists():
        print("original audio not found at %s" % original, file=sys.stderr)
        return 2

    if args.what == "mix":
        filt = build_mix_filter(args.duck, lufs, args.bed_gain, bed_in=0, vo_in=1)
        pre = []
        if clip:
            pre = ["-ss", "%.3f" % clip[0], "-t", "%.3f" % (clip[1] - clip[0])]
        ff.run(pre + ["-i", str(original)] + pre + ["-i", str(dub),
                "-filter_complex", filt, "-map", "[out]",
                "-c:a", "pcm_s24le", str(out)])
        print("wrote %s  (%.1f min, %.1f LUFS target)" % (out, ff.duration(out) / 60, lufs))
        return 0

    source = media.get("source")
    video = Path(source) if source else (proj.root / "media" / "source.mp4")
    if not video.exists():
        print("no video at %s - export the mix instead." % video, file=sys.stderr)
        return 2

    print("muxing to picture (video is copied, not re-encoded) ...")
    filt = build_mix_filter(args.duck, lufs, args.bed_gain, bed_in=1, vo_in=2)
    pre = []
    if clip:
        pre = ["-ss", "%.3f" % clip[0], "-t", "%.3f" % (clip[1] - clip[0])]
    ff.run(pre + ["-i", str(video)] + pre + ["-i", str(original)] + pre + ["-i", str(dub),
            "-filter_complex", filt,
            "-map", "0:v", "-map", "[out]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
            "-movflags", "+faststart", str(out)])
    print("wrote %s  (%.1f min)" % (out, ff.duration(out) / 60))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
