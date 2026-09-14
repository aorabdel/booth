"""WAV I/O. Reads 16/24/32-bit PCM, writes 16- or 24-bit."""

import wave

import numpy as np


def read_wav(path):
    """Return (samples float32 mono in [-1,1], sample_rate).

    Falls back to ffmpeg for anything `wave` rejects - notably 32-bit float
    WAV (format tag 3), which is what FL Studio records.
    """
    try:
        return _read_wav_stdlib(path)
    except (wave.Error, EOFError):
        from . import ff
        return ff.decode_f32(path)


def _read_wav_stdlib(path):
    with wave.open(str(path), "rb") as w:
        nch, sw, sr, nframes = (
            w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        )
        raw = w.readframes(nframes)
    if sw == 2:
        a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sw == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v & 0x800000, v - 0x1000000, v)
        a = v.astype(np.float32) / 8388608.0
    elif sw == 4:
        a = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"unsupported sample width {sw} in {path}; convert with ffmpeg first")
    if nch > 1:
        a = a.reshape(-1, nch).mean(axis=1)
    return a.astype(np.float32), sr


def write_wav(path, samples, sr, bits=24):
    """Write mono WAV. bits=24 keeps the booth's capture depth through the chain."""
    a = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    if bits == 16:
        payload = (a * 32767.0).astype("<i2").tobytes()
        sw = 2
    elif bits == 24:
        v = np.clip(np.rint(a * 8388607.0), -8388608, 8388607).astype("<i4")
        b = v.view(np.uint8).reshape(-1, 4)[:, :3]
        payload = b.tobytes()
        sw = 3
    else:
        raise ValueError(f"bits must be 16 or 24, got {bits}")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(sw)
        w.setframerate(sr)
        w.writeframes(payload)
