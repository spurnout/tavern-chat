#!/usr/bin/env node
/**
 * One-shot codemod for the design-system token migration.
 *
 * Pass 1 — 1:1 renames (safe to apply globally):
 *   tavern-ink       → canvas
 *   tavern-parchment → fg
 *   tavern-mist      → fg-muted
 *   tavern-ember     → ember
 *   tavern-flame     → ember-hi
 *   tavern-mead      → mead
 *   tavern-forest    → moss
 *
 * Pass 2 (printed, not applied):
 *   tavern-stone, tavern-oak — context-dependent. The script lists each
 *   remaining occurrence so a human can choose surface/sunken/raised vs
 *   border-subtle/border-default per call site.
 *
 * Run from the repo root:
 *   node scripts/migrate-tokens.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const PASS_1 = [
  // Order matters — longer keys first so `tavern-ember-x` (none today) doesn't
  // get half-rewritten by a shorter key.
  ['tavern-parchment', 'fg'],
  ['tavern-flame', 'ember-hi'],
  ['tavern-forest', 'moss'],
  ['tavern-ember', 'ember'],
  ['tavern-mead', 'mead'],
  ['tavern-mist', 'fg-muted'],
  ['tavern-ink', 'canvas'],
];

// Pass 2a — safe substitutions handled here (regex-based).
//   border-tavern-oak (any side)   → border-subtle
//   hover:bg-tavern-oak            → hover:bg-raised
//   bg-tavern-oak (no hover)       → bg-raised
//   bg-tavern-stone/60             → bg-tint-fg-04
//   hover:bg-tavern-stone/60       → hover:bg-tint-fg-04
//   bg-ember/10 (any prefix)       → bg-tint-ember (was bg-tavern-ember/10)
//   hover:bg-ember/80              → hover:bg-ember-hi
const PASS_2A = [
  // border colors
  [/\bborder-tavern-oak\b/g, 'border-subtle'],
  // hover backgrounds (must come before plain bg-tavern-oak)
  [/\bhover:bg-tavern-oak\b/g, 'hover:bg-raised'],
  [/\bbg-tavern-oak\b/g, 'bg-raised'],
  // subtle row hover
  [/\bhover:bg-tavern-stone\/60\b/g, 'hover:bg-tint-fg-04'],
  [/\bbg-tavern-stone\/60\b/g, 'bg-tint-fg-04'],
  // opacity-modifier rewrites — Tailwind opacity modifiers don't combine
  // cleanly with var()-based oklch colors, so swap to predefined tokens.
  [/\bbg-ember\/10\b/g, 'bg-tint-ember'],
  [/\bhover:bg-ember\/80\b/g, 'hover:bg-ember-hi'],
];

const PASS_2_KEYS = ['tavern-stone'];

const ROOT = resolve(process.cwd());
const FILES = execSync(
  'git ls-files "apps/web/src/**/*.ts" "apps/web/src/**/*.tsx"',
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

let totalReplacements = 0;
let filesChanged = 0;
const pass2Hits = []; // { file, lineNo, line, key }

for (const rel of FILES) {
  const path = resolve(ROOT, rel);
  let src;
  try {
    src = readFileSync(path, 'utf8');
  } catch {
    continue;
  }

  let next = src;
  let fileReplacements = 0;
  for (const [from, to] of PASS_1) {
    const re = new RegExp(`\\b${from}\\b`, 'g');
    const before = next;
    next = next.replace(re, to);
    if (next !== before) {
      fileReplacements += (before.match(re) ?? []).length;
    }
  }
  for (const [re, to] of PASS_2A) {
    const before = next;
    next = next.replace(re, to);
    if (next !== before) {
      fileReplacements += (before.match(re) ?? []).length;
    }
  }

  if (fileReplacements > 0) {
    writeFileSync(path, next, 'utf8');
    totalReplacements += fileReplacements;
    filesChanged += 1;
  }

  // Audit Pass 2 candidates against the rewritten content.
  const lines = next.split('\n');
  lines.forEach((line, i) => {
    for (const key of PASS_2_KEYS) {
      const re = new RegExp(`\\b${key}\\b`);
      if (re.test(line)) {
        pass2Hits.push({ file: rel, lineNo: i + 1, line: line.trim(), key });
      }
    }
  });
}

console.log(`\nPass 1 complete.`);
console.log(`  files changed:      ${filesChanged}`);
console.log(`  total replacements: ${totalReplacements}\n`);

if (pass2Hits.length === 0) {
  console.log('Pass 2: no tavern-stone / tavern-oak occurrences remain.');
} else {
  console.log(`Pass 2: ${pass2Hits.length} occurrences need a contextual decision.\n`);
  const byFile = new Map();
  for (const hit of pass2Hits) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, []);
    byFile.get(hit.file).push(hit);
  }
  for (const [file, hits] of byFile) {
    console.log(`  ${file}`);
    for (const h of hits) {
      const trimmed = h.line.length > 100 ? h.line.slice(0, 97) + '...' : h.line;
      console.log(`    L${String(h.lineNo).padStart(4)}  [${h.key}]  ${trimmed}`);
    }
    console.log('');
  }
  console.log('Resolve each per the design-system docs:');
  console.log('  tavern-stone (background) → bg-sunken (sidebars) | bg-surface (cards/modals) | bg-raised (hover)');
  console.log('  tavern-oak (border) → border-subtle | border-default (inputs)');
  console.log('  tavern-oak (background or hover fill) → bg-raised');
}
