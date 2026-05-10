#!/usr/bin/env node
/**
 * Stitch the per-step screenshots produced by tests/walkthrough.spec.ts into:
 *
 *   - walkthrough.mp4   — if ffmpeg is on PATH (preferred)
 *   - walkthrough.html  — always; an offline slideshow with prev/next/play
 *
 * Why HTML at all? ffmpeg isn't always installed, and a self-contained HTML
 * slideshow renders everywhere a browser does. So we emit it unconditionally
 * as a backup. PNGs are inlined as base64 so the file stands alone.
 *
 * Tweak the per-frame duration via SECONDS_PER_FRAME, default 2.5s.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRAMES = path.join(ROOT, 'walkthrough-frames');
const OUTPUT_MP4 = path.join(ROOT, 'walkthrough.mp4');
const OUTPUT_HTML = path.join(ROOT, 'walkthrough.html');
const SECONDS_PER_FRAME = Number(process.env['SECONDS_PER_FRAME'] ?? '2.5');

if (!existsSync(FRAMES)) {
  console.error(`No frames found at ${FRAMES}.`);
  console.error('Run `pnpm walkthrough` first.');
  process.exit(1);
}

const frames = readdirSync(FRAMES)
  .filter((f) => f.endsWith('.png'))
  .sort();

if (frames.length === 0) {
  console.error('Frames directory is empty. Did the walkthrough test fail?');
  process.exit(1);
}

console.info(`Found ${frames.length} frames in ${FRAMES}`);

writeHtmlSlideshow();
writeMp4IfPossible();

// ---------------------------------------------------------------------------

function writeMp4IfPossible() {
  const ffmpeg = spawnSync('ffmpeg', ['-version']);
  if (ffmpeg.status !== 0) {
    console.warn('ffmpeg not found on PATH — skipping MP4. The HTML slideshow still works.');
    console.warn('Install ffmpeg from https://ffmpeg.org/ or via your package manager.');
    return;
  }

  // The concat demuxer wants explicit per-file durations and the last entry
  // repeated without a duration, otherwise the final frame is dropped.
  const list = path.join(FRAMES, '_concat.txt');
  const lines = [];
  for (const f of frames) {
    lines.push(`file '${f}'`);
    lines.push(`duration ${SECONDS_PER_FRAME}`);
  }
  lines.push(`file '${frames[frames.length - 1]}'`);
  writeFileSync(list, lines.join('\n'));

  console.info(`Encoding MP4 @ ${SECONDS_PER_FRAME}s per frame → ${OUTPUT_MP4}`);
  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', list,
        '-vsync', 'vfr',
        '-pix_fmt', 'yuv420p',
        '-vf', 'scale=1280:-2',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '22',
        OUTPUT_MP4,
      ],
      { stdio: 'inherit' },
    );
    console.info(`✓ ${OUTPUT_MP4}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('ffmpeg encoding failed:', msg);
    console.error('The HTML slideshow at walkthrough.html still works.');
    process.exitCode = 1;
  }
}

function writeHtmlSlideshow() {
  const slides = frames.map((name) => {
    const data = readFileSync(path.join(FRAMES, name)).toString('base64');
    return { name, dataUrl: `data:image/png;base64,${data}` };
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Tavern walkthrough</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    background: #0c0a09;
    color: #f5e9d3;
    font: 14px/1.4 Inter, system-ui, -apple-system, Segoe UI, sans-serif;
    overflow: hidden;
  }
  .stage { position: fixed; inset: 0; display: grid; place-items: center; }
  .frame { display: none; }
  .frame.active { display: block; }
  img {
    max-width: 96vw;
    max-height: 96vh;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  }
  .controls {
    position: fixed;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    display: flex;
    gap: 10px;
    align-items: center;
    background: rgba(28, 25, 23, 0.88);
    backdrop-filter: blur(6px);
    border: 1px solid #292524;
    border-radius: 999px;
    padding: 6px 10px;
  }
  button {
    background: transparent;
    color: #f5e9d3;
    border: 0;
    font: inherit;
    font-weight: 600;
    padding: 6px 10px;
    border-radius: 999px;
    cursor: pointer;
  }
  button:hover { background: #292524; }
  button.primary { background: #f97316; color: #0c0a09; }
  button.primary:hover { background: #fb923c; }
  .counter { padding: 6px 10px; opacity: 0.7; font-variant-numeric: tabular-nums; }
  .duration { padding: 6px 10px; opacity: 0.7; font-size: 12px; }
  .duration input {
    width: 56px;
    background: #1c1917;
    color: #f5e9d3;
    border: 1px solid #292524;
    border-radius: 4px;
    padding: 2px 4px;
  }
</style>
</head>
<body>
  <div class="stage" id="stage"></div>
  <div class="controls">
    <button onclick="prev()" title="Previous (←)">←</button>
    <button id="playBtn" class="primary" onclick="toggle()">⏸ Pause</button>
    <button onclick="next()" title="Next (→)">→</button>
    <span class="counter" id="counter"></span>
    <span class="duration">
      <label>seconds <input id="dur" type="number" min="0.5" max="10" step="0.5" value="${SECONDS_PER_FRAME}" onchange="setDur(this.value)" /></label>
    </span>
  </div>
<script>
const SLIDES = ${JSON.stringify(slides)};
const stage = document.getElementById('stage');
SLIDES.forEach((s, i) => {
  const div = document.createElement('div');
  div.className = 'frame' + (i === 0 ? ' active' : '');
  const img = document.createElement('img');
  img.alt = s.name;
  img.src = s.dataUrl;
  div.appendChild(img);
  stage.appendChild(div);
});
const counter = document.getElementById('counter');
const playBtn = document.getElementById('playBtn');
let i = 0;
let durationMs = ${SECONDS_PER_FRAME * 1000};
let timer = null;
let playing = false;
function show(n) {
  i = ((n % SLIDES.length) + SLIDES.length) % SLIDES.length;
  document.querySelectorAll('.frame').forEach((f, idx) => {
    f.classList.toggle('active', idx === i);
  });
  counter.textContent = (i + 1) + ' / ' + SLIDES.length;
}
function next() { show(i + 1); }
function prev() { show(i - 1); }
function play() {
  if (playing) return;
  playing = true;
  playBtn.textContent = '⏸ Pause';
  timer = setInterval(next, durationMs);
}
function pause() {
  if (!playing) return;
  playing = false;
  playBtn.textContent = '▶ Play';
  clearInterval(timer);
  timer = null;
}
function toggle() { playing ? pause() : play(); }
function setDur(v) {
  durationMs = Math.max(500, Math.min(10000, Number(v) * 1000));
  if (playing) { pause(); play(); }
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') next();
  else if (e.key === 'ArrowLeft') prev();
  else if (e.key === ' ') { e.preventDefault(); toggle(); }
});
show(0);
play();
</script>
</body>
</html>
`;

  writeFileSync(OUTPUT_HTML, html);
  console.info(`✓ ${OUTPUT_HTML} (open in a browser)`);
}
