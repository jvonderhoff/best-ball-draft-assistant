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

bAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openTab') {
    const url = msg.url + (msg.url.includes('?') ? '&' : '?') + 'bba_auto=1';
    bAPI.tabs.create({ url, active: false });
  }

  if (msg.action === 'closeTab' && sender.tab) {
    bAPI.tabs.remove(sender.tab.id);
  }

  if (['saveDraft', 'getExposure', 'refreshPlayers', 'getRankings'].includes(msg.action)) {
    callNative(msg).then(sendResponse);
    return true; // keep channel open for async response
  }
});
