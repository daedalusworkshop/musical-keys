// A deliberately finite harmonic vocabulary. Jev supplies feelings, not notes.
export const CHORDS = [
  { id: 'Cmaj7', name: 'C major 7', root: 0, notes: [0, 4, 7, 11], brightness: .82, strain: .13 },
  { id: 'Dm7', name: 'D minor 7', root: 2, notes: [2, 5, 9, 0], brightness: .42, strain: .25 },
  { id: 'Em7', name: 'E minor 7', root: 4, notes: [4, 7, 11, 2], brightness: .48, strain: .28 },
  { id: 'Fmaj7', name: 'F major 7', root: 5, notes: [5, 9, 0, 4], brightness: .74, strain: .17 },
  { id: 'G7', name: 'G dominant 7', root: 7, notes: [7, 11, 2, 5], brightness: .62, strain: .72 },
  { id: 'Am7', name: 'A minor 7', root: 9, notes: [9, 0, 4, 7], brightness: .29, strain: .25 },
  { id: 'Bdim', name: 'B diminished', root: 11, notes: [11, 2, 5, 9], brightness: .16, strain: .92 },
  { id: 'Csus2', name: 'C suspended 2', root: 0, notes: [0, 2, 7], brightness: .58, strain: .4 }
];
const scale = [0, 2, 4, 5, 7, 9, 11];
const clamp = x => Math.max(0, Math.min(1, x));
const distance = (a, b) => Math.min(Math.abs(a - b), 12 - Math.abs(a - b));
const hash = s => [...s].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) | 0, 7) >>> 0;
const nearestTone = (midi, tones) => tones
  .flatMap(pc => [60 + pc, 72 + pc, 84 + pc])
  .filter(note => note <= 84)
  .sort((a, b) => Math.abs(a - midi) - Math.abs(b - midi) || a - b)[0];

function variedMotif(notes, previous, chord) {
  if (!Array.isArray(previous?.notes) || !previous.notes.length) return notes;
  return notes.map((note, i) => {
    const source = previous.notes[Math.min(previous.notes.length - 1, Math.floor(i * previous.notes.length / notes.length))];
    if (!Number.isFinite(source?.midi)) return note;
    // Keep the earlier contour. One changed tone makes the revision audible.
    const sourceMidi = i === Math.floor(notes.length / 2) ? source.midi + 2 : source.midi;
    return { ...note, midi: nearestTone(sourceMidi, chord.notes) };
  });
}

function voicedChord(chord, previous, seed) {
  const tones = chord.notes.map(pc => 48 + pc).sort((a, b) => a - b);
  const oldBass = Array.isArray(previous?.chordNotes) ? Math.min(...previous.chordNotes) % 12 : null;
  const oldIndex = tones.findIndex(note => note % 12 === oldBass);
  const inversion = oldIndex < 0 ? hash(seed) % tones.length : (oldIndex + 1) % tones.length;
  return tones.slice(inversion).concat(tones.slice(0, inversion).map(note => note + 12));
}

export function compose(emotion, previous = null, seed = '') {
  const valence = clamp(emotion.valence);
  const arousal = clamp(emotion.arousal);
  const friction = clamp(emotion.friction);
  // Missing continuity retains the original composition rules for older callers.
  const continuity = Number.isFinite(emotion.continuity) ? clamp(emotion.continuity) : null;
  const previousTension = previous?.tension ?? .18;
  // Memory lets suspense develop over a conversation without forcing every line to resolve.
  const memory = continuity === null ? .57 : .18 + continuity * .47;
  const tension = clamp(previousTension * memory + friction * (1 - memory) + (friction > .65 ? .08 : -.04));
  const targetBrightness = valence;
  const previousChord = CHORDS.find(c => c.id === previous?.chordId);
  const desiredStrain = tension * .86;
  const ranked = CHORDS.map(chord => {
    let cost = 1.15 * Math.abs(chord.brightness - targetBrightness)
      + 1.3 * Math.abs(chord.strain - desiredStrain);
    if (previousChord) {
      cost += .035 * distance(chord.root, previousChord.root);
      if (chord.id === previousChord.id) cost += continuity === null ? .16 : .32 - continuity * .48;
      if (previousChord.strain > .6 && friction < .4 && chord.id === 'Cmaj7') cost -= .32;
    }
    return { chord, cost };
  }).sort((a, b) => a.cost - b.cost);
  // A strong emotional turn can replace the harmony even when the words continue a thought.
  const emotionalTurn = previousChord && (
    Math.abs(valence - previousChord.brightness) > .38 ||
    Math.abs(tension - previousTension) > .3 ||
    (friction > .78 && previousChord.strain < .4) ||
    (friction < .18 && previousChord.strain > .65)
  );
  const chord = continuity >= .7 && previousChord && !emotionalTurn ? previousChord : ranked[0].chord;
  // A single session pulse keeps adjacent messages musically connected.
  // Arousal changes density and dynamics, not the clock under the listener.
  const bpm = 84;
  const density = arousal > .68 ? 8 : arousal > .38 ? 6 : 4;
  const step = 8 / density; // two bars of 4/4
  const salt = hash(seed);
  let notes = Array.from({ length: density }, (_, i) => {
    const tones = i === density - 1 ? chord.notes : (i % 3 === 2 ? scale : chord.notes);
    const pc = tones[(salt + i * 3 + Math.floor(i / 3)) % tones.length];
    const octave = 72 + pc + (i > density / 2 && arousal > .64 ? 0 : -12);
    const midi = Math.max(60, Math.min(84, octave));
    return { midi, beat: i * step, duration: Math.min(step * .82, 1.05), velocity: .34 + arousal * .32 };
  });
  if (continuity >= .7 && previousChord?.id === chord.id && !emotionalTurn) {
    notes = variedMotif(notes, previous, chord);
  }
  const chordNotes = continuity >= .7 && previousChord?.id === chord.id && !emotionalTurn
    ? voicedChord(chord, previous, seed)
    : chord.notes.map(pc => 48 + pc);
  const alternatives = continuity === null
    ? ranked.slice(1, 3).map(x => x.chord.id)
    : ranked.filter(x => x.chord.id !== chord.id).slice(0, 2).map(x => x.chord.id);
  const selectionMode = continuity >= .7 && previousChord && !emotionalTurn ? 'variation' : 'new harmony';
  return { chordId: chord.id, chordName: chord.name, chordNotes, tension, bpm, notes, durationBeats: 8, alternatives,
    trace: {
      selectionMode,
      emotionalTurn: Boolean(emotionalTurn),
      previousChord: previousChord?.id || null,
      previousTension,
      targetBrightness,
      targetStrain: desiredStrain,
      candidates: ranked.map(({ chord: candidate, cost }) => ({ chordId: candidate.id, cost: Math.round(cost * 1000) / 1000 }))
    }
  };
}

