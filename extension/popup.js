// Must match SERVER_PORT in the server's .env (and host_permissions in manifest.json).
const SERVER_URL = 'http://127.0.0.1:3737';

const els = {
  serverStatus: document.getElementById('server-status'),
  modelStatus: document.getElementById('model-status'),
  transcriptStatus: document.getElementById('transcript-status'),
  videoStatus: document.getElementById('video-status'),
  lessonStatus: document.getElementById('lesson-status'),
  course: document.getElementById('course'),
  topic: document.getElementById('topic'),
  slides: document.getElementById('slides'),
  slidesStatus: document.getElementById('slides-status'),
  generate: document.getElementById('generate'),
  status: document.getElementById('status'),
};

let currentTabId = null;
let currentTabUrl = null;
let currentState = null;
// While a job runs, the 750ms refresh loop must not re-enable the button — otherwise
// a second click starts a duplicate 5-15 minute job.
let generating = false;

init();

async function init() {
  // Restore last-used course/topic
  const saved = await chrome.storage.local.get(['course', 'topic']);
  if (saved.course) els.course.value = saved.course;
  if (saved.topic) els.topic.value = saved.topic;

  els.course.addEventListener('input', () => chrome.storage.local.set({ course: els.course.value }));
  els.topic.addEventListener('input', () => chrome.storage.local.set({ topic: els.topic.value }));
  els.slides.addEventListener('change', onSlidesChange);
  els.generate.addEventListener('click', onGenerate);
  document.getElementById('diagnostics').addEventListener('click', (e) => {
    e.preventDefault();
    if (currentTabId == null) return;
    chrome.tabs.create({ url: chrome.runtime.getURL(`diagnostics.html?tab=${currentTabId}`) });
  });

  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;
  currentTabUrl = tab?.url ?? null;

  await Promise.all([checkServer(), refreshState()]);

  // Auto-refresh state every 750ms so the user doesn't have to reopen the popup
  // after pressing play on the video.
  setInterval(refreshState, 750);
}

async function checkServer() {
  try {
    const r = await fetch(`${SERVER_URL}/health`);
    if (r.ok) {
      const health = await r.json().catch(() => ({}));
      els.serverStatus.textContent = 'connected';
      els.serverStatus.className = 'value';
      showModel(health.llm);
      return true;
    }
  } catch {}
  els.serverStatus.textContent = 'not running — `npm start`';
  els.serverStatus.className = 'value missing';
  els.modelStatus.textContent = '—';
  els.modelStatus.className = 'value muted';
  return false;
}

function showModel(llm) {
  if (!llm) {
    els.modelStatus.textContent = 'unknown (update server)';
    els.modelStatus.className = 'value muted';
    return;
  }
  const name = `${llm.provider ?? '?'} / ${llm.model ?? '?'}`;
  els.modelStatus.textContent = name;
  els.modelStatus.title = llm.error ?? name;
  els.modelStatus.className = llm.error ? 'value missing' : 'value';
  if (llm.error) setStatus(`Server config problem: ${llm.error}`, 'error');
}

async function refreshState() {
  if (currentTabId == null) return;
  currentState = (await chrome.runtime.sendMessage({ type: 'GET_STATE', tabId: currentTabId })) ?? {};

  // Fall back to the actual tab URL if background hasn't seen a navigation event
  if (!currentState.lessonUrl && currentTabUrl && /echo360\.[^/]+\/lesson\//i.test(currentTabUrl)) {
    currentState.lessonUrl = currentTabUrl;
  }

  if (currentState.transcriptUrl) {
    els.transcriptStatus.textContent = shorten(currentState.transcriptUrl);
    els.transcriptStatus.className = 'value';
  } else {
    els.transcriptStatus.textContent = 'no captions — will transcribe video';
    els.transcriptStatus.className = 'value muted';
  }

  if (currentState.videoUrl) {
    els.videoStatus.textContent = shorten(currentState.videoUrl);
    els.videoStatus.className = 'value';
  } else {
    els.videoStatus.textContent = 'press play on the video...';
    els.videoStatus.className = 'value muted';
  }

  if (currentState.lessonUrl) {
    els.lessonStatus.textContent = shorten(currentState.lessonUrl);
    els.lessonStatus.className = 'value';
  } else {
    els.lessonStatus.textContent = '—';
    els.lessonStatus.className = 'value muted';
  }

  // Enable as soon as we have ANY usable source. Prefer transcript, fall back to video.
  els.generate.disabled = generating || !(currentState.transcriptUrl || currentState.videoUrl);
}

async function onGenerate() {
  if (generating || (!currentState?.transcriptUrl && !currentState?.videoUrl)) return;

  generating = true;
  els.generate.disabled = true;
  // Snapshot: the refresh loop replaces currentState while the job is in flight.
  const state = { ...currentState, videoUrls: [...(currentState.videoUrls ?? [])] };

  try {
    if (state.transcriptUrl) {
      await runTranscriptPipeline(state);
    } else {
      await runVideoPipeline(state);
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    generating = false;
    await refreshState();
  }
}

async function runTranscriptPipeline(state) {
  setStatus('Fetching transcript from Echo360...', 'info');

  // Have the background script fetch (so cookies attach properly under MV3)
  const fetchResult = await chrome.runtime.sendMessage({
    type: 'FETCH_TRANSCRIPT',
    url: state.transcriptUrl,
  });

  if (!fetchResult?.ok) {
    setStatus(`Failed to fetch transcript: ${fetchResult?.error ?? 'unknown error'}`, 'error');
    return;
  }

  const slidesFile = els.slides.files[0];
  const slidesBase64 = slidesFile ? await readFileAsBase64(slidesFile) : undefined;
  if (slidesBase64) setStatus('Sending transcript + slides to server...', 'info');
  else setStatus('Sending to local server (the model is generating notes — ~20-60s)...', 'info');

  const r = await fetch(`${SERVER_URL}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transcript: fetchResult.text,
      transcriptUrl: state.transcriptUrl,
      lessonUrl: state.lessonUrl,
      course: els.course.value.trim() || undefined,
      topic: els.topic.value.trim() || undefined,
      slidesBase64,
    }),
  });

  await handleServerResponse(r);
}

async function runVideoPipeline(state) {
  setStatus('Grabbing Echo360 session cookies...', 'info');
  const cookieResult = await chrome.runtime.sendMessage({ type: 'GET_COOKIES' });
  if (!cookieResult?.ok) {
    setStatus(`Failed to read cookies: ${cookieResult?.error ?? 'unknown error'}`, 'error');
    return;
  }

  setStatus(
    'Downloading lecture video → ffmpeg → transcription → notes.\n' +
    'This takes a while (~5-15 min). Keep this popup open.',
    'info'
  );

  const slidesFile = els.slides.files[0];
  const slidesBase64 = slidesFile ? await readFileAsBase64(slidesFile) : undefined;

  const r = await fetch(`${SERVER_URL}/generate-from-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoUrl: state.videoUrl,
      videoUrls: state.videoUrls,
      cookies: cookieResult.cookies,
      lessonUrl: state.lessonUrl,
      course: els.course.value.trim() || undefined,
      topic: els.topic.value.trim() || undefined,
      slidesBase64,
    }),
  });

  await handleServerResponse(r);
}

async function handleServerResponse(r) {
  let data;
  try {
    data = await r.json();
  } catch {
    setStatus(`Error: HTTP ${r.status} (no JSON body)`, 'error');
    return;
  }
  if (!r.ok) {
    setStatus(`Error: ${data.error ?? `HTTP ${r.status}`}`, 'error');
    return;
  }
  const words = typeof data.wordCount === 'number' ? `${data.wordCount.toLocaleString()} words` : '';
  setStatus(`✅ Saved: ${data.filename}\n(${[words, data.model].filter(Boolean).join(' · ')})`, 'success');
  await chrome.runtime.sendMessage({ type: 'CLEAR_STATE', tabId: currentTabId });
}

function onSlidesChange() {
  const file = els.slides.files[0];
  if (file) {
    const sizeMb = (file.size / 1024 / 1024).toFixed(1);
    els.slidesStatus.textContent = `${file.name} (${sizeMb} MB)`;
  } else {
    els.slidesStatus.textContent = '';
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // strip "data:...;base64,"
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = kind ?? '';
}

function shorten(url, n = 38) {
  return url.length > n ? url.slice(0, n) + '…' : url;
}
