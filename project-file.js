/**
 * The .booth project file.
 *
 * Follows the shape editing suites settled on long ago (Premiere, Resolve,
 * Ableton, REAPER): the project file is small, holds only edit state and
 * *references* to media, and never embeds the media itself. Two things that
 * matter in practice and are easy to get wrong:
 *
 *   - every reference stores a path relative to the project file *and* the
 *     absolute path it was last seen at. Relative wins, so moving or copying
 *     the whole folder just works; absolute is the fallback for media parked
 *     on another drive.
 *   - each reference carries size and duration, so a missing file can be
 *     re-linked with confidence rather than hope.
 *
 * Regenerable things - caches, renders, proxies - are named here but never
 * treated as precious.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FORMAT = "booth-project";
const FORMAT_VERSION = 1;
const EXT = ".booth";

// Directories a project owns, relative to the project file.
const LAYOUT = {
  data: "project/project.json",
  media: "project/media",
  takes: "project/takes",
  output: "project/out",
  cache: "project/cache",
};

const MEDIA_SLOTS = ["video", "audio", "script"];

function nowIso() { return new Date().toISOString(); }

/** Path stored two ways so the project survives being moved or copied. */
function makeRef(absPath, projectDir, extra) {
  if (!absPath) return null;
  const abs = path.resolve(absPath);
  const ref = {
    relative: path.relative(projectDir, abs).split(path.sep).join("/"),
    absolute: abs,
  };
  try {
    const st = fs.statSync(abs);
    ref.bytes = st.size;
    ref.modified = new Date(st.mtimeMs).toISOString();
  } catch (e) { /* recorded even when currently missing */ }
  return Object.assign(ref, extra || {});
}

/** Relative first: a moved folder still resolves, a moved drive still can. */
function resolveRef(ref, projectDir) {
  if (!ref) return null;
  const candidates = [];
  if (ref.relative) candidates.push(path.resolve(projectDir, ref.relative));
  if (ref.absolute) candidates.push(ref.absolute);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0] || null;
}

function blank(name) {
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    id: crypto.randomUUID(),
    name: name || "Untitled dub",
    created: nowIso(),
    modified: nowIso(),
    app: { name: "Booth", version: require("./package.json").version },
    layout: Object.assign({}, LAYOUT),
    media: { video: null, audio: null, script: null },
    tools: { python: "python", whisperDir: process.env.WHISPER_DIR || null },
    session: { view: "stage", line: null, window: null },
    recentImports: [],
  };
}

function ext() { return EXT; }

function isProjectFile(file) {
  return !!file && path.extname(file).toLowerCase() === EXT;
}

/** The .booth file inside a folder, if there is exactly one to pick. */
function findIn(dir) {
  try {
    const hits = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(EXT));
    if (!hits.length) return null;
    hits.sort();
    return path.join(dir, hits[0]);
  } catch (e) {
    return null;
  }
}

function read(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.format !== FORMAT) {
    throw new Error(`${path.basename(file)} is not a Booth project file`);
  }
  if (data.formatVersion > FORMAT_VERSION) {
    throw new Error(
      `${path.basename(file)} was written by a newer Booth `
      + `(format ${data.formatVersion}, this build reads ${FORMAT_VERSION})`);
  }
  data.layout = Object.assign({}, LAYOUT, data.layout || {});
  data.media = Object.assign({ video: null, audio: null, script: null }, data.media || {});
  data.tools = Object.assign({ python: "python" }, data.tools || {});
  data.session = Object.assign({ view: "stage" }, data.session || {});
  return data;
}

function write(file, data) {
  data.modified = nowIso();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return file;
}

/** Create the folders a project needs. Safe to call on an existing one. */
function scaffold(dir) {
  for (const key of ["media", "takes", "output", "cache"]) {
    fs.mkdirSync(path.join(dir, LAYOUT[key].split("/").join(path.sep)), { recursive: true });
  }
  return dir;
}

/**
 * Point a project file at the media already sitting in a folder, and fill in
 * anything a hand-made layout implies. Used both for `New project` and to
 * migrate a folder that predates the project file.
 */
function adopt(data, projectDir) {
  scaffold(projectDir);
  const mediaDir = path.join(projectDir, "project", "media");
  const guesses = {
    video: ["source.mp4", "proxy.mp4"].map((f) => path.join(mediaDir, f)),
    audio: [path.join(mediaDir, "original.wav")],
  };
  for (const [slot, paths] of Object.entries(guesses)) {
    if (data.media[slot] && resolveRef(data.media[slot], projectDir)
        && fs.existsSync(resolveRef(data.media[slot], projectDir))) continue;
    const hit = paths.find((p) => fs.existsSync(p));
    if (hit) data.media[slot] = makeRef(hit, projectDir);
  }
  if (!data.media.script) {
    const xlsx = findScript(projectDir);
    if (xlsx) data.media.script = makeRef(xlsx, projectDir);
  }
  return data;
}

/** The newest .xlsx anywhere shallow in the project - the translation script. */
function findScript(dir, depth = 2) {
  let best = null;
  const walk = (d, left) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (left > 0 && !["node_modules", "project", ".git"].includes(e.name)) {
          walk(full, left - 1);
        }
      } else if (e.name.toLowerCase().endsWith(".xlsx") && !e.name.startsWith("~$")) {
        const st = fs.statSync(full);
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(dir, depth);
  return best && best.path;
}

/**
 * Check every reference the project depends on.
 * -> { ok, missing: [{slot, ref, expected}], data: {...} }
 */
function validate(data, file) {
  const dir = path.dirname(file);
  const missing = [];
  const dataFile = path.resolve(dir, data.layout.data);
  if (!fs.existsSync(dataFile)) {
    missing.push({ slot: "data", expected: dataFile, required: true });
  }
  for (const slot of MEDIA_SLOTS) {
    const ref = data.media[slot];
    if (!ref) continue;
    const p = resolveRef(ref, dir);
    if (!p || !fs.existsSync(p)) {
      missing.push({ slot, ref, expected: p, required: slot === "video" });
    }
  }
  return { ok: missing.length === 0, missing, dir, dataFile };
}

/** Re-point one media slot at a file the user located. */
function relink(data, projectDir, slot, newPath) {
  data.media[slot] = makeRef(newPath, projectDir);
  return data;
}

function noteImport(data, kind, filePath) {
  data.recentImports = (data.recentImports || []).filter((r) => r.path !== filePath);
  data.recentImports.unshift({ kind, path: filePath, at: nowIso() });
  data.recentImports = data.recentImports.slice(0, 20);
  return data;
}

module.exports = {
  EXT, FORMAT, FORMAT_VERSION, LAYOUT, MEDIA_SLOTS,
  ext, blank, read, write, scaffold, adopt, validate, relink,
  makeRef, resolveRef, isProjectFile, findIn, findScript, noteImport,
};
