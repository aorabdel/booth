/**
 * Booth's local service: project state, take capture, and the checker daemon.
 *
 * This runs inside the desktop app's main process. It is a loopback HTTP
 * server rather than direct IPC for one reason: the guide video is a 2 GB
 * file that has to be scrubbed to an arbitrary timecode on every take, and
 * byte-range streaming over http://127.0.0.1 is what makes that instant.
 * Nothing listens on an external interface and no browser is involved.
 *
 * Also runnable headless for development:
 *   node server.js [--port 7800] [--root E:\dub] [--no-asr]
 */

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");

const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// ---------------------------------------------------------------- WAV output

function writeWav24(filePath, float32, sampleRate) {
  const n = float32.length;
  const dataBytes = n * 3;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 3, 28);
  header.writeUInt16LE(3, 32);            // block align
  header.writeUInt16LE(24, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);

  const data = Buffer.alloc(dataBytes);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    let v = Math.round(s * 8388607);
    if (v < 0) v += 0x1000000;
    data[i * 3] = v & 0xff;
    data[i * 3 + 1] = (v >> 8) & 0xff;
    data[i * 3 + 2] = (v >> 16) & 0xff;
  }
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

// ------------------------------------------------------------ checker daemon

class Checker {
  constructor(pipelineRoot, projectJson, python, noAsr, log) {
    this.root = pipelineRoot;
    this.projectJson = projectJson;
    this.python = python;
    this.noAsr = noAsr;
    this.log = log || (() => {});
    this.seq = 0;
    this.pending = new Map();
    this.ready = false;
    this.asr = false;
    this.error = null;
    this.buf = "";
    this.proc = null;
  }

  start() {
    const args = ["-u", "-m", "pipeline.checkd", "--project", this.projectJson];
    if (this.noAsr) args.push("--no-asr");
    try {
      this.proc = spawn(this.python, args, {
        cwd: this.root,
        env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      this.error = String(e.message || e);
      return;
    }
    this.proc.on("error", (e) => {
      this.error = `could not start Python (${this.python}): ${e.message}`;
      this.log(this.error);
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c) => this._onData(c));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c) => {
      const t = c.trim();
      if (t) { this.error = t.split(/\r?\n/).slice(-1)[0]; this.log(`[checkd] ${t}`); }
    });
    this.proc.on("exit", (code) => {
      this.log(`[checkd] exited with code ${code}`);
      this.ready = false;
      for (const { reject } of this.pending.values()) reject(new Error("checker stopped"));
      this.pending.clear();
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.event === "ready") {
        this.ready = true;
        this.asr = !!msg.asr;
        this.error = null;
        this.log(`[checkd] ready - asr=${this.asr}, ${msg.lines} lines`);
        if (msg.note) this.log(`[checkd] ${msg.note}`);
        continue;
      }
      const waiter = this.pending.get(msg.id);
      if (waiter) { this.pending.delete(msg.id); waiter.resolve(msg); }
    }
  }

  send(payload, timeoutMs = 60000) {
    if (!this.proc || this.proc.exitCode !== null) {
      return Promise.reject(new Error(this.error || "checker not running"));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("checker timed out"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify(Object.assign({ id }, payload)) + "\n");
    });
  }

  stop() {
    if (this.proc) {
      try { this.proc.stdin.write('{"cmd":"quit"}\n'); } catch (e) { /* closing */ }
      this.proc.kill();
      this.proc = null;
    }
  }
}

// --------------------------------------------------------------------- server

function startServer(opts) {
  const root = path.resolve(opts.root);
  const python = opts.python || "python";
  const log = opts.log || console.log;
  const projectDir = opts.projectDir
    ? path.resolve(opts.projectDir) : path.join(root, "project");
  const projectJson = opts.projectJson
    ? path.resolve(opts.projectJson) : path.join(projectDir, "project.json");
  const takesDir = path.join(projectDir, "takes");
  // Where `python -m pipeline.*` is run from: the folder holding pipeline/.
  const pipelineRoot = path.resolve(opts.pipelineRoot || root);

  if (!fs.existsSync(projectJson)) {
    throw new Error(`no project at ${projectJson}`);
  }

  let project = JSON.parse(fs.readFileSync(projectJson, "utf8"));
  let saveTimer = null;
  let running = null;   // name of the pipeline step currently running, if any

  const loadProject = () => {
    project = JSON.parse(fs.readFileSync(projectJson, "utf8"));
    return project;
  };

  function saveProjectSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const tmp = projectJson + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(project, null, 1), "utf8");
      fs.renameSync(tmp, projectJson);
    }, 400);
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const tmp = projectJson + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(project, null, 1), "utf8");
    fs.renameSync(tmp, projectJson);
  }

  const lineByN = (n) => project.lines.find((l) => l.n === n);
  const nextTakeName = (line) =>
    `${String(line.n).padStart(4, "0")}_t${String(line.takes.length + 1).padStart(2, "0")}.wav`;

  function runPython(args, timeoutMs = 20 * 60 * 1000) {
    return new Promise((resolve, reject) => {
      const proc = spawn(python, ["-u"].concat(args), {
        cwd: pipelineRoot,
        env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }),
      });
      let out = "", err = "";
      proc.stdout.on("data", (d) => { out += d; });
      proc.stderr.on("data", (d) => { err += d; });
      const timer = setTimeout(() => { proc.kill(); reject(new Error("timed out")); }, timeoutMs);
      proc.on("error", (e) => { clearTimeout(timer); reject(e); });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim());
        else reject(new Error((err || out).trim().split(/\r?\n/).slice(-3).join(" ")));
      });
    });
  }

  const checker = new Checker(pipelineRoot, projectJson, python, opts.noAsr, log);
  checker.start();

  // ---- http helpers

  function sendJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  function serveFile(req, res, filePath) {
    let stat;
    try { stat = fs.statSync(filePath); } catch (e) { res.writeHead(404).end("not found"); return; }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (start >= stat.size || end >= stat.size || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end();
          return;
        }
        res.writeHead(206, {
          "Content-Type": type,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": type.startsWith("video") ? "public, max-age=3600" : "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  }

  function readBody(req, limitBytes = 256 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > limitBytes) { reject(new Error("body too large")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  function underRoot(base, rel) {
    const p = path.resolve(base, "." + path.sep + rel.replace(/^[/\\]+/, ""));
    return p.startsWith(path.resolve(base)) ? p : null;
  }

  // ---- routes

  async function handleTake(req, res, url) {
    const n = parseInt(url.searchParams.get("n"), 10);
    const sr = parseInt(url.searchParams.get("sr") || "48000", 10);
    const cueRaw = parseFloat(url.searchParams.get("cue"));
    const cue = isFinite(cueRaw) ? cueRaw : null;
    const line = lineByN(n);
    if (!line) return sendJson(res, 404, { ok: false, error: `no line ${n}` });

    const raw = await readBody(req);
    const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
    if (!samples.length) return sendJson(res, 400, { ok: false, error: "empty take" });

    fs.mkdirSync(takesDir, { recursive: true });
    const name = nextTakeName(line);
    writeWav24(path.join(takesDir, name), samples, sr);

    const rel = `takes/${name}`;
    const take = {
      file: rel,
      origin: "booth",
      dur: +(samples.length / sr).toFixed(3),
      cue,
      recorded: new Date().toISOString(),
    };
    line.takes.push(take);
    line.selected = rel;
    if (line.status === "todo") line.status = "recorded";
    saveProjectSoon();

    let check = null;
    try {
      check = await checker.send({ cmd: "check", n, file: rel, cue });
      if (check && check.ok) {
        take.check = {
          verdict: check.verdict, speech: check.speech, headroom: check.headroom,
          message: check.message, start_offset: check.start_offset,
          warnings: check.warnings,
        };
        saveProjectSoon();
      }
    } catch (e) {
      check = { ok: false, error: String(e.message || e) };
    }
    sendJson(res, 200, { ok: true, take, check });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = decodeURIComponent(url.pathname);

    if (req.method === "POST" && p === "/api/take") return handleTake(req, res, url);

    if (req.method === "POST" && p === "/api/line") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const line = lineByN(body.n);
      if (!line) return sendJson(res, 404, { ok: false, error: "no such line" });
      for (const k of ["status", "flag", "selected"]) if (k in body) line[k] = body[k];
      saveProjectSoon();
      return sendJson(res, 200, { ok: true, line });
    }

    if (req.method === "POST" && p === "/api/recheck") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      try {
        await checker.send({ cmd: "reload" });
        const check = await checker.send({
          cmd: "check", n: body.n, file: body.file, cue: body.cue });
        return sendJson(res, 200, { ok: true, check });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e.message || e) });
      }
    }

    // Run one pipeline step. `fit` assembles the timeline; `recheck` replays
    // every stored verdict through the current checker.
    if (req.method === "POST" && (p === "/api/fit" || p === "/api/recheck-all")) {
      const step = p === "/api/fit" ? "fit" : "recheck";
      if (running) return sendJson(res, 409, { ok: false, error: `${running} already running` });
      running = step;
      try {
        flush();
        const out = await runPython(
          ["-m", `pipeline.${step}`, "--project", projectJson]);
        await checker.send({ cmd: "reload" }).catch(() => {});
        loadProject();
        return sendJson(res, 200, { ok: true, log: out });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e.message || e) });
      } finally {
        running = null;
      }
    }

    // Hand edits for one line: save the override, re-fit only that line, and
    // hand back its render so the page can audition it immediately.
    // One clip, re-rendered inside the already-running checker. Spawning
    // python and rebuilding the two-hour master took 16s for a two-second
    // clip; this is the difference between editing and waiting.
    if (req.method === "POST" && p === "/api/line-edit") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const line = lineByN(body.n);
      if (!line) return sendJson(res, 404, { ok: false, error: "no such line" });
      try {
        flush();
        const msg = { cmd: "fit", n: body.n };
        if ("edit" in body) msg.edit = body.edit;
        if (body.replace) msg.replace = true;
        if (body.selected) msg.selected = body.selected;
        const r = await checker.send(msg);
        if (!r.ok) throw new Error(r.error || "fit failed");
        // The checker computes; this process owns the file. Apply what came
        // back rather than re-reading, so nothing else in flight is lost.
        line.fit = r.fit || null;
        if (r.selected !== undefined) line.selected = r.selected;
        if (r.status) line.status = r.status;
        if (r.edit === undefined || r.edit === null) delete line.edit;
        else line.edit = r.edit;
        flush();
        return sendJson(res, 200, { ok: true, line, fit: line.fit });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e.message || e) });
      }
    }

    if (req.method === "POST" && p === "/api/export") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (running) return sendJson(res, 409, { ok: false, error: `${running} already running` });
      running = "export";
      try {
        flush();
        // Editing is live per clip; the flat timeline only exists for export,
        // so build it here rather than asking the user to remember to.
        await runPython(["-m", "pipeline.fit", "--project", projectJson]);
        loadProject();
        const args = ["-m", "pipeline.export", "--project", projectJson,
                      "--what", body.what || "dub", "--out", body.out];
        if (body.range) args.push("--range", String(body.range));
        if (body.duck != null) args.push("--duck", String(body.duck));
        if (body.lufs != null) args.push("--lufs", String(body.lufs));
        const out = await runPython(args);
        return sendJson(res, 200, { ok: true, log: out });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e.message || e) });
      } finally {
        running = null;
      }
    }

    // Bring a script and/or a video into the project and build the line list.
    if (req.method === "POST" && p === "/api/ingest") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (running) return sendJson(res, 409, { ok: false, error: `${running} already running` });
      running = "ingest";
      try {
        const args = ["-m", "pipeline.ingest", "--project", projectJson];
        if (body.script) args.push("--xlsx", body.script);
        if (body.video) args.push("--video", body.video);
        if (body.mediaOnly) args.push("--media-only");
        else args.push("--force");
        const out = await runPython(args);
        // the editor draws the original underneath the clips, so it needs peaks
        await runPython(["-m", "pipeline.peaks", "--project", projectJson, "--force"])
          .catch((e) => log("peaks failed: " + e.message));
        loadProject();
        // A rebuild renumbers the cues, so any recording carried across needs
        // its clip rendered again under the new numbering.
        if (project.lines.some((l) => l.selected)) {
          await runPython(["-m", "pipeline.fit", "--project", projectJson])
            .catch((e) => log("fit after import failed: " + e.message));
          loadProject();
        }
        await checker.send({ cmd: "reload" }).catch(() => {});
        const nar = project.lines.filter((l) => l.kind === "narration").length;
        return sendJson(res, 200, { ok: true, log: out, lines: project.lines.length, narration: nar });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e.message || e) });
      } finally {
        running = null;
      }
    }

    // Moving a clip changes only where it sits, so it is answered from memory.
    // Re-rendering audio for a drag would make the timeline unusable.
    if (req.method === "POST" && p === "/api/line-move") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const line = lineByN(body.n);
      if (!line || !line.fit) return sendJson(res, 404, { ok: false, error: "no fitted line" });
      const at = Math.max(0, Number(body.placed_at));
      if (!isFinite(at)) return sendJson(res, 400, { ok: false, error: "bad position" });
      const delta = at - (line.fit.placed_at || line.start);
      // Absolute, not an offset from the cue: a clip must come back to where
      // it was put, whatever the pre-roll inside it happens to be.
      line.edit = Object.assign({}, line.edit, { place_at: +at.toFixed(3) });
      line.fit.placed_at = +at.toFixed(3);

      // Overrun is measured against the speech, not the whole clip - a clip
      // carries its pre-roll and tail on purpose, and measuring those would
      // flag every line. Shift the speech with the clip rather than
      // recomputing it, which would need the audio.
      const limit = line.end + line.slack_after;
      if (typeof line.fit.speech_starts_at === "number") {
        line.fit.speech_starts_at = +(line.fit.speech_starts_at + delta).toFixed(3);
        const speechEnd = line.fit.speech_starts_at + (line.fit.speech || 0);
        line.fit.overrun = +Math.max(0, speechEnd - limit).toFixed(3);
      } else {
        line.fit.overrun = +Math.max(0, at + (line.fit.fitted || 0) - limit).toFixed(3);
      }
      if (line.fit.verdict === "REC" || line.fit.verdict === "OVERRUN") {
        line.fit.verdict = line.fit.overrun > 0.25 ? "OVERRUN" : "REC";
      }
      saveProjectSoon();
      return sendJson(res, 200, { ok: true, fit: line.fit });
    }

    // Take the clip off the timeline. The recordings themselves are kept -
    // this un-chooses a take, it does not throw the audio away.
    if (req.method === "POST" && p === "/api/line-clear") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const line = lineByN(body.n);
      if (!line) return sendJson(res, 404, { ok: false, error: "no such line" });
      const render = line.fit && line.fit.render;
      line.selected = null;
      line.fit = null;
      delete line.edit;
      if (line.status === "recorded") line.status = "todo";
      flush();
      if (render) {
        try { fs.unlinkSync(path.join(projectDir, render)); } catch (e) { /* gone */ }
      }
      return sendJson(res, 200, { ok: true, line });
    }

    if (req.method === "GET" && p === "/api/project") {
      loadProject();
      return sendJson(res, 200, project);
    }

    if (req.method === "GET" && p === "/api/state") {
      return sendJson(res, 200, {
        ready: checker.ready,
        asr: checker.asr,
        error: checker.error,
        running,
        root,
        projectDir,
        projectJson,
        title: project.title,
        settings: project.settings,
        media: project.media,
        counts: project.lines.reduce((a, l) => {
          if (l.kind === "narration") a[l.status] = (a[l.status] || 0) + 1;
          return a;
        }, {}),
      });
    }

    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(302, { Location: "/app.html" }).end();
      return;
    }

    // Media kept outside the project (a master on another drive) still has to
    // reach the player, so it is streamed by absolute path rather than copied.
    if (req.method === "GET" && (p === "/source" || p === "/source.mp4")) {
      const abs = (project.media || {}).source;
      if (!abs || !fs.existsSync(abs)) {
        return void res.writeHead(404).end("source video not found");
      }
      return serveFile(req, res, abs);
    }

    for (const [prefix, base] of [["/media/", path.join(projectDir, "media")],
                                  ["/takes/", takesDir],
                                  ["/out/", path.join(projectDir, "out")],
                                  ["/fitted/", path.join(projectDir, "fitted")]]) {
      if (p.startsWith(prefix)) {
        const f = underRoot(base, p.slice(prefix.length));
        if (!f) return void res.writeHead(403).end("forbidden");
        return serveFile(req, res, f);
      }
    }

    const f = underRoot(PUBLIC_DIR, p);
    if (!f) return void res.writeHead(403).end("forbidden");
    return serveFile(req, res, f);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(e);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(e.message || e) });
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port || 0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        root,
        projectDir,
        projectJson,
        checker,
        url: (page) => `http://127.0.0.1:${port}/${page || "stage.html"}`,
        stop: () => new Promise((done) => {
          try { flush(); } catch (e) { /* nothing to flush */ }
          checker.stop();
          server.close(() => done());
          setTimeout(done, 1500);
        }),
      });
    });
  });
}

module.exports = { startServer };

// -------------------------------------------------------------- headless mode

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
  };
  startServer({
    root: arg("--root", process.cwd()),
    pipelineRoot: __dirname,   // pipeline/ ships beside this file
    port: parseInt(arg("--port", "7800"), 10),
    python: arg("--python", "python"),
    noAsr: argv.includes("--no-asr"),
  }).then((s) => {
    console.log(`booth  →  ${s.url("app.html")}`);
    console.log(`project: ${s.projectJson}`);
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => s.stop().then(() => process.exit(0)));
    }
  }).catch((e) => {
    console.error(String(e.message || e));
    process.exit(1);
  });
}
