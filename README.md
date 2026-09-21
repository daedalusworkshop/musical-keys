# Musical Keys

A local, playable sketch of a musical messenger. The web interface feels like a minimal terminal: messages, an input prompt directly after the last line, and a separate decision trace. Messages are analyzed into Russell-style valence and arousal, plus unresolved friction and thought continuity. A deterministic composer shapes a two-bar phrase from a finite chord palette.

## Run

Requires Node.js 20+. No packages to install.

```powershell
npm start
```

Open http://localhost:4173. Without a key, the UI clearly says **local demo mode** and uses a tiny word-based stand-in. For actual Jev analysis, set a server-side key before starting:

```powershell
$secureKey = Read-Host "TypeSafe API key" -AsSecureString
$env:TYPESAFE_API_KEY = (New-Object System.Net.NetworkCredential('', $secureKey)).Password
npm start
```

Do not put the key in browser code. Optionally set `JEV_MODEL` or `PORT`. Run `npm test` for the mapping checks.

## Design contract

- The server sends the current message and up to four short prior messages as `state` to Jev's `POST /v1/systemone`, with independent `score` questions for valence, arousal, friction, and (when there is a prior message) continuity. Each 0–4 score becomes a 0–1 coordinate. Low-confidence results are pulled toward a conservative baseline. The inspector shows each question, rubric, raw score, probabilities, confidence, and value actually used; an optional raw-payload view shows the request body and response without the API key. It never invents Jev probabilities in local demo mode. Failures remain visible; there is no silent fallback from a configured Jev API.
- Valence influences harmonic brightness, arousal influences melodic density and dynamics, and friction updates remembered tension. Tempo is fixed at 84 BPM across messages. High continuity favors keeping a chord while changing its voicing and melodic motif; low continuity permits a fresh chord. A strong emotional shift can override continuity.
- `src/sound.mjs` plays the phrase with bundled CC0 VCSL Renaissance Organ recordings (see `samples/renaissance-organ/LICENSE.txt`), using note-retaining chord changes and crossfades. Its additive oscillator voice is a fallback. The referenced Spatial Organ GitHub repository was inaccessible during development, so this is **not** a verified reproduction of that instrument or its change model.
- This finite palette is an authored musical vocabulary, not an assertion that major means happy or minor means sad. The full continuum is expressed through motion, pacing, and contextual progression, not 100 fixed emotion labels.
- Message history stays in this browser's localStorage. This is **not** yet a multi-user, authenticated, or encrypted messenger. Jev mode sends message text to TypeSafe's service; seek consent and plan retention/privacy before real conversations.

The API request shape follows [TypeSafe's quick start](https://docs.typesafe.ai/introduction/quickstart) and its [Score primitive](https://docs.typesafe.ai/primitives/score). The listening interface is intentionally a prototype: calibrate the prompts and the musical mapping with people, especially around sarcasm, cultural cues, ambiguous emotion, and low-confidence readings.
