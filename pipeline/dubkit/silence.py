"""Speech / pause detection on a mono float32 signal.

The gate is referenced to the take's own room tone rather than to its peak.
This booth runs about 25 dB SNR (room tone near -48 dBFS, speech near -22),
so a peak-relative gate at -42 dB sits *below* the noise and marks the whole
file as speech. Measuring the quietest second and gating a fixed margin above
it survives that, and costs nothing on a clean recording.
"""

import numpy as np


def rms_envelope(x, sr, win_ms=20.0):
    n = max(1, int(sr * win_ms / 1000.0))
    pad = (-len(x)) % n
    y = np.concatenate([x, np.zeros(pad, dtype=np.float32)])
    y = y.reshape(-1, n)
    return np.sqrt((y ** 2).mean(axis=1) + 1e-12), n


def noise_floor_db(x, sr, win_s=1.0):
    """dBFS of the quietest `win_s` window - the take's true room tone.

    On a clip too short to contain a full window (a trimmed single take) the
    5th percentile stands in; env.min() would land on a stop consonant and
    read far below the actual floor.
    """
    env, hop = rms_envelope(x, sr)
    if env.size == 0:
        return -120.0
    w = max(1, int(win_s * sr / hop))
    if env.size <= w:
        return float(20 * np.log10(np.percentile(env, 5) + 1e-12))
    power = np.convolve(env.astype(np.float64) ** 2, np.ones(w) / w, mode="valid")
    return float(10 * np.log10(power.min() + 1e-24))


NO_SPEECH_DBFS = -38.0   # a take whose loudest moment is below this holds no voice
MIN_SEPARATION_DB = 8.0  # room and voice closer than this means the take is uniform


def gate_db(x, sr, above_noise_db=10.0, min_separation_db=MIN_SEPARATION_DB):
    """Absolute dBFS threshold separating speech from room tone.

    The gate sits a fraction of the way up from the room to the voice, so it
    adapts to both a noisy booth and a clean one. Two degenerate cases have to
    be handled explicitly, because both occur in real sessions:

    * a take already trimmed to its speech has no silence in it, so its
      measured "floor" is the voice; and
    * a take where the actor never spoke is uniform room tone, and anchoring
      the gate to its peak puts the threshold *below* the noise, marking the
      whole file as speech.

    When room and voice are not separated, the absolute level decides: quiet
    means no speech at all, loud means it is all speech.
    """
    env, _ = rms_envelope(x, sr)
    if env.size == 0:
        return 200.0
    db = 20 * np.log10(env + 1e-12)
    floor = noise_floor_db(x, sr)
    loud = float(np.percentile(db, 95))
    sep = loud - floor
    if sep < min_separation_db:
        return -200.0 if loud >= NO_SPEECH_DBFS else 200.0
    return floor + float(np.clip(0.35 * sep, 5.0, 14.0))


def find_speech_spans(x, sr, floor_db=None, above_noise_db=10.0,
                      min_pause=0.14, pad=0.03, min_dur=0.0):
    """Return [(start_s, end_s), ...] speech spans.

    floor_db: absolute dBFS threshold. None (default) derives it from the
              take's own room tone. A negative value relative to peak is still
              accepted for backward compatibility when peak_relative=True.
    min_pause: gaps shorter than this do not split a span.
    min_dur:   spans shorter than this are dropped (kills clicks and breaths).
    """
    env, hop = rms_envelope(x, sr)
    if env.size == 0:
        return []
    thr_db = gate_db(x, sr, above_noise_db) if floor_db is None else floor_db
    voiced = 20 * np.log10(env + 1e-12) > thr_db

    spans, i = [], 0
    while i < len(voiced):
        if voiced[i]:
            j = i
            while j < len(voiced) and voiced[j]:
                j += 1
            spans.append([i * hop / sr, j * hop / sr])
            i = j
        else:
            i += 1
    if not spans:
        return []

    merged = [spans[0]]
    for s in spans[1:]:
        if s[0] - merged[-1][1] < min_pause:
            merged[-1][1] = s[1]
        else:
            merged.append(s)

    total = len(x) / sr
    out = []
    for s, e in merged:
        if e - s < min_dur:
            continue
        out.append((max(0.0, s - pad), min(total, e + pad)))
    return out


def speech_extent(x, sr, **kw):
    """(start, end, duration) after trimming outer silence, or None."""
    spans = find_speech_spans(x, sr, **kw)
    if not spans:
        return None
    return spans[0][0], spans[-1][1], spans[-1][1] - spans[0][0]


def measure(x, sr, spans=None, min_silence=0.30):
    """Signal report for one take: levels, SNR, clipping.

    SNR needs actual silence to measure against. A take trimmed to its speech
    has none, and measuring room tone inside the voice reports ~0 dB and cries
    "noisy" on a perfectly good take. So room tone is taken only from the
    silence outside `spans`, and both room_dbfs and snr_db are None when
    there is not enough of it.
    """
    env, hop = rms_envelope(x, sr)
    peak = float(np.abs(x).max()) if x.size else 0.0
    db = 20 * np.log10(env + 1e-12)
    top = db.max() if db.size else -120.0
    voiced = db[db > top - 20]
    speech_db = float(voiced.mean()) if voiced.size else None

    room = None
    total = len(x) / sr if sr else 0.0
    if spans is None:
        if total >= 2.0:
            room = noise_floor_db(x, sr)
    else:
        quiet = np.ones(env.size, dtype=bool)
        for a, b in spans:
            quiet[max(0, int(a * sr / hop)):int(np.ceil(b * sr / hop))] = False
        if quiet.sum() * hop / sr >= min_silence:
            room = float(10 * np.log10((env[quiet].astype(np.float64) ** 2).mean() + 1e-24))

    return {
        "peak_dbfs": round(float(20 * np.log10(peak + 1e-12)), 1),
        "speech_dbfs": round(speech_db, 1) if speech_db is not None else None,
        "room_dbfs": round(room, 1) if room is not None else None,
        "snr_db": (round(speech_db - room, 1)
                   if (room is not None and speech_db is not None) else None),
        "clipped_samples": int((np.abs(x) >= 0.999).sum()),
    }
