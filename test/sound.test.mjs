import test from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../src/music.mjs';
import { midiFrequency, planPhrase, createSoundEngine, ORGAN_SAMPLE_FILES } from '../src/sound.mjs';

test('composer phrases produce bounded chord and melody events', () => {
  const phrase = compose({ valence: .45, arousal: .72, friction: .4 }, null, 'hello');
  const plan = planPhrase(phrase);
  assert.equal(plan.events.length, phrase.chordNotes.length + phrase.notes.length);
  assert.equal(plan.duration, phrase.durationBeats * 60 / phrase.bpm);
  assert.ok(plan.events.every(event => Number.isFinite(event.start) && event.start >= 0 && event.duration > 0 && Math.abs(event.pan) <= 1));
  assert.equal(midiFrequency(69), 440);
});

test('malformed phrase data fails before creating an audio context', async () => {
  let created = false;
  const engine = createSoundEngine({ contextFactory: () => { created = true; } });
  await assert.rejects(engine.playPhrase({ chordNotes: [48], notes: [{ midi: NaN }], bpm: 80, durationBeats: 8 }), TypeError);
  assert.equal(created, false);
});

test('play, replay, and dispose schedule and release voices', async () => {
  const oscillators = [];
  const timers = new Map();
  let nextTimer = 0;
  const parameter = () => ({
    value: 0,
    setValueAtTime(value) { this.value = value; },
    linearRampToValueAtTime(value) { this.value = value; },
    cancelScheduledValues() {},
    cancelAndHoldAtTime() {}
  });
  const node = () => ({ connect() { return this; }, disconnect() {} });
  const context = {
    currentTime: 1,
    destination: node(),
    resumed: 0,
    async resume() { this.resumed++; },
    createGain() { return { ...node(), gain: parameter() }; },
    createStereoPanner() { return { ...node(), pan: parameter() }; },
    createOscillator() {
      const oscillator = { ...node(), frequency: parameter(), detune: parameter(), start() {}, stops: [], stop(at) { this.stops.push(at); } };
      oscillators.push(oscillator);
      return oscillator;
    }
  };
  const engine = createSoundEngine({ context, setTimer: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimer: id => timers.delete(id) });
  const phrase = compose({ valence: .5, arousal: .2, friction: .3 }, null, 'play');
  const first = await engine.playPhrase(phrase);
  assert.ok(first.duration > 0);
  assert.equal(oscillators.length, (phrase.chordNotes.length + phrase.notes.length) * 3);
  context.currentTime += first.duration + 1;
  assert.ok(oscillators.slice(0, phrase.chordNotes.length * 3).every(oscillator => oscillator.stops.length === 0));
  await engine.playPhrase(phrase);
  assert.equal(context.resumed, 2);
  assert.equal(timers.size, 0); // no phrase-end chord release
  engine.stop();
  await engine.dispose();
  await assert.rejects(engine.playPhrase(phrase), /disposed/);
});

test('shared chord notes keep sounding while departing notes release', async () => {
  const oscillators = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelAndHoldAtTime() {} });
  const node = () => ({ connect() { return this; }, disconnect() {} });
  const context = {
    currentTime: 1, destination: node(), async resume() {},
    createGain() { return { ...node(), gain: param() }; },
    createOscillator() {
      const oscillator = { ...node(), frequency: param(), detune: param(), start() {}, stops: [], stop(at) { this.stops.push(at); } };
      oscillators.push(oscillator);
      return oscillator;
    }
  };
  const engine = createSoundEngine({ context, setTimer() { return 1; }, clearTimer() {} });
  const phrase = chordNotes => ({ chordNotes, notes: [], bpm: 80, durationBeats: 8, tension: .3 });
  await engine.playPhrase(phrase([48, 52, 55]));
  assert.equal(oscillators.length, 9);
  await engine.playPhrase(phrase([48, 52, 59]));
  assert.equal(oscillators.length, 12); // only the new pipe starts
  assert.equal(oscillators.slice(0, 6).filter(oscillator => oscillator.stops.length).length, 0);
  assert.equal(oscillators.slice(6, 9).filter(oscillator => oscillator.stops.length).length, 3);
  engine.rest();
  assert.equal(oscillators.slice(0, 6).filter(oscillator => oscillator.stops.length).length, 6);
});

test('loaded organ recordings replace oscillator pipes and retain common notes', async () => {
  const sources = [];
  const gains = [];
  const timers = new Map();
  let nextTimer = 0;
  const param = () => ({ value: 0, events: [],
    setValueAtTime(value, at) { this.events.push(['set', value, at]); },
    linearRampToValueAtTime(value, at) { this.events.push(['ramp', value, at]); },
    cancelAndHoldAtTime() {} });
  const node = () => ({ connect() { return this; }, disconnect() {} });
  const context = {
    currentTime: 1, destination: node(), async resume() {},
    createGain() { const gain = { ...node(), gain: param() }; gains.push(gain); return gain; },
    createBufferSource() {
      const source = { ...node(), playbackRate: param(), starts: [], start(at) { this.starts.push(at); }, stops: [], stop(at) { this.stops.push(at); } };
      sources.push(source);
      return source;
    },
    createOscillator() { throw new Error('A loaded sample must replace oscillators'); }
  };
  const engine = createSoundEngine({ context,
    setTimer(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimer(id) { timers.delete(id); }
  });
  const buffer = { duration: 3, numberOfChannels: 1, getChannelData() { return new Float32Array([.1, -.1]); } };
  assert.equal(await engine.loadSamples([{ midi: 60, data: buffer }]), 1);
  const phrase = chordNotes => ({ chordNotes, notes: [], bpm: 80, durationBeats: 8, tension: .2 });
  await engine.playPhrase(phrase([60, 64]));
  assert.equal(sources.length, 2);
  assert.equal(timers.size, 2); // the chord renews its samples; no phrase-end rest timer
  const renew = timers.values().next().value;
  context.currentTime += renew.delay / 1000;
  assert.ok(context.currentTime < sources[0].starts[0] + buffer.duration - .55);
  renew.callback();
  assert.equal(sources.length, 3); // the next layer is scheduled before the first fades
  assert.ok(sources[2].starts[0] > context.currentTime); // queued before the crossfade begins
  const oldFade = gains[1].gain.events.at(-1);
  const newFade = gains[3].gain.events[1];
  assert.equal(oldFade[0], 'ramp');
  assert.equal(newFade[0], 'ramp');
  assert.equal(newFade[2], oldFade[2]); // equal fade lengths prevent a gain spike
  await engine.playPhrase(phrase([60, 67]));
  assert.equal(sources.length, 4);
  assert.equal(sources[0].stops.length, 1); // original natural sample end only
  assert.ok(sources[1].stops.length > 1); // departing note fades early
  assert.equal(ORGAN_SAMPLE_FILES.length, 10);
  engine.stop(0);
});

