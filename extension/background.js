// Background service worker — captures Echo360 media URLs and exposes them to the popup.
//
// Echo360's player loads stream files matching s0q0/s0q1/... and caption files
// at .vtt URLs. We listen with webRequest and store the most recent match per tab
// so the popup can grab them when the user clicks the button.

const VIDEO_PATTERNS = [/s\dq\d.*\.mp4/i, /\.m3u8(\?|$)/i];
// Only match real caption file requests — Echo360 also pings a /transcript player
// API endpoint that 404s when no captions exist, so be strict about file extensions.
const CAPTION_PATTERNS = [/\.vtt(\?|$)/i, /\.srt(\?|$)/i];

const ECHO360_COOKIE_DOMAINS = [
  'echo360.org',
  'content.echo360.org',
  'echo360.net.au',
  'echo360.org.uk',
  'echo360.ca',
];

// tabId -> { videoUrl, videoUrls, transcriptUrl, lessonUrl, lessonId, updatedAt }
// videoUrls is an array because Echo360 splits camera/screen/audio across multiple
// stream files (s0q0, s1q0, s2q0...). The popup must hand them all to the server
// so it can pick the one with an audio track.
const tabState = new Map();

const emptyState = () => ({
  videoUrl: null,
  videoUrls: [],
  transcriptUrl: null,
  lessonUrl: null,
  lessonId: null,
  updatedAt: 0,
});

const storageKey = (tabId) => `tab:${tabId}`;

// MV3 service workers are killed after ~30s idle, which wiped the in-memory Map — so
// pressing play and opening the popup a minute later showed nothing captured. Mirror
// state into storage.session (cleared when the browser closes) and rehydrate on wake.
const ready = chrome.storage.session.get(null)
  .then((all) => {
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith('tab:')) tabState.set(Number(key.slice(4)), { ...emptyState(), ...value });
    }
  })
  .catch(() => {});

function getState(tabId) {
  if (!tabState.has(tabId)) tabState.set(tabId, emptyState());
  return tabState.get(tabId);
}

async function updateState(tabId, mutate) {
  await ready;
  const state = getState(tabId);
  mutate(state);
  chrome.storage.session.set({ [storageKey(tabId)]: state }).catch(() => {});
}

async function clearState(tabId) {
  await ready;
  tabState.delete(tabId);
  await chrome.storage.session.remove(storageKey(tabId)).catch(() => {});
}

function lessonIdOf(url) {
  return url?.match(/echo360\.[^/]+\/lesson\/([^/?#]+)/i)?.[1] ?? null;
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;

    if (CAPTION_PATTERNS.some(p => p.test(url))) {
      updateState(details.tabId, (state) => {
        state.transcriptUrl = url;
        state.updatedAt = Date.now();
      });
    } else if (VIDEO_PATTERNS.some(p => p.test(url))) {
      updateState(details.tabId, (state) => {
        state.videoUrl = url;
        if (!state.videoUrls.includes(url)) state.videoUrls.push(url);
        state.updatedAt = Date.now();
      });
    }
  },
  {
    urls: [
      '*://*.echo360.org/*',
      '*://*.echo360.net.au/*',
      '*://*.echo360.org.uk/*',
      '*://*.echo360.ca/*',
      '*://content.echo360.org/*',
      '*://captions.echo360.org/*',
    ],
  }
);

// Track the lesson page URL itself so we can pass it to the server
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const lessonId = lessonIdOf(changeInfo.url);
  if (!lessonId) return;
  updateState(tabId, (state) => {
    // Moving to a different lecture in the same tab: forget the previous lecture's
    // captions/streams, otherwise notes get generated from the wrong lecture.
    if (state.lessonId !== lessonId) Object.assign(state, emptyState());
    state.lessonId = lessonId;
    state.lessonUrl = changeInfo.url;
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearState(tabId);
});

// Popup ↔ background message API
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    const tabId = msg.tabId ?? sender.tab?.id;
    ready.then(() => sendResponse(getState(tabId)));
    return true;
  }

  if (msg.type === 'CLEAR_STATE') {
    const tabId = msg.tabId ?? sender.tab?.id;
    clearState(tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'FETCH_TRANSCRIPT') {
    // Run inside background context — Chrome attaches the user's session cookies
    // automatically because the host_permissions include the echo360 CDN domains.
    fetch(msg.url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ ok: false, error: `HTTP ${res.status}` });
          return;
        }
        const text = await res.text();
        sendResponse({ ok: true, text });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for async response
  }

  if (msg.type === 'GET_COOKIES') {
    // Collect cookies from every echo360 domain so the server can attach them when
    // downloading the MP4 from CloudFront (which gates content with signed cookies).
    Promise.all(
      ECHO360_COOKIE_DOMAINS.map(domain => chrome.cookies.getAll({ domain }))
    )
      .then((groups) => {
        const seen = new Set();
        const cookies = [];
        for (const group of groups) {
          for (const c of group) {
            const key = `${c.domain}|${c.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            cookies.push({ name: c.name, value: c.value, domain: c.domain });
          }
        }
        sendResponse({ ok: true, cookies });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});
