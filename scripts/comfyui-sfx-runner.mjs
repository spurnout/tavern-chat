#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.ogg', '.opus', '.wav']);
const DEFAULT_MANIFEST = 'docs/audio-sfx/tavern-system-sfx.json';
const DEFAULT_OUTPUT_DIR = 'docs/audio-sfx/generated';
const DEFAULT_HOST = 'http://127.0.0.1:8188';

function usage() {
  console.log(`Usage:
  pnpm sfx:generate -- --workflow <workflow-api.json> [options]

Options:
  --workflow <path>       ComfyUI workflow exported in API format.
  --manifest <path>      Prompt manifest. Default: ${DEFAULT_MANIFEST}
  --map <path>           Optional API node map JSON.
  --host <url>           ComfyUI server URL. Default: manifest/default or ${DEFAULT_HOST}
  --only <names>         Comma-separated sound names to generate.
  --take-count <n>       Takes per sound. Default: 1
  --output-dir <path>    Downloaded output metadata/files. Default: ${DEFAULT_OUTPUT_DIR}
  --timeout-ms <n>       Per-prompt timeout. Default: 600000
  --poll-ms <n>          History polling interval. Default: 2000
  --dry-run              Patch and write prompt JSON without queueing ComfyUI.
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isWorkflowApiFormat(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return false;
  return Object.values(workflow).some(
    (node) => node && typeof node === 'object' && 'class_type' in node && 'inputs' in node,
  );
}

function soundNames(manifest, onlyRaw) {
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

function nodeMatchesClass(node, classSpec) {
  if (!classSpec) return false;
  const classes = Array.isArray(classSpec) ? classSpec : [classSpec];
  return classes.includes(node.class_type);
}

function applyPatchSpec(workflow, patch, value, label) {
  if (!patch) return 0;
  if (patch.nodeId) {
    const node = workflow[String(patch.nodeId)];
    if (!node?.inputs) {
      throw new Error(`Patch ${label} points at missing node ${patch.nodeId}.`);
    }
    node.inputs[patch.input] = value;
    return 1;
  }

  if (patch.nodeClass) {
    let count = 0;
    for (const node of Object.values(workflow)) {
      if (!node?.inputs || !nodeMatchesClass(node, patch.nodeClass)) continue;
      if (patch.input in node.inputs) {
        node.inputs[patch.input] = value;
        count += 1;
      }
    }
    return count;
  }

  return 0;
}

function autoPatchInput(workflow, inputNames, value) {
  const matches = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node?.inputs) continue;
    for (const inputName of inputNames) {
      if (inputName in node.inputs) matches.push({ nodeId, inputName });
    }
  }
  if (matches.length !== 1) return 0;
  workflow[matches[0].nodeId].inputs[matches[0].inputName] = value;
  return 1;
}

function autoPatchFilenamePrefix(workflow, value) {
  return applyPatchSpec(
    workflow,
    {
      nodeClass: ['SaveAudio', 'SaveAudioMP3', 'SaveAudioOpus', 'SaveAudioAdvanced'],
      input: 'filename_prefix',
    },
    value,
    'filenamePrefix',
  );
}

function applyPatch(workflow, map, label, value, autoInputNames = []) {
  const explicitCount = applyPatchSpec(workflow, map?.patches?.[label], value, label);
  if (explicitCount > 0) return explicitCount;
  if (label === 'filenamePrefix') return autoPatchFilenamePrefix(workflow, value);
  if (autoInputNames.length > 0) return autoPatchInput(workflow, autoInputNames, value);
  return 0;
}

function buildPrompt(defaults, sound) {
  const styleAnchor = defaults.styleAnchor ? `${defaults.styleAnchor}. ` : '';
  const negative = defaults.negativePrompt ? ` Avoid: ${defaults.negativePrompt}.` : '';
  return `${styleAnchor}${sound.prompt}${negative}`;
}

function patchWorkflow(baseWorkflow, map, manifest, sound, takeIndex) {
  const workflow = cloneJson(baseWorkflow);
  const defaults = manifest.promptDefaults ?? {};
  const seed = Number(sound.seed ?? 1) + takeIndex;
  const prefix = `audio/tavern-system/${sound.name}/take-${String(takeIndex + 1).padStart(2, '0')}`;
  const patches = [
    ['prompt', buildPrompt(defaults, sound), ['user_input', 'prompt']],
    ['durationSeconds', sound.generationDurationSeconds, ['duration', 'seconds']],
    ['seed', seed, ['seed', 'noise_seed']],
    ['category', sound.category ?? defaults.category, ['category', 'reprompt_category']],
    ['useReprompt', sound.useReprompt ?? defaults.useReprompt ?? false, ['use_reprompt']],
    ['filenamePrefix', prefix, []],
  ];

  const applied = {};
  for (const [label, value, autoNames] of patches) {
    if (value === undefined) continue;
    applied[label] = applyPatch(workflow, map, label, value, autoNames);
  }
  return { workflow, applied, seed, prefix };
}

async function queuePrompt(host, prompt, clientId) {
  const res = await fetch(new URL('/prompt', host), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: clientId }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`ComfyUI /prompt failed (${res.status}): ${body}`);
  }
  const parsed = JSON.parse(body);
  if (!parsed.prompt_id) {
    throw new Error(`ComfyUI did not return a prompt_id: ${body}`);
  }
  return parsed.prompt_id;
}

async function readHistory(host, promptId) {
  const res = await fetch(new URL(`/history/${promptId}`, host));
  if (!res.ok) return null;
  const parsed = await res.json();
  return parsed[promptId] ?? null;
}

async function waitForHistory(host, promptId, timeoutMs, pollMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const history = await readHistory(host, promptId);
    if (history) return history;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for ComfyUI history for ${promptId}.`);
}

function collectOutputRefs(value, refs = []) {
  if (!value || typeof value !== 'object') return refs;
  if (Array.isArray(value)) {
    for (const item of value) collectOutputRefs(item, refs);
    return refs;
  }

  if (typeof value.filename === 'string') {
    const ext = path.extname(value.filename).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext)) {
      refs.push({
        filename: value.filename,
        subfolder: value.subfolder ?? '',
        type: value.type ?? 'output',
      });
    }
  }

  for (const child of Object.values(value)) collectOutputRefs(child, refs);
  return refs;
}

async function downloadOutput(host, ref, targetDir) {
  const url = new URL('/view', host);
  url.searchParams.set('filename', ref.filename);
  url.searchParams.set('subfolder', ref.subfolder ?? '');
  url.searchParams.set('type', ref.type ?? 'output');
  const res = await fetch(url);
  if (!res.ok) return null;
  await mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, path.basename(ref.filename));
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
  return target;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }

  const manifestPath = resolveRepoPath(args.manifest ?? DEFAULT_MANIFEST);
  const workflowPath = resolveRepoPath(args.workflow);
  const mapPath = args.map ? resolveRepoPath(args.map) : null;
  if (!workflowPath) {
    usage();
    throw new Error('Missing --workflow <workflow-api.json>.');
  }

  const manifest = await readJson(manifestPath);
  const workflow = await readJson(workflowPath);
  const map = mapPath ? await readJson(mapPath) : null;
  if (!isWorkflowApiFormat(workflow)) {
    throw new Error('Workflow does not look like ComfyUI API format. Use Export -> API format.');
  }

  const host = String(args.host ?? manifest.comfy?.defaultHost ?? DEFAULT_HOST);
  const outputDir = resolveRepoPath(args['output-dir'] ?? DEFAULT_OUTPUT_DIR);
  const takeCount = Number(args['take-count'] ?? 1);
  const timeoutMs = Number(args['timeout-ms'] ?? 600000);
  const pollMs = Number(args['poll-ms'] ?? 2000);
  const dryRun = Boolean(args['dry-run']);
  const clientId = `tavern-sfx-${randomUUID()}`;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(outputDir, runId);
  const runLog = [];

  await mkdir(runDir, { recursive: true });

  for (const sound of soundNames(manifest, args.only)) {
    for (let take = 0; take < takeCount; take += 1) {
      const patched = patchWorkflow(workflow, map, manifest, sound, take);
      const promptFile = path.join(
        runDir,
        `${sound.name}-take-${String(take + 1).padStart(2, '0')}.api.json`,
      );
      await writeFile(promptFile, JSON.stringify(patched.workflow, null, 2) + '\n');

      const entry = {
        sound: sound.name,
        take: take + 1,
        seed: patched.seed,
        prefix: patched.prefix,
        appliedPatches: patched.applied,
        promptFile: path.relative(repoRoot, promptFile),
      };

      if (dryRun) {
        console.log(`[dry-run] ${sound.name} take ${take + 1}: ${entry.promptFile}`);
        runLog.push(entry);
        continue;
      }

      console.log(`[queue] ${sound.name} take ${take + 1}`);
      const promptId = await queuePrompt(host, patched.workflow, clientId);
      const history = await waitForHistory(host, promptId, timeoutMs, pollMs);
      const refs = collectOutputRefs(history.outputs ?? history);
      const soundDir = path.join(runDir, sound.name);
      const downloaded = [];
      for (const ref of refs) {
        const file = await downloadOutput(host, ref, soundDir);
        if (file) downloaded.push(path.relative(repoRoot, file));
      }
      runLog.push({ ...entry, promptId, outputs: refs, downloaded });
      console.log(`[done] ${sound.name} take ${take + 1}: ${downloaded.length} file(s)`);
    }
  }

  const logFile = path.join(runDir, 'run.json');
  await writeFile(
    logFile,
    JSON.stringify({ host, manifest: path.relative(repoRoot, manifestPath), runLog }, null, 2) +
      '\n',
  );
  console.log(`Wrote ${path.relative(repoRoot, logFile)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
