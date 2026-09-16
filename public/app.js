/* Booth — one view: record, edit and review the dub in the same place.
 *
 * Playback does not use a pre-assembled master. Each line renders to its own
 * clip and the page schedules those clips against the video clock through Web
 * Audio, so an edit is audible the moment its clip is re-rendered instead of
 * after a two-hour re-assembly. The monolithic file is an export artefact now.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const PREROLL = 3;      // seconds of picture before the cue
/* How much of that run-up is kept in the saved clip. The rest is count-in and
 * room, and carrying it onto the timeline makes every clip overlap its
 * neighbour. Override per project with settings.record_lead. */
const DEFAULT_LEAD = 0.5;
const BEEPS = [-3, -2, -1];
const MIN_CLIP = 0.05;   // a clip may be dragged down to this, but not to nothing

/* Capture buffers into ~43 ms blocks before crossing to the main thread.
 * Posting every 128-sample quantum meant 375 messages a second competing with
 * canvas redraws for the same thread; anything that arrived after the take was
 * stopped was dropped, which is how a take could come back with holes in it.
 * `flush` hands over the partial block so the tail is never lost either. */
const BLOCK = 2048;
const CAPTURE_WORKLET = `
const BLOCK = ${BLOCK};
class Cap extends AudioWorkletProcessor {
  constructor () {
    super();
    this.buf = new Float32Array(BLOCK);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.port.postMessage(this.buf.slice(0, this.n));
        this.n = 0;
      }
    };
  }
  process (inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === BLOCK) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(BLOCK);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('cap', Cap);
`;

const fmtTC = (t) => {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:` +
         `${s.toFixed(1).padStart(4, "0")}`;
};
const esc = (s) => (s || "").replace(/[<>&"]/g, (c) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------------- state

const S = {
  project: null, lines: [], nar: [], byN: new Map(),
  sel: null,            // the focused line
  cur: null,            // the line under the playhead
  peaks: null, peaksRate: 50,
  duration: 0,
  filter: "", onlyFlags: false, onlyTodo: false,
  rolling: false, paused: false, cueOffset: null, rollLine: null,
  duck: true, playing: false,
  edgeMode: "stretch",     // what dragging a clip edge does
  busyLine: null,          // a clip is re-rendering; the timeline is locked
};

/* Every render reuses the same filename, so the decoded-audio cache has to be
 * keyed on something that changes. Without this a re-record renders correctly
 * and plays back as the take before it. */
const clipUrl = (l) =>
  "/" + l.fit.render + "?v=" + (l.fit.rev || Math.round(l.fit.fitted * 1000));

const locked = () => S.busyLine !== null;

const slotOf = (l) => l.end - l.start;
const effOf = (l) => slotOf(l) + l.slack_before + l.slack_after;
const placedAt = (l) => (l.fit && typeof l.fit.placed_at === "number")
  ? l.fit.placed_at : l.start;
const placedDur = (l) => (l.fit && l.fit.fitted) || 0;
const hasClip = (l) => !!(l.fit && l.fit.render && l.fit.fitted);
const isPending = (l) => !!l.selected && (!l.fit || l.fit.take !== l.selected);

// ------------------------------------------------------------------- playback

/** Schedules the per-line clips against the video clock. */
class Dub {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.buffers = new Map();   // render url -> AudioBuffer, in use order
    this.pending = new Map();   // render url -> in-flight decode
    this.playing = new Map();   // line n -> source
    this.gen = 0;               // bumped by stopAll, so a tick that awaited across a seek bails
    this.volume = 1;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    this.ctx = new AudioContext({ latencyHint: "playback" });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    return this.ctx;
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  async buffer(url) {
    if (this.buffers.has(url)) {
      const buf = this.buffers.get(url);
      this.buffers.delete(url);           // keep the map in use order
      this.buffers.set(url, buf);
      return buf;
    }
    if (this.pending.has(url)) return this.pending.get(url);
    const job = (async () => {
      const ctx = this.ensure();
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(url, buf);
      // A whole film of decoded clips would be hundreds of megabytes, so the
      // oldest fall out once there are plenty resident.
      while (this.buffers.size > MAX_CLIPS) {
        this.buffers.delete(this.buffers.keys().next().value);
      }
      this.pending.delete(url);
      return buf;
    })();
    this.pending.set(url, job);
    return job;
  }

  forget(url) {
    const bare = url.split("?")[0];
    for (const key of [...this.buffers.keys()]) {
      if (key.split("?")[0] === bare) this.buffers.delete(key);
    }
    for (const key of [...this.pending.keys()]) {
      if (key.split("?")[0] === bare) this.pending.delete(key);
    }
    peakCache.delete(bare);
  }

  /** Preload everything that could play in the next few seconds. */
  warm(t, ahead = 12) {
    for (const l of S.nar) {
      if (!hasClip(l)) continue;
      const a = placedAt(l);
      if (a > t - 2 && a < t + ahead) this.buffer(clipUrl(l)).catch(() => {});
    }
  }

  stopAll() {
    this.gen++;
    for (const src of this.playing.values()) { try { src.stop(); } catch (e) { /* ended */ } }
    this.playing.clear();
  }

  /** Called each frame while the video runs. */
  async tick(mediaTime) {
    if (!S.playing) return;
    const ctx = this.ensure();
    const gen = this.gen;
    for (const l of S.nar) {
      if (!hasClip(l) || this.playing.has(l.n)) continue;
      const at = placedAt(l), dur = placedDur(l);
      const lead = at - mediaTime;
      if (lead > 0.35 || lead < -dur) continue;          // not due yet, or missed
      const buf = await this.buffer(clipUrl(l));
      // Every frame runs a tick, so while this awaited a decode another tick may
      // have started the clip, or a seek may have made this one stale.
      if (!buf || !S.playing || gen !== this.gen || this.playing.has(l.n)) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      const offset = Math.max(0, -lead);
      const when = ctx.currentTime + Math.max(0, lead);
      src.start(when, offset);
      // A stopped source reports `ended` later, after a seek may already have
      // started this line again; only remove the entry if it is still ours.
      src.onended = () => { if (this.playing.get(l.n) === src) this.playing.delete(l.n); };
      this.playing.set(l.n, src);
    }
  }

}
const dub = new Dub();

// ------------------------------------------------------------------ recording

class Recorder {
  constructor() {
    this.ctx = null; this.node = null;
    this.chunks = []; this.on = false; this.flushing = false;
    this.peak = 0; this.frames = 0;
  }

  async init() {
    if (this.ctx) return;
    // These three defaults are destructive to a VO take and must be off.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false,
               autoGainControl: false, channelCount: 1, sampleRate: 48000 },
    });
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(this.ctx, "cap", { numberOfOutputs: 0 });
    this.node = node;
    node.port.onmessage = (e) => {
      // `flushing` lets the final partial block through even when the take was
      // paused when it ended, which is otherwise dropped by the `on` check.
      if (!this.on && !this.flushing) return;
      const c = e.data;
      this.chunks.push(c);
      this.frames += c.length;
      for (let i = 0; i < c.length; i += 16) {
        const v = Math.abs(c[i]);
        if (v > this.peak) this.peak = v;
      }
    };
    this.ctx.createMediaStreamSource(stream).connect(node);
  }

  start() {
    this.chunks = []; this.peak = 0; this.frames = 0;
    this.on = true; this.flushing = false;
  }

  pause() { this.on = false; }

  resume() { this.on = true; }

  /** How much audio is in the buffer so far, in seconds. */
  recorded() {
    return this.ctx ? this.frames / this.ctx.sampleRate : 0;
  }

  async stop() {
    if (this.node) {
      // ask for the partial block, and give it a moment to arrive
      this.flushing = true;
      this.node.port.postMessage("flush");
      await new Promise((r) => setTimeout(r, 60));
      this.flushing = false;
    }
    this.on = false;
    let n = 0;
    for (const c of this.chunks) n += c.length;
    const out = new Float32Array(n);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    this.chunks = [];
    return out;
  }

  beep(when, freq = 1000, dur = 0.05, gain = 0.1) {
    const osc = this.ctx.createOscillator(), g = this.ctx.createGain();
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.005);
    g.gain.setValueAtTime(gain, when + dur - 0.01);
    g.gain.linearRampToValueAtTime(0, when + dur);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(when); osc.stop(when + dur + 0.02);
  }
}
const rec = new Recorder();

// ----------------------------------------------------------------------- api

async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  const r = await fetch(path, opt);
  return r.json();
}

// -------------------------------------------------------------------- loading

async function loadProject() {
  S.project = await (await fetch("/api/project")).json();
  S.lines = S.project.lines || [];
  S.nar = S.lines.filter((l) => l.kind === "narration");
  S.byN = new Map(S.lines.map((l) => [l.n, l]));
  S.duration = (S.project.media && S.project.media.duration) || 0;

  const vid = $("vid");
  const src = "/" + ((S.project.media && S.project.media.proxy) || "media/source.mp4");
  if (!vid.src || !vid.src.endsWith(src)) vid.src = src;

  if (S.project.media && S.project.media.peaks) {
    S.peaksRate = S.project.media.peaks_rate || 50;
    try {
      const r = await fetch("/" + S.project.media.peaks);
      if (r.ok) S.peaks = new Uint8Array(await r.arrayBuffer());
    } catch (e) { S.peaks = null; }
  }
  // Re-point the selection at the fresh object, or a second take would be
  // recorded against an orphan and never show up.
  const keep = S.sel && S.sel.n;
  S.sel = (keep && S.byN.get(keep))
    || S.nar.find((l) => !l.selected) || S.nar[0] || null;
  $("hName").textContent = S.project.title || "Booth";
  drawAll();
}

function drawAll() { drawRows(); drawStats(); drawStage(); drawTimeline(); }

// -------------------------------------------------------------------- sidebar

function visibleRows() {
  const q = S.filter.trim().toLowerCase();
  return S.nar.filter((l) => {
    if (S.onlyFlags && !l.flag) return false;
    if (S.onlyTodo && l.selected) return false;
    if (!q) return true;
    return String(l.n).includes(q) || (l.text || "").toLowerCase().includes(q);
  });
}

function drawRows() {
  const rows = visibleRows().slice(0, 1200);
  $("rows").innerHTML = rows.map((l) => {
    const state = !l.selected ? "" : isPending(l) ? "PENDING"
      : ((l.fit && l.fit.verdict) || "OK");
    const colour = { OK: "var(--good)", BORROW: "var(--tight)", SHORT: "var(--over)",
      STRETCH: "var(--over)", MANUAL: "var(--over)", OVERRUN: "var(--bad)",
      EMPTY: "var(--bad)", PENDING: "var(--sel)" }[state] || "var(--none)";
    return `<div class="row ${l.selected ? "" : "norec"}` +
      `${S.sel && S.sel.n === l.n ? " sel" : ""}` +
      `${S.cur && S.cur.n === l.n ? " cur" : ""}" data-n="${l.n}">` +
      `<span class="n">${l.n}</span>` +
      `<span class="txt">${esc(l.text)}</span>` +
      `<span class="side">` +
        `<i class="flag ${l.flag ? "on" : ""}" data-flag="${l.n}" title="flag">⚑</i>` +
        `<i class="dot" style="background:${colour}"></i>` +
        (l.takes && l.takes.length > 1
          ? `<i class="n">${l.takes.length}t</i>` : "") +
      `</span></div>`;
  }).join("");
  const sel = document.querySelector(".row.sel");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function drawStats() {
  const done = S.nar.filter((l) => l.selected).length;
  const flagged = S.nar.filter((l) => l.flag).length;
  const over = S.nar.filter((l) => l.fit && l.fit.verdict === "OVERRUN").length;
  $("sbstat").innerHTML =
    `<span>recorded <b>${done}</b>/<b>${S.nar.length}</b></span>` +
    `<span>${((100 * done) / (S.nar.length || 1)).toFixed(1)}%</span>` +
    (flagged ? `<span style="color:var(--over)">⚑ <b>${flagged}</b></span>` : "") +
    (over ? `<span style="color:var(--bad)">overrun <b>${over}</b></span>` : "");
  $("hCount").textContent = `${done}/${S.nar.length}`;
}

// ---------------------------------------------------------------------- stage

function drawStage() {
  const l = S.sel;
  if (!l) return;
  $("ar").textContent = l.text;
  $("hPos").textContent = `line ${l.n} · ${fmtTC(l.start)}`;

  const cps = (S.project.settings && S.project.settings.cps) || 11;
  const need = l.chars / cps;
  const slot = slotOf(l), eff = effOf(l);
  const take = l.takes && l.takes[l.takes.length - 1];
  const spoke = (l.fit && l.fit.natural) || (take && take.check && take.check.speech) || 0;

  // Pace is always on screen: the actor should never have to ask for it.
  $("pace").innerHTML =
    `<span>slot <b>${slot.toFixed(2)}s</b>${eff > slot + 0.01
      ? ` +${(eff - slot).toFixed(2)}s borrowable` : ""}</span>` +
    `<span>${l.chars} chars → needs <b>${need.toFixed(2)}s</b> at ${cps} c/s</span>` +
    (spoke ? `<span>last read <b>${spoke.toFixed(2)}s</b></span>` : "") +
    "";

  const v = !l.selected ? null : isPending(l) ? "PENDING" : (l.fit && l.fit.verdict);
  const msg = take && take.check ? take.check.message : "";
  $("verdict").innerHTML = v
    ? `<span class="pill ${v}">${v}</span><span class="hintline">${esc(msg)}</span>` : "";

  const e = l.edit || {};
  const resized = e.target_dur !== undefined || !!e.cut_head || !!e.cut_tail;
  $("btnReset").disabled = !resized;
  $("btnReset").title = resized
    ? `back to the recorded length (${(l.fit && l.fit.natural || 0).toFixed(2)}s)`
    : "this clip is at its recorded length";

  $("budget").style.width = "0%";
  $("budgetWrap").classList.remove("live");
  $("streamer").style.width = "0%";
  drawTakes();
}

/** A line can collect a dozen takes; a row of buttons stops being readable
 *  well before that, so they live in a menu. */
function drawTakes() {
  const l = S.sel;
  const host = $("pace");
  if (!l || !l.takes || !l.takes.length) return;
  const opts = l.takes.map((t, k) => {
    const on = t.file === l.selected;
    const vv = (t.check && t.check.verdict) || "";
    const dur = t.dur ? `${t.dur.toFixed(1)}s` : "";
    const newest = k === l.takes.length - 1 ? " · newest" : "";
    return `<option value="${esc(t.file)}"${on ? " selected" : ""}>` +
      `take ${k + 1} of ${l.takes.length} — ${dur}${vv ? " · " + vv : ""}${newest}` +
      `</option>`;
  }).join("");
  host.insertAdjacentHTML("beforeend",
    `<span class="takepick"><label for="takeSel">take</label>` +
    `<select id="takeSel">${opts}</select></span>`);
  $("takeSel").addEventListener("change", (e) => useTake(l, e.target.value));
}

// ------------------------------------------------------------------- timeline
/* A scrolling track at a fixed pixels-per-second, the way an NLE does it,
 * rather than a window pinned to the playhead: at feature length you need to be
 * able to sit still and look at one place. Wheel zooms about the pointer,
 * horizontal wheel pans, and the view follows the playhead while playing until
 * the user scrolls, after which they are in charge until playback restarts. */

const RULER_H = 15;
const WAVE_H = 40;
const CLIP_H = 56;
const HANDLE_PX = 7;          // grab zone for an edge
const HANDLE_VIS_PPS = 26;    // below this, handles are too small to mean anything
const MIN_ZOOM = 1, MAX_ZOOM = 400, ZOOM_SPEED = 0.0028;
const TICKS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

const TL = { drag: null, zoom: 1, scroll: 0, userScrolled: false, width: 0 };

const fitPps = () => (S.duration > 0 && TL.width > 0 ? TL.width / S.duration : 50);
const pps = () => fitPps() * TL.zoom;
const timeAt = (clientX) => {
  const r = $("clips").getBoundingClientRect();
  return clamp((clientX - r.left + TL.scroll) / pps(), 0, S.duration);
};
const xOf = (t) => t * pps() - TL.scroll;

function setScroll(v) {
  TL.scroll = clamp(v, 0, Math.max(0, S.duration * pps() - TL.width));
}

function followPlayhead() {
  if (!S.playing || TL.userScrolled) return;
  const x = xOf($("vid").currentTime || 0);
  if (x < 24 || x > TL.width - 96) setScroll(($("vid").currentTime || 0) * pps() - 96);
}

function fitCanvas(c, h) {
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth || 1;
  TL.width = w;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return [g, w, h];
}

function drawTimeline() { drawWave(); drawClips(); }

function drawWave() {
  const [g, w, h] = fitCanvas($("wave"), RULER_H + WAVE_H);
  g.fillStyle = "#0e1013"; g.fillRect(0, 0, w, h);
  const P = pps();

  // ruler
  const step = TICKS.find((s) => s * P >= 55) || TICKS[TICKS.length - 1];
  g.fillStyle = "#1a1d23"; g.fillRect(0, 0, w, RULER_H);
  g.font = "9px ui-monospace,Consolas,monospace";
  const t0 = TL.scroll / P, t1 = (TL.scroll + w) / P;
  for (let t = Math.floor(t0 / step) * step; t < t1; t += step) {
    const x = Math.round(xOf(t)) + 0.5;
    g.strokeStyle = "#2a2e35"; g.beginPath();
    g.moveTo(x, 0); g.lineTo(x, RULER_H); g.stroke();
    g.fillStyle = "#5a616d";
    const m = Math.floor(t / 60), sec = t % 60;
    g.fillText(step < 1 ? `${m}:${sec.toFixed(1).padStart(4, "0")}`
                        : `${m}:${String(Math.round(sec)).padStart(2, "0")}`, x + 3, 10);
  }

  // original waveform, min/max envelope
  const mid = RULER_H + WAVE_H / 2, half = WAVE_H / 2 - 2;
  if (S.peaks && S.peaks.length) {
    g.fillStyle = "#39414d";
    const n = S.peaks.length / 2;
    for (let x = 0; x < w; x++) {
      const a = (TL.scroll + x) / P, b = (TL.scroll + x + 1) / P;
      let i0 = Math.floor(a * S.peaksRate);
      let i1 = Math.max(i0 + 1, Math.floor(b * S.peaksRate));
      if (i0 >= n) break;
      i1 = Math.min(i1, n);
      let lo = 0, hi = 0;
      for (let i = i0; i < i1; i++) {
        const mn = S.peaks[i * 2], mx = S.peaks[i * 2 + 1];
        if (mn < lo) lo = mn;
        if (mx > hi) hi = mx;
      }
      const yTop = mid - (hi / 127) * half, yBot = mid - (lo / 127) * half;
      g.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }
  } else {
    g.fillStyle = "#2a2e35";
    g.fillText("waveform not built — re-import the video", 8, mid);
  }

  // cues that stay in the original language, never dubbed
  for (const l of S.lines) {
    if (l.kind === "narration") continue;
    const x = xOf(l.start), bw = Math.max(1, (l.end - l.start) * P);
    if (x > w || x + bw < 0) continue;
    g.fillStyle = "#3a4250"; g.fillRect(x, h - 3, bw, 3);
  }
  playhead(g, w, h);
}

function roundRect(g, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

const CLIP_FILL = { OK: "#2f6f52", BORROW: "#6b6030", SHORT: "#6b4a26",
  STRETCH: "#6b4a26", MANUAL: "#5a4a7a", OVERRUN: "#6e2f2f", EMPTY: "#6e2f2f" };

const MAX_CLIPS = 140;          // decoded clips kept resident
const CLIP_PEAKS = 400;         // envelope buckets per clip
const peakCache = new Map();    // bare render url -> Float32Array of peaks

/** Envelope of a clip, computed once from the buffer already decoded for
 *  playback. Null until the decode lands; the clip just draws plain until then. */
function clipPeaks(l) {
  const url = clipUrl(l), bare = url.split("?")[0];
  const hit = peakCache.get(bare);
  if (hit && hit.rev === (l.fit.rev || 0)) return hit.peaks;
  const buf = dub.buffers.get(url);
  if (!buf) {
    if (!dub.pending.has(url)) dub.buffer(url).catch(() => {});
    return null;
  }
  const src = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(src.length / CLIP_PEAKS));
  const peaks = new Float32Array(Math.ceil(src.length / step));
  for (let i = 0, k = 0; i < src.length; i += step, k++) {
    let m = 0;
    const end = Math.min(src.length, i + step);
    for (let j = i; j < end; j += 3) {
      const v = src[j] < 0 ? -src[j] : src[j];
      if (v > m) m = v;
    }
    peaks[k] = m;
  }
  peakCache.set(bare, { rev: l.fit.rev || 0, peaks });
  return peaks;
}

function drawClips() {
  const [g, w, h] = fitCanvas($("clips"), CLIP_H);
  g.fillStyle = "#0e1013"; g.fillRect(0, 0, w, h);
  const P = pps();
  // The slot box stands proud of the clip top and bottom, so you can see at a
  // glance how the recording sits inside the time the translation was given.
  const SLOT_TOP = 3, SLOT_H = h - 15;
  const CLIP_INSET = 7;
  const cTop = SLOT_TOP + CLIP_INSET, cH = SLOT_H - CLIP_INSET * 2;

  // Cues that keep their original audio. These are not slots and never get a
  // clip, so they are drawn as a hatched band along the floor of the lane -
  // unmistakably not an empty slot box waiting to be filled.
  for (const l of S.lines) {
    if (l.kind === "narration") continue;
    const x = xOf(l.start), bw = Math.max(2, (l.end - l.start) * P);
    if (x > w || x + bw < 0) continue;
    const y = h - 11;
    g.fillStyle = "#242a33";
    g.fillRect(x, y, bw, 8);
    g.strokeStyle = "#39414d";
    g.lineWidth = 1;
    g.beginPath();
    for (let d = -8; d < bw; d += 6) {
      g.moveTo(Math.max(x, x + d), y + 8);
      g.lineTo(Math.min(x + bw, x + d + 8), y);
    }
    g.stroke();
    if (bw > 62) {
      g.fillStyle = "#5a616d";
      g.font = "9px Segoe UI";
      g.fillText("original audio", x + 5, y + 6.5);
    }
  }

  for (const l of S.nar) {
    const sx = xOf(l.start), sw = Math.max(2, (l.end - l.start) * P);
    const cx = hasClip(l) ? xOf(placedAt(l)) : sx;
    const cw = hasClip(l) ? Math.max(3, placedDur(l) * P) : sw;
    if (Math.max(sx + sw, cx + cw) < 0 || Math.min(sx, cx) > w) continue;

    // the slot the translation was given
    g.fillStyle = "#20242c";
    roundRect(g, sx, SLOT_TOP, sw, SLOT_H, 2); g.fill();
    g.strokeStyle = "#333944"; g.lineWidth = 1;
    roundRect(g, sx + 0.5, SLOT_TOP + 0.5, sw - 1, SLOT_H - 1, 2); g.stroke();
    if (l.flag) { g.fillStyle = "#e08b3c"; g.fillRect(sx, SLOT_TOP, 2, SLOT_H); }

    if (!hasClip(l)) continue;
    const on = S.sel && S.sel.n === l.n;
    const busy = S.busyLine === l.n;
    g.fillStyle = busy ? "#3a3f47"
      : (CLIP_FILL[(l.fit && l.fit.verdict) || "OK"] || "#2f6f52");
    roundRect(g, cx, cTop, cw, cH, 3); g.fill();
    g.strokeStyle = on ? "#4a9eff" : "#00000066";
    g.lineWidth = on ? 2 : 1;
    roundRect(g, cx + 0.5, cTop + 0.5, cw - 1, cH - 1, 3); g.stroke();

    if (on && !busy && P >= HANDLE_VIS_PPS && cw > 12) {
      g.fillStyle = "#4a9eff";
      g.fillRect(cx, cTop, 3, cH);
      g.fillRect(cx + cw - 3, cTop, 3, cH);
    }
    // The recording itself, drawn inside its box.
    //
    // The envelope normally fills the box, which is right: a stretched clip
    // really is the whole recording spread over that width. While a cut drag
    // is in progress it is not - the audio is untouched and the box is simply
    // getting shorter - so the envelope is pinned to its own natural width and
    // the tail is allowed to fall outside the box, which is what cutting looks
    // like.
    if (!busy && cw > 8) {
      const peaks = clipPeaks(l);
      if (peaks && peaks.length) {
        const drag = TL.drag;
        const cutting = drag && drag.n === l.n && drag.mode !== "move"
                        && drag.mode !== "pan" && S.edgeMode === "cut";
        const wavW = cutting ? Math.max(1, drag.dur0 * P) : cw;
        // A head cut keeps the tail still, so the envelope is pinned to the
        // clip's right edge and runs off the left instead.
        const wavX = cutting && drag.mode === "start" ? cx + cw - wavW : cx;
        const mid = cTop + cH / 2, half = cH / 2 - 2;
        const x0 = Math.max(0, cx), x1 = Math.min(w, cx + cw);
        g.fillStyle = "#ffffff5c";
        for (let x = Math.floor(x0); x < x1; x++) {
          const f0 = (x - wavX) / wavW;
          if (f0 >= 1) break;                       // past the end of the audio
          if (f0 < 0) continue;                     // before it starts
          const f1 = (x + 1 - wavX) / wavW;
          const i0 = Math.floor(f0 * peaks.length);
          const i1 = Math.max(i0 + 1, Math.floor(f1 * peaks.length));
          let m = 0;
          for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
          const a = m * half;
          if (a > 0.3) g.fillRect(x, mid - a, 1, a * 2);
        }
      }
    }
    if (busy && cw > 16) {
      // a moving dash while this clip re-renders
      const t = (performance.now() / 260) % 1;
      g.fillStyle = "#9ecbff";
      g.fillRect(cx + 3 + (cw - 22) * t, cTop + cH / 2 - 1, 16, 2);
    }
    if (cw > 30) {
      g.fillStyle = "#cdd5e0"; g.font = "10px Segoe UI";
      g.fillText(String(l.n), cx + 5, h - 3);
    }
  }
  playhead(g, w, h);
}

function playhead(g, w, h) {
  const x = xOf($("vid").currentTime || 0);
  if (x < -2 || x > w + 2) return;
  g.fillStyle = "#fff"; g.fillRect(x - 1, 0, 2, h);
}

/** Where this clip may sit without touching its neighbours. */
function hitTest(clientX) {
  const t = timeAt(clientX);
  const P = pps();
  for (const l of S.nar) {
    if (!hasClip(l)) continue;
    const a = placedAt(l), b = a + placedDur(l);
    if (t < a - HANDLE_PX / P || t > b + HANDLE_PX / P) continue;
    const edge = P < HANDLE_VIS_PPS ? null
      : (t - a) * P < HANDLE_PX ? "start"
      : (b - t) * P < HANDLE_PX ? "end" : null;
    return { line: l, t, edge };
  }
  return { line: null, t, edge: null };
}

$("clips").addEventListener("pointerdown", (ev) => {
  if (locked()) return;
  const hit = hitTest(ev.clientX);
  if (!hit.line) {
    // Empty space: a click seeks, a drag pans. Panning has to exist once you
    // are zoomed in far enough that the wheel alone will not get you there.
    TL.drag = { mode: "pan", x0: ev.clientX, scroll0: TL.scroll, t: hit.t, moved: false };
    $("clips").style.cursor = "grabbing";
    return;
  }
  select(hit.line);
  // No bounds. A clip goes wherever it is dragged, including across its
  // neighbours and outside its own cue - the slot boxes are guides to read,
  // not walls to fight.
  const f0 = hit.line.fit || {};
  TL.drag = {
    n: hit.line.n, mode: hit.edge || "move", t0: hit.t,
    at0: placedAt(hit.line), dur0: placedDur(hit.line), moved: false,
    // the cut window this clip already has, so a new cut composes with it
    natural: f0.natural || placedDur(hit.line),
    head0: f0.cut_head || 0, tail0: f0.cut_tail || 0,
  };
});

$("clips").addEventListener("pointermove", (ev) => {
  const c = $("clips");
  const d = TL.drag;
  if (!d) {
    if (locked()) { c.style.cursor = "wait"; return; }
    const hit = hitTest(ev.clientX);
    c.style.cursor = !hit.line ? "grab" : hit.edge ? "ew-resize" : "move";
    return;
  }
  if (d.mode === "pan") {
    if (Math.abs(ev.clientX - d.x0) > 2) d.moved = true;
    TL.userScrolled = true;
    setScroll(d.scroll0 - (ev.clientX - d.x0));
    drawTimeline();
    return;
  }
  const t = timeAt(ev.clientX);
  const l = S.byN.get(d.n);
  if (Math.abs(t - d.t0) * pps() > 2) d.moved = true;

  if (d.mode === "move") {
    l.fit.placed_at = +Math.max(0, d.at0 + (t - d.t0)).toFixed(3);
  } else if (d.mode === "end") {
    // Cutting moves the tail of the window. Dragging outwards puts audio back,
    // up to whatever the head cut left of the recording.
    let dur = Math.max(MIN_CLIP, d.dur0 + (t - d.t0));
    if (S.edgeMode === "cut") {
      dur = Math.min(dur, d.natural - d.head0);
      d.cutHead = d.head0;
      d.cutTail = Math.max(0, d.natural - d.head0 - dur);
    }
    d.newDur = dur;
    l.fit.fitted = +dur.toFixed(3);
  } else {
    // Left edge: the right edge stays put, so this moves the head of the
    // window. Its limit is what the tail cut left, not the raw recording.
    const right = d.at0 + d.dur0;
    let at = Math.max(0, Math.min(d.at0 + (t - d.t0), right - MIN_CLIP));
    if (S.edgeMode === "cut") {
      at = Math.max(at, right - (d.natural - d.tail0));
      d.cutTail = d.tail0;
      d.cutHead = Math.max(0, d.natural - d.tail0 - (right - at));
    }
    d.newDur = right - at;
    l.fit.placed_at = +at.toFixed(3);
    l.fit.fitted = +d.newDur.toFixed(3);
  }
  drawClips();
  showDragHint(l, d);
});

function showDragHint(l, d) {
  const natural = d.natural || (l.fit && l.fit.natural) || d.dur0;
  const window = Math.max(0.05, natural - (d.head0 || 0) - (d.tail0 || 0));
  const dur = d.mode === "move" ? d.dur0 : (d.newDur || d.dur0);
  const ratio = window / dur;
  $("verdict").innerHTML = d.mode === "move"
    ? `<span class="hintline">at ${fmtTC(placedAt(l))} · ` +
      `${(placedAt(l) - l.start >= 0 ? "+" : "")}${(placedAt(l) - l.start).toFixed(2)}s ` +
      `from its cue</span>`
    : `<span class="hintline">${dur.toFixed(2)}s · ` +
      (S.edgeMode === "cut"
        ? (dur < natural
            ? `keeping ${dur.toFixed(2)}s of ${natural.toFixed(2)}s · ` +
              `${(d.cutHead || 0).toFixed(2)}s off the front, ` +
              `${(d.cutTail || 0).toFixed(2)}s off the end`
            : "the whole recording — drag inwards to cut")
        : `tempo ×${ratio.toFixed(3)}${ratio > 1.15 || ratio < 0.87
            ? ' <b style="color:var(--over)">outside the transparent window</b>' : ""}`) +
      `</span>`;
}

// A drag has to end even if the pointer leaves the canvas.
addEventListener("pointerup", async () => {
  const d = TL.drag;
  TL.drag = null;
  $("clips").style.cursor = "default";
  if (!d) return;

  if (d.mode === "pan") {
    if (!d.moved) seek(d.t);           // a click on empty space is a seek
    return;
  }
  const l = S.byN.get(d.n);
  if (!d.moved) { drawStage(); return; }
  if (d.mode === "move") {
    await api("/api/line-move", { n: l.n, placed_at: placedAt(l) });
    drawTimeline(); drawStage();
    return;
  }
  const keep = Object.assign({}, l.edit || {});
  delete keep.cut_edge;                       // superseded by the window
  if (S.edgeMode === "cut") {
    // A cut is a window into the recording, so both edges are sent every
    // time. Sending only the edge that moved is what let a second cut wipe
    // out the first one.
    Object.assign(keep, {
      cut_head: +(d.cutHead || 0).toFixed(3),
      cut_tail: +(d.cutTail || 0).toFixed(3),
      mode: "cut",
    });
    delete keep.target_dur;                   // the window sets the length now
  } else {
    keep.target_dur = +(d.newDur || d.dur0).toFixed(3);
    keep.mode = "stretch";
  }
  keep.place_at = +placedAt(l).toFixed(3);
  await applyEdit(l, keep, true);
});

$("clips").addEventListener("wheel", (ev) => {
  if (!ev.ctrlKey && Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
    ev.preventDefault();
    TL.userScrolled = true;
    setScroll(TL.scroll + ev.deltaX);
    drawTimeline();
    return;
  }
  ev.preventDefault();
  const P0 = pps();
  const r = $("clips").getBoundingClientRect();
  const px = ev.clientX - r.left;
  const anchor = (TL.scroll + px) / P0;
  TL.zoom = clamp(TL.zoom * Math.exp(-ev.deltaY * ZOOM_SPEED), MIN_ZOOM, MAX_ZOOM);
  TL.userScrolled = true;
  setScroll(anchor * pps() - px);
  drawTimeline();
}, { passive: false });

$("wave").addEventListener("pointerdown", (ev) => { seek(timeAt(ev.clientX)); });

// ------------------------------------------------------------------ commands

function select(l) {
  if (!l) return;
  S.sel = l;
  drawRows(); drawStage(); drawClips();
}

function seek(t, andSelect = true) {
  const vid = $("vid");
  const at = clamp(t, 0, Math.max(0, S.duration - 0.05));
  vid.currentTime = at;
  dub.stopAll();
  // Whatever is under the playhead becomes the focused line, so `R` always
  // records the thing you are looking at.
  if (andSelect) {
    const l = lineAt(at) || nearestLine(at);
    if (l && (!S.sel || S.sel.n !== l.n)) select(l);
  }
}

function lineAt(t) {
  for (const l of S.nar) {
    const a = hasClip(l) ? Math.min(l.start, placedAt(l)) : l.start;
    const b = hasClip(l) ? Math.max(l.end, placedAt(l) + placedDur(l)) : l.end;
    if (t >= a - 0.05 && t <= b + 0.4) return l;
  }
  return null;
}

function nearestLine(t) {
  let best = null, dist = Infinity;
  for (const l of S.nar) {
    const d = t < l.start ? l.start - t : t > l.end ? t - l.end : 0;
    if (d < dist) { dist = d; best = l; }
  }
  return dist <= 6 ? best : null;
}

function jumpTo(l) {
  select(l);
  seek(Math.max(0, l.start - 1.2), false);
  revealLine(l);
}

/** Bring a line into view, centring it when the zoom is too tight to show it. */
function revealLine(l) {
  const P = pps();
  const a = Math.min(l.start, placedAt(l));
  const b = Math.max(l.end, placedAt(l) + placedDur(l));
  const x0 = a * P - TL.scroll, x1 = b * P - TL.scroll;
  TL.userScrolled = true;
  if (x0 < 40 || x1 > TL.width - 40 || (x1 - x0) > TL.width) {
    setScroll(((a + b) / 2) * P - TL.width / 2);
  }
  drawTimeline();
}

/** Re-render one clip. The timeline is locked meanwhile: the audio on disk is
 *  briefly out of step with what is drawn, and a second drag on top of that
 *  would be applied to a length that no longer exists. */
async function applyEdit(l, edit, replace = false) {
  S.busyLine = l.n;
  setBusy(`rendering line ${l.n}…`);
  drawTimeline();
  try {
    const r = await api("/api/line-edit", { n: l.n, edit, replace });
    if (!r.ok) { flash(r.error); return; }
    Object.assign(l, r.line);
    S.byN.set(l.n, l);
    if (r.fit && r.fit.render) dub.forget("/" + r.fit.render);
    drawAll();
  } finally {
    S.busyLine = null;
    setBusy(null);
    drawTimeline();
  }
}

function setBusy(msg) {
  $("tlBusy").hidden = !msg;
  if (msg) $("tlBusyTxt").textContent = msg;
}

function flash(msg) {
  $("verdict").innerHTML = `<span class="hintline" style="color:var(--bad)">${esc(msg)}</span>`;
}

async function toggleFlag(l) {
  l.flag = l.flag ? null : "flagged";
  await api("/api/line", { n: l.n, flag: l.flag });
  drawRows(); drawStats();
}

async function useTake(l, file) {
  S.busyLine = l.n;
  setBusy(`loading take…`);
  drawTimeline();
  try {
    const r = await api("/api/line-edit", { n: l.n, selected: file });
    if (!r.ok) { flash(r.error); return; }
    Object.assign(l, r.line);
    S.byN.set(l.n, l);
    if (r.fit && r.fit.render) dub.forget("/" + r.fit.render);
    drawAll();
  } finally {
    S.busyLine = null;
    setBusy(null);
    drawTimeline();
  }
}

/** Take the clip off the timeline. The recordings are kept. */
async function clearClip(l) {
  if (!l || !hasClip(l)) return;
  S.busyLine = l.n;
  setBusy(`removing line ${l.n} from the timeline…`);
  drawTimeline();
  try {
    const r = await api("/api/line-clear", { n: l.n });
    if (!r.ok) { flash(r.error); return; }
    if (l.fit && l.fit.render) dub.forget("/" + l.fit.render);
    Object.assign(l, r.line);
    S.byN.set(l.n, l);
    drawAll();
  } finally {
    S.busyLine = null;
    setBusy(null);
    drawTimeline();
  }
}

// ----------------------------------------------------------------- transport

async function play() {
  const vid = $("vid");
  if (!vid.src) return;
  dub.ensure();
  if (dub.ctx.state === "suspended") await dub.ctx.resume();
  dub.warm(vid.currentTime);
  S.playing = true;
  TL.userScrolled = false;
  await vid.play();
  $("btnPlay").textContent = "❚❚ pause";
}

function pause() {
  S.playing = false;
  $("vid").pause();
  dub.stopAll();
  $("btnPlay").textContent = "▶ play";
}

function applyMix() {
  const base = +$("vOrig").value / 100;
  const onDubbed = S.duck && S.cur && hasClip(S.cur);
  $("vid").volume = onDubbed ? base * 0.18 : base;
  dub.setVolume(+$("vDub").value / 100);
}

// ----------------------------------------------------------------- recording

async function roll() {
  const l = (S.sel && S.byN.get(S.sel.n)) || S.sel;
  if (!l || S.rolling) return;
  S.rollLine = l;
  try { await rec.init(); }
  catch (e) { flash(`microphone unavailable: ${e.message}`); return; }
  if (rec.ctx.state === "suspended") await rec.ctx.resume();

  const vid = $("vid");
  pause();
  const from = Math.max(0, l.start - PREROLL);
  S.rolling = true;
  $("rec").classList.add("on"); $("recLabel").textContent = "rolling";
  $("streamerWrap").classList.add("armed");
  setRollUi(true);

  await new Promise((res) => {
    const done = () => { vid.removeEventListener("seeked", done); res(); };
    vid.addEventListener("seeked", done);
    vid.currentTime = from;
    if (Math.abs(vid.currentTime - from) < 0.02) done();
  });

  rec.start();
  S.cueOffset = null;
  S.playing = false;                      // the dub track stays silent while recording
  await vid.play();
  const t0a = rec.ctx.currentTime, t0m = vid.currentTime;
  for (const off of BEEPS) {
    const when = t0a + (l.start + off - t0m);
    if (when > rec.ctx.currentTime + 0.02) rec.beep(when);
  }

  // Recording runs until the user stops it. It is allowed to spill into the
  // next line - the clip can be moved and stretched afterwards, and an ending
  // cut off by a timer is worse than one that runs long.
  const step = () => {
    if (!S.rolling) return;
    const t = vid.currentTime;
    if (t < l.start) {
      $("streamer").style.width = `${clamp((t - from) / (l.start - from), 0, 1) * 100}%`;
    } else {
      if (S.cueOffset == null && !S.paused) {
        // where the line's own start fell inside the recording, corrected for
        // the frame we noticed it on
        S.cueOffset = Math.max(0, rec.recorded() - (t - l.start));
      }
      $("streamer").style.width = "100%";
      $("streamerWrap").classList.remove("armed");
      $("budgetWrap").classList.add("live");
      const used = t - l.start, lim = effOf(l);
      $("budget").style.width = `${Math.min(100, (used / lim) * 100)}%`;
      $("budget").className = used > lim ? "over" : used > slotOf(l) ? "tight" : "";
      $("budgetMark").style.left = `${(slotOf(l) / lim) * 100}%`;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Space holds the take mid-flight - picture and microphone stop together. */
function togglePauseRecording() {
  if (!S.rolling) return;
  S.paused = !S.paused;
  if (S.paused) {
    rec.pause();
    $("vid").pause();
    $("recLabel").textContent = "paused";
    $("rec").classList.remove("on");
    flash("recording held — Space to carry on, R to keep the take");
  } else {
    rec.resume();
    $("vid").play().catch(() => {});
    $("recLabel").textContent = "rolling";
    $("rec").classList.add("on");
    $("verdict").innerHTML = "";
  }
  setRollUi(true);
}

async function finish() {
  if (!S.rolling) return;
  S.rolling = false;
  S.paused = false;
  $("vid").pause();
  $("rec").classList.remove("on"); $("recLabel").textContent = "idle";
  $("streamerWrap").classList.remove("armed");
  setRollUi(false);
  const buf = await rec.stop();
  const l = S.rollLine || S.sel;
  S.rollLine = null;
  if (!l) return;
  if (!buf.length) { flash("nothing captured"); return; }

  // Recording rolls from the top of the pre-roll so the actor hears the
  // count-in, but three seconds of beeps and room does not belong in the clip.
  // Keep a short run-up instead - enough to catch a read that starts a beat
  // early, without carrying the count-in into the timeline.
  const sr = rec.ctx.sampleRate;
  let take = buf, cue = S.cueOffset;
  const lead = (S.project.settings && S.project.settings.record_lead) != null
    ? S.project.settings.record_lead : DEFAULT_LEAD;
  if (cue != null && cue > lead) {
    const cut = Math.floor((cue - lead) * sr);
    if (cut > 0 && cut < buf.length) { take = buf.subarray(cut); cue = lead; }
  }

  const q = `n=${l.n}&sr=${sr}` + (cue != null ? `&cue=${cue.toFixed(3)}` : "");
  const r = await fetch(`/api/take?${q}`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" },
    body: take.slice().buffer,
  }).then((x) => x.json());
  if (!r.ok) { flash(`save failed: ${r.error}`); return; }

  // Place it straight away, but do not play anything: an automatic replay on
  // top of whatever the user is already doing just doubles up.
  if (l.fit && l.fit.render) dub.forget("/" + l.fit.render);
  const fit = await api("/api/line-edit", { n: l.n, edit: null });
  if (fit.ok) Object.assign(l, fit.line);
  else await loadProject();
  if (l.fit && l.fit.render) dub.forget("/" + l.fit.render);
  drawAll();
  revealLine(l);
}

function abort() {
  if (!S.rolling) return;
  S.rolling = false;
  S.paused = false;
  S.rollLine = null;
  $("vid").pause();
  rec.stop();
  $("rec").classList.remove("on"); $("recLabel").textContent = "idle";
  $("streamerWrap").classList.remove("armed");
  setRollUi(false);
}

function setRollUi(rolling) {
  if (window.booth && window.booth.setRecording) window.booth.setRecording(rolling);
  $("btnRoll").textContent = rolling ? (S.paused ? "■ keep take" : "■ stop") : "● record";
  $("btnRoll").classList.toggle("stop", rolling);
  $("kbdRoll").textContent = rolling ? "stop" : "record";
  // While a take is running, Space holds it rather than driving playback.
  $("kbdSpace").textContent = rolling ? (S.paused ? "resume" : "hold") : "play";
  $("btnPlay").textContent = rolling
    ? (S.paused ? "▶ resume" : "❚❚ hold")
    : (S.playing ? "❚❚ pause" : "▶ play");
}

// --------------------------------------------------------------------- frame

function frame() {
  const vid = $("vid");
  const t = vid.currentTime || 0;
  $("tc").textContent = fmtTC(t);

  let cur = null;
  for (const l of S.nar) {
    const a = hasClip(l) ? Math.min(l.start, placedAt(l)) : l.start;
    const b = hasClip(l) ? Math.max(l.end, placedAt(l) + placedDur(l)) : l.end;
    if (t >= a - 0.05 && t <= b + 0.4) { cur = l; break; }
  }
  if (cur !== S.cur) {
    S.cur = cur;
    $("sub").textContent = cur ? cur.text : "";
    if (cur && S.playing && !S.rolling && (!S.sel || S.sel.n !== cur.n)) select(cur);
    applyMix();
    drawRows();
  }

  if (S.playing) { dub.tick(t); dub.warm(t); followPlayhead(); }
  if (rec.on) {
    const pk = rec.peak; rec.peak *= 0.86;
    $("meter").style.width = `${Math.min(100, pk * 100)}%`;
    $("meter").className = pk > 0.89 ? "hot" : "";
  }

  // Redrawing hundreds of lines across two canvases every frame while capturing audio
  // starves the thread the microphone blocks arrive on. The meter above still
  // runs at full rate; only the canvases slow down while a take is rolling.
  const now = performance.now();
  if (!S.rolling || now - (S.lastDraw || 0) >= 50) {
    S.lastDraw = now;
    drawTimeline();
  }
  requestAnimationFrame(frame);
}

// --------------------------------------------------------------------- wiring

$("rows").addEventListener("click", (ev) => {
  const f = ev.target.closest("[data-flag]");
  if (f) { toggleFlag(S.byN.get(+f.dataset.flag)); ev.stopPropagation(); return; }
  const row = ev.target.closest(".row");
  if (row) jumpTo(S.byN.get(+row.dataset.n));
});

$("q").addEventListener("input", (e) => { S.filter = e.target.value; drawRows(); });
$("btnFlags").addEventListener("click", (e) => {
  S.onlyFlags = !S.onlyFlags; e.target.classList.toggle("on", S.onlyFlags); drawRows();
});
$("btnTodo").addEventListener("click", (e) => {
  S.onlyTodo = !S.onlyTodo; e.target.classList.toggle("on", S.onlyTodo); drawRows();
});
$("btnZoomIn").addEventListener("click", () => {
  TL.zoom = clamp(TL.zoom * 1.6, MIN_ZOOM, MAX_ZOOM); TL.userScrolled = true; drawTimeline();
});
$("btnZoomOut").addEventListener("click", () => {
  TL.zoom = clamp(TL.zoom / 1.6, MIN_ZOOM, MAX_ZOOM); drawTimeline();
});
$("btnZoomFit").addEventListener("click", () => {
  TL.zoom = MIN_ZOOM; TL.scroll = 0; TL.userScrolled = false; drawTimeline();
});

$("btnPlay").addEventListener("click", () => {
  if (S.rolling) togglePauseRecording();
  else if (S.playing) pause();
  else play();
});
$("btnRoll").addEventListener("click", () => (S.rolling ? finish() : roll()));
$("btnPrev").addEventListener("click", () => {
  const i = S.nar.indexOf(S.sel);
  if (i > 0) jumpTo(S.nar[i - 1]);
});
$("btnNext").addEventListener("click", () => {
  const i = S.nar.indexOf(S.sel);
  if (i >= 0 && i + 1 < S.nar.length) jumpTo(S.nar[i + 1]);
});
/** Undo a hand-set length, keeping wherever the clip was dragged to. */
async function resetLength(l) {
  const e = l && l.edit;
  if (!e || (e.target_dur === undefined && !e.cut_head && !e.cut_tail)) return;
  const edit = Object.assign({}, e);
  for (const k of ["target_dur", "mode", "cut_edge", "cut_head", "cut_tail"]) {
    delete edit[k];
  }
  await applyEdit(l, Object.keys(edit).length ? edit : null, true);
}

$("btnReset").addEventListener("click", () => resetLength(S.sel));

$("btnDuck").addEventListener("click", (e) => {
  S.duck = !S.duck; e.target.classList.toggle("on", S.duck); applyMix();
});
$("btnEdge").addEventListener("click", () => {
  S.edgeMode = S.edgeMode === "cut" ? "stretch" : "cut";
  setEdgeUi();
});

function setEdgeUi() {
  const cut = S.edgeMode === "cut";
  $("btnEdge").textContent = cut ? "Edge: Cut" : "Edge: Stretch";
  $("btnEdge").classList.toggle("on", cut);
  $("btnEdge").title = cut
    ? "Dragging an edge trims the recording. Nothing is re-timed."
    : "Dragging an edge changes the tempo. Pitch and formants stay put.";
}
for (const id of ["vOrig", "vDub"]) $(id).addEventListener("input", applyMix);
$("vid").addEventListener("pause", () => {
  if (!S.rolling) { S.playing = false; dub.stopAll(); $("btnPlay").textContent = "▶ play"; }
});

addEventListener("keydown", (ev) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
  switch (ev.code) {
    case "Space":
      ev.preventDefault();
      if (S.rolling) togglePauseRecording();
      else if (S.playing) pause();
      else play();
      break;
    case "KeyR": ev.preventDefault(); S.rolling ? finish() : roll(); break;
    case "Escape": ev.preventDefault(); abort(); break;
    case "KeyF": ev.preventDefault(); if (S.sel) toggleFlag(S.sel); break;
    case "Delete":
    case "Backspace":
      ev.preventDefault();
      if (!S.rolling && S.sel && hasClip(S.sel)) clearClip(S.sel);
      break;
    case "ArrowRight": ev.preventDefault(); $("btnNext").click(); break;
    case "ArrowLeft": ev.preventDefault(); $("btnPrev").click(); break;
    default: break;
  }
});
addEventListener("resize", () => { if (S.project) drawTimeline(); });

// ---------------------------------------------------------------------- export

$("btnExport").addEventListener("click", () => {
  const done = S.nar.filter((l) => l.selected).length;
  $("xNote").textContent = `${done} of ${S.nar.length} lines recorded.`;
  $("exportModal").hidden = false;
});
$("xCancel").addEventListener("click", () => { $("exportModal").hidden = true; });
$("exportModal").addEventListener("click", (e) => {
  if (e.target.id === "exportModal") $("exportModal").hidden = true;
});
$("xGo").addEventListener("click", async () => {
  const what = document.querySelector('input[name=xwhat]:checked').value;
  const rng = document.querySelector('input[name=xrange]:checked').value;
  $("exportModal").hidden = true;
  await window.booth.export(what, rng);
});

$("btnClose").addEventListener("click", () => window.booth.closeProject());

if (window.booth && window.booth.onBusy) {
  window.booth.onBusy((message) => {
    $("busy").hidden = !message;
    if (message) $("busyTxt").textContent = message;
  });
}

// ----------------------------------------------------------------------- boot

(async function boot() {
  await loadProject();
  setEdgeUi();
  applyMix();
  requestAnimationFrame(frame);
})();
