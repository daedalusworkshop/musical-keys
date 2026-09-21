import { compose } from './src/music.mjs';
import { createSoundEngine } from './src/sound.mjs';

const $ = selector => document.querySelector(selector);
const messagesEl = $('#messages');
const input = $('#messageInput');
const scroll = $('#threadScroll');
const soundEngine = createSoundEngine({ sampleBaseUrl: '/samples/renaissance-organ' });
const stored = (() => { try { return JSON.parse(localStorage.getItem('musical-keys-v1')) || []; } catch { return []; } })();
const messages = Array.isArray(stored) ? stored.filter(m => typeof m.text === 'string' && m.phrase && m.emotion).slice(-40) : [];
let selected = null;

const labels = { valence: 'valence', arousal: 'energy', friction: 'friction', continuity: 'thought link' };
const axes = Object.keys(labels);
const percent = value => `${Math.round(Math.max(0, Math.min(1, value || 0)) * 100)}%`;
const el = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};

function persist() {
  try { localStorage.setItem('musical-keys-v1', JSON.stringify(messages.slice(-40))); } catch { /* storage is optional */ }
}

function renderMessage(message, index) {
  const row = el('div', 'message-row');
  const line = el('button', 'bubble', message.text);
  line.type = 'button';
  line.title = 'Play this message';
  line.addEventListener('click', () => { select(index); play(message.phrase); });
  const meta = el('div', 'message-meta');
  const mode = message.phrase.trace?.selectionMode === 'variation' ? 'variation' : 'new phrase';
  meta.append(el('span', 'sound-tag', `↳ ${message.phrase.chordId} · ${mode}`));
  const inspect = el('button', 'trace-link', 'inspect decision ↗');
  inspect.type = 'button';
  inspect.addEventListener('click', () => { select(index); $('#inspector').classList.add('is-open'); });
  meta.append(inspect);
  row.append(line, meta);
  messagesEl.append(row);
}

function renderTrace(trace) {
  const list = $('#decisionList');
  list.replaceChildren();
  if (!trace?.dimensions) {
    $('#traceModel').textContent = '—';
    $('#traceIntro').textContent = 'This message was created before decision tracing was enabled. Send a new message to see the full readout.';
    $('#rawPanel').hidden = true;
    return;
  }
  const jev = trace.kind === 'jev';
  const usage = trace.usage ? ` · ${trace.usage.inputTokens} input tokens` : '';
  $('#traceModel').textContent = jev ? `${trace.model}${usage}` : 'local demo';
  $('#traceIntro').textContent = jev
    ? 'The exact rubric, score, probabilities, and confidence returned for this message. “Used” is the value after the app’s confidence gate.'
    : 'Jev was not called. These are simple offline estimates; they have no model probability distribution or confidence.';
  $('#rawPanel').hidden = !trace.raw;
  $('#rawPanel').open = false;
  $('#rawPayload').textContent = trace.raw ? JSON.stringify(trace.raw, null, 2) : '';

  for (const axis of axes) {
    const decision = trace.dimensions[axis];
    if (!decision) continue;
    const card = el('details', 'decision-card');
    if (axis === 'valence') card.open = true;
    const summary = el('summary');
    const title = el('div', 'decision-summary');
    title.append(el('span', 'decision-name', labels[axis]));
    const value = decision.asked ? `${decision.score.toFixed(2)} / 4` :
      jev ? 'not asked' : percent(decision.used);
    title.append(el('span', 'decision-value', value));
    summary.append(title);
    const sub = el('div', 'decision-sub');
    sub.append(el('span', '', decision.asked ? `used ${percent(decision.used)}` : jev ? 'not evaluated' : 'offline estimate'));
    sub.append(el('span', '', decision.asked ? `${percent(decision.confidence)} confidence` : ''));
    summary.append(sub);
    const mini = el('div', `mini-bars${decision.asked ? '' : ' missing'}`);
    for (const probability of decision.probabilities || [0, 0, 0, 0, 0]) {
      const bar = el('span');
      bar.style.height = `${Math.max(2, Math.round(probability * 28))}px`;
      mini.append(bar);
    }
    summary.append(mini);
    card.append(summary);

    const detail = el('div', 'decision-detail');
    detail.append(el('p', 'question', decision.instructions));
    detail.append(el('div', 'trace-caption', decision.asked ? 'rubric · probability for each level' : 'reference rubric · no Jev probabilities'));
    (decision.levels || []).forEach((level, levelIndex) => {
      const row = el('div', 'level-row');
      row.append(el('span', 'level-index', String(levelIndex)));
      const body = el('span', 'level-body');
      body.append(el('span', 'level-label', level));
      const track = el('span', 'level-track');
      const fill = el('span', 'level-fill');
      fill.style.width = decision.asked ? percent(decision.probabilities[levelIndex]) : '0%';
      track.append(fill);
      body.append(track);
      row.append(body, el('span', 'level-percent', decision.asked ? percent(decision.probabilities[levelIndex]) : '—'));
      detail.append(row);
    });
    const calculation = el('div', 'trace-calculation');
    if (decision.asked) {
      calculation.append(el('div', '', `raw ${percent(decision.rawNormalized)} → confidence weight ${percent(decision.confidenceWeight)} → used ${percent(decision.used)}`));
      calculation.append(el('div', '', 'Confidence describes how concentrated Jev’s answer is, not a guarantee of correctness.'));
    } else {
      calculation.textContent = decision.reason || 'Not evaluated.';
    }
    detail.append(calculation);
    card.append(detail);
    list.append(card);
  }
}

function select(index) {
  selected = index;
  [...messagesEl.children].forEach((row, i) => row.classList.toggle('selected', i === index));
  renderTrace(messages[index]?.emotion?.trace);
}

async function play(phrase) {
  try { await soundEngine.playPhrase(phrase); }
  catch { showError('Audio is unavailable in this browser. Your message is still saved.'); }
}

function showError(message) { $('#error').textContent = message; $('#error').hidden = false; }

async function send() {
  if ($('#sendButton').disabled) return;
  const text = input.value.trim();
  if (!text) return;
  $('#error').hidden = true;
  $('#sendButton').disabled = true;
  $('#sendButton').textContent = '…';
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, context: messages.slice(-4).map(m => m.text) })
    });
    const emotion = await response.json();
    if (!response.ok) throw new Error(emotion.error || 'Analysis failed');
    const phrase = compose(emotion, messages.at(-1)?.phrase, text);
    const message = { text, emotion, phrase };
    messages.push(message);
    renderMessage(message, messages.length - 1);
    select(messages.length - 1);
    persist();
    input.value = '';
    input.style.height = 'auto';
    $('#charCount').textContent = '0 / 2000';
    $('#form').scrollIntoView({ block: 'nearest' });
    await play(phrase);
  } catch (error) { showError(`${error.message}. Your message was not sent; please try again.`); }
  finally { $('#sendButton').disabled = false; $('#sendButton').textContent = '↵'; input.focus(); }
}

$('#form').addEventListener('submit', event => { event.preventDefault(); send(); });
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
});
input.addEventListener('input', () => {
  $('#charCount').textContent = `${input.value.length} / 2000`;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
});
$('#closeInspector').addEventListener('click', () => $('#inspector').classList.remove('is-open'));
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('#inspector').classList.remove('is-open'); });
fetch('/api/status').then(r => r.json()).then(({ mode }) => {
  $('#modeLabel').textContent = mode === 'jev' ? 'jev connected · enter a thought' : 'local demo · jev not connected';
}).catch(() => { $('#modeLabel').textContent = 'engine offline'; });
messages.forEach(renderMessage);
if (messages.length) select(messages.length - 1);
else input.focus();
