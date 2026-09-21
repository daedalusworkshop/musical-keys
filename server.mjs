import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeLocally, buildJevRequest, normalizeJevAnswers, traceJevAnswers, traceLocalAnalysis } from './src/emotion.mjs';
import { ORGAN_SAMPLE_FILES } from './src/sound.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const key = process.env.TYPESAFE_API_KEY;
const model = process.env.JEV_MODEL || 'jev-latest';
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.txt': 'text/plain' };
const samplePaths = new Set(ORGAN_SAMPLE_FILES.map(({ file }) => `/samples/renaissance-organ/${file}`));
samplePaths.add('/samples/renaissance-organ/LICENSE.txt');

function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 32_000) throw new Error('Request too large');
  }
  return JSON.parse(raw);
}

async function analyze(req, res) {
  try {
    const input = await body(req);
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) {
      return respond(res, 400, { error: 'Message must be 1–2000 characters.' });
    }
    const context = Array.isArray(input.context) ? input.context
      .filter(x => typeof x === 'string' && x.trim())
      .slice(-4).map((x, index, recent) => x.slice(0, index === recent.length - 1 ? 2000 : 300)) : [];
    const previous = context.at(-1) || null;
    if (!key) {
      const normalized = analyzeLocally(input.text, previous);
      return respond(res, 200, { ...normalized, source: 'local demo', trace: traceLocalAnalysis(normalized, Boolean(previous)) });
    }

    const jevRequest = buildJevRequest(input.text, context, model);
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(jevRequest),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
    const result = await response.json();
    const normalized = normalizeJevAnswers(result.answers, Boolean(previous));
    const actualModel = result.model || model;
    const trace = traceJevAnswers(result.answers, normalized, Boolean(previous), actualModel, result.usage, jevRequest);
    return respond(res, 200, { ...normalized, source: actualModel, trace });
  } catch (error) {
    // Never silently replace a failed remote judgment with a seemingly real one.
    respond(res, 502, { error: error.message || 'Analysis failed.' });
  }
}

createServer(async (req, res) => {
  if (req.url === '/api/status') return respond(res, 200, { mode: key ? 'jev' : 'local demo' });
  if (req.url === '/api/analyze' && req.method === 'POST') return analyze(req, res);
  if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed' });
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!path.startsWith(root) || !(['/index.html', '/styles.css', '/app.mjs', '/src/emotion.mjs', '/src/music.mjs', '/src/sound.mjs'].includes(pathname === '/' ? '/index.html' : pathname) || samplePaths.has(pathname))) {
    return respond(res, 404, { error: 'Not found' });
  }
  try {
    const data = await readFile(path);
    const type = mime[extname(path)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type === 'audio/wav' ? type : `${type}; charset=utf-8` });
    res.end(data);
  } catch { respond(res, 404, { error: 'Not found' }); }
}).listen(port, () => console.log(`Musical Keys → http://localhost:${port} (${key ? 'Jev' : 'local demo'})`));
