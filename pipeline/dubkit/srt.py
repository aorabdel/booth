"""SRT / timecode parsing and writing."""

import math
import re
from dataclasses import dataclass, field

TS = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*"
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)

ONE_TS = re.compile(r"(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})")


@dataclass
class Cue:
    idx: int
    start: float          # seconds
    end: float            # seconds
    text: str
    meta: dict = field(default_factory=dict)

    @property
    def dur(self):
        return self.end - self.start


def _t(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000.0


def parse_ts(s):
    """Parse a single 'HH:MM:SS,mmm' timestamp. Returns None if unparseable."""
    m = ONE_TS.search(str(s or ""))
    return _t(*m.groups()) if m else None


def read_srt(path):
    """Parse an SRT file into a list of Cue. Tolerates BOM, CRLF, missing indices."""
    with open(path, "r", encoding="utf-8-sig") as f:
        raw = f.read().replace("\r\n", "\n").replace("\r", "\n")
    cues, n = [], 0
    for block in re.split(r"\n{2,}", raw.strip()):
        lines = [l for l in block.split("\n") if l.strip()]
        if not lines:
            continue
        m = None
        body_start = 0
        for i, line in enumerate(lines[:2]):
            m = TS.search(line)
            if m:
                body_start = i + 1
                break
        if not m:
            continue
        n += 1
        text = " ".join(lines[body_start:]).strip()
        cues.append(Cue(n, _t(*m.groups()[:4]), _t(*m.groups()[4:]), text))
    return cues


def fmt_ts(t):
    if t < 0:
        t = 0.0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - math.floor(t)) * 1000))
    if ms == 1000:
        ms, s = 0, s + 1
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(cues, path):
    with open(path, "w", encoding="utf-8") as f:
        for i, c in enumerate(cues, 1):
            f.write(f"{i}\n{fmt_ts(c.start)} --> {fmt_ts(c.end)}\n{c.text}\n\n")
