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

// tabId -> { videoUrl, videoUrls, transcriptUrl, lessonUrl, updatedAt }
// videoUrls is an array because Echo360 splits camera/screen/audio across multiple
// stream files (s0q0, s1q0, s2q0...). The popup must hand them all to the server
// so it can pick the one with an audio track.
const tabState = new Map();

function getState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, {
      videoUrl: null,
      videoUrls: [],
      transcriptUrl: null,
      lessonUrl: null,
      updatedAt: 0,
    });
  }
  return tabState.get(tabId);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;
    const state = getState(details.tabId);

    if (CAPTION_PATTERNS.some(p => p.test(url))) {
      state.transcriptUrl = url;
      state.updatedAt = Date.now();
    } else if (VIDEO_PATTERNS.some(p => p.test(url))) {
      state.videoUrl = url;
      if (!state.videoUrls.includes(url)) state.videoUrls.push(url);
      state.updatedAt = Date.now();
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
  if (changeInfo.url && /echo360\.[^/]+\/lesson\//i.test(changeInfo.url)) {
    const state = getState(tabId);
    state.lessonUrl = changeInfo.url;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

// Popup ↔ background message API
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    const tabId = msg.tabId ?? sender.tab?.id;
    sendResponse(getState(tabId));
    return true;
  }

  if (msg.type === 'CLEAR_STATE') {
    const tabId = msg.tabId ?? sender.tab?.id;
    tabState.delete(tabId);
    sendResponse({ ok: true });
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
