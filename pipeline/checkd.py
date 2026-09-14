"""Line-protocol daemon that judges a take the moment it is recorded.

The booth server spawns one of these and keeps it alive for the session. It
holds the project, the whisper-server and the fit maths in one process, so a
verdict comes back in well under a second instead of paying a 1.6 GB model
load per take.

Protocol: one JSON object per line on stdin, one JSON object per line on
stdout, `id` echoed back.

    {"id":1,"cmd":"ping"}
    {"id":2,"cmd":"check","n":412,"file":"takes/0412_t01.wav"}
    {"id":3,"cmd":"reload"}

A check answers with a verdict, the headroom in seconds, level metering and -
when ASR is on - the script words the actor did not say.
"""

import json
import sys
import traceback
from difflib import SequenceMatcher
from pathlib import Path

from .dubkit import asr, ff
from .dubkit.arabic import tokens
from .dubkit.project import Project
from .dubkit.silence import find_speech_spans, measure

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROJECT = ROOT / "project" / "project.json"

UNSET = object()   # not supplied, as distinct from an explicit null


# level guidance for a spoken take
PEAK_HOT_DBFS = -3.0
PEAK_QUIET_DBFS = -30.0
SNR_POOR_DB = 30.0

# The take starts rolling `preroll` seconds before the cue and the count-in
# beeps live in that window. If any of it reaches the microphone it must not
# be measured as performance, so analysis starts just before the cue.
EARLY_ALLOW = 0.6     # the actor may legitimately come in this early
BLEED_GUARD = 0.35    # ignore this much either side of the cue when judging bleed
BLEED_MARGIN_DB = 18.0  # pre-roll this close to the voice means guide bleed


WORD_MATCH = 0.75      # a script word this close to any ASR word counts as said
MIN_MISSING_WORDS = 2  # below this, assume ASR noise rather than a dropped line
LONG_WORD = 6          # ...unless the single missing word is a big content word


def missing_words(script_text, asr_text, thresh=WORD_MATCH):
    """Script words the actor plausibly did not say.

    Exact comparison is useless here: whisper writes تنتظر for تنتظرنا and
    adds definite articles, so a strict diff flags healthy takes and sends the
    actor back into the booth for nothing. A false retake costs more than a
    missed one, so matching is fuzzy and deliberately forgiving.
    """
    a, b = tokens(script_text), tokens(asr_text)
    if not a:
        return []
    out = []
    for w in a:
        if len(w) <= 2:
            continue
        if any(SequenceMatcher(None, w, v).ratio() >= thresh for v in b):
            continue
        out.append(w)
    return out


def worth_flagging(miss):
    return len(miss) >= MIN_MISSING_WORDS or any(len(w) >= LONG_WORD for w in miss)


class Checker:
    def __init__(self, project_path, use_asr=True):
        self.project_path = Path(project_path)
        self.proj = Project.load(self.project_path)
        self.use_asr = use_asr and asr.available()
        self.whisper = None
        if self.use_asr:
            self.whisper = asr.Whisper(self.proj.root / "cache" / "asr")

    def start(self):
        if self.whisper:
            try:
                self.whisper.start()
            except asr.AsrError as e:
                self.use_asr = False
                self.whisper = None
                return "asr disabled: %s" % e
        return None

    def stop(self):
        if self.whisper:
            self.whisper.stop()

    def reload(self):
        self.proj = Project.load(self.project_path)

    def fit(self, n, edit=UNSET, selected=None, replace=False):
        """Re-render one clip in this process, and return what changed.

        Two rules here, both learned the hard way:

        * reload first. This process has its own copy of the project, and the
          server has just written a take into the file. Fitting against the
          stale copy renders the wrong audio - or none.
        * never save. The server owns project.json; if this process wrote its
          copy back it would erase every take recorded since it started, which
          is exactly what happened. The caller applies what is returned.

        Spawning python and rebuilding the whole timeline took 16 seconds for a
        two-second clip; here numpy is already imported and only the clip is
        written, so a drag settles in about a tenth of that.
        """
        from .fit import fit_one

        self.reload()
        ln = self.proj.by_n(n)
        if ln is None:
            raise ValueError("no line %s" % n)
        if selected:
            if not any(t.get("file") == selected for t in ln["takes"]):
                raise ValueError("no such take on line %s" % n)
            if ln.get("selected") != selected:
                ln.pop("edit", None)
            ln["selected"] = selected
            if ln.get("status") == "todo":
                ln["status"] = "recorded"
        if edit is None:
            ln.pop("edit", None)          # explicit reset
        elif edit is not UNSET and edit:
            # `replace` is how a key gets removed: merging can only ever add.
            ln["edit"] = dict(edit) if replace else dict(ln.get("edit") or {}, **edit)
        fit_one(self.proj, ln)
        return {
            "n": n,
            "fit": ln.get("fit"),
            "selected": ln.get("selected"),
            "edit": ln.get("edit"),
            "status": ln.get("status"),
        }

    @staticmethod
    def _bleed(x, sr, cue, sig):
        """How close the pre-roll gets to the voice, in dB. None if clean."""
        end = int(max(0.0, cue - BLEED_GUARD) * sr)
        if end < int(0.4 * sr) or sig["speech_dbfs"] is None:
            return None
        import numpy as np
        from .dubkit.silence import rms_envelope
        env, _ = rms_envelope(x[:end], sr)
        if env.size == 0:
            return None
        pre = float(20 * np.log10(np.percentile(env, 97) + 1e-12))
        gap = sig["speech_dbfs"] - pre
        return round(gap, 1) if gap < BLEED_MARGIN_DB else None

    def check(self, n, file, cue=None):
        ln = self.proj.by_n(n)
        if ln is None:
            raise ValueError("no line %s" % n)
        path = self.proj.root / file if not Path(file).is_absolute() else Path(file)
        if not path.exists():
            raise FileNotFoundError(str(path))

        x, sr = ff.decode_f32(path)

        # Analyse from just before the cue so the count-in cannot be mistaken
        # for the read. Spans are reported in whole-take time.
        a0 = max(0.0, cue - EARLY_ALLOW) if cue else 0.0
        i0 = int(a0 * sr)
        spans = [(a + a0, b + a0) for a, b in
                 find_speech_spans(x[i0:], sr, min_pause=0.35, pad=0.06, min_dur=0.10)]
        sig = measure(x, sr, spans=spans)

        s = self.proj.settings
        slot = self.proj.slot(ln)
        effective = self.proj.effective_slot(ln)
        out = {
            "n": n, "file": file, "text": ln["text"],
            "slot": round(slot, 3), "effective_slot": round(effective, 3),
            "level": sig, "warnings": [], "asr": None, "missing": [],
        }

        if not spans:
            out.update(verdict="EMPTY", speech=0.0, headroom=None, ratio=None,
                       message="no speech found in that take")
            return out

        speech = spans[-1][1] - spans[0][0]
        pauses = sum(spans[i + 1][0] - spans[i][1] for i in range(len(spans) - 1))
        out["speech"] = round(speech, 3)
        out["trim_head"] = round(spans[0][0], 3)
        out["trim_tail"] = round(len(x) / sr - spans[-1][1], 3)
        out["internal_pause"] = round(pauses, 3)

        headroom = effective - speech
        out["headroom"] = round(headroom, 3)
        out["ratio"] = round(speech / effective, 3) if effective > 0 else None

        if speech <= slot:
            out["verdict"] = "GOOD"
            out["message"] = "good - %.1fs of room" % (slot - speech)
        elif speech <= effective:
            out["verdict"] = "TIGHT"
            out["message"] = "fits by borrowing %.1fs from the gap" % (speech - slot)
        elif speech <= effective * s["rmax"]:
            out["verdict"] = "OVER"
            out["message"] = "%.1fs over - will be compressed %d%%" % (
                speech - effective, round(100 * (speech / effective - 1)))
        else:
            out["verdict"] = "LONG"
            out["message"] = "%.1fs over - a touch quicker" % (speech - effective)

        if cue:
            out["cue"] = round(cue, 3)
            out["start_offset"] = round(spans[0][0] - cue, 3)
            bleed = self._bleed(x, sr, cue, sig)
            if bleed is not None:
                out["bleed_db"] = bleed
                out["warnings"].append(
                    "guide/beeps bleeding into the mic (%.0f dB below the voice) "
                    "- headphones only" % bleed)

        if sig["clipped_samples"] > 0:
            out["warnings"].append("clipping (%d samples)" % sig["clipped_samples"])
        elif sig["peak_dbfs"] is not None and sig["peak_dbfs"] > PEAK_HOT_DBFS:
            out["warnings"].append("hot: peak %.1f dBFS" % sig["peak_dbfs"])
        if sig["peak_dbfs"] is not None and sig["peak_dbfs"] < PEAK_QUIET_DBFS:
            out["warnings"].append("very quiet: peak %.1f dBFS" % sig["peak_dbfs"])
        if sig["snr_db"] is not None and sig["snr_db"] < SNR_POOR_DB:
            out["warnings"].append("noisy: %.0f dB SNR" % sig["snr_db"])

        if self.whisper and ln["text"]:
            try:
                text = self.whisper.transcribe_span(
                    x, sr, spans[0][0], spans[-1][1])
                out["asr"] = text
                miss = missing_words(ln["text"], text)
                out["missing"] = miss
                if worth_flagging(miss) and out["verdict"] in ("GOOD", "TIGHT"):
                    out["verdict"] = "WORDS"
                    out["message"] = "missing: %s" % "، ".join(miss[:3])
            except asr.AsrError as e:
                out["warnings"].append("asr unavailable: %s" % e)
        return out


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    project = DEFAULT_PROJECT
    # The word check cost a whole speech model in memory and produced more
    # false retakes than real catches; the length verdict is what the actor
    # actually acts on. Off unless explicitly asked for.
    use_asr = False
    for i, a in enumerate(argv):
        if a == "--project" and i + 1 < len(argv):
            project = Path(argv[i + 1])
        elif a == "--asr":
            use_asr = True
        elif a == "--no-asr":
            use_asr = False

    checker = Checker(project, use_asr=use_asr)
    note = checker.start()
    ready = {"event": "ready", "asr": bool(checker.whisper),
             "lines": len(checker.proj.lines)}
    if note:
        ready["note"] = note
    print(json.dumps(ready, ensure_ascii=False), flush=True)

    try:
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                req = json.loads(raw)
            except ValueError:
                continue
            rid, cmd = req.get("id"), req.get("cmd")
            try:
                if cmd == "ping":
                    res = {"ok": True}
                elif cmd == "reload":
                    checker.reload()
                    res = {"ok": True, "lines": len(checker.proj.lines)}
                elif cmd == "fit":
                    res = checker.fit(req["n"],
                                      req["edit"] if "edit" in req else UNSET,
                                      req.get("selected"),
                                      bool(req.get("replace")))
                    res["ok"] = True
                elif cmd == "check":
                    res = checker.check(req["n"], req["file"], cue=req.get("cue"))
                    res["ok"] = True
                elif cmd == "quit":
                    break
                else:
                    res = {"ok": False, "error": "unknown cmd %r" % cmd}
            except Exception as e:  # a bad take must not kill the session
                res = {"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                       "trace": traceback.format_exc(limit=3)}
            res["id"] = rid
            print(json.dumps(res, ensure_ascii=False), flush=True)
    finally:
        checker.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
