# Tavern system SFX workflow

This workflow is for Tavern's app/system cues: voice room enter/leave, another
member joining/leaving, mic toggle, screen-share start/stop, and the existing
message/mention/DM/dice chimes.

The runtime owner is `apps/web/src/lib/sound.ts`. Tavern now prefers authored
MP3 assets in `apps/web/public/sounds/system/` and falls back to the existing
Web Audio synth tones when an asset is missing.

## Current local Comfy paths

Comfy Desktop is installed locally at:

- `E:\Comfy-Desktop\ComfyUI-Installs\comfy`
- shared output: `E:\Comfy-Desktop\ComfyUI-Shared\output`
- shared models: `E:\Comfy-Desktop\ComfyUI-Shared\models`

The installed Comfy build includes Stable Audio 3 and ACE-Step audio
blueprints. The shared model folder did not yet contain the Stable Audio model
weights when this workflow was added.

## Recommended Comfy workflow

Use Comfy's built-in `Stable Audio 3 Medium Base` or `Stable Audio 3 Small-SFX`
template if available. Small-SFX is the better target for short UI sounds, but
Medium Base is fine for first passes.

In ComfyUI:

1. Load the audio template from the template library.
2. Install/download the missing audio model files prompted by Comfy.
3. Set the save node to `SaveAudioMP3` if the template is not already saving
   MP3.
4. Export the workflow in API format and save it somewhere local, for example:
   `docs/audio-sfx/workflows/stable-audio3-base.api.json`.
5. Copy `docs/audio-sfx/comfyui-api-map.example.json` to
   `docs/audio-sfx/comfyui-api-map.local.json` and adjust node ids only if the
   runner cannot auto-detect the exposed inputs.

## Generate takes

Start the Comfy server/API, then run:

```powershell
pnpm sfx:generate -- --workflow docs/audio-sfx/workflows/stable-audio3-base.api.json --map docs/audio-sfx/comfyui-api-map.local.json --take-count 3
```

Useful narrower pass:

```powershell
pnpm sfx:generate -- --workflow docs/audio-sfx/workflows/stable-audio3-base.api.json --only vc-self-join,vc-self-leave,voice-join,voice-leave,mic-toggle --take-count 4
```

If Comfy Desktop uses a non-default port:

```powershell
pnpm sfx:generate -- --host http://127.0.0.1:8190 --workflow docs/audio-sfx/workflows/stable-audio3-base.api.json
```

Generated draft takes and prompt JSON are written under
`docs/audio-sfx/generated/`, which is gitignored.

## Normalize selected takes

After choosing the best take for each sound, either leave it in the generated
run folder with the sound name in the filename, or copy chosen raw files into a
scratch folder such as `docs/audio-sfx/raw/selected`.

Then run:

```powershell
pnpm sfx:prepare -- --input docs/audio-sfx/raw/selected
```

The script writes final browser assets to:

```text
apps/web/public/sounds/system/<sound-name>.mp3
```

Those final MP3 files are intentionally trackable once reviewed.

## Review checklist

- Each cue is short enough to avoid masking speech in a voice room.
- Self join/leave are distinct from another member joining/leaving.
- `mention` is clearly higher priority than `message`, but not alarming.
- `mic-toggle` is extremely short and dry.
- Screen-share sounds communicate start/stop without feeling like an error.
- No speech, vocals, copyrighted motifs, long music, harsh alarms, or noisy
  tails.

## Validation

Run at least:

```powershell
pnpm --filter @tavern/web typecheck
pnpm sfx:prepare -- --input docs/audio-sfx/raw/selected --dry-run
```

Then start the app and use Settings -> Notifications -> Try a sound to audition
every cue in-browser.
