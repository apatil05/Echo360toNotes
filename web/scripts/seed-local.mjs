// Fills a LOCAL Supabase with example students, courses, lectures, notes and
// jobs so every screen can be seen with realistic content. Refuses to run
// against anything but 127.0.0.1 / localhost.
//
//   node scripts/seed-local.mjs
//
// Accounts (password for both: example-password):
//   demo@example.com  finished setup, full library, jobs in every state
//   new@example.com   brand new, lands in the setup wizard

import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const status = execFileSync('supabase', ['status', '-o', 'env'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
const env = Object.fromEntries(status.split('\n').map((l) => l.match(/^([A-Z_]+)="?([^"]*)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const url = env.API_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url ?? '')) {
  throw new Error(`Refusing to seed ${url}: this script is for the local Supabase only.`);
}

const admin = createClient(url, env.SECRET_KEY, { auth: { persistSession: false } });
const PASSWORD = 'example-password';

async function resetUser(email, fullName) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const old = list.users.find((u) => u.email === email);
  if (old) await admin.auth.admin.deleteUser(old.id);
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: fullName },
  });
  if (error) throw error;
  return data.user.id;
}

async function signIn(email) {
  const client = createClient(url, env.PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

const must = ({ data, error }) => { if (error) throw error; return data; };

function notesFor(topic, sections) {
  const body = sections.map((s, i) => {
    const lines = [`## ${s}${i === 1 ? ' *(MOST IMPORTANT)*' : ''}`];
    lines.push(`- **${s}** is what the lecturer spent most of this segment on.`);
    lines.push(`- The worked example in class started from the definition and built up step by step.`);
    if (i === 0) lines.push('> [!important]\n> The whole lecture hangs on this idea; everything later refers back to it.');
    if (i === 1) lines.push('> [!warning]\n> Asked on last year\'s exam: be ready to justify each step, not just state the result.');
    if (i === 2) lines.push('> [!note]\n> "Say it in one sentence before you write anything down." (Professor)');
    if (i === 3) lines.push('> [!tip]\n> Think of it like sorting a hand of cards: you always know where the next one belongs.');
    if (i === 4) lines.push(['| Case | Time | Space |', '| --- | --- | --- |', '| Best | O(n log n) | O(n) |', '| Worst | O(n^2) | O(1) |'].join('\n'));
    lines.push(`### Worked example\nStart from the general form, then substitute the values from the slide.`);
    return lines.join('\n\n');
  }).join('\n\n');
  return `---\ntags: [lecture-notes]\ndate: ${new Date().toISOString().slice(0, 10)}\n---\n# ${topic}\n\n${body}\n`;
}

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

// ── demo@example.com ───────────────────────────────────────────────────────
const demoId = await resetUser('demo@example.com', 'Jordan Lee');
const demo = await signIn('demo@example.com');

const keyId = must(await demo.rpc('set_api_key', { p_provider: 'groq', p_key: 'gsk_example_not_a_real_key_0000', p_validated: true }));
must(await demo.from('profiles').update({
  default_notes_provider: 'groq',
  default_notes_model: 'openai/gpt-oss-120b',
  onboarding: { step_id: 'done', completed_at: new Date().toISOString(), capture: 'extension' },
}).eq('id', demoId));

const courses = must(await demo.from('courses').insert([
  { user_id: demoId, code: 'CS 220', name: 'Data Structures' },
  { user_id: demoId, code: 'BIO 151', name: 'Cell Biology' },
  { user_id: demoId, code: 'PSY 100', name: 'Intro to Psychology' },
  { user_id: demoId, code: 'MATH 233', name: 'Multivariable Calculus' },
  { user_id: demoId, code: 'HIST 205', name: 'Modern Europe' },
]).select('id, code'));
const course = Object.fromEntries(courses.map((c) => [c.code, c.id]));

const lectures = [
  { code: 'CS 220', topic: 'Merge sort and divide and conquer', day: 0, dur: 4492, sections: ['Big Picture', 'Splitting the list', 'Merging two sorted halves', 'Running time', 'Stability', 'Master theorem preview', 'Key Terms'], job: { status: 'generating', progress: 64, chunks_total: 7, chunks_done: 4, status_detail: 'Writing notes…' } },
  { code: 'BIO 151', topic: 'Membrane transport', day: 0, dur: 2950, job: { status: 'transcribing', progress: 22, status_detail: 'Transcribing…' } },
  { code: 'PSY 100', topic: 'Classical conditioning', day: 1, dur: 3010, job: { status: 'generating', progress: 51, chunks_total: 5, chunks_done: 2, status_detail: 'Provider rate limit reached, waiting to retry…' } },
  { code: 'CS 220', topic: 'Hash tables and collisions', day: 2, dur: 4520, sections: ['Big Picture', 'Hash functions', 'Chaining', 'Open addressing', 'Load factor and resizing', 'Key Terms'] },
  { code: 'MATH 233', topic: 'Partial derivatives', day: 3, dur: 3060, sections: ['Big Picture', 'Limits in two variables', 'Partial derivatives', 'Clairaut’s theorem', 'Tangent planes', 'Linear approximation', 'Worked examples', 'Key Terms'] },
  { code: 'HIST 205', topic: null, day: 3, dur: 4800, job: { status: 'failed', progress: 10, error_code: 'no_speech', error_message: 'No speech was found in the audio. Check that the recording has sound, then upload it again.' } },
  { code: 'BIO 151', topic: 'The lipid bilayer', day: 5, dur: 2980, sections: ['Big Picture', 'Phospholipids', 'Fluid mosaic model', 'Membrane proteins', 'Key Terms'] },
  { code: 'PSY 100', topic: 'Memory: encoding and retrieval', day: 6, dur: 3025, sections: ['Big Picture', 'Sensory memory', 'Working memory', 'Long-term memory', 'Retrieval cues', 'Forgetting curves', 'Key Terms'] },
  { code: 'HIST 205', topic: 'The revolutions of 1848', day: 8, dur: 4760, sections: ['Big Picture', 'Economic crisis', 'February in Paris', 'The German states', 'Why the revolutions failed', 'Key Historical Figures', 'Key Terms'] },
  { code: 'CS 220', topic: 'Binary search trees', day: 9, dur: 4480, sections: ['Big Picture', 'BST property', 'Insertion', 'Deletion', 'Balanced trees', 'Traversals', 'Complexity', 'Common mistakes', 'Key Terms'] },
  { code: 'MATH 233', topic: 'Vectors and the dot product', day: 10, dur: 3100, sections: ['Big Picture', 'Vector operations', 'Dot product', 'Projections', 'Key Terms'] },
];

for (const l of lectures) {
  const lecture = must(await demo.from('lectures').insert({
    user_id: demoId, course_id: course[l.code], topic: l.topic, lecture_date: daysAgo(l.day),
    duration_seconds: l.dur, has_captions: !l.job || l.job.status !== 'transcribing',
    echo360_host: 'echo360.org', echo360_lesson_id: `example-${l.code}-${l.day}-${l.dur}`,
  }).select('id').single());

  const finished = !l.job;
  const job = must(await demo.from('jobs').insert({
    user_id: demoId, lecture_id: lecture.id, api_key_id: keyId,
    source: l.job?.status === 'transcribing' || l.job?.status === 'failed' ? 'audio' : 'captions',
    runner: l.job?.status === 'transcribing' || l.job?.status === 'failed' ? 'lambda' : 'browser',
  }).select('id').single());

  // Worker-owned fields are set with the service role, as the pipeline does.
  const at = new Date(Date.now() - l.day * 86400_000 - 3600_000).toISOString();
  must(await admin.from('jobs').update(finished
    ? { status: 'succeeded', progress: 100, chunks_total: l.sections.length > 6 ? 2 : 1, chunks_done: l.sections.length > 6 ? 2 : 1, started_at: at, finished_at: at }
    : { ...l.job, started_at: at, finished_at: l.job.status === 'failed' ? at : null },
  ).eq('id', job.id));

  if (l.sections && finished) {
    must(await admin.from('notes').insert({
      user_id: demoId, lecture_id: lecture.id, job_id: finished ? job.id : null,
      title: l.topic, body_md: notesFor(l.topic, l.sections), word_count: 900 + l.sections.length * 310,
    }));
  }
}

// ── new@example.com ────────────────────────────────────────────────────────
await resetUser('new@example.com', '');

console.log('Seeded demo@example.com (library) and new@example.com (wizard). Password: example-password');
