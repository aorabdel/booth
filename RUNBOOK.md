# Runbook

The pipeline is the Python standard library plus numpy, and ffmpeg.

Requires: Python 3.12 with numpy, Node 24, ffmpeg with the rubberband filter
(gyan full build, on PATH), and the
CUDA whisper.cpp build at `E:\whisper` (override with `WHISPER_DIR`).

## 0. Put the video in place

Point ingest at the script and the video; it hardlinks the video into
`project/media/source.mp4`, so no second copy of 2 GB is made:

```bash
python -m pipeline.ingest --force --xlsx path/to/script.xlsx --video path/to/film.mp4
```

A faststart h264 source with frequent keyframes seeks fine and the booth plays
it directly — no proxy transcode. Pass `--proxy` if seeking feels sluggish.

`original.wav` is extracted from the video (not a separate audio file) so
picture and sound cannot drift apart.

Note `--force` resets `cps` to the default 13.0. Put the actor's measured rate
back, replacing `<cps>` with the rate `salvage` reported:

```bash
python -c "import sys;sys.path.insert(0,'.');from pipeline.dubkit.project import Project;p=Project.load('project/project.json');p.settings['cps']=<cps>;p.save()"
python -m pipeline.preflight
```

## 1. Ingest — workbook and media to project.json

```bash
python -m pipeline.ingest --force --xlsx path/to/script.xlsx
```

Reads the workbook passed with `--xlsx` (or a plain `.srt`), writes
`project/project.json` (the single source of truth), plus `narration.srt` and
`all_cues.srt`. Extracts `project/media/original.wav`, and builds a 720p
`proxy.mp4` for the booth once the video is present.

`--force` rebuilds from the workbook and **discards take assignments** — use it
after the adapter edits the script, then re-run salvage.

## 2. Salvage — recover what is already recorded

```bash
python -m pipeline.salvage --takes-dir path/to/session-wavs --dry-run   # report only
python -m pipeline.salvage --takes-dir path/to/session-wavs             # slice takes, update project
```

Finds real utterances in earlier recording sessions (e.g. WAVs exported from a
DAW) by energy gate, identifies each
with whisper, slices it into `project/takes/`, and measures the actor's true
speaking rate. Writes `project/out/salvage.csv`.

## 3. Preflight — what can actually be said in time

```bash
python -m pipeline.preflight --sweep        # verdict split across speaking rates
python -m pipeline.preflight                # score at the project's cps
python -m pipeline.preflight --list REWRITE # the lines to send back to the adapter
```

Writes `project/out/preflight.csv` and a verdict on every line:

| verdict | meaning | who acts |
|---|---|---|
| `GREEN` | fits its own slot | nobody |
| `BORROW` | fits using neighbouring silence | the fitter, automatically |
| `STRETCH` | needs Rubber Band inside the transparent window | the fitter |
| `REWRITE` | cannot be spoken in time | the adapter, before recording |

## The project file

A project is a **`.booth` file** plus the folder around it, for example
`E:\dub\My dub.booth`. Double-click it and Booth opens that project.

It follows the shape editing suites settled on long ago (Premiere, Resolve,
Ableton, REAPER): the file is small, holds edit state and *references* to
media, and never embeds media itself.

```json
{
  "format": "booth-project", "formatVersion": 1,
  "id": "19ddf683-…", "name": "My dub",
  "created": "…", "modified": "…",
  "layout":  { "data": "project/project.json", "media": "project/media",
               "takes": "project/takes", "output": "project/out",
               "cache": "project/cache" },
  "media":   { "video":  { "relative": "project/media/source.mp4",
                           "absolute": "E:\dub\project\media\source.mp4",
                           "bytes": 2113102717, "modified": "…" },
               "audio":  { … }, "script": { … } },
  "tools":   { "python": "python", "whisperDir": null },
  "session": { "view": "stage", "line": null, "window": null },
  "recentImports": []
}
```

Three deliberate choices:

- **Every reference is stored twice** — relative to the project file and
  absolute. Relative wins, so moving or copying the whole folder just works;
  absolute is the fallback for media parked on another drive. Size and
  modified-time travel with it so a missing file can be re-linked with
  confidence. **Project → Relink missing media…** walks the broken ones.
- **Import links, it does not copy.** The file stays where it is. Copying a
  2 GB master into every project is exactly what those tools learned not to do.
- **Session state lives in the file** — the view you were on, the window
  bounds — so reopening lands you where you left. Take-by-take progress stays
  in `project/project.json`, which is written as you record.

The regenerable things (`project/cache`, `project/out`) are named in `layout`
but never treated as precious.

### Opening, creating, importing

**Project → Open project…** wants a **`.booth` file**, not a folder.

**New project…** asks where to put one, creates `project/media`, `project/takes`,
`project/out`, `project/cache` beside it, then offers to import straight away.

**Import translation script…** takes an `.xlsx` (the timed workbook) or a plain
`.srt`. The file is copied into the project folder, the line list is built from
it, and the project reloads with the lines in place. Nothing else to run.

**Import video…** brings the picture in, extracts `original.wav` from it — so
sound and picture cannot drift — and reloads.

Files are hardlinked into the project when they are on the same drive, which is
instant and uses no extra disk. Across drives a hardlink is impossible, so
anything over 512 MB asks first: **reference it where it is** (the default, and
what editing suites do) or **copy it in** (self-contained, but duplicated).
Referenced video is streamed straight from wherever it lives, so either choice
plays and seeks identically.

Re-importing a script rebuilds the line list, which renumbers the cues and
detaches existing takes from their lines — so Booth warns first when any line
already has one. The take files themselves are never deleted.

### Where the pipeline lives

The Python pipeline is **code that ships inside the app** (`resources/pipeline`
in a build, the repo checkout when run from source), so a project folder holds
only data and can live anywhere. Booth runs `python -m pipeline.<step>
--project <that project's json>`.

## 4. Booth — the desktop app

```
dist/Booth-Setup-1.0.0.exe     installer
dist/Booth-1.0.0-portable.exe  single file, no install
```

Booth always starts at a **welcome screen** with two buttons — **New project…**
and **Open project…**. It never reopens the last project on its own; the only
thing that opens one automatically is double-clicking a `.booth`. **Project →
Close project** (`Ctrl+W`) returns to the welcome screen and stops everything
behind it.

Python and ffmpeg must be on PATH. Dark only; it does not follow the system theme.

### One view

There are no tabs. Everything is on one screen:

- **picture** with the Arabic line burned under it
- **the line, large**, with the pace always on screen — the slot, how long the
  text needs at the actor's measured rate, and how long the last read was
- **two timeline lanes**: the original waveform with a ruler on top, the
  sentence clips below
- **transport** — play the whole film, or record the focused line
- **sidebar** — every line, with a flag toggle and a colour showing its state

### Recording

`R` rolls: 3s of pre-roll, beeps at −3/−2/−1, silence on the cue. The take is
saved, fitted and placed on the timeline immediately, and you hear the verdict
as a length hint — *0.4s of room*, *0.7s over*. There is no speech recognition
in the loop any more; it cost a 1.6 GB model at start-up and produced more
false retakes than real catches.

| key | |
|---|---|
| `Space` | play / pause the whole film |
| `R` | record the focused line — the button reads **record** / **stop** |
| `Esc` | discard the take that is rolling |
| `F` | flag the focused line (a flag shows in the sidebar and on the clip) |
| `Del` | take the selected clip off the timeline |
| `←` `→` | previous / next line |

### The timeline

The lower lane holds one clip per recorded line, sitting inside the slot the
translation was given.

- **drag a clip** to move it. It cannot cross into its neighbours. Moving is
  answered from memory, so it is instant, and it keeps the automatic fitting —
  a nudge is a placement, not an instruction to stop fitting.
- **drag an edge** to stretch it. Tempo changes; pitch and formants do not. The
  readout shows the resulting tempo and warns when it leaves the transparent
  window (±15%).
- **drag the background** to pan, **wheel** to zoom about the pointer. The view
  follows the playhead while playing until you scroll, after which you are in
  charge until playback restarts.
- **`Del`** takes the selected clip off the timeline. The recordings are kept —
  this un-chooses a take rather than deleting audio.
- The **slot box stands proud of the clip** top and bottom, so you can see at a
  glance how the recording sits inside the time the translation was given.

Every edit re-renders just that clip and plays it back, and the timeline is
locked with a progress bar while it does. **Nothing to re-assemble** — playback
schedules the per-line clips against the video clock, so an edit is audible as
soon as it is rendered.

Edits run inside the already-running checker rather than spawning Python and
rebuilding the master: a clip settles in about **0.1s** instead of 16 seconds.

Clicking anywhere on the timeline also selects the line under the playhead, and
during playback the selection follows the playhead — so `R` always records the
line you are looking at.

### Takes

Every take is kept. When a line has more than one, the take chips appear beside
the pace line with their verdicts; click one to make it the keeper. The line is
re-fitted and played back at once.

### Export

**Export…** in the header opens a sheet:

- **narration stem (WAV)** — the voice alone on the film's timeline
- **mix (WAV)** — narration over the original, the original sidechain-ducked
  underneath, normalised to the project target
- **dubbed video (MP4)** — the mix muxed back to picture, video copied not
  re-encoded

and a length: **full film**, or **recorded span only**, trimmed to what exists
so a part-finished dub is a short file rather than two hours of mostly silence.
The flat timeline is assembled as part of the export, so it can never be stale.

## Reading the verdicts

Three columns, three different questions, asked at three different moments.
They use separate words on purpose: a line can be easy to say and still come
out badly, or be hard to say and land perfectly. **Control → what do these
mean?** shows the same table in the app, and every pill carries the numbers
behind it as a tooltip.

**Will it fit?** — estimated *before* recording, from the character count
divided by the actor's measured rate.

| | |
|---|---|
| `GREEN` | fits inside the line's own slot |
| `BORROW` | fits by taking silence from the gaps either side; automatic |
| `STRETCH` | still long; needs time-compression when assembled |
| `REWRITE` | cannot be spoken in time — the translation must be shortened |

**Last take** — measured from the audio, about 0.3s after you stop rolling.

| | |
|---|---|
| `GOOD` | speech fits inside the slot with room to spare |
| `TIGHT` | fits only by borrowing neighbouring silence; fine |
| `OVER` | past slot + slack but inside the stretch window; usable |
| `LONG` | too long even for stretching — worth another take |
| `WORDS` | timing fine, but ASR could not hear some scripted words |
| `EMPTY` | no speech in the take at all |

**In the dub** — what the fitter actually did when assembling.

| | |
|---|---|
| `OK` | placed as recorded |
| `BORROW` | placed using silence borrowed from the gaps |
| `SHORT` | delivery shorter than the slot, leaving air; usually fine |
| `STRETCH` | time-compressed to fit |
| `MANUAL` | a hand edit is in force; the automatic ladder was skipped |
| `OVERRUN` | still past its limit after everything was tried |
| `PENDING` | recorded but **not assembled** — the dub track is silent there |

`PENDING` is the one to watch. Recording a take does not put it in the dub
track; the fitter does. Review shows a banner and a **Re-assemble now** button
whenever takes are waiting.

## Choosing between takes

Booth keeps every take and uses the **newest** one by default. That is usually
right and occasionally badly wrong — the tenth try can be the one where nothing
was said. In **Review**, select a line and click **N takes…** to see them all
with their verdicts; click any one to make it the keeper. The line is re-fitted
and played back immediately.

## Hand edits

For the lines where the automatic ladder is not quite right, select the line in
**Review** and use the hand-edit panel:

- **length** — the exact duration you want, as a slider or a typed number.
  **fit to slot** sets it to the line's slot.
- **stretch / trim** — how the length is reached. *stretch* changes the tempo
  with pitch and formants locked, so it does not chipmunk; *trim* cuts the tail
  instead. The readout shows the resulting tempo and turns amber past ±15%,
  where stretching starts to be audible.
- **nudge** — slide the line earlier or later, up to 2s.
- **trim in / trim out** — shave the head or tail before anything else.

**apply & hear it** re-renders that one line and plays it back. Nothing is
applied while you drag — a Rubber Band pass per keystroke would make the
sliders unusable. **reset** returns the line to automatic fitting.

A hand edit overrides the automatic ladder completely (verdict `MANUAL`), on
the grounds that second-guessing an explicit instruction is worse than obeying
it. Switching to a different take clears the edit, since its timing no longer
means anything.

## Export

**Tools → Export…**, or from the command line:

```bash
python -m pipeline.export --what dub   --out vo.wav          # narration stem
python -m pipeline.export --what mix   --out mix.wav         # over the original
python -m pipeline.export --what video --out dubbed_ar.mp4   # muxed to picture
```

- **narration stem** — the voice alone on the film's timeline. What a mixer wants.
- **mix** — narration over the original, the original sidechain-ducked by the
  narration so it drops only while the narrator speaks and lifts in the gaps, then
  loudness-normalised to the project target (−23 LUFS = EBU R128).
- **dubbed video** — the same mix muxed back to picture. Video is copied, not
  re-encoded, so it is fast and lossless.

Export always uses the last assembled timeline, so re-assemble first if takes
are pending.

## Saving and resuming

There is nothing to save. Every take is written to
`project/takes/NNNN_tNN.wav` the instant you stop rolling, and `project.json`
is updated within 400 ms. Close the browser, kill the server, reboot — reopen
`stage.html` and it resumes at the first line still marked `todo`.

Takes are never overwritten or thrown away: a retake is `_t02`, `_t03`, and so
on, and `selected` records which one is in use. `fit.py` is what splices them
into a single timeline, and it is non-destructive — re-run it as often as you
like.

## Layout

```
pipeline/           python: ingest, salvage, preflight, checkd
  dubkit/           srt, wav, silence, arabic, asr, ff, project
main.js, server.js  node: Electron app + loopback service
public/             app.html, app.js, startup.html
project/
  project.json      single source of truth
  media/            source.mp4, proxy.mp4, original.wav
  takes/            NNNN_tNN.wav, one file per take
  out/              preflight.csv, salvage.csv
  cache/asr/        whisper results, safe to delete
```

## 6. Fit — splice everything into one timeline

```bash
python -m pipeline.fit                    # assemble every take recorded so far
python -m pipeline.fit --list OVERRUN     # the lines that still do not fit
python -m pipeline.fit --only 412 413     # re-fit just these
```

Writes `project/out/dub_fitted.wav` (the full-length timeline) and
`project/out/fit_report.csv`. Corrections are applied cheapest-damage-first:
trim the outer silence, absorb into the line's own pauses, borrow slack from
the neighbouring gaps, then one Rubber Band pass clamped to 0.87–1.15, then
flag. Raw takes are never modified.

## Recovering takes

Take files are named `NNNN_tNN.wav` after the line they belong to, so a
recording is never really lost even if its entry goes missing from the project.

```bash
python -m pipeline.reattach --dry-run   # what is on disk but not in the project
python -m pipeline.reattach             # put them back
python -m pipeline.fit                  # then place them on the timeline
```

## Re-checking old takes

```bash
python -m pipeline.recheck
```

Verdicts are stored on the take when it is recorded, so they go stale when the
checker improves or the script timings change. This replays them all.

## Not built yet

`mix.py` (music-and-effects bed, sidechain duck, loudnorm, mux) and `qc.py`
(drift report, flagged-moments reel).
