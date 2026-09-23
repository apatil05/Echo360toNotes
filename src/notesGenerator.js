import { createClient, describe } from './providers.js';
import { localDate } from './output.js';

const RATE_LIMIT_RETRIES = 3;

/**
 * @param {string} transcript  Plain-text lecture transcript
 * @param {object} llm         Config from resolveLLMConfig()
 * @param {object} meta        { course, topic, slides, date }
 */
export async function generateNotes(transcript, llm, meta = {}) {
  const result = await generateNotesResumable(transcript, llm, meta);
  return result.notes;
}

/**
 * Like generateNotes, but can stop between chunks and pick up later — for runners
 * with a time limit (AWS Lambda) where rate-limit pauses don't fit in one run.
 *
 * @param {object} options
 * @param {string[]} [options.parts]     Notes already written for the first chunks
 * @param {Function} [options.onPart]    async (parts, totalChunks) after each chunk
 * @param {Function} [options.canContinue] (waitMs) => whether there's time to wait
 *   waitMs and then write another chunk. Returning false pauses the run.
 * @returns {Promise<{done: true, notes: string, total: number} |
 *                   {done: false, parts: string[], total: number, resumeAfterMs: number}>}
 *   When paused, resume after resumeAfterMs with the returned parts; the resumed
 *   run doesn't wait again before its first chunk.
 */
export async function generateNotesResumable(transcript, llm, meta = {}, { parts: doneParts = [], onPart, canContinue = () => true } = {}) {
  if (!transcript?.trim()) throw new Error('Cannot generate notes from an empty transcript.');

  const client = createClient(llm);
  const today = meta.date ?? localDate();
  const course = meta.course ?? 'Unknown Course';
  const slides = limitSlides(meta.slides ?? null, llm.maxSlidesChars);

  const chunks = chunkTranscript(transcript, llm.chunkChars);
  const total = chunks.length;
  if (doneParts.length > total) {
    throw new Error(`Saved progress has ${doneParts.length} parts but the transcript splits into ${total}. Was the chunk size changed?`);
  }

  if (total === 1) {
    if (doneParts.length === 1) return { done: true, notes: doneParts[0], total };
    if (!canContinue(0)) return { done: false, parts: [], total, resumeAfterMs: 0 };
    const notes = await callModel(client, llm, buildSystemPrompt({ first: true, only: true }), buildUserPrompt(chunks[0], { course, today, topic: meta.topic, slides, part: null }));
    await onPart?.([notes], total);
    return { done: true, notes, total };
  }

  const pacing = llm.chunkDelayMs > 0 ? ` (~${Math.round(llm.chunkDelayMs / 1000)}s between calls for rate limits)` : '';
  const resuming = doneParts.length ? `, resuming at chunk ${doneParts.length + 1}` : '';
  console.log(`   Transcript is ${transcript.length.toLocaleString()} chars — splitting into ${total} chunks${pacing}${resuming}.`);

  const parts = [...doneParts];
  const start = parts.length;
  for (let i = start; i < total; i++) {
    const wait = i > start ? llm.chunkDelayMs : 0;
    if (!canContinue(wait)) return { done: false, parts, total, resumeAfterMs: wait };
    if (wait > 0) {
      console.log(`   Waiting ${Math.round(wait / 1000)}s for rate limit window...`);
      await sleep(wait);
    }

    const isFirst = i === 0;
    const isLast = i === total - 1;
    console.log(`   → Chunk ${i + 1}/${total} (${chunks[i].length.toLocaleString()} chars)...`);

    const system = buildSystemPrompt({ first: isFirst, only: false, last: isLast });
    const user = buildUserPrompt(chunks[i], {
      course,
      today,
      topic: meta.topic,
      slides,
      part: { index: i + 1, total },
    });

    parts.push(await callModel(client, llm, system, user));
    await onPart?.(parts, total);
  }

  return { done: true, notes: mergeChunks(parts), total };
}

async function callModel(client, llm, systemPrompt, userPrompt, state = { attempt: 1, omit: new Set() }) {
  const params = {
    model: llm.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
  if (llm.temperature !== null && !state.omit.has('temperature')) params.temperature = llm.temperature;
  params[state.omit.has('max_tokens') ? 'max_completion_tokens' : llm.tokenParam] = llm.maxOutputTokens;
  if (llm.reasoningEffort) params.reasoning_effort = llm.reasoningEffort;

  // Stream the response: headers arrive immediately, so slow/large models can't trip
  // Node fetch's 5-minute headers timeout while the whole completion is generated.
  let content = '';
  let finishReason = null;
  try {
    const stream = await client.chat.completions.create({ ...params, stream: true });
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) content += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  } catch (err) {
    const msg = err?.message ?? '';

    // Some models (e.g. OpenAI reasoning models) reject parameters other models require.
    // Drop the offending one and retry once rather than making every user tune it.
    if (err.status === 400 && params.max_tokens !== undefined && /max_completion_tokens/.test(msg)) {
      return callModel(client, llm, systemPrompt, userPrompt, { ...state, omit: new Set([...state.omit, 'max_tokens']) });
    }
    if (err.status === 400 && params.temperature !== undefined && /temperature/i.test(msg) && /support/i.test(msg)) {
      return callModel(client, llm, systemPrompt, userPrompt, { ...state, omit: new Set([...state.omit, 'temperature']) });
    }

    if (err.status === 429 && state.attempt <= RATE_LIMIT_RETRIES) {
      const waitMs = retryAfterMs(err) ?? 65_000;
      console.log(`   Rate limited — waiting ${Math.ceil(waitMs / 1000)}s and retrying (attempt ${state.attempt}/${RATE_LIMIT_RETRIES})...`);
      await sleep(waitMs);
      return callModel(client, llm, systemPrompt, userPrompt, { ...state, attempt: state.attempt + 1 });
    }

    throw explainApiError(err, llm);
  }

  const text = cleanModelOutput(content);

  if (finishReason === 'length') {
    if (!text) {
      throw new Error(`${describe(llm)} used its whole output budget (${llm.maxOutputTokens} tokens) without writing any notes. Raise LLM_MAX_OUTPUT_TOKENS — reasoning models need extra room.`);
    }
    console.warn(`   ⚠️  Output hit LLM_MAX_OUTPUT_TOKENS (${llm.maxOutputTokens}) — this section of the notes may be cut off.`);
  }
  if (!text) throw new Error(`${describe(llm)} returned empty content.`);
  return text;
}

function explainApiError(err, llm) {
  const msg = err?.message ?? String(err);
  let hint = null;

  if (err.status === 401 || err.status === 403) {
    hint = `Authentication failed for ${llm.label}. Check ${llm.apiKeyEnv ?? 'LLM_API_KEY'} in .env.`;
  } else if (err.status === 404 || /model_not_found|does not exist/i.test(msg)) {
    hint = `Model "${llm.model}" isn't available on ${llm.label}. Run \`npm run models\` to see what is, then set LLM_MODEL.`;
  } else if (err.status === 413 || /request too large|tokens per minute|context length|maximum context/i.test(msg)) {
    hint = `The request is too large for ${describe(llm)}. Lower LLM_CHUNK_CHARS (currently ${llm.chunkChars}), LLM_MAX_OUTPUT_TOKENS (${llm.maxOutputTokens}) or LLM_MAX_SLIDES_CHARS (${llm.maxSlidesChars}).`;
  } else if (err.status === undefined && /connection|ECONNREFUSED|fetch failed/i.test(msg)) {
    hint = `Could not reach ${llm.baseURL}. Is the provider running / the base URL correct?`;
  }

  if (!hint) return err;
  const wrapped = new Error(`${hint}\n(${msg})`, { cause: err });
  wrapped.status = err.status;
  return wrapped;
}

function retryAfterMs(err) {
  const header = (name) => err.headers?.get?.(name) ?? err.headers?.[name];
  const ms = Number(header('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms + 2000;
  const secs = Number(header('retry-after'));
  if (Number.isFinite(secs) && secs > 0) return secs * 1000 + 2000;

  // Groq also puts it in the message: "Please try again in 1m2.5s" / "try again in 7.66s"
  const m = (err.message ?? '').match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  if (m) return Math.ceil(((Number(m[1] ?? 0) * 60) + parseFloat(m[2])) * 1000) + 2000;
  return null;
}

function limitSlides(slides, maxChars) {
  if (!slides) return null;
  if (maxChars === 0) {
    console.log('   LLM_MAX_SLIDES_CHARS=0 — ignoring slides.');
    return null;
  }
  if (slides.length <= maxChars) return slides;
  console.log(`   Slides text is ${slides.length.toLocaleString()} chars — truncating to ${maxChars.toLocaleString()} (LLM_MAX_SLIDES_CHARS).`);
  return slides.slice(0, maxChars) + '\n[... remaining slides truncated ...]';
}

export function chunkTranscript(text, maxChars) {
  const clean = text.trim();
  if (clean.length <= maxChars) return [clean];

  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + maxChars, clean.length);
    if (end < clean.length) {
      const slice = clean.slice(i, end);
      const sentenceBreak = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
      );
      const wordBreak = slice.lastIndexOf(' ');
      if (sentenceBreak > maxChars * 0.5) end = i + sentenceBreak + 1;
      else if (wordBreak > maxChars * 0.5) end = i + wordBreak;
    }
    const chunk = clean.slice(i, end).trim();
    if (chunk) chunks.push(chunk);
    i = end;
  }
  return chunks;
}

/** Strips inline reasoning and a wrapping ```markdown fence that some models add. */
export function cleanModelOutput(text) {
  let out = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = out.match(/^```(?:markdown|md)?[ \t]*\n([\s\S]*)\n```$/i);
  if (fenced && /^(---|#)/.test(fenced[1].trim())) out = fenced[1].trim();
  // Some models (seen with Qwen3) fence just the frontmatter, which Obsidian then ignores.
  out = out.replace(/^```[a-z]*[ \t]*\r?\n(---\r?\n[\s\S]*?\r?\n---)[ \t]*\r?\n```[ \t]*(?:\r?\n|$)/i, '$1\n');
  return out.trim();
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
- When lecture slides are provided alongside the transcript, use the slide headings and structure as the backbone of your note hierarchy, and the transcript for verbal explanations and professor commentary
- Output ONLY the markdown notes — no surrounding code fence, no preamble, no closing remarks`;

  if (only) {
    return base + `

### YAML Frontmatter (always first)
The very first line of your output must be \`---\`. Do NOT put the frontmatter inside a code block — Obsidian only recognizes it as raw text:

---
tags: [<course-slug>, <topic-slug>, lecture-notes]
date: <YYYY-MM-DD>
course: "<Course Name>"
topic: "<Detected Lecture Topic>"
---

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
The very first line of your output must be \`---\`. Do NOT put the frontmatter inside a code block — Obsidian only recognizes it as raw text:

---
tags: [<course-slug>, <topic-slug>, lecture-notes]
date: <YYYY-MM-DD>
course: "<Course Name>"
topic: "<Detected Lecture Topic>"
---

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
    // Every part sees the whole deck, so without this the model re-covers all slides each time.
    const slidesScope = part
      ? '\nThe slides cover the WHOLE lecture, but the transcript below is only one segment. Only use slides that relate to what is said in this segment.'
      : '';
    return `Course: ${course}
Date: ${today}
${topicHint}${partHint}

You have TWO sources for this lecture. Use both together:
- **Lecture Slides** — use these for the structural backbone: headings, key terms, and slide-level concepts
- **Lecture Transcript** — use this for the professor's verbal explanations, examples, analogies, and exam hints${slidesScope}

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

/**
 * Joins per-chunk notes. Later parts are told not to repeat the frontmatter or title,
 * but models don't always listen — strip them so the file has exactly one of each.
 */
export function mergeChunks(parts) {
  return parts
    .map((p, i) => {
      let s = p.trim();
      if (i > 0) {
        s = s.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '');
        s = s.replace(/^#\s[^\n]*\n+/, '');
      }
      return s.trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
