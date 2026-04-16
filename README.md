# Echo360 Notes Converter

Convert Echo360 lectures into structured, exam-ready Obsidian notes — completely free.

**Architecture:** Chrome extension captures the lecture transcript URL → local Node server fetches it → Groq LLaMA 3.3 70B generates Obsidian markdown → file is written into your vault.

```
┌─────────────────────────┐         ┌────────────────────────────┐
│  Chrome extension       │  POST   │  Local Node server         │
│  • webRequest listener  │ ──────► │  • parses VTT/JSON         │
│  • captures s0q*/VTT    │         │  • calls Groq LLaMA        │
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

### 2. Get a free Groq API key

Sign up at [console.groq.com](https://console.groq.com) and create an API key.

The free tier covers Whisper transcription (for the offline CLI fallback) and generous LLaMA 3.3 70B usage for note generation.

### 3. Configure `.env`

```bash
cp .env.example .env
```

Then fill in:

```bash
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

## Daily Usage

### 1. Start the local server

```bash
npm start
```

Leave this running in a terminal. It listens on `127.0.0.1:3737` for the extension.

### 2. Open your Echo360 lecture in Chrome

Navigate to the lesson page in Chrome the way you normally would (SSO and all). Press play for a second so the player loads — that's what triggers the transcript request the extension is listening for.

### 3. Click the extension icon

The popup shows:
- **Server:** `connected` (green) if `npm start` is running
- **Transcript URL:** the captured `.vtt` URL once the player has requested it
- **Lesson:** the current lesson page

Fill in **Course** (e.g. `CS383`) and optionally **Topic**, then click **Generate Notes**.

The extension fetches the transcript inside Chrome (so your session cookies attach automatically), POSTs it to the local server, and the server runs the LLaMA pipeline. After ~20-40 seconds the notes file appears in your vault.

---

## Offline CLI Mode

For lectures you already have on disk (or saved transcripts), the CLI is still available:

```bash
# Local audio/video file → Whisper → notes
npm run cli -- --file lecture.mp3 --course "CS383" --topic "Sorting"

# Saved transcript file → notes
npm run cli -- --transcript lecture.vtt --course "CS383"
```

| Flag | Description |
|---|---|
| `-f, --file <path>` | Local audio/video file (transcribed with Groq Whisper) |
| `-t, --transcript <path>` | Saved `.txt` or `.vtt` transcript file |
| `-c, --course <name>` | Course name for filename + frontmatter |
| `--topic <name>` | Lecture topic override |
| `-o, --output <dir>` | Output directory (overrides vault path) |
| `--save-transcript` | Save the raw transcript next to the notes |
| `--api-key <key>` | Pass Groq API key directly (overrides `.env`) |

---

## Obsidian Vault Layout

With `OBSIDIAN_SUBFOLDER=Lectures` and course `CS383`, notes are organized as:

```
~/Obsidian/My Vault/
└── Lectures/
    └── CS383/
        ├── 2026-04-11_CS383.md
        └── 2026-04-15_CS383_Sorting.md
```

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
└── src/
    ├── server.js           # Local Express server — POST /generate
    ├── index.js            # Offline CLI (--file / --transcript)
    ├── notesGenerator.js   # Groq LLaMA → Obsidian markdown
    ├── transcriber.js      # Groq Whisper (CLI fallback)
    └── vttParser.js        # Parses VTT and Echo360 JSON transcripts
```

---

## Troubleshooting

**Popup says `Server: not running`**
Run `npm start` in a terminal. Leave it running while you use the extension.

**Popup says `Transcript URL: waiting...` and never updates**
Press play on the Echo360 player for a second. The player only requests the `.vtt` file once you start playback. Then click the extension icon again.

**`Generate Notes` button stays disabled**
Same fix — the extension needs to see at least one transcript request first. Reload the extension popup after pressing play.

**`Failed to fetch transcript: HTTP 401/403`**
Your Echo360 session may have expired. Refresh the lesson page in Chrome and try again.

**Notes not appearing in Obsidian**
Check `OBSIDIAN_VAULT_PATH` in `.env`. The server log prints the exact file path it wrote to — confirm Obsidian is watching that folder.

---

## Limitations

- **Groq free tier:** Whisper has a daily limit (~2 hours of audio); LLaMA 3.3 70B is generous but rate-limited.
- **Long lectures:** transcripts over ~100,000 characters are trimmed before note generation.
- **Single transcript per lesson:** the extension keeps the most recent VTT URL it sees. If you switch tabs to a different lecture, click the extension on that tab.
