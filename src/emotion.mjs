// Jev judges four narrow dimensions. The application, not Jev, maps them to music.
// Score levels are ordered descriptions; TypeSafe returns a weighted position from 0 to 4.
export const questions = {
  valence: {
    type: 'score',
    instructions: 'Assess the emotional pleasantness expressed by current_message. Use earlier messages only to interpret its meaning. Judge the speaker\'s expressed tone, not whether its subject is generally good or bad.',
    criteria: ['Pain, dread, grief, or anger is strongly expressed', 'Disappointment, worry, or sadness is expressed', 'The expressed feeling is mixed or emotionally neutral', 'Relief, affection, or hope is expressed', 'Joy, delight, or gratitude is strongly expressed']
  },
  arousal: {
    type: 'score',
    instructions: 'Assess the energy or activation expressed by current_message, independent of whether the feeling is pleasant.',
    criteria: ['Still, drained, or subdued expression', 'Quiet or low-energy expression', 'Ordinary conversational energy', 'Animated or energized expression', 'Intense, urgent, or highly excited expression']
  },
  friction: {
    type: 'score',
    instructions: 'Assess unresolved interpersonal or narrative friction in current_message, using earlier messages for context. Excitement or unpleasant feeling alone does not imply unresolved friction.',
    criteria: ['The thought is settled or resolved', 'A slight open question or uncertainty remains', 'Noticeable unresolved pressure remains', 'Clear conflict, obstacle, or suspense remains', 'Acute unresolved conflict, obstacle, or suspense remains']
  },
  continuity: {
    type: 'score',
    instructions: 'Compare current_message only with immediately_previous_message. How much does the NEW message develop, qualify, correct, or revise the immediately previous thought, instead of starting an independent thought? Topic similarity alone is insufficient; look for a meaningful continuation or revision.',
    criteria: ['Starts a separate thought with no meaningful development of the previous message', 'Touches the previous thought but mainly introduces a new idea', 'Partly develops or modifies the previous thought and partly starts something new', 'Substantially develops, qualifies, or revises the previous thought', 'Directly continues, clarifies, corrects, or revises the previous thought']
  }
};

const axes = ['valence', 'arousal', 'friction', 'continuity'];
const baseline = { valence: 0.5, arousal: 0.3, friction: 0, continuity: 0 };
const confidenceFloor = 0.35;
const clamp = x => Math.max(0, Math.min(1, x));

export function buildJevRequest(text, context = [], model = 'jev-latest') {
  const previous = context.at(-1);
  return {
    model,
    state: {
      earlier_messages: previous ? context.slice(0, -1) : [],
      immediately_previous_message: previous || null,
      current_message: text
    },
    questions: previous ? questions : Object.fromEntries(Object.entries(questions).filter(([axis]) => axis !== 'continuity'))
  };
}

export function normalizeJevAnswers(answers, hasPrevious = false) {
  const values = {};
  const confidence = {};
  for (const axis of axes) {
    if (axis === 'continuity' && !hasPrevious) {
      values[axis] = 0; // A first message begins a new thought by definition.
      confidence[axis] = null;
      continue;
    }
    const answer = answers?.[axis];
    if (answer?.type !== 'score' || !Number.isFinite(answer.score) ||
        answer.score < 0 || answer.score > questions[axis].criteria.length - 1 ||
        !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
      throw new Error(`Invalid Jev ${axis} answer`);
    }
    const normalized = answer.score / (questions[axis].criteria.length - 1);
    // A diffuse answer should not drive an extreme musical change. Keep raw confidence visible.
    const weight = Math.min(1, answer.confidence / confidenceFloor);
    values[axis] = clamp(baseline[axis] + (normalized - baseline[axis]) * weight);
    confidence[axis] = answer.confidence;
  }
  return { ...values, confidence };
}

// A read-only audit of exactly what Jev returned and what our confidence gate used.
// No request state or credential is included: the message is already shown in the thread.
export function traceJevAnswers(answers, normalized, hasPrevious = false, model = 'jev-latest', usage = null, request = null) {
  const dimensions = {};
  for (const axis of axes) {
    const question = questions[axis];
    if (axis === 'continuity' && !hasPrevious) {
      dimensions[axis] = { asked: false, instructions: question.instructions, levels: question.criteria,
        reason: 'First message: there is no previous thought to revise.', used: 0 };
      continue;
    }
    const answer = answers?.[axis];
    const probabilities = question.criteria.map((_, level) => answer?.probabilities?.[String(level)]);
    if (probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1) ||
        Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 0.02) {
      throw new Error(`Invalid Jev ${axis} probabilities`);
    }
    const rawNormalized = answer.score / (question.criteria.length - 1);
    dimensions[axis] = {
      asked: true,
      instructions: question.instructions,
      levels: question.criteria,
      score: answer.score,
      probabilities,
      confidence: answer.confidence,
      rawNormalized,
      confidenceWeight: Math.min(1, answer.confidence / confidenceFloor),
      used: normalized[axis]
    };
  }
  return {
    kind: 'jev', model, dimensions,
    usage: usage && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
      ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : null,
    raw: request ? { request, response: { model, answers, usage } } : null
  };
}

export function traceLocalAnalysis(normalized, hasPrevious = false) {
  const dimensions = Object.fromEntries(axes.map(axis => [axis, {
    asked: false,
    instructions: questions[axis].instructions,
    levels: questions[axis].criteria,
    reason: axis === 'continuity' && !hasPrevious ? 'First message: no previous thought.' : 'Local word-cue estimate; Jev was not called.',
    used: normalized[axis]
  }]));
  return { kind: 'local-demo', model: null, dimensions, usage: null };
}

// OFFLINE DEMO ONLY: word cues and overlap are not substitutes for Jev judgments.
export function analyzeLocally(text, previousMessage = null) {
  const words = text.toLowerCase().match(/[a-z']+/g) || [];
  const count = set => words.filter(w => set.includes(w)).length;
  const positive = count(['love', 'happy', 'glad', 'wonderful', 'beautiful', 'great', 'good', 'excited', 'thank', 'thanks', 'hope', 'yes', 'laugh', 'miss']);
  const negative = count(['sad', 'hurt', 'angry', 'afraid', 'scared', 'hate', 'sorry', 'lost', 'bad', 'worry', 'worried', 'alone', 'no']);
  const tense = count(['but', 'if', 'maybe', 'wait', 'why', 'never', "can't", 'cannot', 'please', 'need', 'unsure']);
  const meaningful = input => new Set((input.toLowerCase().match(/[a-z']+/g) || [])
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'that', 'this', 'with', 'have', 'from', 'your', 'about', 'just', 'want'].includes(w)));
  const current = meaningful(text);
  const prior = previousMessage ? meaningful(previousMessage) : new Set();
  const overlap = [...current].filter(w => prior.has(w)).length;
  const union = new Set([...current, ...prior]).size;
  const continuationCue = /^(but|and|also|actually|because|so|yes|no|wait|i mean|to clarify)\b/i.test(text.trim());
  const relativeCue = /^(who|which|that|it|they|he|she)\b/i.test(text.trim());
  const expandsPrevious = prior.size > 0 && [...prior].every(w => current.has(w)) && current.size > prior.size;
  return {
    valence: clamp(0.5 + 0.18 * (positive - negative)),
    arousal: clamp(0.27 + 0.14 * Math.min(3, (text.match(/[!?]/g) || []).length) + 0.09 * Math.min(3, positive + negative)),
    friction: clamp(0.12 + 0.15 * tense + 0.12 * negative),
    continuity: previousMessage ? clamp(Math.max(expandsPrevious ? 0.82 : 0, relativeCue ? 0.78 : 0,
      0.75 * (union ? overlap / union : 0) + (continuationCue ? 0.25 : 0))) : 0,
    confidence: { valence: null, arousal: null, friction: null, continuity: null }
  };
}

