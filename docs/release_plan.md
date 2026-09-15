# Release plan: auto-updates for Booth

Goal: publishing a new version makes every installed copy of Booth download it
in the background and offer to install it with a popup.

Status: **not implemented.** This document is the plan.

## Approach

Use [`electron-updater`](https://www.electron.build/auto-update) with GitHub
Releases as the update source, the same way rescript-ar did before its fork
(last upstream release `8a91ec3`; the fork commit `f9602d4` disabled it).

- There is no update server. electron-builder uploads the installer, its
  `.blockmap`, and a `latest.yml` file describing the newest version to a GitHub
  release.
- The installed app reads `latest.yml` from the latest **published** release on
  `aorabdel/booth`, compares versions, and downloads the new installer.
- `aorabdel/booth` is public, so the app needs no token to read releases.
- The repo already builds an `app-update.yml` pointing at `github / aorabdel /
  booth`. Only the updater code and publish configuration are missing.

## Changes

### 1. Dependency

```bash
npm install electron-updater
```

It must be a runtime `dependency`, not a `devDependency`, so electron-builder
bundles it. After building, check that `app.asar` contains
`node_modules/electron-updater`.

### 2. `package.json`

Add a publish target under `build`:

```json
"publish": [
  { "provider": "github", "owner": "aorabdel", "repo": "booth" }
]
```

Add scripts:

```json
"release": "electron-builder --win --publish always",
"cut:patch": "npm version patch -m \"Release v%s\" && git push --follow-tags",
"cut:minor": "npm version minor -m \"Release v%s\" && git push --follow-tags",
"cut:major": "npm version major -m \"Release v%s\" && git push --follow-tags"
```

### 3. `main.js`

Call `initAutoUpdater()` from `app.whenReady()`:

```js
const { autoUpdater } = require("electron-updater");

function initAutoUpdater() {
  // Dev runs and the portable .exe can't update themselves.
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;   // "Later" still installs on the next quit
  autoUpdater.on("error", (e) => log("updater:", e.message));

  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox(win, {
      type: "info", icon: icon(), title: "Booth",
      message: `Booth ${info.version} is ready to install`,
      detail: "Restart now to update. Your takes are already saved.",
      buttons: ["Restart and update", "Later"], defaultId: 0, cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
}
```

Notes:

- `quitAndInstall()` goes through the existing `before-quit` handler, so
  `saveSession()` and `service.stop()` still run.
- **Don't interrupt a take.** Recording state lives in the page, not the main
  process. Expose it through `preload.js` (e.g. the page reports when a take
  starts and stops), and hold the popup until no take is rolling.

### 4. `.github/workflows/release.yml`

Runs on version tags and publishes the release once every file is uploaded:

```yaml
name: Release

on:
  push:
    tags: ["v*.*.*"]

permissions:
  contents: write

jobs:
  release:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: Publish the draft release
        run: gh release edit ${{ github.ref_name }} --repo aorabdel/booth --draft=false --latest
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

No secrets are needed beyond the built-in `GITHUB_TOKEN`.

## Releasing a version

1. Commit everything so the working tree is clean.
2. Run `npm run cut:patch` (or `cut:minor` / `cut:major`). It bumps
   `package.json`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, and pushes.
3. GitHub Actions builds and uploads `Booth-Setup-X.Y.Z.exe`, its `.blockmap`,
   and `latest.yml` to a draft release, then publishes it.
4. Installed copies see it at next launch or within an hour, download it in the
   background, and show the popup.

## Caveats

- **Existing installs get no popup.** The version users have now contains no
  updater, so each user must install the first updater-enabled release by hand.
  Every release after that updates automatically.
- **The portable `.exe` never auto-updates.** electron-updater doesn't support
  it, which is why the code skips it. Only NSIS installer users get updates.
- **Versions must increase, and the tag must match `package.json`.** Keep
  `appId` as `com.booth.dub`, or updates won't match existing installs.
- **The build is unsigned.** Windows SmartScreen may warn on the first manual
  install. Signing later needs `CSC_LINK` / `CSC_KEY_PASSWORD` in the workflow.
- **Releases stay drafts until fully uploaded.** electron-builder uploads to a
  draft by default; the workflow's last step publishes it, so users never see a
  half-uploaded release.

## Testing before going public

1. Build and install version X with the installer.
2. Cut version X+1 and let the workflow publish it.
3. Launch the installed X and confirm the update downloads and the popup
   appears. Check `<userData>/booth.log` for `updater:` lines if it doesn't.
4. Choose **Restart and update** and confirm the app reopens as X+1 with the
   project intact.
