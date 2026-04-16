import Groq from 'groq-sdk';

const NOTES_MODEL = 'llama-3.3-70b-versatile';

// Groq free tier: 12,000 tokens per minute on llama-3.3-70b.
// We chunk the transcript so input + output stays well under that ceiling.
//   ~25k chars ≈ ~6k input tokens + ~4k output tokens = ~10k total per request.
const CHUNK_CHARS = 25_000;
const MAX_OUTPUT_TOKENS = 4096;

// Wait between chunks to let the TPM window slide. Free tier resets every 60s.
const INTER_CHUNK_DELAY_MS = 65_000;

const RATE_LIMIT_RETRIES = 3;

export async function generateNotes(transcript, apiKey, meta = {}) {
  const client = new Groq({ apiKey });
  const today = meta.date ?? new Date().toISOString().split('T')[0];
  const course = meta.course ?? 'Unknown Course';
  const slides = meta.slides ?? null;

  const chunks = chunkTranscript(transcript, CHUNK_CHARS);

  if (chunks.length === 1) {
    return await callGroq(client, buildSystemPrompt({ first: true, only: true }), buildUserPrompt(chunks[0], { course, today, topic: meta.topic, slides, part: null }));
  }

  console.log(`   Transcript is ${transcript.length.toLocaleString()} chars — splitting into ${chunks.length} chunks (~${INTER_CHUNK_DELAY_MS / 1000}s between calls for rate limits).`);

  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    console.log(`   → Chunk ${i + 1}/${chunks.length} (${chunks[i].length.toLocaleString()} chars)...`);

    const system = buildSystemPrompt({ first: isFirst, only: false, last: isLast });
    const user = buildUserPrompt(chunks[i], {
      course,
      today,
      topic: meta.topic,
      slides,
      part: { index: i + 1, total: chunks.length },
    });

    const md = await callGroq(client, system, user);
    parts.push(md);

    if (!isLast) {
      console.log(`   Waiting ${INTER_CHUNK_DELAY_MS / 1000}s for rate limit window...`);
      await sleep(INTER_CHUNK_DELAY_MS);
    }
  }

  return mergeChunks(parts);
}

async function callGroq(client, systemPrompt, userPrompt, attempt = 1) {
  try {
    const completion = await client.chat.completions.create({
      model: NOTES_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: MAX_OUTPUT_TOKENS,
    });

    const text = completion.choices?.[0]?.message?.content;
    if (!text || !text.trim()) throw new Error('Notes generation returned empty content.');
    return text.trim();
  } catch (err) {
    const isRateLimit = err.status === 429 || /rate_limit/i.test(err.message ?? '');
    if (isRateLimit && attempt <= RATE_LIMIT_RETRIES) {
      const waitMs = parseRetryAfter(err) ?? 65_000;
      console.log(`   Rate limited — waiting ${Math.ceil(waitMs / 1000)}s and retrying (attempt ${attempt}/${RATE_LIMIT_RETRIES})...`);
      await sleep(waitMs);
      return callGroq(client, systemPrompt, userPrompt, attempt + 1);
    }
    throw err;
  }
}

function parseRetryAfter(err) {
  const msg = err.message ?? '';
  const m = msg.match(/try again in ([\d.]+)s/i);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 2000;
  return null;
}

function chunkTranscript(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxChars, text.length);
    if (end < text.length) {
      const slice = text.slice(i, end);
      const lastBreak = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
      );
      if (lastBreak > maxChars * 0.5) end = i + lastBreak + 1;
    }
    chunks.push(text.slice(i, end).trim());
    i = end;
  }
  return chunks;
}

function buildSystemPrompt({ first, only, last }) {
  const base = `You are an expert note-taker for university students. You produce highly structured, exam-ready Obsidian markdown notes from lecture transcripts.

## Output Format Rules

### Heading Hierarchy
- \`# Topic Name\` — document title only
- \`## Section Name\` — major topics (append \`*(MOST IMPORTANT)*\` or \`*(VERY IMPORTANT)*\` when the lecturer signals something is critical for exams)
- \`### Subsection\` — sub-concepts within a section

### Text Formatting
- **Bold** all key terms, definitions, and named principles the first time they appear
- Use \`-\` bullet points. Indent sub-bullets with two spaces.
- Keep bullets concise — one idea per bullet.

### Obsidian Callouts
For KEY INSIGHTS / implications:
> [!important]
> The insight or implication here

For DEFINITIONS / quotes from the professor:
> [!note]
> "Definition or quote here"

For ANALOGIES, EXAMPLES, and MNEMONICS:
> [!tip]
> Analogy or example here (note source e.g. "Professor's analogy")

For EXAM WARNINGS:
> [!warning]
> What to watch out for on exams

### Style Notes
- If the professor uses a memorable analogy, include it in a \`[!tip]\` callout and note it's the professor's
- If the professor says "very important", "on the exam", "core concept", flag the heading with \`*(MOST IMPORTANT)*\`
- Do NOT add filler text, transitions, or summaries beyond what the lecture covered
- Do NOT invent content not present in the transcript
- When lecture slides are provided alongside the transcript, use the slide headings and structure as the backbone of your note hierarchy, and the transcript for verbal explanations and professor commentary`;

  if (only) {
    return base + `

### YAML Frontmatter (always first)
\`\`\`
---
tags: [<course-slug>, <topic-slug>, lecture-notes]
date: <YYYY-MM-DD>
course: "<Course Name>"
topic: "<Detected Lecture Topic>"
---
\`\`\`

### Always include (if content exists)
1. **Big Picture** — what is this lecture fundamentally about?
2. Content sections (derived from the transcript)
3. **Key Historical Figures** — if any people are mentioned
4. **Master Thinking Framework** — bulleted checklist of questions/steps to apply this material
5. **Key Terms** — \`**Term**: definition\``;
  }

  if (first) {
    return base + `

### YAML Frontmatter (always first)
\`\`\`
---
tags: [<course-slug>, <topic-slug>, lecture-notes]
date: <YYYY-MM-DD>
course: "<Course Name>"
topic: "<Detected Lecture Topic>"
---
\`\`\`

This is **PART 1** of a multi-part lecture. Include the frontmatter, the \`# Topic\` title, and a **Big Picture** section. Cover the content from this segment with \`##\` sections. DO NOT include "Key Historical Figures", "Master Thinking Framework", or "Key Terms" sections — those will be added in the final part.`;
  }

  if (last) {
    return base + `

This is the **FINAL PART** of a multi-part lecture. DO NOT include YAML frontmatter or a \`# Topic\` title — those are already in part 1. Continue with \`##\` sections for the content in this segment. THEN add these summary sections at the end:
- **Key Historical Figures** — if any people were mentioned across the lecture
- **Master Thinking Framework** — bulleted checklist of questions/steps to apply this material
- **Key Terms** — \`**Term**: definition\``;
  }

  return base + `

This is a **MIDDLE PART** of a multi-part lecture. DO NOT include YAML frontmatter, a \`# Topic\` title, "Big Picture", "Key Historical Figures", "Master Thinking Framework", or "Key Terms" sections. Just continue with \`##\` sections covering the content in this segment.`;
}

function buildUserPrompt(transcript, { course, today, topic, slides, part }) {
  const topicHint = topic ? `The lecture topic is: "${topic}".` : '';
  const partHint = part ? `\nThis is part ${part.index} of ${part.total}.` : '';

  if (slides) {
    return `Course: ${course}
Date: ${today}
${topicHint}${partHint}

You have TWO sources for this lecture. Use both together:
- **Lecture Slides** — use these for the structural backbone: headings, key terms, and slide-level concepts
- **Lecture Transcript** — use this for the professor's verbal explanations, examples, analogies, and exam hints

## Lecture Slides (extracted text):
---
${slides}
---

## Lecture Transcript:
---
${transcript}
---`;
  }

  return `Course: ${course}
Date: ${today}
${topicHint}${partHint}

Please generate Obsidian notes from the following lecture transcript segment:

---
${transcript}
---`;
}

function mergeChunks(parts) {
  // Parts already have appropriate structure: part 1 has frontmatter+title,
  // middle/last parts have only ## sections. Just join with blank lines.
  return parts.map(p => p.trim()).join('\n\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
