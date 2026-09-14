"""whisper.cpp transcription via the CUDA whisper-server, with an on-disk cache.

Uses the Arabic-dialectal large-v3-turbo finetune already on this machine
(undiacritized output, which matches the script). The model is loaded once by
a long-lived server process: a 14-second span comes back in ~0.7s, which is
what makes both bulk salvage and the booth's live word-check practical. The
one-shot CLI reloads 1.6 GB per call and is only kept as a fallback.

Whisper's own segmentation is never trusted - it loops on room tone and will
repeat a phrase every 2 seconds for half a minute. Callers pass energy-derived
spans and each span is transcribed on its own.
"""

import atexit
import hashlib
import io
import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

import numpy as np

WHISPER_DIR = Path(os.environ.get("WHISPER_DIR", r"E:\whisper"))
WHISPER_BIN = WHISPER_DIR / "bin"
SERVER_EXE = WHISPER_BIN / "whisper-server.exe"
CLI_EXE = WHISPER_BIN / "whisper-cli.exe"
MODEL_ARABIC = WHISPER_DIR / "models" / "ggml-arabic-turbo.bin"
MODEL_GENERIC = WHISPER_DIR / "models" / "ggml-large-v3-turbo.bin"

SR = 16000  # whisper.cpp input rate


class AsrError(RuntimeError):
    pass


def available():
    return SERVER_EXE.exists() and MODEL_ARABIC.exists()


def encode_wav16(samples, sr):
    """float32 mono at `sr` -> 16 kHz 16-bit WAV bytes, in memory."""
    x = np.asarray(samples, dtype=np.float32)
    if sr != SR and x.size:
        n = int(round(x.size * SR / float(sr)))
        x = np.interp(np.linspace(0, x.size - 1, n), np.arange(x.size), x).astype(np.float32)
    pcm = np.clip(x * 32767.0, -32768, 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _kill_on_close_job(proc):
    """Tie `proc` to a Windows job object that kills it when we die.

    whisper-server holds a 1.6 GB model. If the parent is terminated hard -
    the app closed from Task Manager, a crash, a killed terminal - the plain
    child would survive, and every launch would strand another copy until the
    GPU is full and the next model load crawls. A job object with
    KILL_ON_JOB_CLOSE makes the OS clean up even when no handler runs.

    Returns the job handle, which the caller must keep referenced.
    """
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                    ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [("ReadOperationCount", ctypes.c_uint64),
                    ("WriteOperationCount", ctypes.c_uint64),
                    ("OtherOperationCount", ctypes.c_uint64),
                    ("ReadTransferCount", ctypes.c_uint64),
                    ("WriteTransferCount", ctypes.c_uint64),
                    ("OtherTransferCount", ctypes.c_uint64)]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                    ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    JobObjectExtendedLimitInformation = 9
    PROCESS_SET_QUOTA, PROCESS_TERMINATE = 0x0100, 0x0001

    try:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        job = k32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(
                job, JobObjectExtendedLimitInformation,
                ctypes.byref(info), ctypes.sizeof(info)):
            k32.CloseHandle(job)
            return None
        handle = k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, proc.pid)
        if not handle:
            k32.CloseHandle(job)
            return None
        ok = k32.AssignProcessToJobObject(job, handle)
        k32.CloseHandle(handle)
        if not ok:
            k32.CloseHandle(job)
            return None
        return job
    except OSError:
        return None


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Whisper:
    """A whisper-server process plus a transcript cache.

    Use as a context manager; the server is started on first use and stopped
    on exit. Pass `port` of an already-running server to attach instead.
    """

    def __init__(self, cache_dir, model=None, lang="ar", threads=8,
                 port=None, start=True):
        self.model = Path(model or MODEL_ARABIC)
        self.lang = lang
        self.threads = threads
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.port = port
        self._own = start and port is None
        self._proc = None
        self._job = None

    # -- lifecycle ---------------------------------------------------------

    def __enter__(self):
        if self._own:
            self.start()
        return self

    def __exit__(self, *exc):
        self.stop()
        return False

    def start(self, timeout=120.0):
        if self._proc is not None:
            return
        if not SERVER_EXE.exists():
            raise AsrError("whisper-server not found at %s" % SERVER_EXE)
        if not self.model.exists():
            raise AsrError("whisper model not found at %s" % self.model)
        self.port = self.port or _free_port()
        cmd = [str(SERVER_EXE), "-m", str(self.model), "-l", self.lang,
               "-t", str(self.threads), "--port", str(self.port),
               "--host", "127.0.0.1"]
        self._proc = subprocess.Popen(
            cmd, cwd=str(WHISPER_BIN),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self._job = _kill_on_close_job(self._proc)
        atexit.register(self.stop)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._proc.poll() is not None:
                raise AsrError("whisper-server exited during startup (code %s)"
                               % self._proc.returncode)
            try:
                with socket.create_connection(("127.0.0.1", self.port), 0.5):
                    return
            except OSError:
                time.sleep(0.4)
        self.stop()
        raise AsrError("whisper-server did not become ready within %.0fs" % timeout)

    def stop(self):
        if self._proc is not None:
            try:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
            except OSError:
                pass
            self._proc = None
        if self._job is not None:
            try:
                import ctypes
                ctypes.WinDLL("kernel32").CloseHandle(self._job)
            except OSError:
                pass
            self._job = None

    # -- inference ---------------------------------------------------------

    def _post(self, wav_bytes, timeout=120.0):
        boundary = uuid.uuid4().hex
        parts = []
        for key, val in (("temperature", "0.0"), ("response_format", "json"),
                         ("language", self.lang)):
            parts.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                          % (boundary, key, val)).encode())
        parts.append(("--%s\r\nContent-Disposition: form-data; name=\"file\"; "
                      "filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
                      % boundary).encode())
        parts.append(wav_bytes)
        parts.append(("\r\n--%s--\r\n" % boundary).encode())
        body = b"".join(parts)
        req = urllib.request.Request(
            "http://127.0.0.1:%d/inference" % self.port, data=body,
            headers={"Content-Type": "multipart/form-data; boundary=%s" % boundary})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                payload = json.loads(r.read().decode("utf-8", "replace"))
        except (urllib.error.URLError, OSError) as e:
            raise AsrError("whisper-server request failed: %s" % e)
        return " ".join((payload.get("text") or "").split()).strip()

    def transcribe_audio(self, samples, sr, cache_key=None):
        """Transcribe a float32 mono buffer. Cached when cache_key is given."""
        path = None
        if cache_key:
            h = hashlib.sha1(("%s|%s|%s" % (cache_key, self.model.name, self.lang))
                             .encode("utf-8")).hexdigest()[:20]
            path = self.cache_dir / ("%s.json" % h)
            if path.exists():
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)["text"]
        if self._proc is None and self._own:
            self.start()
        text = self._post(encode_wav16(samples, sr))
        if path:
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"text": text, "key": cache_key}, f, ensure_ascii=False)
        return text

    def transcribe_span(self, samples, sr, start, end, cache_key=None):
        a = max(0, int(start * sr))
        b = min(len(samples), int(end * sr))
        key = "%s@%.3f-%.3f" % (cache_key, start, end) if cache_key else None
        return self.transcribe_audio(samples[a:b], sr, cache_key=key)


def file_key(path):
    """Cache identity for a source file: path + size + mtime."""
    st = os.stat(path)
    return "%s|%d|%d" % (os.path.basename(path), st.st_size, int(st.st_mtime))
