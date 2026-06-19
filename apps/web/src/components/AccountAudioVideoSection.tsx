import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Volume2, Video } from 'lucide-react';
import { usePreferences } from '../lib/preferences-store.js';

/**
 * Audio & video device settings. Lets the user pick which microphone,
 * speaker, and camera Tavern uses for voice rooms, plus the browser-level
 * mic filters (noise suppression / echo cancellation / auto gain). The
 * device picks persist client-side and are applied to the live LiveKit room
 * immediately (see the switchActiveDevice effects in VoiceRoom).
 *
 * Test affordances let you confirm hardware works without joining a room —
 * the usual fix for "we both joined but can't hear each other" is the wrong
 * default mic or speaker being selected.
 */
export function AccountAudioVideoSection(): JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [permissionAsked, setPermissionAsked] = useState(false);

  const refreshDevices = useCallback(async (): Promise<void> => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    const onChange = (): void => void refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
  }, [refreshDevices]);

  // Labels are blank until the page has been granted mic/camera access once.
  // This briefly lights the camera, so it's an explicit, user-initiated button.
  const grantAccess = useCallback(async (): Promise<void> => {
    setPermissionAsked(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      // Camera may be absent or denied — try audio alone so at least the mic
      // and speaker lists get real names.
      try {
        const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioOnly.getTracks().forEach((t) => t.stop());
      } catch {
        // Nothing we can do; the selects fall back to generic labels.
      }
    }
    await refreshDevices();
  }, [refreshDevices]);

  const mics = devices.filter((d) => d.kind === 'audioinput');
  const speakers = devices.filter((d) => d.kind === 'audiooutput');
  const cameras = devices.filter((d) => d.kind === 'videoinput');
  const labelsHidden = devices.length > 0 && devices.every((d) => d.label === '');

  return (
    <section className="rounded border border-subtle bg-surface p-5">
      <h2 className="font-serif text-lg">Audio &amp; video</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Choose which microphone, speaker, and camera Tavern uses in voice rooms. Saved on this
        device and applied straight away — no need to step out and back in.
      </p>

      {labelsHidden && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded border border-subtle bg-sunken px-3 py-2 text-sm text-fg-muted">
          <span>Allow access so we can show your device names.</span>
          <button type="button" className="btn-ghost" onClick={() => void grantAccess()}>
            {permissionAsked ? 'Try again' : 'Allow access'}
          </button>
        </div>
      )}

      <div className="mt-4 grid gap-4">
        <MicrophoneSetting devices={mics} />
        <SpeakerSetting devices={speakers} />
        <CameraSetting devices={cameras} />
      </div>

      <VoiceFilterPreferences />
    </section>
  );
}

/** Build the `<option>`s, falling back to a numbered label before permission. */
function DeviceOptions({ devices, kind }: { devices: MediaDeviceInfo[]; kind: string }): JSX.Element {
  return (
    <>
      <option value="default">System default</option>
      {devices
        .filter((d) => d.deviceId && d.deviceId !== 'default')
        .map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${kind} ${i + 1}`}
          </option>
        ))}
    </>
  );
}

function MicrophoneSetting({ devices }: { devices: MediaDeviceInfo[] }): JSX.Element {
  const value = usePreferences((s) => s.audioInputDeviceId);
  const setValue = usePreferences((s) => s.setAudioInputDeviceId);
  const [level, setLevel] = useState(0);
  const [testing, setTesting] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const stopTest = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setTesting(false);
    setLevel(0);
  }, []);

  const startTest = useCallback(async (): Promise<void> => {
    stopTest();
    try {
      const constraints: MediaStreamConstraints = {
        audio: value !== 'default' ? { deviceId: { exact: value } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let raf = 0;
      const tick = (): void => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) {
          const centered = (v - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / buf.length);
        setLevel(Math.min(1, rms * 3));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      setTesting(true);
      cleanupRef.current = () => {
        cancelAnimationFrame(raf);
        source.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      };
    } catch {
      setTesting(false);
    }
  }, [value, stopTest]);

  useEffect(() => stopTest, [stopTest]);

  return (
    <label className="block">
      <span className="flex items-center gap-1.5 text-xs text-fg-muted">
        <Mic size={13} /> Microphone
      </span>
      <div className="mt-1 flex items-center gap-2">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="input w-full"
        >
          <DeviceOptions devices={devices} kind="Microphone" />
        </select>
        <button
          type="button"
          className="btn-ghost shrink-0"
          onClick={() => (testing ? stopTest() : void startTest())}
        >
          {testing ? 'Stop' : 'Test'}
        </button>
      </div>
      {testing && (
        <div className="mt-2 h-2 w-full overflow-hidden rounded bg-sunken" aria-hidden>
          <div
            className="h-full rounded bg-ember transition-[width] duration-[80ms]"
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
      )}
      {testing && (
        <p className="mt-1 text-xs text-fg-muted">Speak — the bar should move.</p>
      )}
    </label>
  );
}

function SpeakerSetting({ devices }: { devices: MediaDeviceInfo[] }): JSX.Element {
  const value = usePreferences((s) => s.audioOutputDeviceId);
  const setValue = usePreferences((s) => s.setAudioOutputDeviceId);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // setSinkId is the gate for output-device selection. Firefox lacks it, so we
  // hide the selector there and play the test tone through the default device.
  const sinkSupported =
    typeof window !== 'undefined' &&
    typeof HTMLMediaElement !== 'undefined' &&
    'setSinkId' in HTMLMediaElement.prototype;

  const playTest = useCallback(async (): Promise<void> => {
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 440;
      gain.gain.value = 0.0001;
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.7);
      osc.connect(gain);
      gain.connect(dest);
      const el = audioRef.current ?? new Audio();
      audioRef.current = el;
      el.srcObject = dest.stream;
      const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (sinkSupported && value !== 'default' && withSink.setSinkId) {
        await withSink.setSinkId(value).catch(() => undefined);
      }
      osc.start();
      await el.play().catch(() => undefined);
      window.setTimeout(() => {
        osc.stop();
        el.srcObject = null;
        void ctx.close();
      }, 800);
    } catch {
      // Output test is best-effort.
    }
  }, [value, sinkSupported]);

  return (
    <label className="block">
      <span className="flex items-center gap-1.5 text-xs text-fg-muted">
        <Volume2 size={13} /> Speaker
      </span>
      <div className="mt-1 flex items-center gap-2">
        <select
          value={sinkSupported ? value : 'default'}
          onChange={(e) => setValue(e.target.value)}
          className="input w-full"
          disabled={!sinkSupported}
        >
          <DeviceOptions devices={devices} kind="Speaker" />
        </select>
        <button type="button" className="btn-ghost shrink-0" onClick={() => void playTest()}>
          Test
        </button>
      </div>
      {!sinkSupported && (
        <p className="mt-1 text-xs text-fg-muted">
          This browser doesn&rsquo;t support choosing an output device — it uses your system
          default. The test still plays through it.
        </p>
      )}
    </label>
  );
}

function CameraSetting({ devices }: { devices: MediaDeviceInfo[] }): JSX.Element {
  const value = usePreferences((s) => s.videoInputDeviceId);
  const setValue = usePreferences((s) => s.setVideoInputDeviceId);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const stopPreview = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setPreviewing(false);
  }, []);

  const startPreview = useCallback(async (): Promise<void> => {
    stopPreview();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: value !== 'default' ? { deviceId: { exact: value } } : true,
      });
      streamRef.current = stream;
      setPreviewing(true);
      // The <video> mounts in the same render this flips `previewing`, so wait
      // a tick for the ref before attaching the stream.
      window.setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
        }
      }, 0);
    } catch {
      setPreviewing(false);
    }
  }, [value, stopPreview]);

  useEffect(() => stopPreview, [stopPreview]);

  return (
    <label className="block">
      <span className="flex items-center gap-1.5 text-xs text-fg-muted">
        <Video size={13} /> Camera
      </span>
      <div className="mt-1 flex items-center gap-2">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="input w-full"
        >
          <DeviceOptions devices={devices} kind="Camera" />
        </select>
        <button
          type="button"
          className="btn-ghost shrink-0"
          onClick={() => (previewing ? stopPreview() : void startPreview())}
        >
          {previewing ? 'Stop' : 'Test'}
        </button>
      </div>
      {previewing && (
        <video
          ref={videoRef}
          muted
          playsInline
          className="mt-2 aspect-video w-full max-w-xs rounded border border-subtle bg-sunken"
        />
      )}
    </label>
  );
}

/**
 * Browser-level mic filters. Moved here from Appearance so all voice/audio
 * controls live in one place. These apply on the next voice-room join.
 */
function VoiceFilterPreferences(): JSX.Element {
  const noise = usePreferences((s) => s.voiceNoiseSuppression);
  const echo = usePreferences((s) => s.voiceEchoCancellation);
  const gain = usePreferences((s) => s.voiceAutoGain);
  const setNoise = usePreferences((s) => s.setVoiceNoiseSuppression);
  const setEcho = usePreferences((s) => s.setVoiceEchoCancellation);
  const setGain = usePreferences((s) => s.setVoiceAutoGain);
  return (
    <div className="mt-4 border-t border-subtle pt-3">
      <h3 className="text-xs uppercase tracking-wider text-fg-muted">Mic filters</h3>
      <p className="mt-1 text-xs text-fg-muted">
        Browser-level filters applied to your mic. Defaults match what Meet, Teams, and Discord do.
        Changes take effect the next time you join a voice room.
      </p>
      <div className="mt-2 grid gap-2 text-sm md:grid-cols-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={noise} onChange={(e) => setNoise(e.target.checked)} />
          Noise suppression
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={echo} onChange={(e) => setEcho(e.target.checked)} />
          Echo cancellation
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={gain} onChange={(e) => setGain(e.target.checked)} />
          Auto gain
        </label>
      </div>
    </div>
  );
}
