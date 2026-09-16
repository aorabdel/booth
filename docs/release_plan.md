# Release plan: auto-updates for Booth

Goal: publishing a new version makes every installed copy of Booth download it
in the background and offer to install it with a popup.

Status: **implemented.** The first release is `v1.0.0`; see
[Releasing a version](#releasing-a-version).

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

`initAutoUpdater()` (the "updates" section of `main.js`) runs from
`app.whenReady()`:

- Skips dev runs and the portable `.exe`, which can't update themselves.
- Checks at startup and then hourly, and downloads new versions in the
  background (`autoDownload`). "Later" still installs on the next quit
  (`autoInstallOnAppQuit`).
- When a download finishes, shows **Restart and update / Later**, once per
  version so the hourly check doesn't nag.
- Updater events and errors go to `<userData>/booth.log` as `updater:` lines.
- `quitAndInstall()` goes through the existing `before-quit` handler, so
  `saveSession()` and `service.stop()` still run.

**A take is never interrupted.** Recording state lives in the page, so
`setRollUi()` in `public/app.js` reports it through
`window.booth.setRecording()` (`preload.js`, IPC `booth:recording`). The popup
waits until no take is rolling.

### 4. `.github/workflows/release.yml`

Runs on `v*.*.*` tags, on `windows-latest`, with `contents: write`:

1. Checks out the full history and tags, and sets up Node 24.
2. Fails if the tag doesn't match the `package.json` version.
3. `npm ci`.
4. Writes the **changelog from the conventional commit titles** since the
   previous `v*` tag (all commits for the first release), skipping
   `Initial commit` and `Release vX.Y.Z` bump commits, plus a compare link.
5. Creates a **draft** release named after the tag (**vX.Y.Z**) with that
   changelog.
6. `npm run release`, which builds and uploads into that draft.
7. Fails unless the draft has both `.exe` files, the `.blockmap` and
   `latest.yml`.
8. Publishes the draft and marks it latest.

The draft is created before the build on purpose. electron-builder 26.15.3
can start one uploader per Windows target at the same moment. When no release
exists yet, each uploader creates its own draft, which splits the files across
two releases (this happened on the first v1.0.0 run). Every uploader reuses an
existing draft with the same tag, so creating the draft first avoids this.

No secrets are needed beyond the built-in `GITHUB_TOKEN`. Because the changelog
is built from commit titles, keep every commit title in conventional form
(`feat: …`, `fix: …`, `chore: …`).

## Releasing a version

**First release (`v1.0.0`).** `package.json` is already `1.0.0`, so tag
without bumping:

```bash
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

**Every release after that:**

1. Commit everything so the working tree is clean.
2. Run `npm run cut:patch` (or `cut:minor` / `cut:major`). It bumps
   `package.json`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, and pushes.
3. GitHub Actions builds and uploads `Booth-Setup-X.Y.Z.exe`, its `.blockmap`,
   and `latest.yml` to a draft release, then publishes it.
4. Installed copies see it at next launch or within an hour, download it in the
   background, and show the popup.

## Hosting limits and cost on free GitHub

Checked against GitHub's docs on 2026-09-15
([releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases),
[Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
Releasing many ~100 MB versions across several projects is sustainable **as
long as the repos are public**.

| Limit | What it means here |
| --- | --- |
| Each release file must be under **2 GiB** | A ~100 MB installer is fine |
| Up to **1,000 files** per release | Booth uploads 4 (installer, portable `.exe`, `.blockmap`, `latest.yml`) |
| Total release size and bandwidth | **No limit**, so versions × projects × downloads doesn't matter |

Build minutes (GitHub Actions):

- **Public repos:** standard GitHub-hosted runners, Windows included, are
  **free with no minute cap**.
- **Private repos on GitHub Free:** **2,000 minutes a month**, shared across
  all your repos. A Windows Electron build takes roughly 5–10 minutes, so that
  still allows a couple of hundred releases a month.
- **Storage:** GitHub Free includes 500 MB of artifact storage and 10 GB of
  cache per repo. The workflow above uploads straight to the release, not as an
  Actions artifact, so it doesn't use that allowance.

What would change this:

- **A private repo breaks auto-updates.** Release files in a private repo can't
  be downloaded without a token, so installed apps couldn't fetch updates
  unless a token shipped inside the app, which isn't safe. Keep release repos
  public.
- **Very large apps hit the 2 GiB file limit.** For example Katib's `runtime/`
  is ~2.7 GB, mostly its 1.6 GB model, so an installer bundling it would likely
  exceed the limit. Download large models on first run instead, from a separate
  release asset or a model host, rather than packing them into the installer.
- **Updates are usually much smaller than the installer.** With the
  `.blockmap`, electron-updater downloads only the changed parts, not the full
  ~100 MB.
- **Old releases can be deleted.** Nothing requires keeping them. Users jumping
  from a deleted version just download the full installer instead of only the
  changes.

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
- **Releases stay drafts until fully uploaded.** The workflow uploads into a
  draft and only publishes it once every file is there, so users never see a
  half-uploaded release or one without `latest.yml`.

## Testing before going public

1. Build and install version X with the installer.
2. Cut version X+1 and let the workflow publish it.
3. Launch the installed X and confirm the update downloads and the popup
   appears. Check `<userData>/booth.log` for `updater:` lines if it doesn't.
4. Choose **Restart and update** and confirm the app reopens as X+1 with the
   project intact.
