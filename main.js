/**
 * Booth - desktop app for recording and reviewing a dub.
 *
 * Dark only, one window, three views (Stage / Control / Review).
 *
 * A project is a `.booth` file plus the folder around it. The file holds
 * references and session state; the folder holds the data. The Python
 * pipeline is code that ships with the app, so a project can live anywhere.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const {
  app, BrowserWindow, Menu, dialog, nativeTheme, nativeImage, shell, ipcMain,
} = require("electron");

const { startServer } = require("./server");
const pf = require("./project-file");

const ICON_ICO = path.join(__dirname, "build", "icon.ico");
const ICON_PNG = path.join(__dirname, "build", "icon.png");
const BG = "#0b0c0e";
const PAGE = "app.html";   // one view; the tabs are gone

app.setName("Booth");
if (process.platform === "win32") app.setAppUserModelId("com.booth.dub");

let win = null;
let service = null;
let settings = { recent: [], python: "python" };
let projectFile = null;    // absolute path to the open .booth
let project = null;        // its parsed contents

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
const logFile = () => path.join(app.getPath("userData"), "booth.log");
const projectDir = () => (projectFile ? path.dirname(projectFile) : null);

/** A double-clicked app has nowhere to print, so keep a rolling log. */
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  console.log(line);
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.appendFileSync(logFile(), line + require("os").EOL, "utf8");
  } catch (e) { /* logging must never break start-up */ }
}

function icon() {
  const p = fs.existsSync(ICON_ICO) ? ICON_ICO : ICON_PNG;
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : undefined;
}

/** The pipeline is code that ships with the app; the project is data. */
function pipelineRoot() {
  const packaged = path.join(process.resourcesPath || "", "pipeline");
  if (fs.existsSync(packaged)) return path.dirname(packaged);
  return __dirname;   // running from the repo checkout, pipeline/ sits beside main.js
}

// ------------------------------------------------------------------ settings

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), "utf8")));
  } catch (e) { /* first run */ }
  settings.recent = (settings.recent || []).filter((r) => r && fs.existsSync(r.file));
}

function saveSettings() {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 1), "utf8");
  } catch (e) { log("could not save settings:", e.message); }
}

function rememberRecent(file) {
  settings.recent = (settings.recent || []).filter((r) => r.file !== file);
  settings.recent.unshift({
    file,
    name: (project && project.name) || path.basename(file, pf.EXT),
    at: new Date().toISOString(),
  });
  settings.recent = settings.recent.slice(0, 10);
  saveSettings();
}

// -------------------------------------------------------- finding a project

/** A folder laid out the old way, before project files existed. */
function isLegacyRoot(dir) {
  return !!dir && fs.existsSync(path.join(dir, "project", "project.json"));
}

/** Walk up from a few likely places looking for a .booth, then a legacy folder. */
function findProjectNear() {
  const seeds = [];
  if (process.env.BOOTH_PROJECT) seeds.push(process.env.BOOTH_PROJECT);
  if (process.env.BOOTH_ROOT) seeds.push(process.env.BOOTH_ROOT);
  // A portable build unpacks into %TEMP% and runs from there, so the executable
  // path is useless; electron-builder passes the real launch folder here.
  if (process.env.PORTABLE_EXECUTABLE_DIR) seeds.push(process.env.PORTABLE_EXECUTABLE_DIR);
  seeds.push(process.cwd());
  try { seeds.push(path.dirname(app.getPath("exe"))); } catch (e) { /* not ready */ }
  seeds.push(path.resolve(__dirname, ".."));

  for (const seed of seeds) {
    if (!seed) continue;
    if (pf.isProjectFile(seed) && fs.existsSync(seed)) return seed;
    let dir = seed;
    for (let up = 0; up < 5 && dir; up++) {
      const hit = pf.findIn(dir);
      if (hit) return hit;
      if (isLegacyRoot(dir)) return adoptLegacy(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** Give a pre-project-file folder a .booth so it opens like anything else. */
function adoptLegacy(dir) {
  const name = path.basename(dir);
  const file = path.join(dir, `${name}${pf.EXT}`);
  try {
    const data = pf.adopt(pf.blank(name), dir);
    // carry the title across from the pipeline's own data file
    try {
      const inner = JSON.parse(fs.readFileSync(path.join(dir, "project", "project.json"), "utf8"));
      if (inner.title) data.name = inner.title;
    } catch (e) { /* keep the folder name */ }
    pf.write(file, data);
    log("created project file for existing folder:", file);
    return file;
  } catch (e) {
    log("could not adopt legacy folder:", e.message);
    return null;
  }
}

function projectArg(argv) {
  return argv.slice(1).find((a) => pf.isProjectFile(a) && fs.existsSync(a)) || null;
}

// ---------------------------------------------------------------- the window

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1024, minHeight: 700,
    backgroundColor: BG,
    show: true,
    icon: icon(),
    title: "Booth",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // the mic must not be throttled
    },
  });

  win.on("closed", () => { win = null; });
  win.loadFile(path.join(__dirname, "public", "startup.html"));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!service || !url.startsWith(`http://127.0.0.1:${service.port}/`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  const session = win.webContents.session;
  session.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === "media" || permission === "audioCapture");
  });
  session.setPermissionCheckHandler((wc, permission) =>
    permission === "media" || permission === "audioCapture");
  return win;
}

/** Push a line to the start-up screen, so nothing is ever a silent spinner. */
function status(s) {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send("booth:status", s); } catch (e) { /* closing */ }
  }
  if (s.title) log("status:", s.title, s.detail ? `(${s.detail})` : "");
}

function show() {
  if (!win || !service) return;
  win.setTitle(`${(project && project.name) || "Booth"} — Booth`);
  win.loadURL(service.url(PAGE));
  buildMenu();
}

/** Back to the welcome screen, with nothing running behind it. */
async function closeProject() {
  if (service) { await service.stop(); service = null; }
  saveSession();
  projectFile = null;
  project = null;
  if (win && !win.isDestroyed()) {
    win.setTitle("Booth");
    await win.loadFile(path.join(__dirname, "public", "startup.html"));
  }
  buildMenu();
  status({
    title: "No project open",
    message: "Create a project, or open one you already have.",
    actions: [{ id: "new", label: "New project…", primary: true },
              { id: "open", label: "Open project…" }],
  });
}

// ------------------------------------------------------------------ the menu

function buildMenu() {
  const recent = (settings.recent || []).map((r) => ({
    label: `${r.name}   ${path.dirname(r.file)}`,
    click: () => openProject(r.file),
  }));

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "Project",
      submenu: [
        { label: "New project…", accelerator: "CmdOrCtrl+N", click: () => newProject() },
        { label: "Open project…", accelerator: "CmdOrCtrl+O", click: () => openProjectDialog() },
        {
          label: "Open recent",
          submenu: recent.length ? recent : [{ label: "(nothing yet)", enabled: false }],
        },
        { type: "separator" },
        {
          label: "Import translation script…",
          enabled: !!projectFile, click: () => importMedia("script"),
        },
        { label: "Import video…", enabled: !!projectFile, click: () => importMedia("video") },
        { label: "Relink missing media…", enabled: !!projectFile, click: () => relinkAll() },
        { type: "separator" },
        {
          label: "Close project", accelerator: "CmdOrCtrl+W",
          enabled: !!projectFile, click: () => closeProject(),
        },
        {
          label: "Reveal project on disk", enabled: !!projectFile,
          click: () => projectFile && shell.showItemInFolder(projectFile),
        },
        { label: "Open log", click: () => shell.openPath(logFile()) },
        { type: "separator" },
        { role: "quit", label: "Exit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "togglefullscreen" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" }, { role: "toggleDevTools" },
      ],
    },
    {
      label: "Tools",
      submenu: [
        {
          label: "Re-assemble the dub", accelerator: "CmdOrCtrl+R", enabled: !!service,
          click: () => runStep("fit", "Re-assembling the dub timeline…"),
        },
        {
          label: "Re-check every take", enabled: !!service,
          click: () => runStep("recheck-all", "Re-checking every take…"),
        },
        { type: "separator" },
        {
          label: "Export narration stem (WAV)…", enabled: !!service,
          click: () => exportAs("dub"),
        },
        { label: "Export mix (WAV)…", enabled: !!service, click: () => exportAs("mix") },
        {
          label: "Export dubbed video (MP4)…", enabled: !!service,
          click: () => exportAs("video"),
        },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Runbook",
          click: () => {
            const p = path.join(pipelineRoot(), "RUNBOOK.md");
            if (fs.existsSync(p)) shell.openPath(p);
          },
        },
        {
          label: "About Booth",
          click: () => dialog.showMessageBox(win, {
            type: "info", icon: icon(), title: "Booth", message: "Booth",
            detail: `Recording and review for a dub.\n\n`
                  + `Project: ${projectFile || "none"}\n`
                  + `Format:  ${pf.FORMAT} v${pf.FORMAT_VERSION}\n`
                  + `Service: 127.0.0.1:${service ? service.port : "-"}\n`
                  + `Electron ${process.versions.electron} · Node ${process.versions.node}`,
            buttons: ["OK"],
          }),
        },
      ],
    },
  ]));
}

async function runStep(step, message) {
  if (!service || !win) return;
  win.webContents.send("booth:busy", message);
  try {
    const r = await fetch(`http://127.0.0.1:${service.port}/api/${step}`, { method: "POST" });
    const j = await r.json();
    win.webContents.send("booth:busy", null);
    if (!j.ok) throw new Error(j.error);
    await dialog.showMessageBox(win, {
      type: "info", icon: icon(), title: "Booth",
      message: message.replace(/…$/, " — done"), detail: j.log || "", buttons: ["OK"],
    });
    win.reload();
  } catch (e) {
    win.webContents.send("booth:busy", null);
    dialog.showErrorBox("Booth", String(e.message || e));
  }
}

const EXPORT_LABEL = { dub: "narration stem", mix: "mix", video: "dubbed video" };

async function exportAs(what, range = "full") {
  if (!service || !project) return;
  const ext = what === "video" ? "mp4" : "wav";
  const blurb = {
    dub: "The narration alone on the film's timeline.",
    mix: "Narration over the original, ducked underneath.",
    video: "The mix muxed back to picture.",
  }[what] || "";
  const base = (project.name || "dub").replace(/[\/:*?"<>|]/g, "-");
  const suffix = ({ dub: "-vo", mix: "-mix", video: "-dubbed" }[what] || "")
    + (range === "recorded" ? "-recorded" : "");
  const r = await dialog.showSaveDialog(win, {
    title: `Export ${EXPORT_LABEL[what]}`,
    message: blurb,
    buttonLabel: "Export",
    defaultPath: path.join(projectDir(), "project", "out", `${base}${suffix}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return;

  win.webContents.send("booth:busy", `Exporting the ${EXPORT_LABEL[what]}…`);
  try {
    const resp = await fetch(`http://127.0.0.1:${service.port}/api/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ what, range, out: r.filePath }),
    });
    const j = await resp.json();
    win.webContents.send("booth:busy", null);
    if (!j.ok) throw new Error(j.error);
    const pick = await dialog.showMessageBox(win, {
      type: "info", icon: icon(), title: "Booth",
      message: "Export finished", detail: `${r.filePath}

${j.log || ""}`,
      buttons: ["Show in folder", "OK"], defaultId: 1,
    });
    if (pick.response === 0) shell.showItemInFolder(r.filePath);
  } catch (e) {
    win.webContents.send("booth:busy", null);
    dialog.showErrorBox("Booth", `Export failed.

${e.message || e}`);
  }
}

// ------------------------------------------------------- open / new / import

async function openProjectDialog() {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: "Open a Booth project",
    buttonLabel: "Open",
    filters: [{ name: "Booth project", extensions: ["booth"] },
              { name: "All files", extensions: ["*"] }],
    properties: ["openFile"],
    defaultPath: projectDir() || app.getPath("documents"),
  });
  if (r.canceled || !r.filePaths.length) return false;
  return openProject(r.filePaths[0]);
}

async function openProject(file) {
  status({ step: "root", busy: true, title: "Opening project…", detail: file });
  let data;
  try {
    data = pf.read(file);
  } catch (e) {
    status({
      step: "root", error: true, title: "That is not a Booth project",
      message: String(e.message || e), detail: file,
      actions: [{ id: "open", label: "Open another…", primary: true },
                { id: "new", label: "New project…" }, { id: "quit", label: "Quit" }],
    });
    return false;
  }

  const check = pf.validate(data, file);
  if (!check.ok) {
    const required = check.missing.filter((m) => m.required);
    log("missing references:", check.missing.map((m) => m.slot).join(", "));
    if (required.length) {
      const names = required.map((m) => `${m.slot}: ${m.expected || "(unset)"}`).join("\n");
      status({
        step: "root", error: true, title: "Some files this project needs are missing",
        message: names, detail: file,
        hint: "Media is referenced, never copied into the project file — so a moved "
            + "or renamed file has to be pointed at again.",
        actions: [{ id: "relink", label: "Locate them…", primary: true },
                  { id: "continue", label: "Open anyway" },
                  { id: "open", label: "Open another…" }],
      });
      projectFile = file; project = data;
      return false;
    }
  }

  projectFile = file;
  project = data;
  rememberRecent(file);
  return startService();
}

async function newProject() {
  const r = await dialog.showSaveDialog(win || undefined, {
    title: "New Booth project",
    buttonLabel: "Create",
    defaultPath: path.join(app.getPath("documents"), `Untitled dub${pf.EXT}`),
    filters: [{ name: "Booth project", extensions: ["booth"] }],
  });
  if (r.canceled || !r.filePath) return false;

  let file = r.filePath;
  if (path.extname(file).toLowerCase() !== pf.EXT) file += pf.EXT;
  const dir = path.dirname(file);
  const name = path.basename(file, pf.EXT);

  try {
    pf.scaffold(dir);
    const data = pf.adopt(pf.blank(name), dir);
    // A project needs the pipeline's own data file; create an empty one so the
    // folder is valid immediately and ingest can fill it in.
    const dataFile = path.join(dir, data.layout.data.split("/").join(path.sep));
    if (!fs.existsSync(dataFile)) {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(dataFile, JSON.stringify({
        version: 1, title: name, media: {}, settings: {}, lines: [],
      }, null, 1), "utf8");
    }
    pf.write(file, data);
    log("created project:", file);
  } catch (e) {
    dialog.showErrorBox("Booth", `Could not create the project.\n\n${e.message || e}`);
    return false;
  }

  await openProject(file);
  const pick = await dialog.showMessageBox(win, {
    type: "info", icon: icon(), title: "Booth",
    message: "Project created",
    detail: `${file}\n\nImport the translation script to build the line list, `
          + `then the video to record against.`,
    buttons: ["Import script…", "Import video…", "Later"], defaultId: 0, cancelId: 2,
  });
  if (pick.response === 0) await importMedia("script");
  else if (pick.response === 1) await importMedia("video");
  return true;
}

const IMPORT_FILTERS = {
  script: [{ name: "Translation script", extensions: ["xlsx", "srt"] }],
  video: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "m4v", "webm"] }],
  audio: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "m4a"] }],
};

/**
 * Bring a file into the project folder. A hardlink is instant and costs no
 * disk, which matters for a 2 GB master; it only works within one volume, so
 * a copy is the fallback.
 */
const BIG_FILE = 512 * 1024 * 1024;   // ask before duplicating anything this size

async function bringIn(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (path.resolve(src) === path.resolve(dest)) return dest;

  // A hardlink is instant and costs no disk, but only works within one volume.
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    fs.linkSync(src, dest);
    log("linked into the project:", dest);
    return dest;
  } catch (e) { /* different volume, or the filesystem cannot */ }

  const size = fs.statSync(src).size;
  if (size >= BIG_FILE) {
    // Copying a master onto another drive is a real cost, and editing suites
    // reference rather than duplicate for exactly this reason. Ask.
    const pick = await dialog.showMessageBox(win, {
      type: "question", icon: icon(), title: "Booth",
      message: "This file is on a different drive from the project.",
      detail: `${src}\n${(size / 1e9).toFixed(1)} GB\n\n`
            + `Copying it into the project makes the project self-contained but `
            + `duplicates the file. Referencing it leaves it where it is — the `
            + `project records both a relative and an absolute path to it.\n\n`
            + `Either way Booth loads it now.`,
      buttons: ["Reference it where it is", "Copy into the project"],
      defaultId: 0, cancelId: 0,
    });
    if (pick.response === 0) return src;
  }
  win.webContents.send("booth:busy",
    `Copying ${(size / 1e6).toFixed(0)} MB into the project…`);
  fs.copyFileSync(src, dest);
  log("copied into the project:", dest);
  return dest;
}

/**
 * Import a script or a video: bring the file into the project folder, then
 * actually load it. An import that only records a path and tells you to run
 * something else is not an import.
 */
async function importMedia(slot) {
  if (!projectFile || !project) return false;
  const r = await dialog.showOpenDialog(win || undefined, {
    title: slot === "script" ? "Import the translation script" : "Import the video",
    buttonLabel: "Import",
    filters: (IMPORT_FILTERS[slot] || []).concat([{ name: "All files", extensions: ["*"] }]),
    properties: ["openFile"],
    defaultPath: projectDir(),
  });
  if (r.canceled || !r.filePaths.length) return false;
  const src = r.filePaths[0];

  win.webContents.send("booth:busy",
    slot === "video"
      ? "Importing the video and extracting its audio — a minute or two…"
      : "Importing the script and building the line list…");
  try {
    const dest = slot === "video"
      ? await bringIn(src, path.join(projectDir(), "project", "media",
                                     "source" + path.extname(src).toLowerCase()))
      : await bringIn(src, path.join(projectDir(), path.basename(src)));

    pf.relink(project, projectDir(), slot, dest);
    pf.noteImport(project, slot, dest);
    pf.write(projectFile, project);

    const script = pf.resolveRef(project.media.script, projectDir());
    const video = pf.resolveRef(project.media.video, projectDir());
    const haveScript = script && fs.existsSync(script);

    if (!haveScript) {
      win.webContents.send("booth:busy", null);
      await dialog.showMessageBox(win, {
        type: "info", icon: icon(), title: "Booth",
        message: "Video imported",
        detail: `${dest}\n\nImport the translation script next and Booth will build `
              + `the line list from it.`,
        buttons: ["Import script now", "Later"], defaultId: 0,
      }).then((pick) => (pick.response === 0 ? importMedia("script") : null));
      return true;
    }

    // Rebuilding the line list discards take assignments, so say so first.
    const recorded = countRecorded();
    if (slot === "script" && recorded > 0) {
      win.webContents.send("booth:busy", null);
      const pick = await dialog.showMessageBox(win, {
        type: "warning", icon: icon(), title: "Booth",
        message: `Rebuild the line list from this script?`,
        detail: `${recorded} line(s) already have takes. Rebuilding renumbers the `
              + `cues, so those takes would be detached from their lines.\n\n`
              + `The take files themselves are never deleted.`,
        buttons: ["Rebuild", "Cancel"], defaultId: 1, cancelId: 1,
      });
      if (pick.response !== 0) return false;
      win.webContents.send("booth:busy", "Rebuilding the line list…");
    }

    const body = { script, video: video && fs.existsSync(video) ? video : undefined };
    const resp = await fetch(`http://127.0.0.1:${service.port}/api/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await resp.json();
    win.webContents.send("booth:busy", null);
    if (!j.ok) throw new Error(j.error);

    log(`imported ${slot}: ${dest} -> ${j.narration} narration lines`);
    show();      // straight back into the project, now populated
    return true;
  } catch (e) {
    win.webContents.send("booth:busy", null);
    dialog.showErrorBox("Booth", `Could not import that ${slot}.\n\n${e.message || e}`);
    return false;
  }
}

function countRecorded() {
  try {
    const dataFile = path.resolve(projectDir(), project.layout.data);
    const inner = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    return (inner.lines || []).filter((l) => l.selected).length;
  } catch (e) {
    return 0;
  }
}

async function relinkAll() {
  if (!projectFile || !project) return false;
  const check = pf.validate(project, projectFile);
  if (check.ok) {
    dialog.showMessageBox(win, {
      type: "info", icon: icon(), title: "Booth",
      message: "Nothing to relink", detail: "Every file this project references was found.",
      buttons: ["OK"],
    });
    return true;
  }
  for (const m of check.missing) {
    if (m.slot === "data") continue;
    const r = await dialog.showOpenDialog(win || undefined, {
      title: `Locate the ${m.slot}`,
      message: `Missing: ${m.expected || "(unset)"}`,
      buttonLabel: "Use this file",
      filters: (IMPORT_FILTERS[m.slot] || []).concat([{ name: "All files", extensions: ["*"] }]),
      properties: ["openFile"],
      defaultPath: projectDir(),
    });
    if (r.canceled || !r.filePaths.length) continue;
    pf.relink(project, projectDir(), m.slot, r.filePaths[0]);
    log(`relinked ${m.slot}:`, r.filePaths[0]);
  }
  pf.write(projectFile, project);
  return startService();
}

// ------------------------------------------------------------------- service

async function startService() {
  if (service) { await service.stop(); service = null; }
  if (!projectFile || !project) {
    status({
      step: "root", error: true, title: "No project open",
      message: "Booth could not work out which project to open.",
      hint: "A project is a <code>.booth</code> file. Open one, or create a new project.",
      actions: [{ id: "open", label: "Open project…", primary: true },
                { id: "new", label: "New project…" },
                { id: "log", label: "Open log" }, { id: "quit", label: "Quit" }],
    });
    return false;
  }

  const dir = projectDir();
  const dataFile = path.resolve(dir, project.layout.data);
  status({ step: "service", done: ["root"], busy: true, title: "Starting the local service…",
           detail: projectFile });
  try {
    service = await startServer({
      root: dir,
      projectDir: path.dirname(dataFile),
      projectJson: dataFile,
      pipelineRoot: pipelineRoot(),
      python: (project.tools && project.tools.python) || settings.python || "python",
      log,
    });
    log("service on 127.0.0.1:" + service.port);
  } catch (e) {
    log("service failed:", (e && e.stack) || e);
    status({
      step: "service", done: ["root"], error: true, title: "Could not open the project",
      message: String((e && e.message) || e), detail: projectFile,
      actions: [{ id: "retry", label: "Try again", primary: true },
                { id: "open", label: "Open another…" }, { id: "log", label: "Open log" }],
    });
    return false;
  }

  // The checker loads a 1.6 GB speech model; wait here rather than dropping the
  // actor on the stage wondering why no verdicts come back.
  status({ step: "model", done: ["root", "service"], busy: true, title: "Loading the speech model…",
           message: "About 20 seconds, once per session.", detail: projectFile });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && !service.checker.ready) {
    if (service.checker.error) {
      log("checker error:", service.checker.error);
      status({
        step: "model", done: ["root", "service"], error: true,
        title: "The speech checker did not start",
        message: service.checker.error, detail: projectFile,
        hint: "Booth needs <code>python</code> and <code>ffmpeg</code> on PATH and a whisper "
            + "build (set <code>WHISPER_DIR</code>). Recording works without it — only the "
            + "per-take verdict is lost.",
        actions: [{ id: "continue", label: "Record without the checker", primary: true },
                  { id: "retry", label: "Try again" }, { id: "log", label: "Open log" }],
      });
      return false;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!service.checker.ready) log("checker not ready after 180s; continuing");
  show();
  return true;
}

/** Session state lives in the project file, so a reopen lands where you left. */
function saveSession() {
  if (!projectFile || !project) return;
  try {
    project.session = Object.assign({}, project.session, {
      window: win && !win.isDestroyed() ? win.getBounds() : project.session.window,
    });
    pf.write(projectFile, project);
  } catch (e) { log("could not save session:", e.message); }
}

// ------------------------------------------------------------------ start-up

if (!app.requestSingleInstanceLock()) app.quit();

app.on("second-instance", (_e, argv) => {
  const file = projectArg(argv);
  if (file) openProject(file);
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

process.on("uncaughtException", (e) => {
  log("fatal:", (e && e.stack) || e);
  try { dialog.showErrorBox("Booth", String((e && e.message) || e)); } catch (_) { /* no UI */ }
});

app.whenReady().then(async () => {
  nativeTheme.themeSource = "dark";      // dark only, never follow the OS
  loadSettings();
  createWindow();
  buildMenu();

  log("exe      =", app.getPath("exe"));
  log("pipeline =", pipelineRoot());

  // Only a project the user actually asked for is opened - double-clicking a
  // .booth, or naming one. Otherwise Booth waits at the welcome screen rather
  // than silently resuming whatever was open last.
  const explicit = projectArg(process.argv)
    || (pf.isProjectFile(process.env.BOOTH_PROJECT || "")
        && fs.existsSync(process.env.BOOTH_PROJECT) ? process.env.BOOTH_PROJECT : null);
  log("project  =", explicit || "(waiting for the user)");
  if (explicit) await openProject(explicit);
});

ipcMain.handle("booth:action", async (_e, id) => {
  if (id === "open") return openProjectDialog();
  if (id === "new") return newProject();
  if (id === "relink") return relinkAll();
  if (id === "retry") return startService();
  if (id === "continue") { show(); return true; }
  if (id === "log") { shell.openPath(logFile()); return true; }
  if (id === "close") return closeProject();
  if (id === "quit") { app.quit(); return true; }
  return false;
});

ipcMain.handle("booth:close", () => closeProject());
ipcMain.handle("booth:export", (_e, what, range) => exportAs(what, range));

ipcMain.handle("booth:root", () => projectDir());
ipcMain.handle("booth:project", () => ({ file: projectFile, project }));

app.on("before-quit", () => { saveSession(); if (service) service.stop(); });
app.on("window-all-closed", async () => {
  saveSession();
  if (service) { await service.stop(); service = null; }
  app.quit();
});
