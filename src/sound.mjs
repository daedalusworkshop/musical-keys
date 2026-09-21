// Original Web Audio instrument: note-retaining chord changes inspired by
// Headroom Organ. No source code or sample assets are copied.
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, name) => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
};

export const midiFrequency = midi => 440 * 2 ** ((midi - 69) / 12);

// Filenames and pitches are factual metadata for the CC0 VCSL recordings
// identified in Headroom Organ's THIRD-PARTY-NOTICES.md.
export const ORGAN_SAMPLE_FILES = Object.freeze([
  { midi: 46, file: 'Asharp1.wav' }, { midi: 50, file: 'D2.wav' },
  { midi: 52, file: 'E2.wav' }, { midi: 58, file: 'Asharp2.wav' },
  { midi: 60, file: 'C3.wav' }, { midi: 62, file: 'D3.wav' },
  { midi: 64, file: 'E3.wav' }, { midi: 66, file: 'Fsharp3.wav' },
  { midi: 68, file: 'Gsharp3.wav' }, { midi: 72, file: 'C4.wav' }
]);

export function planPhrase(phrase) {
  if (!phrase || !Array.isArray(phrase.chordNotes) || !Array.isArray(phrase.notes)) {
    throw new TypeError('Expected a phrase with chordNotes and notes arrays');
  }
  const bpm = clamp(finite(phrase.bpm, 'bpm'), 40, 200);
  const durationBeats = clamp(finite(phrase.durationBeats, 'durationBeats'), 1, 32);
  const tension = clamp(finite(phrase.tension ?? 0, 'tension'), 0, 1);
  const beatSeconds = 60 / bpm;
  const chordNotes = [...new Set(phrase.chordNotes.slice(0, 8).map(midi => clamp(finite(midi, 'chord midi'), 24, 96)))];
  const chord = chordNotes.map((midi, index) => ({
    midi,
    start: 0,
    duration: durationBeats * beatSeconds,
    velocity: 0.28,
    pan: chordNotes.length === 1 ? 0 : (index / (chordNotes.length - 1) - 0.5) * 1.3,
    kind: 'chord'
  }));
  const melody = phrase.notes.slice(0, 64).map((note, index) => {
    if (!note || typeof note !== 'object') throw new TypeError('Expected note objects');
    const startBeat = clamp(finite(note.beat, 'note beat'), 0, durationBeats);
    return {
      midi: clamp(finite(note.midi, 'note midi'), 36, 108),
      start: startBeat * beatSeconds,
      duration: clamp(finite(note.duration, 'note duration'), 0.05, durationBeats - startBeat || 0.05) * beatSeconds,
      velocity: clamp(finite(note.velocity, 'note velocity'), 0, 1),
      pan: Math.sin(index * 1.9) * 0.48,
      kind: 'melody'
    };
  });
  if (!chord.length && !melody.length) throw new TypeError('Phrase has no playable notes');
  return { chord, melody, events: [...chord, ...melody], duration: durationBeats * beatSeconds, tension };
}

function hold(param, at) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(at);
  else {
    param.cancelScheduledValues(at);
    param.setValueAtTime(param.value, at);
  }
}

function sampleVoice(ctx, bus, event, start, sustained, samples, setTimer, clearTimer) {
  const nearest = [...samples].reduce((best, entry) =>
    !best || Math.abs(entry[0] - event.midi) < Math.abs(best[0] - event.midi) ? entry : best, null);
  const [sampleMidi, sample] = nearest;
  const { buffer, scale } = sample;
  const rate = 2 ** ((event.midi - sampleMidi) / 12);
  const pan = ctx.createStereoPanner?.();
  if (pan) pan.pan.setValueAtTime(event.pan, start);
  const destination = pan || bus;
  if (pan) pan.connect(bus);
  const layers = new Set();
  let timer;
  const result = {
    released: false,
    release(at, seconds) {
      if (result.released) return;
      result.released = true;
      if (timer !== undefined) clearTimer(timer);
      for (const layer of layers) {
        hold(layer.gain.gain, at);
        layer.gain.gain.linearRampToValueAtTime(0, at + seconds);
        try { layer.source.stop(at + seconds + 0.02); } catch { /* already ended */ }
      }
      if (!layers.size) pan?.disconnect();
    }
  };
  function layer(at, renewed = false) {
    if (result.released) return;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(rate, at);
    source.connect(gain).connect(destination);
    const length = buffer.duration / rate;
    const overlap = Math.min(0.9, Math.max(0.55, length * 0.12), length * 0.5);
    const level = event.velocity * (sustained ? 0.5 : 0.62) * scale;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + (renewed ? overlap : Math.min(0.13, length * 0.25)));
    gain.gain.setValueAtTime(level, at + length - overlap);
    gain.gain.linearRampToValueAtTime(0, at + length);
    const current = { source, gain };
    layers.add(current);
    source.onended = () => {
      layers.delete(current);
      source.disconnect();
      gain.disconnect();
      if (result.released && !layers.size) pan?.disconnect();
    };
    source.start(at);
    source.stop(at + length + 0.02);
    if (sustained) {
      const nextAt = at + length - overlap;
      // Web Audio can queue the next source before it plays. Give the main
      // thread time to wake up so a delayed timer cannot miss the crossfade.
      const renewalLead = Math.min(0.75, (nextAt - at) * 0.5);
      timer = setTimer(() => layer(nextAt, true), Math.max(0, (nextAt - renewalLead - ctx.currentTime) * 1000));
    }
  }
  layer(start);
  if (!sustained) {
    // The sample may outlast a melody note; its release follows the score.
    timer = setTimer(() => result.release(ctx.currentTime, 0.15),
      Math.max(0, (start + event.duration - ctx.currentTime) * 1000));
  }
  return result;
}

function voice(ctx, bus, event, start, tension, sustained) {
  const gain = ctx.createGain();
  const pan = ctx.createStereoPanner?.();
  if (pan) {
    pan.pan.setValueAtTime(event.pan, start);
    gain.connect(pan).connect(bus);
  } else gain.connect(bus);
  const amplitude = event.velocity * (sustained ? 0.12 : 0.2);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(amplitude, start + (sustained ? 0.13 : 0.025));
  const partials = sustained
    ? [[1, 0.7, 0], [2, 0.2 + tension * 0.06, 0], [1, 0.1, 3.2]]
    : [[1, 0.72, 0], [2, 0.19, 0], [3, 0.09 + tension * 0.06, 0]];
  let remaining = partials.length;
  const oscillators = partials.map(([multiple, level, cents]) => {
    const oscillator = ctx.createOscillator();
    const partialGain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(midiFrequency(event.midi) * multiple, start);
    oscillator.detune?.setValueAtTime(cents, start);
    partialGain.gain.value = level;
    oscillator.connect(partialGain).connect(gain);
    oscillator.onended = () => {
      oscillator.disconnect();
      partialGain.disconnect();
      if (--remaining === 0) {
        gain.disconnect();
        pan?.disconnect();
      }
    };
    oscillator.start(start);
    return oscillator;
  });
  const result = {
    released: false,
    release(at, seconds) {
      if (result.released) return;
      result.released = true;
      hold(gain.gain, at);
      gain.gain.linearRampToValueAtTime(0, at + seconds);
      for (const oscillator of oscillators) {
        try { oscillator.stop(at + seconds + 0.02); } catch { /* already ended */ }
      }
    }
  };
  if (!sustained) {
    const end = start + event.duration;
    gain.gain.setValueAtTime(amplitude, end);
    gain.gain.linearRampToValueAtTime(0, end + 0.15);
    for (const oscillator of oscillators) oscillator.stop(end + 0.17);
  }
  return result;
}

export function createSoundEngine({ context, contextFactory, sampleBaseUrl = globalThis.window ? '/samples/renaissance-organ' : null, fetcher = globalThis.fetch, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let ctx = context;
  const ownsContext = !context;
  let output;
  const chordVoices = new Map();
  let melodyVoices = [];
  let samples = new Map();
  let loadingSamples;
  let generation = 0;
  let disposed = false;

  function getContext() {
    if (!ctx) ctx = (contextFactory || (() => new globalThis.AudioContext()))();
    if (!output) {
      output = ctx.createGain();
      output.gain.value = 0.72;
      const warmth = ctx.createBiquadFilter?.();
      const compressor = ctx.createDynamicsCompressor?.();
      if (warmth) {
        warmth.type = 'lowpass';
        warmth.frequency.value = 13500;
        output.connect(warmth);
        if (compressor) warmth.connect(compressor).connect(ctx.destination);
        else warmth.connect(ctx.destination);
      } else if (compressor) output.connect(compressor).connect(ctx.destination);
      else output.connect(ctx.destination);
    }
    return ctx;
  }

  async function loadSamples(entries) {
    if (disposed) throw new Error('Sound engine is disposed');
    if (!Array.isArray(entries) || !entries.length) throw new TypeError('Expected sample entries');
    const audio = getContext();
    const loaded = new Map();
    for (const entry of entries) {
      const midi = finite(entry?.midi, 'sample midi');
      const input = entry?.data;
      const buffer = input instanceof ArrayBuffer ? await audio.decodeAudioData(input.slice(0)) : input;
      if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
        throw new TypeError('Expected an AudioBuffer or ArrayBuffer for each sample');
      }
      let peak = 0;
      let energy = 0;
      let count = 0;
      for (let channel = 0; channel < (buffer.numberOfChannels || 0); channel++) {
        const data = buffer.getChannelData(channel);
        for (const value of data) {
          peak = Math.max(peak, Math.abs(value));
          energy += value * value;
          count++;
        }
      }
      const rms = count ? Math.sqrt(energy / count) : 0;
      const scale = clamp(Math.min(0.12 / Math.max(rms, 0.001), 0.9 / Math.max(peak, 0.001)), 0.2, 4);
      loaded.set(midi, { buffer, scale });
    }
    if (chordVoices.size || melodyVoices.length) stop(0.1);
    samples = loaded;
    return loaded.size;
  }

  async function loadOrganSamples(baseUrl = sampleBaseUrl) {
    if (!baseUrl) throw new Error('No organ sample location configured');
    if (samples.size) return samples.size;
    if (!loadingSamples) {
      loadingSamples = (async () => {
        const entries = await Promise.all(ORGAN_SAMPLE_FILES.map(async ({ midi, file }) => {
          const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/${file}`);
          if (!response.ok) throw new Error(`Could not load organ sample ${file}`);
          return { midi, data: await response.arrayBuffer() };
        }));
        return loadSamples(entries);
      })();
    }
    try { return await loadingSamples; }
    finally { loadingSamples = undefined; }
  }

  function releaseChord(seconds) {
    if (!ctx) return;
    for (const note of chordVoices.values()) note.release(ctx.currentTime, seconds);
    chordVoices.clear();
  }

  function rest() {
    generation++;
    releaseChord(0.72);
  }

  function stop(fadeSeconds = 0.72) {
    generation++;
    if (!ctx) return;
    const fade = clamp(finite(fadeSeconds, 'fadeSeconds'), 0, 2);
    releaseChord(fade);
    for (const note of melodyVoices) note.release(ctx.currentTime, Math.min(fade, 0.15));
    melodyVoices = [];
  }

  async function playPhrase(phrase) {
    if (disposed) throw new Error('Sound engine is disposed');
    const plan = planPhrase(phrase);
    const request = ++generation;
    const audio = getContext();
    await audio.resume();
    if (sampleBaseUrl && !samples.size) await loadOrganSamples();
    if (disposed || request !== generation) return null;
    const start = audio.currentTime + 0.04;
    const wanted = new Set(plan.chord.map(event => event.midi));
    for (const [midi, note] of chordVoices) {
      if (!wanted.has(midi)) {
        note.release(audio.currentTime, 0.42);
        chordVoices.delete(midi);
      }
    }
    plan.chord.forEach((event, index) => {
      if (!chordVoices.has(event.midi)) chordVoices.set(event.midi,
        samples.size
          ? sampleVoice(audio, output, event, start + index * 0.018, true, samples, setTimer, clearTimer)
          : voice(audio, output, event, start + index * 0.018, plan.tension, true));
    });
    for (const note of melodyVoices) note.release(audio.currentTime, 0.1);
    melodyVoices = plan.melody.map(event => samples.size
      ? sampleVoice(audio, output, event, start + event.start, false, samples, setTimer, clearTimer)
      : voice(audio, output, event, start + event.start, plan.tension, false));
    return { duration: plan.duration, startedAt: start };
  }

  async function dispose() {
    if (disposed) return;
    stop(0);
    disposed = true;
    output?.disconnect();
    if (ownsContext && ctx) await ctx.close();
  }

  return { loadSamples, loadOrganSamples, playPhrase, rest, stop, dispose };
}

