import { runDiagnostics } from './lib/audioDiagnostics.js';

const tabId = Number(new URLSearchParams(location.search).get('tab'));

const els = {
  run: document.getElementById('run'),
  copy: document.getElementById('copy'),
  status: document.getElementById('status'),
  verdict: document.getElementById('verdict'),
  details: document.getElementById('details'),
  report: document.getElementById('report'),
};

let reportText = '';

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = kind;
}

function renderVerdict(lines) {
  els.verdict.replaceChildren(...lines.map((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    li.className = line.split(':')[0].toLowerCase();
    return li;
  }));
}

els.run.addEventListener('click', async () => {
  if (!Number.isInteger(tabId)) {
    setStatus('Open this page from the extension popup while on a lecture tab.', 'error');
    return;
  }
  els.run.disabled = true;
  els.copy.hidden = true;
  els.details.hidden = true;
  renderVerdict([]);
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', tabId });
    const cookieResult = await chrome.runtime.sendMessage({ type: 'GET_COOKIES' });
    const report = await runDiagnostics({
      state,
      cookies: cookieResult?.ok ? cookieResult.cookies : [],
      onProgress: (text) => setStatus(text),
    });
    reportText = JSON.stringify(report, null, 2);
    els.report.textContent = reportText;
    els.details.hidden = false;
    els.copy.hidden = false;
    renderVerdict(report.summary.verdict);
    setStatus(`Done. Tried ${report.summary.streamsTried} stream URL(s).`);
  } catch (err) {
    setStatus(`Test failed: ${err.message}`, 'error');
  } finally {
    els.run.disabled = false;
  }
});

els.copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(reportText);
  setStatus('Report copied. Paste it into the chat.');
});
