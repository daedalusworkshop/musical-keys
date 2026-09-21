import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLocally, buildJevRequest, normalizeJevAnswers, questions, traceJevAnswers, traceLocalAnalysis } from '../src/emotion.mjs';

const answer = (score, confidence = 1) => ({ type: 'score', score, confidence });
const answers = () => Object.fromEntries(Object.keys(questions).map(axis => [axis, answer(2)]));

test('Jev request asks narrow scores and compares continuity with only the immediate predecessor', () => {
  const request = buildJevRequest('Actually, I meant tomorrow', ['old topic', 'Let us meet today'], 'jev-latest');
  assert.deepEqual(request.state, {
    earlier_messages: ['old topic'],
    immediately_previous_message: 'Let us meet today',
    current_message: 'Actually, I meant tomorrow'
  });
  assert.deepEqual(Object.keys(request.questions), ['valence', 'arousal', 'friction', 'continuity']);
  assert.ok(Object.values(request.questions).every(q => q.type === 'score' && q.criteria.length === 5));
  assert.match(request.questions.continuity.instructions, /immediately_previous_message/);
  assert.ok(!JSON.stringify(request.questions).toLowerCase().includes('chord'));
});

test('first message omits continuity question and returns a defined new-thought value', () => {
  const request = buildJevRequest('Hello');
  assert.equal(request.state.immediately_previous_message, null);
  assert.ok(!('continuity' in request.questions));
  const result = normalizeJevAnswers(answers());
  assert.equal(result.continuity, 0);
  assert.equal(result.confidence.continuity, null);
  assert.equal(analyzeLocally('Hello').continuity, 0);
});

test('valid scores normalize to zero through one and keep per-axis confidence', () => {
  const input = answers();
  input.valence = answer(4, 0.9);
  input.arousal = answer(0, 0.8);
  input.continuity = answer(3, 0.7);
  const result = normalizeJevAnswers(input, true);
  assert.equal(result.valence, 1);
  assert.equal(result.arousal, 0);
  assert.equal(result.friction, 0.5);
  assert.equal(result.continuity, 0.75);
  assert.equal(result.confidence.continuity, 0.7);
});

test('low-confidence readings move toward conservative baselines', () => {
  const input = answers();
  input.valence = answer(4, 0);
  input.arousal = answer(4, 0);
  input.friction = answer(4, 0);
  input.continuity = answer(4, 0);
  const result = normalizeJevAnswers(input, true);
  assert.deepEqual([result.valence, result.arousal, result.friction, result.continuity], [0.5, 0.3, 0, 0]);
  assert.equal(result.confidence.valence, 0);
});

test('malformed or missing required Jev answers fail closed', () => {
  for (const malformed of [answer(-0.1), answer(4.1), answer(NaN), answer(2, 1.1), { type: 'choice', score: 2, confidence: 1 }, { type: 'score', score: 2 }]) {
    assert.throws(() => normalizeJevAnswers({ ...answers(), continuity: malformed }, true), /Invalid Jev continuity answer/);
  }
  assert.throws(() => normalizeJevAnswers({ ...answers(), continuity: undefined }, true));
});

test('offline demo continuity is contextual but remains labeled as an estimate', () => {
  assert.ok(analyzeLocally('Actually, the blue door', 'The blue door is open').continuity > 0);
  assert.equal(analyzeLocally('A different idea', 'The blue door is open').continuity, 0);
  assert.ok(analyzeLocally('I want a black cat', 'I want a cat').continuity >= 0.7);
  assert.ok(analyzeLocally('I want a dog', 'I want a cat').continuity < 0.7);
  assert.equal(analyzeLocally('A different idea', 'The blue door is open').confidence.continuity, null);
});

test('Jev trace preserves each rubric and probability while exposing the value used', () => {
  const response = Object.fromEntries(Object.keys(questions).map(axis => [axis, {
    type: 'score', score: 2, confidence: 0.7,
    probabilities: { '0': 0, '1': 0.2, '2': 0.6, '3': 0.2, '4': 0 }
  }]));
  const normalized = normalizeJevAnswers(response, true);
  const request = buildJevRequest('hello', ['hi'], 'jev-test');
  const trace = traceJevAnswers(response, normalized, true, 'jev-test', { input_tokens: 12, output_tokens: 8 }, request);
  assert.equal(trace.kind, 'jev');
  assert.equal(trace.model, 'jev-test');
  assert.deepEqual(trace.dimensions.valence.probabilities, [0, 0.2, 0.6, 0.2, 0]);
  assert.deepEqual(trace.dimensions.valence.levels, questions.valence.criteria);
  assert.equal(trace.dimensions.valence.used, 0.5);
  assert.deepEqual(trace.usage, { inputTokens: 12, outputTokens: 8 });
  assert.equal(trace.raw.request.state.current_message, 'hello');
  assert.equal(trace.raw.response.answers.valence.score, 2);
  assert.ok(!JSON.stringify(trace.raw).includes('Authorization'));
  assert.equal(traceJevAnswers(response, normalized).dimensions.continuity.asked, false);
  assert.throws(() => traceJevAnswers({ ...response, valence: { ...response.valence, probabilities: {} } }, normalized, true), /probabilities/);
});

test('local trace never invents Jev confidence or probabilities', () => {
  const estimate = analyzeLocally('I want a cat');
  const trace = traceLocalAnalysis(estimate);
  assert.equal(trace.kind, 'local-demo');
  assert.equal(trace.dimensions.valence.asked, false);
  assert.equal(trace.dimensions.valence.probabilities, undefined);
});

