/**
 * Decode an audio file with Web Audio and reduce it to a small array of peak
 * values per bucket, normalised to [0, 255]. We use this for voice-message
 * waveforms so the worker doesn't need ffmpeg.
 *
 * Falls back gracefully — callers should catch errors and use the worker's
 * placeholder waveform if decoding fails.
 */

export interface DecodedPeaks {
  peaks: number[];
  durationMs: number;
}

const AudioContextCtor: typeof AudioContext | undefined =
  typeof window === 'undefined'
    ? undefined
    : window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

export async function decodeAudioPeaks(file: Blob, buckets = 32): Promise<DecodedPeaks> {
  if (!AudioContextCtor) throw new Error('No AudioContext available');

  const arrayBuffer = await file.arrayBuffer();
  const ctx = new AudioContextCtor();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const channelData = audioBuffer.getChannelData(0);
    const samplesPerBucket = Math.max(1, Math.floor(channelData.length / buckets));
    const peaks: number[] = [];
    let max = 0;
    for (let i = 0; i < buckets; i++) {
      const start = i * samplesPerBucket;
      const end = Math.min(start + samplesPerBucket, channelData.length);
      let peak = 0;
      for (let j = start; j < end; j++) {
        const v = Math.abs(channelData[j] ?? 0);
        if (v > peak) peak = v;
      }
      peaks.push(peak);
      if (peak > max) max = peak;
    }
    // Normalise to 0..255 with a guard against silent audio.
    const normalised = peaks.map((p) => Math.round((p / (max || 1)) * 255));
    return {
      peaks: normalised,
      durationMs: Math.round(audioBuffer.duration * 1000),
    };
  } finally {
    void ctx.close();
  }
}
