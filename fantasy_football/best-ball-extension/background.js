const bAPI = typeof browser !== 'undefined' ? browser : chrome;

// ── Native messaging ──────────────────────────────────────────────────────────
// db_writer.py is launched on-demand by Firefox; no server needs to be running.

function callNative(msg) {
  return new Promise((resolve) => {
    bAPI.runtime.sendNativeMessage('bestball_assistant', msg, response => {
      if (bAPI.runtime.lastError) {
        console.error('[BBA background] native messaging error:', bAPI.runtime.lastError.message);
        resolve({ ok: false, error: bAPI.runtime.lastError.message });
        return;
      }
      console.log('[BBA background] native response:', response);
      resolve(response || { ok: false, error: 'empty response' });
    });
  });
}

// ── Message handler ───────────────────────────────────────────────────────────

const FLASK_BASE = 'https://192.168.1.161:8000';

// Proxy Flask requests from content scripts (which can't reach the self-signed cert).
async function flaskPost(endpoint, body) {
  try {
    const r = await fetch(FLASK_BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok ? await r.json() : { ok: false, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function flaskGet(endpoint) {
  try {
    const r = await fetch(FLASK_BASE + endpoint);
    return r.ok ? await r.json() : { ok: false, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

bAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openTab') {
    const url = msg.url + (msg.url.includes('?') ? '&' : '?') + 'bba_auto=1';
    bAPI.tabs.create({ url, active: false });
  }

  if (msg.action === 'closeTab' && sender.tab) {
    bAPI.tabs.remove(sender.tab.id);
  }

  // Proxy Flask POST/GET from content scripts (cert not trusted in content script context)
  if (msg.action === 'flaskPost') {
    flaskPost(msg.endpoint, msg.body).then(sendResponse);
    return true;
  }

  if (msg.action === 'flaskGet') {
    flaskGet(msg.endpoint).then(sendResponse);
    return true;
  }

  if (['saveDraft', 'getExposure', 'refreshPlayers', 'getRankings'].includes(msg.action)) {
    callNative(msg).then(sendResponse);
    return true; // keep channel open for async response
  }
});
