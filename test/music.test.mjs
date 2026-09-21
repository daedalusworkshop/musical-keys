import test from 'node:test';
import assert from 'node:assert/strict';
import { compose, CHORDS } from '../src/music.mjs';
import { normalizeJevAnswers } from '../src/emotion.mjs';

test('every phrase uses the closed vocabulary and playable notes', () => {
  let previous;
  for (let i = 0; i < 100; i++) {
    const phrase = compose({ valence: i / 99, arousal: (i * 17 % 100) / 99, friction: (i * 29 % 100) / 99 }, previous, String(i));
    assert.ok(CHORDS.some(c => c.id === phrase.chordId));
    assert.ok(phrase.notes.every(n => n.midi >= 60 && n.midi <= 84 && n.beat < 8));
    assert.ok(phrase.tension >= 0 && phrase.tension <= 1);
    previous = phrase;
  }
});

test('high friction raises remembered tension; low friction releases it', () => {
  let phrase = compose({ valence: .5, arousal: .5, friction: 1 }, null, 'a');
  const high = phrase.tension;
  phrase = compose({ valence: .5, arousal: .5, friction: 0 }, phrase, 'b');
  assert.ok(phrase.tension < high);
});

test('arousal changes the phrase without changing the session pulse', () => {
  const quiet = compose({ valence: .5, arousal: .1, friction: .2 }, null, 'pulse');
  const animated = compose({ valence: .5, arousal: .9, friction: .2 }, quiet, 'pulse');
  assert.equal(quiet.bpm, 84);
  assert.equal(animated.bpm, 84);
  assert.ok(animated.notes.length > quiet.notes.length);
});

test('continuing a thought keeps harmony while revising its voicing and motif', () => {
  const first = compose({ valence: .8, arousal: .5, friction: .1 }, null, 'first');
  const revised = compose({ valence: .8, arousal: .5, friction: .1, continuity: 1 }, first, 'second');
  assert.equal(revised.chordId, first.chordId);
  assert.notDeepEqual(revised.chordNotes, first.chordNotes);
  assert.notDeepEqual(revised.notes.map(n => n.midi), first.notes.map(n => n.midi));
  assert.ok(revised.notes.filter((n, i) => n.midi === first.notes[i].midi).length >= 3);
  assert.deepEqual(
    revised.chordNotes.map(n => n % 12).sort((a, b) => a - b),
    first.chordNotes.map(n => n % 12).sort((a, b) => a - b)
  );
});

test('a new thought can find fresh harmony with the same emotional tone', () => {
  const first = compose({ valence: .8, arousal: .5, friction: .1 }, null, 'first');
  const fresh = compose({ valence: .8, arousal: .5, friction: .1, continuity: 0 }, first, 'second');
  assert.notEqual(fresh.chordId, first.chordId);
  assert.ok(CHORDS.some(c => c.id === fresh.chordId));
});

test('a sharp emotional and tension shift overrides high continuity', () => {
  const settled = compose({ valence: .8, arousal: .5, friction: .1 }, null, 'first');
  const disturbed = compose({ valence: .1, arousal: .5, friction: .95, continuity: 1 }, settled, 'second');
  assert.notEqual(disturbed.chordId, settled.chordId);
  assert.ok(disturbed.tension > settled.tension + .3);
  const released = compose({ valence: .8, arousal: .5, friction: 0, continuity: 0 }, disturbed, 'third');
  assert.ok(released.tension < disturbed.tension);
});

test('omitting continuity preserves the original tension rule', () => {
  const phrase = compose({ valence: .5, arousal: .5, friction: .6 }, { tension: .4 }, 'legacy');
  assert.equal(phrase.tension, .4 * .57 + .6 * .43 - .04);
});

test('Jev scores are normalized and malformed answers fail closed', () => {
  const answers = Object.fromEntries(['valence', 'arousal', 'friction'].map(axis => [axis, { type: 'score', score: 2, confidence: .7 }]));
  assert.equal(normalizeJevAnswers(answers).valence, .5);
  assert.throws(() => normalizeJevAnswers({ ...answers, arousal: { score: 7, type: 'score' } }));
});

