"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/** Small surface: the three views talk to the loopback service over fetch as
 *  before. This only carries what a renderer cannot reach on its own - the
 *  startup screen's status feed and its buttons. */
contextBridge.exposeInMainWorld("booth", {
  isDesktop: true,
  root: () => ipcRenderer.invoke("booth:root"),
  action: (id) => ipcRenderer.invoke("booth:action", id),
  onBusy: (fn) => ipcRenderer.on("booth:busy", (_e, message) => fn(message)),
  onStatus: (fn) => ipcRenderer.on("booth:status", (_e, s) => fn(s)),
  closeProject: () => ipcRenderer.invoke("booth:close"),
  export: (what, range) => ipcRenderer.invoke("booth:export", what, range),
});
