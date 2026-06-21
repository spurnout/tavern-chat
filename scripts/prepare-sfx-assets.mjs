#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_MANIFEST = 'docs/audio-sfx/tavern-system-sfx.json';
const DEFAULT_INPUT_DIR = 'docs/audio-sfx/generated';
const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.ogg', '.opus', '.wav']);

function usage() {
  console.log(`Usage:
  pnpm sfx:prepare -- --input <dir> [options]

Options:
  --input <dir>       Directory containing ComfyUI output takes.
  --manifest <path>   Prompt manifest. Default: ${DEFAULT_MANIFEST}
  --only <names>      Comma-separated sound names to prepare.
  --dry-run           Print ffmpeg commands without writing files.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function resolveRepoPath(filePath) {
  if (!filePath) return filePath;
  return path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function listAudioFiles(dir) {
  const files = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const info = await stat(fullPath);
        files.push({ path: fullPath, mtimeMs: info.mtimeMs });
      }
    }
  }
  await visit(dir);
  return files;
}

function selectedSounds(manifest, onlyRaw) {
  const only =
    typeof onlyRaw === 'string'
      ? new Set(
          onlyRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : null;
  return manifest.sounds.filter((sound) => !only || only.has(sound.name));
}

function chooseSource(files, soundName) {
  const needle = soundName.toLowerCase();
  return (
    files
      .filter((file) => path.basename(file.path).toLowerCase().includes(needle))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null
  );
}

function buildFilter(normalization, durationSeconds) {
  const fadeIn = normalization.fadeInSeconds ?? 0.01;
  const fadeOut = normalization.fadeOutSeconds ?? 0.05;
  const fadeOutStart = Math.max(0, durationSeconds - fadeOut);
  const targetLufs = normalization.targetLufs ?? -20;
  const peakDb = normalization.peakDb ?? -1.5;
  return [
    `atrim=0:${durationSeconds}`,
    'asetpts=N/SR/TB',
    `afade=t=in:st=0:d=${fadeIn}`,
    `afade=t=out:st=${fadeOutStart}:d=${fadeOut}`,
    `loudnorm=I=${targetLufs}:LRA=7:TP=${peakDb}`,
  ].join(',');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }

  const manifestPath = resolveRepoPath(args.manifest ?? DEFAULT_MANIFEST);
  const inputDir = resolveRepoPath(args.input ?? DEFAULT_INPUT_DIR);
  const manifest = await readJson(manifestPath);
  const outputDir = resolveRepoPath(manifest.assetOutputDir);
  const normalization = manifest.normalization ?? {};
  const format = normalization.format ?? 'mp3';
  const dryRun = Boolean(args['dry-run']);
  const files = await listAudioFiles(inputDir);

  await mkdir(outputDir, { recursive: true });

  for (const sound of selectedSounds(manifest, args.only)) {
    const source = chooseSource(files, sound.name);
    if (!source) {
      console.warn(`[skip] ${sound.name}: no source file found under ${inputDir}`);
      continue;
    }

    const target = path.join(outputDir, `${sound.name}.${format}`);
    const duration = sound.targetDurationSeconds ?? sound.generationDurationSeconds ?? 1;
    const ffmpegArgs = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'warning',
      '-i',
      source,
      '-af',
      buildFilter(normalization, duration),
      '-ar',
      String(normalization.sampleRate ?? 44100),
      '-ac',
      String(normalization.channels ?? 2),
      '-b:a',
      normalization.bitrate ?? '128k',
      target,
    ];

    if (dryRun) {
      console.log(`ffmpeg ${ffmpegArgs.map((arg) => JSON.stringify(arg)).join(' ')}`);
      continue;
    }

    const result = spawnSync('ffmpeg', ffmpegArgs, { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`ffmpeg failed for ${sound.name} (${source}).`);
    }
    console.log(`[ok] ${sound.name} -> ${path.relative(repoRoot, target)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
