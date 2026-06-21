export type SoundName =
  | 'vc-self-join'
  | 'vc-self-leave'
  | 'screenshare-start'
  | 'screenshare-stop'
  | 'message'
  | 'mention'
  | 'dm'
  | 'roll'
  | 'voice-join'
  | 'voice-leave'
  | 'mic-toggle';

export interface SoundSettings {
  enabled: boolean;
  /** 0..1 — multiplied against the per-sound peak gain. */
  volume: number;
}

let ctx: AudioContext | null = null;
let unlocked = false;
let settingsReader: () => SoundSettings = readLocalStorage;

const SOUND_ASSET_PATHS: Record<SoundName, string> = {
  'vc-self-join': '/sounds/system/vc-self-join.mp3',
  'vc-self-leave': '/sounds/system/vc-self-leave.mp3',
  'screenshare-start': '/sounds/system/screenshare-start.mp3',
  'screenshare-stop': '/sounds/system/screenshare-stop.mp3',
  message: '/sounds/system/message.mp3',
  mention: '/sounds/system/mention.mp3',
  dm: '/sounds/system/dm.mp3',
  roll: '/sounds/system/roll.mp3',
  'voice-join': '/sounds/system/voice-join.mp3',
  'voice-leave': '/sounds/system/voice-leave.mp3',
  'mic-toggle': '/sounds/system/mic-toggle.mp3',
};

type AssetCacheEntry =
  | { status: 'missing' }
  | { status: 'loading'; promise: Promise<AudioBuffer | null> }
  | { status: 'ready'; buffer: AudioBuffer };

const assetCache = new Map<SoundName, AssetCacheEntry>();

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

// localStorage keys carry the `tavern.` prefix the rest of the codebase uses
// (preferences-store, outbox, api-client) so multi-app collisions on the same
// origin are impossible. The non-prefixed names are still consulted as a
// one-time read-side fallback for users upgrading from an earlier build.
const ENABLED_KEY = 'tavern.sound.enabled';
const VOLUME_KEY = 'tavern.sound.volume';
const LEGACY_ENABLED_KEY = 'sound.enabled';
const LEGACY_VOLUME_KEY = 'sound.volume';

function readLocalStorage(): SoundSettings {
  if (typeof window === 'undefined') return { enabled: true, volume: 0.7 };
  const ls = window.localStorage;
  const enabledRaw = ls.getItem(ENABLED_KEY) ?? ls.getItem(LEGACY_ENABLED_KEY);
  const enabled = enabledRaw !== 'false';
  const volumeRaw = ls.getItem(VOLUME_KEY) ?? ls.getItem(LEGACY_VOLUME_KEY);
  const n = volumeRaw != null ? Number(volumeRaw) : 70;
  const volume = Number.isFinite(n) ? Math.max(0, Math.min(1, n / 100)) : 0.7;
  return { enabled, volume };
}

/**
 * Phase 4 plugs the DB-backed settings store into the sound engine here.
 * Until then, settings live in localStorage as a stopgap.
 */
export function setSoundSettingsReader(fn: () => SoundSettings): void {
  settingsReader = fn;
}

/**
 * One-time listener pair that resumes the AudioContext on the first user
 * gesture. Browsers suspend new contexts until the user interacts; without
 * this, the first sound after page load would be silently dropped.
 */
export function initSoundUnlock(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (): void => {
    if (unlocked) return;
    const c = getContext();
    if (!c) return;
    void c.resume().then(() => {
      unlocked = true;
    });
  };
  const opts: AddEventListenerOptions = { capture: true };
  window.addEventListener('pointerdown', handler, opts);
  window.addEventListener('keydown', handler, opts);
  window.addEventListener('touchstart', handler, opts);
  return () => {
    window.removeEventListener('pointerdown', handler, opts);
    window.removeEventListener('keydown', handler, opts);
    window.removeEventListener('touchstart', handler, opts);
  };
}

function attackHoldRelease(
  c: AudioContext,
  dest: AudioNode,
  start: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(peak, start + attack);
  if (hold > 0) g.gain.setValueAtTime(peak, start + attack + hold);
  g.gain.linearRampToValueAtTime(0, start + attack + hold + release);
  g.connect(dest);
  return g;
}

function cleanup(...nodes: AudioNode[]): () => void {
  return () => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        // already disconnected
      }
    }
  };
}

async function loadAsset(c: AudioContext, name: SoundName): Promise<AudioBuffer | null> {
  const cached = assetCache.get(name);
  if (cached?.status === 'ready') return cached.buffer;
  if (cached?.status === 'missing') return null;
  if (cached?.status === 'loading') return cached.promise;
  if (typeof fetch === 'undefined') return null;

  const promise = fetch(SOUND_ASSET_PATHS[name], { cache: 'force-cache' })
    .then(async (res) => {
      if (!res.ok) {
        assetCache.set(name, { status: 'missing' });
        return null;
      }
      const buffer = await c.decodeAudioData(await res.arrayBuffer());
      assetCache.set(name, { status: 'ready', buffer });
      return buffer;
    })
    .catch(() => {
      assetCache.set(name, { status: 'missing' });
      return null;
    });

  assetCache.set(name, { status: 'loading', promise });
  return promise;
}

function playAsset(c: AudioContext, dest: AudioNode, buffer: AudioBuffer, now: number): number {
  const source = c.createBufferSource();
  source.buffer = buffer;
  source.connect(dest);
  source.start(now);
  source.onended = cleanup(source);
  return Math.max(500, (buffer.duration + 0.25) * 1000);
}

function tone(
  c: AudioContext,
  dest: AudioNode,
  freq: number,
  start: number,
  duration: number,
  peak: number,
  type: OscillatorType = 'sine',
): void {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  const env = attackHoldRelease(c, dest, start, peak, 0.005, duration * 0.3, duration * 0.7);
  osc.connect(env);
  osc.start(start);
  osc.stop(start + duration + 0.05);
  osc.onended = cleanup(osc, env);
}

function glide(
  c: AudioContext,
  dest: AudioNode,
  freqStart: number,
  freqEnd: number,
  start: number,
  duration: number,
  peak: number,
): void {
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freqStart, start);
  osc.frequency.exponentialRampToValueAtTime(freqEnd, start + duration);
  const env = attackHoldRelease(c, dest, start, peak, 0.015, duration * 0.5, duration * 0.5);
  osc.connect(env);
  osc.start(start);
  osc.stop(start + duration + 0.05);
  osc.onended = cleanup(osc, env);
}

function click(c: AudioContext, dest: AudioNode, start: number, peak = 0.4): void {
  const osc = c.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(2000, start);
  const g = c.createGain();
  g.gain.setValueAtTime(peak, start);
  g.gain.exponentialRampToValueAtTime(0.001, start + 0.025);
  g.connect(dest);
  osc.connect(g);
  osc.start(start);
  osc.stop(start + 0.04);
  osc.onended = cleanup(osc, g);
}

type SoundFn = (c: AudioContext, dest: AudioNode, now: number) => void;

const SOUNDS: Record<SoundName, SoundFn> = {
  // Lower octave than the design-system `voice-join` so you can tell apart
  // "I joined" from "someone else joined."
  'vc-self-join': (c, d, n) => glide(c, d, 261.63, 392.0, n, 0.26, 0.35),
  'vc-self-leave': (c, d, n) => glide(c, d, 392.0, 261.63, n, 0.26, 0.35),
  // Design system: C5 → G5 glide, 220ms
  'voice-join': (c, d, n) => glide(c, d, 523.25, 783.99, n, 0.22, 0.3),
  'voice-leave': (c, d, n) => glide(c, d, 783.99, 523.25, n, 0.22, 0.3),
  // Two-note ascending chirp for start, descending for stop.
  'screenshare-start': (c, d, n) => {
    tone(c, d, 659.25, n, 0.1, 0.3); // E5
    tone(c, d, 987.77, n + 0.08, 0.16, 0.3); // B5
  },
  'screenshare-stop': (c, d, n) => {
    tone(c, d, 987.77, n, 0.1, 0.3);
    tone(c, d, 659.25, n + 0.08, 0.16, 0.3);
  },
  // Soft single tone for regular messages.
  message: (c, d, n) => tone(c, d, 660, n, 0.18, 0.22),
  // Design system: 880 + 1320 Hz, 380ms decay.
  mention: (c, d, n) => {
    tone(c, d, 880, n, 0.38, 0.32);
    tone(c, d, 1320, n, 0.38, 0.2);
  },
  // Design system: 660 + 990 Hz double-tap, 120ms apart. Distinct from
  // `message` so an incoming DM doesn't get confused with a tavern chime.
  dm: (c, d, n) => {
    tone(c, d, 660, n, 0.14, 0.3);
    tone(c, d, 990, n, 0.14, 0.22);
    tone(c, d, 660, n + 0.12, 0.16, 0.3);
    tone(c, d, 990, n + 0.12, 0.16, 0.22);
  },
  // Design system: 3 clicks + 1760 Hz bell.
  roll: (c, d, n) => {
    click(c, d, n, 0.3);
    click(c, d, n + 0.06, 0.3);
    click(c, d, n + 0.12, 0.3);
    tone(c, d, 1760, n + 0.2, 0.3, 0.28);
  },
  'mic-toggle': (c, d, n) => click(c, d, n, 0.22),
};

export function playSound(name: SoundName, opts: { volume?: number } = {}): void {
  const c = getContext();
  if (!c) return;
  if (c.state === 'suspended') return;
  const settings = settingsReader();
  if (!settings.enabled) return;
  const local = opts.volume ?? 1;
  const master = c.createGain();
  master.gain.value = settings.volume * local;
  master.connect(c.destination);
  const now = c.currentTime + 0.01;
  const cachedAsset = assetCache.get(name);
  let cleanupDelayMs = 1500;
  if (cachedAsset?.status === 'ready') {
    cleanupDelayMs = playAsset(c, master, cachedAsset.buffer, now);
  } else {
    if (cachedAsset?.status !== 'missing') void loadAsset(c, name);
    SOUNDS[name](c, master, now);
  }
  // Procedural sounds are short; generated assets report their own duration.
  window.setTimeout(() => {
    try {
      master.disconnect();
    } catch {
      // already disconnected
    }
  }, cleanupDelayMs);
}
