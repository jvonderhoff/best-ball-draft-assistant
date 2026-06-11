const bAPI = typeof browser !== 'undefined' ? browser : chrome;

// ── Remote Flask (Render) ─────────────────────────────────────────────────────
const RENDER_BASE = 'https://best-ball-draft-assistant.onrender.com';

async function renderPost(endpoint, body) {
  try {
    const r = await fetch(RENDER_BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok ? await r.json() : { ok: false, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function renderGet(endpoint) {
  try {
    const r = await fetch(RENDER_BASE + endpoint);
    return r.ok ? await r.json() : { ok: false, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Local Flask proxy (live-draft push) ───────────────────────────────────────
// Content scripts can't reach the self-signed LAN cert; background.js can.
const LOCAL_BASE = 'https://192.168.1.161:8000';

async function flaskPost(endpoint, body) {
  try {
    const r = await fetch(LOCAL_BASE + endpoint, {
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
    const r = await fetch(LOCAL_BASE + endpoint);
    return r.ok ? await r.json() : { ok: false, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Save draft to Render ──────────────────────────────────────────────────────
async function saveDraftToRender(msg) {
  const body = {
    dk_draft_id: msg.dk_draft_id,
    my_position: msg.my_position,
    picks:       msg.picks,
    contest:     msg.contest || '',
  };
  const result = await renderPost('/api/drafts/import', body);
  if (result.duplicate) return { ok: true, duplicate: true, draft_id: result.draft_id };
  if (result.success)   return { ok: true, draft_id: result.draft_id };
  return { ok: false, error: result.error || 'unknown' };
}

// ── Message handler ───────────────────────────────────────────────────────────

bAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openTab') {
    const url = msg.url + (msg.url.includes('?') ? '&' : '?') + 'bba_auto=1';
    bAPI.tabs.create({ url, active: false });
  }

  if (msg.action === 'closeTab' && sender.tab) {
    bAPI.tabs.remove(sender.tab.id);
  }

  // Proxy local Flask POST/GET (live-draft push)
  if (msg.action === 'flaskPost') {
    flaskPost(msg.endpoint, msg.body).then(sendResponse);
    return true;
  }

  if (msg.action === 'flaskGet') {
    flaskGet(msg.endpoint).then(sendResponse);
    return true;
  }

  // Save completed draft to Render
  if (msg.action === 'saveDraft') {
    saveDraftToRender(msg).then(sendResponse);
    return true;
  }

  // Rankings — read from Render
  if (msg.action === 'getRankings') {
    renderGet('/api/rankings').then(data => {
      sendResponse(Array.isArray(data) ? { ok: true, data } : { ok: false });
    });
    return true;
  }
});
