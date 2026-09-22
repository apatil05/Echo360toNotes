# Echo360 Notes Converter

Convert Echo360 lectures into structured, exam-ready Obsidian notes, using the AI model of your choice.

**Architecture:** Chrome extension captures the lecture transcript URL → local Node server fetches it → any OpenAI-compatible model (Groq by default, or Nebius, OpenAI, OpenRouter, Ollama…) generates Obsidian markdown → file is written into your vault.

```
┌─────────────────────────┐         ┌────────────────────────────┐
│  Chrome extension       │  POST   │  Local Node server         │
│  • webRequest listener  │ ──────► │  • parses VTT/SRT/JSON     │
│  • captures s0q*/VTT    │         │  • calls your chosen model │
│  • fetches transcript   │         │  • writes to Obsidian vault│
└─────────────────────────┘         └────────────────────────────┘
```

The extension runs *inside* your already-logged-in Chrome, so no SSO automation, no cookie scraping, no Playwright.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get an API key

The default provider is **Groq**, which has a free tier. Sign up at [console.groq.com](https://console.groq.com) and create an API key.

Groq also runs Whisper transcription, which is used for lectures that have no captions. To use a different model for notes, see [Choosing a model](#choosing-a-model).

### 3. Configure `.env`

```bash
cp .env.example .env
```

Then fill in:

```bash
LLM_PROVIDER=groq
GROQ_API_KEY=your_actual_key_here

# Notes are written directly into your Obsidian vault
OBSIDIAN_VAULT_PATH=/Users/yourname/Obsidian/My Vault
OBSIDIAN_SUBFOLDER=Lectures

# Local server port (optional, defaults to 3737)
SERVER_PORT=3737
```

### 4. Install the Chrome extension (unpacked)

1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder inside this repo
5. The Echo360 Notes Converter icon appears in your toolbar

No Web Store approval, no fee — Chrome supports loading unpacked extensions for personal use.

---

## Choosing a model

Notes are generated through the OpenAI-compatible chat API, so you can switch to any model with a few lines in `.env`:

| `LLM_PROVIDER` | Key variable | Default `LLM_MODEL` | Notes |
|---|---|---|---|
| `groq` *(default)* | `GROQ_API_KEY` | `openai/gpt-oss-120b` | Free tier; chunking + pacing tuned for its 8K tokens/min limit |
| `nebius` | `NEBIUS_API_KEY` | `Qwen/Qwen3-235B-A22B-Instruct-2507` | [Nebius Token Factory](https://tokenfactory.nebius.com) |
| `openai` | `OPENAI_API_KEY` | *(set one)* | |
| `openrouter` | `OPENROUTER_API_KEY` | *(set one)* | |
| `ollama` | *(none)* | *(set one)* | Local models at `http://localhost:11434/v1` |
| `custom` | `LLM_API_KEY` | *(set one)* | Any OpenAI-compatible server — also set `LLM_BASE_URL` |

Example — Nebius Token Factory:

```bash
LLM_PROVIDER=nebius
NEBIUS_API_KEY=your_nebius_key
LLM_MODEL=Qwen/Qwen3-235B-A22B-Instruct-2507   # optional, this is the default
```

Example — a local LM Studio / vLLM server:

```bash
LLM_PROVIDER=custom
LLM_BASE_URL=http://localhost:1234/v1
LLM_MODEL=qwen2.5-32b-instruct
```

**See which models your key can use:**

```bash
npm run models                       # lists models for LLM_PROVIDER, marks the current one
npm run models -- --filter qwen      # filter the list
npm run models -- --provider nebius  # check another provider without editing .env
```

Restart `npm start` after changing `.env`. The extension popup shows the model the server is using.

### Tuning

Defaults depend on the provider. Override them if you hit rate limits or context-length errors:

| Variable | Groq default | Other providers | What it does |
|---|---|---|---|
| `LLM_CHUNK_CHARS` | 12,000 | 60,000 | Transcript characters sent per request |
| `LLM_CHUNK_DELAY_MS` | 62,000 | 0 | Pause between chunks (rate limits) |
| `LLM_MAX_OUTPUT_TOKENS` | 4,096 | 8,192 | Max tokens per response — raise for reasoning models |
| `LLM_MAX_SLIDES_CHARS` | 4,000 | 40,000 | Slide text included with each chunk (`0` = ignore slides) |
| `LLM_TEMPERATURE` | 0.3 | 0.3 | `default` to omit it for models that reject it |
| `LLM_REASONING_EFFORT` | — | — | e.g. `low` for reasoning models that support it |

### Transcription provider

Lectures without captions are transcribed with Whisper. This is configured separately from the notes model:

```bash
TRANSCRIBE_PROVIDER=groq          # groq | openai | custom
TRANSCRIBE_MODEL=whisper-large-v3 # optional
TRANSCRIBE_LANGUAGE=en            # blank = auto-detect
```

---

## Daily Usage

### 1. Start the local server

```bash
npm start
```

Leave this running in a terminal. It listens on `127.0.0.1:3737` for the extension and prints which models it is using.

### 2. Open your Echo360 lecture in Chrome

Navigate to the lesson page in Chrome the way you normally would (SSO and all). Press play for a second so the player loads — that's what triggers the transcript request the extension is listening for.

### 3. Click the extension icon

The popup shows:
- **Server:** `connected` (green) if `npm start` is running
- **Model:** the provider / model the server will use
- **Transcript URL:** the captured `.vtt` URL once the player has requested it
- **Video URL:** the captured stream, used when the lecture has no captions
- **Lesson:** the current lesson page

Fill in **Course** (e.g. `CS383`), optionally **Topic** and a **slides PDF**, then click **Generate Notes**.

The extension fetches the transcript inside Chrome (so your session cookies attach automatically), POSTs it to the local server, and the server runs the pipeline. After ~20-60 seconds the notes file appears in your vault. Lectures without captions take longer (~5-15 min), because the video is downloaded and transcribed first.

---

## Offline CLI Mode

For lectures you already have on disk (or saved transcripts), the CLI is still available:

```bash
# Local audio/video file → transcription → notes (video is converted with ffmpeg first)
npm run cli -- --file lecture.mp4 --course "CS383" --topic "Sorting"

# Saved transcript file → notes
npm run cli -- --transcript lecture.vtt --course "CS383"

# Use a different model for one run
npm run cli -- --transcript lecture.vtt --provider nebius --model "Qwen/Qwen3-235B-A22B-Instruct-2507"
```

| Flag | Description |
|---|---|
| `-f, --file <path>` | Local audio/video file (transcribed with Whisper) |
| `-t, --transcript <path>` | Saved `.txt`, `.vtt` or `.srt` transcript file |
| `-s, --slides <path>` | Lecture slides PDF to use alongside the transcript |
| `-c, --course <name>` | Course name for filename + frontmatter |
| `--topic <name>` | Lecture topic override |
| `-o, --output <dir>` | Output directory (overrides vault path) |
| `--save-transcript` | Save the raw transcript next to the notes |
| `-p, --provider <name>` | Notes provider (overrides `LLM_PROVIDER`) |
| `-m, --model <id>` | Notes model (overrides `LLM_MODEL`) |
| `--base-url <url>` | OpenAI-compatible base URL (overrides `LLM_BASE_URL`) |
| `--api-key <key>` | API key for the notes provider (overrides `.env`) |

---

## Obsidian Vault Layout

With `OBSIDIAN_SUBFOLDER=Lectures` and course `CS383`, notes are organized as:

```
~/Obsidian/My Vault/
└── Lectures/
    └── CS383/
        ├── 2026-04-11_CS383.md
        ├── 2026-04-11_CS383_2.md          ← second lecture the same day (never overwritten)
        ├── 2026-04-15_CS383_Sorting.md
        └── 2026-04-15_CS383_Sorting.transcript.txt   ← saved when a lecture had no captions
```

Dates use your computer's local timezone.

To find your vault path: Obsidian → Settings → Files and Links → Vault path.

---

## Output Format

```markdown
---
tags: [cs383, sorting, lecture-notes]
date: 2026-04-11
course: "CS383"
topic: "Sorting Algorithms"
---

# Sorting Algorithms

## Big Picture
- Sorting is fundamental to many algorithms
- Tradeoffs: time, space, stability

> [!important]
> Choose the algorithm based on data shape, not by default.

## Core Idea: Comparison Sorts *(MOST IMPORTANT)*

> [!note]
> "Any comparison sort has a Ω(n log n) lower bound."

> [!tip]
> Think of merge sort like splitting a deck of cards in half repeatedly. (Professor's analogy)
```

Conventions:
- `##` / `###` headers, with `*(MOST IMPORTANT)*` markers when flagged
- `> [!important]` for key insights and implications
- `> [!note]` for definitions and professor quotes
- `> [!tip]` for analogies, examples, and mnemonics
- `> [!warning]` for exam warnings
- **Bold** for key terms on first use
- YAML frontmatter with tags, date, course, topic

---

## Project Layout

```
echo360-notes-converter/
├── extension/              # Chrome extension (unpacked)
│   ├── manifest.json
│   ├── background.js       # webRequest listener — captures s0q*/VTT URLs
│   ├── popup.html
│   └── popup.js
├── src/
│   ├── server.js           # Local Express server — POST /generate, /generate-from-video
│   ├── index.js            # Offline CLI (--file / --transcript)
│   ├── models.js           # `npm run models` — list models for your provider
│   ├── providers.js        # Provider presets + LLM_* / TRANSCRIBE_* config
│   ├── notesGenerator.js   # Transcript → Obsidian markdown (chunking, retries)
│   ├── transcriber.js      # Whisper transcription (videos without captions)
│   ├── media.js            # Download, ffprobe, ffmpeg helpers
│   ├── output.js           # Vault paths and filenames
│   ├── slideParser.js      # PDF slide text extraction
│   └── vttParser.js        # Parses VTT, SRT and Echo360 JSON transcripts
├── test/                   # `npm test` — offline unit tests (no API calls)
└── scripts/e2e.mjs         # `npm run test:e2e` — full pipeline against real APIs
```

---

## Testing

```bash
npm test          # fast offline tests, including a mock OpenAI-compatible server
npm run test:e2e  # end-to-end against your configured provider (uses a little quota)
```

The e2e test starts the server, sends captions, slides and a generated lecture video through every endpoint and the CLI, and writes everything to a temp folder, never your vault. It needs `ffmpeg` and a text-to-speech tool (`say` on macOS, `espeak-ng` on Linux) for the video steps; set `E2E_SKIP_AUDIO=1` to skip them. To test another provider: `LLM_PROVIDER=nebius npm run test:e2e`.

---

## Troubleshooting

**Popup says `Server: not running`**
Run `npm start` in a terminal. Leave it running while you use the extension.

**Popup shows the model in red / `Server config problem: ...`**
The server's `.env` is missing something (usually the API key or `LLM_MODEL` for that provider). The message says which variable to set. Restart `npm start` after fixing it.

**`Model "..." isn't available`**
Providers retire models (Groq removed `llama-3.3-70b-versatile`). Run `npm run models` and set `LLM_MODEL` to one of the listed IDs.

**`The request is too large` / rate limited**
Lower `LLM_CHUNK_CHARS` and/or `LLM_MAX_OUTPUT_TOKENS`, or raise `LLM_CHUNK_DELAY_MS`. Rate-limit (429) errors are retried automatically.

**Popup says `Transcript URL: waiting...` and never updates**
Press play on the Echo360 player for a second. The player only requests the `.vtt` file once you start playback.

**`Failed to fetch transcript: HTTP 401/403`**
Your Echo360 session may have expired. Refresh the lesson page in Chrome and try again.

**`None of the captured stream files contained an audio track`**
Check that `ffmpeg`/`ffprobe` are installed (`ffprobe -version`). If `FFMPEG_PATH`/`FFPROBE_PATH` are set in `.env`, make sure they point to real binaries or remove them.

**Notes not appearing in Obsidian**
Check `OBSIDIAN_VAULT_PATH` in `.env`. The server log prints the exact file path it wrote to — confirm Obsidian is watching that folder.

**Changed `SERVER_PORT`?**
Also update `SERVER_URL` in `extension/popup.js` and the `127.0.0.1:3737` entries in `extension/manifest.json`, then reload the extension.

---

## Limitations

- **Groq free tier:** Whisper has a daily limit (~2 hours of audio), and chat models are limited to ~8K tokens/minute, so long lectures are split into chunks with a pause between them.
- **Long lectures:** transcripts longer than `LLM_CHUNK_CHARS` are split into parts and merged into one note. Audio for transcription must fit the provider's upload limit (25 MB ≈ 3.5 hours at the bitrate used).
- **Single transcript per lesson:** the extension keeps the most recent caption URL it sees for each tab, and resets when the tab moves to a different lesson.
- **Security:** the local server only accepts requests from Chrome extensions and local tools, so other websites can't use your API key.
