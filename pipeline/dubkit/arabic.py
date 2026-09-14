"""Arabic normalisation and fuzzy matching of ASR output to script lines."""

import re
from difflib import SequenceMatcher

# tatweel + the combining marks (fatha..sukun, superscript alef, Quranic marks)
DIACRITICS = re.compile(r"[ـً-ْٰۖ-ۭ]")
NON_LETTER = re.compile(r"[^ء-ي٠-٩a-z0-9 ]")
_WS = re.compile(r"\s+")

_FOLD = str.maketrans({
    "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",  # alef forms
    "ى": "ي",   # alef maqsura -> ya
    "ة": "ه",   # ta marbuta -> ha
    "ؤ": "و", "ئ": "ي",  # hamza on waw / ya
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
})


def normalize(text):
    """Fold orthographic variation so ASR output and script text compare fairly."""
    s = DIACRITICS.sub("", text or "")
    s = s.translate(_FOLD)
    s = NON_LETTER.sub(" ", s.lower())
    return _WS.sub(" ", s).strip()


def tokens(text):
    return normalize(text).split()


MIN_CONTAINMENT_TOKENS = 4


def similarity(a_tokens, b_tokens):
    """Word-level ratio, plus a guarded containment term.

    ASR drops and invents words, and a take may cover only part of a line, so
    plain ratio is too strict. But raw containment is far too loose: a
    one-word interjection is wholly "contained" in any long line and scores
    near 1.0. Containment therefore only applies when the shorter side has
    real substance, and is scaled by how lopsided the two lengths are.
    """
    if not a_tokens or not b_tokens:
        return 0.0
    sm = SequenceMatcher(None, a_tokens, b_tokens)
    ratio = sm.ratio()
    shorter = min(len(a_tokens), len(b_tokens))
    longer = max(len(a_tokens), len(b_tokens))
    if shorter < MIN_CONTAINMENT_TOKENS:
        return ratio
    overlap = sum(bl.size for bl in sm.get_matching_blocks())
    containment = overlap / shorter
    return max(ratio, 0.85 * containment * (shorter / longer) ** 0.5)


def best_match(asr_text, candidates, min_score=0.45):
    """candidates: [(key, tokens)] -> (key, score, runner_up_score)."""
    at = tokens(asr_text)
    if not at:
        return None, 0.0, 0.0
    scored = sorted(((similarity(at, ct), key) for key, ct in candidates), reverse=True)
    top_score, top_key = scored[0]
    second = scored[1][0] if len(scored) > 1 else 0.0
    if top_score < min_score:
        return None, top_score, second
    return top_key, top_score, second
