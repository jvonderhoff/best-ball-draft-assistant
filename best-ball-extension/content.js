// Best Ball Draft Assistant — content script
// Injected into draftkings.com pages

const bAPI = typeof browser !== 'undefined' ? browser : chrome;

// ── State ────────────────────────────────────────────────────────────────────

let state = {
  available: [],     // players not yet marked drafted
  drafted: new Set(), // player IDs marked taken (by anyone)
  myTeam: [],
  overallPick: 1,
  numTeams: null,
  myPosition: null,
  stackIntensity: 'medium',
  diversifyStrength: 0.5,
  isSetup: false,
  isComplete: false,
};

let exposure = {};

async function loadExposure() {
  try {
    const resp = await fetch('http://localhost:8000/api/drafts/exposure');
    if (!resp.ok) return;
    const data = await resp.json();
    exposure = data.players || {};
  } catch (_) {}
}

async function saveDraftToFlask(contest = '') {
  try {
    const resp = await fetch('http://localhost:8000/api/drafts/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contest })
    });
    return resp.ok;
  } catch (_) { return false; }
}

let playerNameMap = {};

function initPlayers() {
  if (typeof PLAYERS === 'undefined' || !PLAYERS.length) return;
  state.available = [...PLAYERS];
  playerNameMap = {};
  PLAYERS.forEach(p => {
    playerNameMap[p.name.toLowerCase()] = p;
  });
}

function loadSettings(cb) {
  bAPI.storage.local.get(['numTeams', 'myPosition', 'stackIntensity', 'diversifyStrength'], result => {
    if (result.numTeams && result.myPosition) {
      state.numTeams   = result.numTeams;
      state.myPosition = result.myPosition;
      state.isSetup    = true;
    }
    state.stackIntensity    = result.stackIntensity    || 'medium';
    state.diversifyStrength = result.diversifyStrength != null ? result.diversifyStrength : 0.5;
    cb();
  });
}

// ── Draft actions ─────────────────────────────────────────────────────────────

function markTaken(playerId, silent = false) {
  if (state.drafted.has(playerId)) return;
  state.drafted.add(playerId);
  state.available = state.available.filter(p => p.id !== playerId);
  state.overallPick++;
  state.isComplete = state.myTeam.length >= 20;
  if (!silent) render();
}

function myPick(playerId) {
  const player = state.available.find(p => p.id === playerId);
  if (!player) return;
  state.drafted.add(playerId);
  state.available = state.available.filter(p => p.id !== playerId);
  state.myTeam.push(player);
  state.overallPick++;
  state.isComplete = state.myTeam.length >= 20;
  render();
}

function undoLast() {
  if (state.overallPick <= 1) return;
  const last = state.myTeam[state.myTeam.length - 1];
  if (last) {
    state.myTeam.pop();
    state.drafted.delete(last.id);
    state.available.unshift(last);
    state.available.sort((a, b) => a.adp - b.adp);
  }
  state.overallPick = Math.max(1, state.overallPick - 1);
  state.isComplete = false;
  render();
}

// Jump to a specific overall pick (mid-draft re-sync)
function setCurrentPick(n) {
  state.overallPick = Math.max(1, parseInt(n) || 1);
  render();
}

// ── Page scan: try to mark already-drafted players from DK DOM ────────────────

function scanPageForDraftedPlayers() {
  let found = 0;
  const allText = document.body.innerText;
  for (const [name, player] of Object.entries(playerNameMap)) {
    if (state.drafted.has(player.id)) continue;
    if (allText.toLowerCase().includes(name)) {
      markTaken(player.id, true);
      found++;
    }
  }
  render();
  return found;
}

// ── Auto-detection via MutationObserver ───────────────────────────────────────

const toastedPlayers = new Set();

function extractPlayerFromText(text) {
  if (!text || text.length < 4 || text.length > 120) return null;
  const lower = text.toLowerCase();
  for (const [name, player] of Object.entries(playerNameMap)) {
    if (lower.includes(name)) return player;
  }
  return null;
}

function showDetectionToast(player) {
  const existing = document.getElementById('bba-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'bba-toast';
  toast.className = 'bba-toast';
  toast.innerHTML = `
    <span>Detected: <strong>${player.name}</strong> (${player.pos})</span>
    <button class="bba-toast-btn bba-my-pick" data-id="${player.id}">My Pick</button>
    <button class="bba-toast-btn bba-taken" data-id="${player.id}">Taken</button>
    <button class="bba-toast-dismiss">✕</button>
  `;
  document.body.appendChild(toast);

  toast.querySelector('.bba-my-pick').addEventListener('click', () => { myPick(player.id); toast.remove(); });
  toast.querySelector('.bba-taken').addEventListener('click', () => { markTaken(player.id); toast.remove(); });
  toast.querySelector('.bba-toast-dismiss').addEventListener('click', () => toast.remove());
  setTimeout(() => toast?.remove(), 10000);
}

// Extract player from DK pick element: "Jalen Hurts | QB <span>PHI</span>"
function extractPlayerFromPickElement(el) {
  if (!el) return null;
  const text = el.textContent || '';
  const pipeIdx = text.indexOf(' | ');
  if (pipeIdx === -1) return null;
  const name = text.slice(0, pipeIdx).trim().toLowerCase();
  return playerNameMap[name] || null;
}

// Find the player div next to a "Last Pick:" label
function getPlayerFromLastPickLabel(labelEl) {
  // Sibling pattern: <div class="...last-pick">Last Pick: </div><div>Name | POS TEAM</div>
  const sibling = labelEl.nextElementSibling;
  if (sibling) return extractPlayerFromPickElement(sibling);
  // Sometimes the label and player share a parent — check parent's next sibling
  const parentSib = labelEl.parentElement?.nextElementSibling;
  if (parentSib) return extractPlayerFromPickElement(parentSib);
  return null;
}

let lastDetectedPick = null;

function onMutation(mutations) {
  if (!state.isSetup) return;

  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      // Primary: "Last Pick:" label appearing means a pick just happened
      const lastPickLabels = node.querySelectorAll
        ? [
            ...node.querySelectorAll('[class*="last-pick"], [class*="last-drafted"]'),
            ...(node.className?.includes?.('last-pick') || node.className?.includes?.('last-drafted') ? [node] : [])
          ]
        : [];

      for (const label of lastPickLabels) {
        const player = getPlayerFromLastPickLabel(label);
        if (!player || player.id === lastDetectedPick) continue;
        if (!state.available.find(p => p.id === player.id)) continue;
        lastDetectedPick = player.id;
        toastedPlayers.add(player.id);
        showDetectionToast(player);
      }

      // Fallback: any new element with " | " pipe pattern (covers pick history rows)
      if (!lastPickLabels.length) {
        const player = extractPlayerFromPickElement(node);
        if (player && state.available.find(p => p.id === player.id) && !toastedPlayers.has(player.id)) {
          toastedPlayers.add(player.id);
          showDetectionToast(player);
        }
        // Also check children
        if (node.querySelectorAll) {
          for (const child of node.querySelectorAll('[class*="PickOrder"]')) {
            const p = extractPlayerFromPickElement(child.parentElement);
            if (p && state.available.find(x => x.id === p.id) && !toastedPlayers.has(p.id)) {
              toastedPlayers.add(p.id);
              showDetectionToast(p);
              break;
            }
          }
        }
      }
    }
  }
}

// ── Overlay UI ────────────────────────────────────────────────────────────────

let overlayEl = null;
let overlayOpen = true;
let searchQuery = '';
let posFilter = '';
let activeTab = 'board';

function createOverlay() {
  if (document.getElementById('bba-root')) return;

  const root = document.createElement('div');
  root.id = 'bba-root';
  root.innerHTML = `
    <div id="bba-toggle" title="Best Ball Assistant">🏈</div>
    <div id="bba-panel">
      <div id="bba-header">
        <span id="bba-title">🏈 Best Ball</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button id="bba-undo" title="Undo last pick">↩</button>
          <button id="bba-close">✕</button>
        </div>
      </div>

      <div id="bba-setup-banner" style="display:none">
        <span>⚙️ Not configured — </span>
        <a id="bba-open-setup">open setup</a>
      </div>

      <div id="bba-sync-bar" style="display:none">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span>Pick #</span>
          <input id="bba-pick-input" type="number" min="1" max="240" placeholder="e.g. 47" style="width:60px;background:#0f1419;border:1px solid #2a3f5f;color:#e0e0e0;border-radius:3px;padding:3px 6px;font-size:0.82em;" />
          <button id="bba-set-pick" class="bba-sync-btn">Set</button>
          <button id="bba-scan-page" class="bba-sync-btn">Scan page</button>
        </div>
        <div id="bba-sync-status" style="font-size:0.72em;color:#78909c;margin-top:4px"></div>
      </div>

      <div id="bba-turn-bar"></div>
      <div id="bba-suggestion"></div>

      <div id="bba-tabs">
        <button class="bba-tab active" data-tab="board">Top Picks</button>
        <button class="bba-tab" data-tab="team">My Team (<span id="bba-team-count">0</span>)</button>
        <button class="bba-tab" data-tab="stacks">Stacks</button>
      </div>

      <div id="bba-search-row">
        <input id="bba-search" type="text" placeholder="Search player or team…" />
        <div id="bba-filters">
          <button class="bba-filter active" data-pos="">All</button>
          <button class="bba-filter" data-pos="QB">QB</button>
          <button class="bba-filter" data-pos="RB">RB</button>
          <button class="bba-filter" data-pos="WR">WR</button>
          <button class="bba-filter" data-pos="TE">TE</button>
        </div>
      </div>

      <div id="bba-list"></div>
      <div id="bba-resize-handle" title="Drag to resize"></div>
    </div>
  `;

  document.body.appendChild(root);
  overlayEl = root;

  document.getElementById('bba-toggle').addEventListener('click', togglePanel);
  document.getElementById('bba-close').addEventListener('click', togglePanel);
  document.getElementById('bba-undo').addEventListener('click', undoLast);
  document.getElementById('bba-open-setup').addEventListener('click', () => bAPI.runtime.sendMessage({ action: 'openPopup' }));

  document.getElementById('bba-set-pick').addEventListener('click', () => {
    const val = document.getElementById('bba-pick-input').value;
    setCurrentPick(val);
    document.getElementById('bba-sync-status').textContent = `Pick set to #${state.overallPick}`;
  });

  document.getElementById('bba-scan-page').addEventListener('click', () => {
    const status = document.getElementById('bba-sync-status');
    status.textContent = 'Scanning…';
    const found = scanPageForDraftedPlayers();
    status.textContent = found > 0
      ? `Marked ${found} players as drafted — ${state.available.length} remaining`
      : 'No new drafted players detected on page';
  });

  document.getElementById('bba-search').addEventListener('input', e => {
    searchQuery = e.target.value;
    renderList();
  });

  root.querySelectorAll('.bba-tab').forEach(btn => {
    btn.addEventListener('click', e => {
      root.querySelectorAll('.bba-tab').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      activeTab = e.target.dataset.tab;
      renderList();
    });
  });

  root.querySelectorAll('.bba-filter').forEach(btn => {
    btn.addEventListener('click', e => {
      root.querySelectorAll('.bba-filter').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      posFilter = e.target.dataset.pos;
      renderList();
    });
  });

  makeDraggable(document.getElementById('bba-header'), document.getElementById('bba-panel'));
  makeResizable(document.getElementById('bba-resize-handle'), document.getElementById('bba-panel'));
}

function togglePanel() {
  const panel = document.getElementById('bba-panel');
  overlayOpen = !overlayOpen;
  panel.style.display = overlayOpen ? 'flex' : 'none';
}

function makeDraggable(handle, target) {
  let startX, startY, startRight, startTop;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX; startY = e.clientY;
    const rect = target.getBoundingClientRect();
    startRight = window.innerWidth - rect.right;
    startTop = rect.top;
    const onMove = e => {
      target.style.right = Math.max(0, startRight + (startX - e.clientX)) + 'px';
      target.style.top   = Math.max(0, startTop  + (e.clientY - startY))  + 'px';
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function makeResizable(handle, target) {
  let startX, startY, startW, startH;
  handle.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation();
    startX = e.clientX; startY = e.clientY;
    startW = target.offsetWidth; startH = target.offsetHeight;
    const onMove = e => {
      target.style.width     = Math.max(260, startW + (startX - e.clientX)) + 'px';
      target.style.maxHeight = Math.max(300, startH + (e.clientY - startY)) + 'px';
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  if (!overlayEl) return;
  renderSetupBanner();
  renderSyncBar();
  renderTurnBar();
  renderSuggestion();
  document.getElementById('bba-team-count').textContent = state.myTeam.length;
  renderList();
}

function renderSetupBanner() {
  document.getElementById('bba-setup-banner').style.display = state.isSetup ? 'none' : 'flex';
}

function renderSyncBar() {
  // Show sync bar whenever set up (useful mid-draft and at start)
  document.getElementById('bba-sync-bar').style.display = state.isSetup ? 'block' : 'none';
}

function renderTurnBar() {
  const bar = document.getElementById('bba-turn-bar');
  if (!state.isSetup) {
    bar.className = 'bba-turn-waiting';
    bar.textContent = 'Configure setup to begin';
    return;
  }
  if (state.isComplete) {
    bar.className = 'bba-turn-mine';
    bar.innerHTML = `✓ Draft complete! &nbsp;<button id="bba-save-draft" style="padding:3px 10px;background:#c8e6c9;color:#1b5e20;border:none;border-radius:4px;font-weight:700;cursor:pointer;font-size:0.82em;">Save Draft</button>`;
    document.getElementById('bba-save-draft')?.addEventListener('click', async e => {
      const btn = e.target;
      const ok = await saveDraftToFlask();
      btn.textContent = ok ? '✓ Saved' : 'Flask not running';
      btn.disabled = true;
      if (ok) loadExposure();
    });
    return;
  }

  const myTurn = isMyTurn(state.overallPick, state.numTeams, state.myPosition);
  const round  = currentRound(state.overallPick, state.numTeams);
  const takenCount = state.drafted.size;

  if (myTurn) {
    bar.className = 'bba-turn-mine';
    bar.textContent = `YOUR PICK  •  Round ${round}  •  ${state.myTeam.length + 1}/20  •  ${takenCount} off board`;
  } else {
    const until = picksUntilMyTurn(state.overallPick, state.numTeams, state.myPosition);
    const next  = nextMyOverallPick(state.overallPick + 1, state.numTeams, state.myPosition);
    bar.className = 'bba-turn-waiting';
    bar.textContent = `Round ${round}  •  ${until} picks until yours (#${next})  •  ${takenCount} off board`;
  }
}

function renderSuggestion() {
  const box = document.getElementById('bba-suggestion');
  const myTurn = state.isSetup && isMyTurn(state.overallPick, state.numTeams, state.myPosition);
  if (!myTurn || state.isComplete) { box.style.display = 'none'; return; }

  const rec = getRecommendation(state.available, state.myTeam, state.myTeam.length + 1, state.stackIntensity, exposure, state.diversifyStrength);
  if (!rec) { box.style.display = 'none'; return; }

  const p = rec.player;
  box.style.display = 'block';
  box.innerHTML = `
    <div class="bba-rec-label">Top Recommendation</div>
    <div class="bba-rec-body">
      <div>
        <div class="bba-rec-name">${p.name} <span class="bba-pos bba-pos-${p.pos}">${p.pos}</span></div>
        <div class="bba-rec-meta">${p.team} · Bye ${p.bye} · ADP ${p.adp} · ${p.dk_proj} pts</div>
        <div class="bba-rec-reason">${rec.reason}</div>
      </div>
      <button class="bba-btn-pick" data-id="${p.id}">My Pick</button>
    </div>
  `;
  box.querySelector('.bba-btn-pick').addEventListener('click', e => myPick(e.target.dataset.id));
}

function renderList() {
  const listEl = document.getElementById('bba-list');
  if (activeTab === 'team')   { renderTeam(listEl);   return; }
  if (activeTab === 'stacks') { renderStacks(listEl);  return; }

  const myTurn   = state.isSetup && isMyTurn(state.overallPick, state.numTeams, state.myPosition);
  const needs    = getTeamNeeds(state.myTeam);
  const qbTeams  = getMyQBTeams(state.myTeam);
  const myTeamSet = new Set(state.myTeam.map(p => p.team));

  // Only show available (non-drafted) players
  let players = [...state.available];
  if (posFilter) players = players.filter(p => p.pos === posFilter);

  const isSearching = searchQuery.trim().length > 0;
  if (isSearching) {
    const q = searchQuery.toLowerCase();
    players = players.filter(p => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q));
  }

  if (myTurn) {
    players.sort((a, b) =>
      calculateValue(b, needs, state.myTeam.length + 1, state.myTeam, state.stackIntensity) -
      calculateValue(a, needs, state.myTeam.length + 1, state.myTeam, state.stackIntensity)
    );
  } else {
    players.sort((a, b) => a.adp - b.adp);
  }

  const display = isSearching ? players.slice(0, 30) : players.slice(0, 10);

  if (!display.length) {
    listEl.innerHTML = `<div class="bba-empty">${isSearching ? 'No players found' : 'All players drafted!'}</div>`;
    return;
  }

  listEl.innerHTML = display.map(p => {
    const isQBStack   = ['WR', 'TE'].includes(p.pos) && qbTeams.has(p.team);
    const hasTeammate = myTeamSet.has(p.team);
    const stackBadge  = isQBStack
      ? `<span class="bba-stack-badge bba-stack-qb">STACK</span>`
      : hasTeammate ? `<span class="bba-stack-badge bba-stack-team">+${p.team}</span>` : '';
    const exp = exposure[p.id];
    const expBadge = exp ? `<span class="bba-exp-badge">${Math.round(exp.exposure_rate * 100)}%</span>` : '';
    return `
      <div class="bba-player-row bba-pos-border-${p.pos}${isQBStack ? ' bba-is-stack' : ''}">
        <div class="bba-player-info">
          <div class="bba-player-name">${p.name} <span class="bba-pos bba-pos-${p.pos}">${p.pos}</span>${stackBadge}${expBadge}</div>
          <div class="bba-player-meta">${p.team} · ADP ${p.adp} · ${p.dk_proj} pts</div>
        </div>
        <div class="bba-player-btns">
          <button class="bba-btn-pick ${myTurn ? '' : 'bba-dim'}" data-id="${p.id}">My Pick</button>
          <button class="bba-btn-taken" data-id="${p.id}">Taken</button>
        </div>
      </div>`;
  }).join('');

  if (!isSearching && players.length > 10) {
    listEl.innerHTML += `<div class="bba-empty" style="font-size:0.72em;padding:10px">${players.length - 10} more — search to find them</div>`;
  }

  listEl.querySelectorAll('.bba-btn-pick').forEach(btn =>
    btn.addEventListener('click', e => myPick(e.currentTarget.dataset.id)));
  listEl.querySelectorAll('.bba-btn-taken').forEach(btn =>
    btn.addEventListener('click', e => markTaken(e.currentTarget.dataset.id)));
}

function renderTeam(listEl) {
  if (!state.myTeam.length) {
    listEl.innerHTML = '<div class="bba-empty">No picks yet — use "My Pick" to add players</div>';
    return;
  }
  const byPos = {};
  state.myTeam.forEach(p => { (byPos[p.pos] = byPos[p.pos] || []).push(p); });
  const proj = state.myTeam.reduce((sum, p) => sum + (p.dk_proj || 0), 0);
  listEl.innerHTML =
    `<div style="padding:8px 12px;font-size:0.75em;color:#4fc3f7;border-bottom:1px solid #2a3f5f">
      ${state.myTeam.length} players · ${proj} proj pts
    </div>` +
    ['QB', 'RB', 'WR', 'TE'].map(pos => {
      if (!byPos[pos]) return '';
      return `<div class="bba-pos-group">${pos} (${byPos[pos].length})</div>` +
        byPos[pos].map(p => `
          <div class="bba-player-row bba-pos-border-${p.pos} bba-drafted">
            <div class="bba-player-info">
              <div class="bba-player-name">${p.name}</div>
              <div class="bba-player-meta">${p.team} · Bye ${p.bye} · ${p.dk_proj} pts</div>
            </div>
          </div>`).join('');
    }).join('');
}

function renderStacks(listEl) {
  const stacks  = getStackSummary(state.myTeam);
  const qbTeams = getMyQBTeams(state.myTeam);

  if (!stacks.length && !state.myTeam.length) {
    listEl.innerHTML = '<div class="bba-empty">Draft players to see stacking opportunities</div>';
    return;
  }

  let html = '';
  if (stacks.length) {
    html += '<div class="bba-stack-section-label">Your Stacks</div>';
    stacks.forEach(({ team, positions, players }) => {
      html += `
        <div class="bba-stack-card">
          <div class="bba-stack-team-name">${team} <span class="bba-stack-positions">${positions}</span></div>
          ${players.map(p => `<div class="bba-stack-player">${p.name} (${p.pos})</div>`).join('')}
        </div>`;
    });
  }

  if (qbTeams.size) {
    const stackmates = state.available
      .filter(p => ['WR', 'TE'].includes(p.pos) && qbTeams.has(p.team))
      .sort((a, b) => a.adp - b.adp);
    html += '<div class="bba-stack-section-label">Available Stackmates</div>';
    html += stackmates.length
      ? stackmates.map(p => `
          <div class="bba-player-row bba-pos-border-${p.pos} bba-is-stack">
            <div class="bba-player-info">
              <div class="bba-player-name">${p.name} <span class="bba-pos bba-pos-${p.pos}">${p.pos}</span></div>
              <div class="bba-player-meta">${p.team} · ADP ${p.adp} · ${p.dk_proj} pts</div>
            </div>
            <div class="bba-player-btns">
              <button class="bba-btn-pick" data-id="${p.id}">My Pick</button>
              <button class="bba-btn-taken" data-id="${p.id}">Taken</button>
            </div>
          </div>`).join('')
      : '<div class="bba-empty">None left on the board</div>';
  }

  listEl.innerHTML = html || '<div class="bba-empty">No QB drafted yet</div>';
  listEl.querySelectorAll('.bba-btn-pick').forEach(btn =>
    btn.addEventListener('click', e => myPick(e.currentTarget.dataset.id)));
  listEl.querySelectorAll('.bba-btn-taken').forEach(btn =>
    btn.addEventListener('click', e => markTaken(e.currentTarget.dataset.id)));
}

// ── Listen for settings changes from popup ────────────────────────────────────

bAPI.runtime.onMessage.addListener(msg => {
  if (msg.action === 'settingsUpdated') {
    state.numTeams          = msg.numTeams;
    state.myPosition        = msg.myPosition;
    state.stackIntensity    = msg.stackIntensity    || 'medium';
    state.diversifyStrength = msg.diversifyStrength != null ? msg.diversifyStrength : 0.5;
    state.isSetup           = true;
    state.available    = [...PLAYERS];
    state.drafted      = new Set();
    state.myTeam       = [];
    state.overallPick  = 1;
    state.isComplete   = false;
    render();
  }
});

// ── Auto-detect draft position ────────────────────────────────────────────────

let autoPositionDetected = false;

// Strategy 1: Read window.mvcVars for any position data DK embeds on the page
function tryDetectPositionFromMvcVars() {
  const mv = window.mvcVars;
  if (!mv) return null;

  const sd = mv.snakeDraft;
  if (!sd) return null;

  // numTeams from contest config
  const numTeams = sd.contestData?.maxEntries || sd.numTeams || sd.teamCount || null;

  // DK sometimes puts the user's draft slot directly in mvcVars
  const entry = sd.draftEntry || sd.entry || sd.userEntry || sd.myEntry;
  const pos = entry?.draftPosition ?? entry?.pickPosition ?? entry?.slotPosition ?? entry?.draftSlot ?? null;
  if (pos && pos > 0) return { position: pos, numTeams: numTeams || 12 };

  return numTeams ? { position: null, numTeams } : null;
}

// Strategy 2: Scan draft board DOM for "YOU" / username column
function tryDetectPositionFromDOM() {
  // DraftKings renders the pick order as a horizontal list of team columns.
  // The current user's column is labelled with their username or "YOU".
  const mv = window.mvcVars;
  const username = (mv?.currentUser?.displayName || mv?.user?.displayName || '').toLowerCase();

  // Look for a column header containing "YOU" or the username
  const candidates = [...document.querySelectorAll('[class*="PickOrder"], [class*="pick-order"], [class*="DraftOrder"], [class*="draft-order"]')];
  for (const container of candidates) {
    const cols = container.children;
    for (let i = 0; i < cols.length; i++) {
      const text = cols[i].textContent.toLowerCase();
      if (text.includes('you') || (username && text.includes(username))) {
        return { position: i + 1, numTeams: cols.length };
      }
    }
  }

  // Wider search: any element whose text is literally "YOU"
  const result = document.evaluate(
    "//*[normalize-space(text())='YOU' or normalize-space(text())='you']",
    document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
  );
  const youEl = result.singleNodeValue;
  if (youEl) {
    // Walk up to find siblings to count position
    const parent = youEl.closest('[class*="pick-order"], [class*="PickOrder"], [class*="draft-order"], [class*="DraftOrder"]');
    if (parent?.parentElement) {
      const siblings = [...parent.parentElement.children];
      const idx = siblings.indexOf(parent);
      if (idx >= 0) return { position: idx + 1, numTeams: siblings.length };
    }
  }

  return null;
}

// Strategy 3: infer from "PK X" timer at start of round 1
// At overallPick O in round 1, PK X means our next pick is at O + X, so position = O + X
function tryDetectPositionFromPK(pkValue) {
  const numTeams = state.numTeams || tryDetectPositionFromMvcVars()?.numTeams || 12;
  // Only reliable in round 1
  if (state.overallPick > numTeams) return null;
  const position = state.overallPick + pkValue;
  if (position < 1 || position > numTeams) return null;
  return { position, numTeams };
}

function showPositionDetectedBanner(position, numTeams) {
  if (document.getElementById('bba-pos-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'bba-pos-banner';
  banner.className = 'bba-toast';
  banner.style.cssText = 'bottom:auto;top:80px;';
  banner.innerHTML = `
    <span>🎯 Pick #<strong>${position}</strong> of ${numTeams} detected</span>
    <button class="bba-toast-btn bba-my-pick" id="bba-pos-confirm">Use this</button>
    <button class="bba-toast-dismiss" id="bba-pos-dismiss">✕</button>
  `;
  document.body.appendChild(banner);

  document.getElementById('bba-pos-confirm').addEventListener('click', () => {
    bAPI.storage.local.set({ numTeams, myPosition: position }, () => {
      state.numTeams   = numTeams;
      state.myPosition = position;
      state.isSetup    = true;
      autoPositionDetected = true;
      banner.remove();
      render();
    });
  });
  document.getElementById('bba-pos-dismiss').addEventListener('click', () => {
    autoPositionDetected = false;
    banner.remove();
  });
}

async function tryAutoDetectPosition() {
  if (state.isSetup || autoPositionDetected) return;

  // Strategy 1 — mvcVars
  const fromVars = tryDetectPositionFromMvcVars();
  if (fromVars?.position) {
    autoPositionDetected = true;
    showPositionDetectedBanner(fromVars.position, fromVars.numTeams);
    return;
  }

  // Apply numTeams from mvcVars even if no position yet
  if (fromVars?.numTeams && !state.numTeams) state.numTeams = fromVars.numTeams;

  // Strategy 2 — DOM
  const fromDOM = tryDetectPositionFromDOM();
  if (fromDOM?.position) {
    autoPositionDetected = true;
    showPositionDetectedBanner(fromDOM.position, fromDOM.numTeams);
    return;
  }
}

// ── DraftKings turn timer watcher ─────────────────────────────────────────────

// XPath confirmed from live draft: countdown / "on the clock" span
const DK_TIMER_XPATH = '/html/body/div[3]/div/div/div/div/div[2]/div[1]/div[2]/div[1]/span';

function getDKTimerEl() {
  const result = document.evaluate(DK_TIMER_XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
  return result.singleNodeValue;
}

function parseDKTimerText(text) {
  if (!text) return null;
  const t = text.trim();
  // "on the clock" / "your pick" → my turn
  if (/on the clock|your pick|pick now|you're up/i.test(t)) return { myTurn: true, label: 'On the clock!', pkValue: 0 };
  // "PK 0" or "PK 1" → effectively my turn
  const pkMatch = t.match(/^PK\s*(\d+)$/i);
  if (pkMatch) {
    const picks = parseInt(pkMatch[1]);
    if (picks <= 1) return { myTurn: true, label: 'On the clock!', pkValue: picks };
    return { myTurn: false, label: `${picks} picks away`, pkValue: picks };
  }
  // Countdown timer "1:23"
  const timeMatch = t.match(/(\d+):(\d+)/);
  if (timeMatch) return { myTurn: false, label: t, pkValue: null };
  return { myTurn: false, label: t, pkValue: null };
}

let dkTimerInterval = null;
let lastTimerText = '';
let pkAutoDetectDone = false;

function startTimerWatcher() {
  if (dkTimerInterval) clearInterval(dkTimerInterval);
  dkTimerInterval = setInterval(() => {
    const el = getDKTimerEl();
    if (!el) return;
    const text = el.textContent?.trim();
    if (!text || text === lastTimerText) return;
    lastTimerText = text;

    const parsed = parseDKTimerText(text);
    if (!parsed) return;

    // Strategy 3: infer position from first observed PK value in round 1
    if (!state.isSetup && !autoPositionDetected && !pkAutoDetectDone && parsed.pkValue != null && parsed.pkValue > 1) {
      pkAutoDetectDone = true;
      const detected = tryDetectPositionFromPK(parsed.pkValue);
      if (detected?.position) {
        autoPositionDetected = true;
        showPositionDetectedBanner(detected.position, detected.numTeams);
      }
    }

    // Sync my turn state from DK directly
    const bar = document.getElementById('bba-turn-bar');
    if (!bar || state.isComplete) return;

    if (parsed.myTurn) {
      bar.className = 'bba-turn-mine';
      bar.textContent = `YOUR PICK  •  Round ${currentRound(state.overallPick, state.numTeams)}  •  ${state.myTeam.length + 1}/20`;
      // Re-render suggestion in case it wasn't showing
      renderSuggestion();
      renderList();
    } else if (parsed.label) {
      bar.className = 'bba-turn-waiting';
      const round = currentRound(state.overallPick, state.numTeams);
      bar.textContent = `Round ${round}  •  ${parsed.label}  •  ${state.drafted.size} off board`;
    }
  }, 1000);
}

// ── Init ──────────────────────────────────────────────────────────────────────

let autoDetectRetryTimer = null;

function scheduleAutoDetectRetry(delay = 3000) {
  if (autoDetectRetryTimer) return;
  autoDetectRetryTimer = setTimeout(() => {
    autoDetectRetryTimer = null;
    if (!state.isSetup && !autoPositionDetected) {
      tryAutoDetectPosition().then(() => {
        // Keep retrying until React app is loaded and detection succeeds
        if (!state.isSetup && !autoPositionDetected) scheduleAutoDetectRetry(5000);
      });
    }
  }, delay);
}

function init() {
  initPlayers();
  loadSettings(() => {
    loadExposure().then(() => {
      createOverlay();
      render();
      const observer = new MutationObserver(onMutation);
      observer.observe(document.body, { childList: true, subtree: true });
      startTimerWatcher();
      // Try to auto-detect draft position (React app may not be rendered yet)
      tryAutoDetectPosition().then(() => {
        if (!state.isSetup && !autoPositionDetected) scheduleAutoDetectRetry(3000);
      });
    });
  });
}

if (/draftkings\.com\/(draft|lineup)/.test(location.href)) {
  init();
} else {
  window.addEventListener('popstate', () => {
    if (/draftkings\.com\/(draft|lineup)/.test(location.href) && !document.getElementById('bba-root')) {
      init();
    }
  });
}
