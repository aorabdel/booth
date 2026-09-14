"""project.json - the single source of truth for a dubbing project."""

import json
import re
from pathlib import Path

SCHEMA_VERSION = 1

DEFAULT_SETTINGS = {
    "cps": 13.0,             # actor's characters-per-second, measured in preflight
    "borrow_before_max": 0.5,
    "borrow_after_max": 2.0,
    "keep_clear": 0.25,      # never encroach within this of a neighbouring cue
    "preroll": 3.0,          # seconds of picture before the cue in the booth
    "record_lead": 0.5,      # how much of that run-up is kept in the saved clip
    "rmin": 0.87,            # rubberband clamp
    "rmax": 1.15,
    "floor_db": -42.0,       # speech gate, relative to the take's loudest 20ms
    "lufs": -23.0,           # EBU R128
    "sample_rate": 48000,
    "bit_depth": 24,
}

_WS = re.compile(r"\s+")
# Arabic tatweel and the combining diacritics an actor pronounces but doesn't add length to
_STRIP = re.compile(r"[ـً-ْٰۖ-ۭ]")


def count_chars(text):
    """Spoken-length proxy: non-space characters, diacritics and tatweel removed."""
    return len(_WS.sub("", _STRIP.sub("", text or "")))


def compute_slack(lines, settings):
    """Fill slack_before / slack_after in place from the neighbouring cues.

    Neighbours include `original` cues, which are immovable - the narrator may
    never borrow time that belongs to on-camera dialogue.
    """
    keep = settings["keep_clear"]
    bmax = settings["borrow_before_max"]
    amax = settings["borrow_after_max"]
    for i, ln in enumerate(lines):
        gap_before = ln["start"] - lines[i - 1]["end"] if i > 0 else bmax + keep
        gap_after = lines[i + 1]["start"] - ln["end"] if i < len(lines) - 1 else amax + keep
        ln["slack_before"] = round(max(0.0, min(bmax, gap_before - keep)), 3)
        ln["slack_after"] = round(max(0.0, min(amax, gap_after - keep)), 3)


def new_line(n, start, end, text, row=None):
    text = (text or "").strip()
    return {
        "n": n,
        "row": row,
        "kind": "narration" if text else "original",
        "start": round(start, 3),
        "end": round(end, 3),
        "text": text,
        "chars": count_chars(text),
        "slack_before": 0.0,
        "slack_after": 0.0,
        "takes": [],
        "selected": None,
        "fit": None,
        "verdict": None,
        "status": "todo",   # todo | recorded | approved | needs_rewrite
        "flag": None,
    }


class Project:
    def __init__(self, path, data):
        self.path = Path(path)
        self.data = data

    @property
    def root(self):
        return self.path.parent

    @property
    def lines(self):
        return self.data["lines"]

    @property
    def settings(self):
        return self.data["settings"]

    def narration(self):
        return [l for l in self.lines if l["kind"] == "narration"]

    def by_n(self, n):
        for l in self.lines:
            if l["n"] == n:
                return l
        return None

    def slot(self, ln):
        return ln["end"] - ln["start"]

    def effective_slot(self, ln):
        return self.slot(ln) + ln["slack_before"] + ln["slack_after"]

    @classmethod
    def create(cls, path, title, lines, media=None, settings=None):
        s = dict(DEFAULT_SETTINGS)
        s.update(settings or {})
        compute_slack(lines, s)
        for i, ln in enumerate(l for l in lines if l["kind"] == "narration"):
            ln["nar_n"] = i + 1
        data = {
            "version": SCHEMA_VERSION,
            "title": title,
            "media": media or {},
            "settings": s,
            "lines": lines,
        }
        return cls(path, data)

    @classmethod
    def load(cls, path):
        with open(path, "r", encoding="utf-8") as f:
            return cls(path, json.load(f))

    def save(self):
        tmp = self.path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=1)
        tmp.replace(self.path)
