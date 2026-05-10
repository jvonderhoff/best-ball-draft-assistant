// Best Ball Draft Assistant — content script
// Injected into draftkings.com pages

const bAPI = typeof browser !== 'undefined' ? browser : chrome;

// ── State ────────────────────────────────────────────────────────────────────

let state = {
  available: [],
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
  } catch (_) {
    return false;
  }
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

function markTaken(playerId) {
  state.available = state.available.filter(p => p.id !== playerId);
  state.overallPick++;
  state.isComplete = state.myTeam.length >= 20;
  render();
}

function myPick(playerId) {
  const player = state.available.find(p => p.id === playerId);
  if (!player) return;
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
    state.available.unshift(last);
    state.available.sort((a, b) => a.adp - b.adp);
  }
  state.overallPick--;
  state.isComplete = false;
  render();
}

// ── Auto-detection via MutationObserver ───────────────────────────────────────

// Track players we've already surfaced a toast for so we don't double-fire
const toastedPlayers = new Set();

function extractPlayerFromNode(node) {
  const text = node.textContent?.trim() || '';
  if (text.length < 4 || text.length > 120) return null;
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

  toast.querySelector('.bba-my-pick').addEventListener('click', () => {
    myPick(player.id);
    toast.remove();
  });
  toast.querySelector('.bba-taken').addEventListener('click', () => {
    markTaken(player.id);
    toast.remove();
  });
  toast.querySelector('.bba-toast-dismiss').addEventListener('click', () => toast.remove());
  setTimeout(() => toast?.remove(), 10000);
}

function onMutation(mutations) {
  if (!state.isSetup) return;

  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      // Walk all text-bearing descendants of added nodes
      const walker = document.createTreeWalker(
        node.nodeType === Node.ELEMENT_NODE ? node : (node.parentElement || document.body),
        NodeFilter.SHOW_TEXT
      );
      let textNode;
      while ((textNode = walker.nextNode())) {
        const player = extractPlayerFromNode(textNode);
        if (!player) continue;
        if (!state.available.find(p => p.id === player.id)) continue;
        if (toastedPlayers.has(player.id)) continue;
        toastedPlayers.add(player.id);
        showDetectionToast(player);
        break; // one toast per mutation batch
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
    startX = e.clientX;
    startY = e.clientY;
    const rect = target.getBoundingClientRect();
    startRight = window.innerWidth - rect.right;
    startTop = rect.top;

    function onMove(e) {
      target.style.right = Math.max(0, startRight + (startX - e.clientX)) + 'px';
      target.style.top   = Math.max(0, startTop  + (e.clientY - startY))  + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function makeResizable(handle, target) {
  let startX, startY, startW, startH;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startY = e.clientY;
    startW = target.offsetWidth;
    startH = target.offsetHeight;

    function onMove(e) {
      // Dragging left expands width; dragging down expands height
      const newW = Math.max(260, startW + (startX - e.clientX));
      const newH = Math.max(300, startH + (e.clientY - startY));
      target.style.width     = newW + 'px';
      target.style.maxHeight = newH + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  if (!overlayEl) return;
  renderSetupBanner();
  renderTurnBar();
  renderSuggestion();
  document.getElementById('bba-team-count').textContent = state.myTeam.length;
  renderList();
}

function renderSetupBanner() {
  document.getElementById('bba-setup-banner').style.display = state.isSetup ? 'none' : 'flex';
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

  if (myTurn) {
    bar.className = 'bba-turn-mine';
    bar.textContent = `YOUR PICK  •  Round ${round}  •  ${state.myTeam.length + 1}/20`;
  } else {
    const until = picksUntilMyTurn(state.overallPick, state.numTeams, state.myPosition);
    const next  = nextMyOverallPick(state.overallPick + 1, state.numTeams, state.myPosition);
    bar.className = 'bba-turn-waiting';
    bar.textContent = `Round ${round}  —  your pick in ${until}  (overall #${next})`;
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

  // Board tab: show search results when searching, top 10 by value otherwise
  const myTurn  = state.isSetup && isMyTurn(state.overallPick, state.numTeams, state.myPosition);
  const needs   = getTeamNeeds(state.myTeam);
  const qbTeams = getMyQBTeams(state.myTeam);
  const myTeamSet = new Set(state.myTeam.map(p => p.team));

  let players = [...state.available];
  if (posFilter) players = players.filter(p => p.pos === posFilter);

  const isSearching = searchQuery.trim().length > 0;
  if (isSearching) {
    const q = searchQuery.toLowerCase();
    players = players.filter(p => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q));
  }

  // Sort: by value on my turn, by ADP otherwise
  if (myTurn) {
    players.sort((a, b) =>
      calculateValue(b, needs, state.myTeam.length + 1, state.myTeam, state.stackIntensity) -
      calculateValue(a, needs, state.myTeam.length + 1, state.myTeam, state.stackIntensity)
    );
  } else {
    players.sort((a, b) => a.adp - b.adp);
  }

  // Show top 10 unless actively searching (then show all matches up to 30)
  const display = isSearching ? players.slice(0, 30) : players.slice(0, 10);

  if (!display.length) {
    listEl.innerHTML = '<div class="bba-empty">No players found</div>';
    return;
  }

  listEl.innerHTML = display.map(p => {
    const isQBStack   = ['WR', 'TE'].includes(p.pos) && qbTeams.has(p.team);
    const hasTeammate = myTeamSet.has(p.team);
    const stackBadge  = isQBStack
      ? `<span class="bba-stack-badge bba-stack-qb">STACK</span>`
      : hasTeammate
        ? `<span class="bba-stack-badge bba-stack-team">+${p.team}</span>`
        : '';
    const exp = exposure[p.id];
    const expBadge = exp
      ? `<span class="bba-exp-badge">${Math.round(exp.exposure_rate * 100)}%</span>`
      : '';
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
    listEl.innerHTML += `<div class="bba-empty" style="font-size:0.72em;padding:10px">Search to see more players</div>`;
  }

  listEl.querySelectorAll('.bba-btn-pick').forEach(btn =>
    btn.addEventListener('click', e => myPick(e.currentTarget.dataset.id)));
  listEl.querySelectorAll('.bba-btn-taken').forEach(btn =>
    btn.addEventListener('click', e => markTaken(e.currentTarget.dataset.id)));
}

function renderTeam(listEl) {
  if (!state.myTeam.length) {
    listEl.innerHTML = '<div class="bba-empty">No picks yet</div>';
    return;
  }
  const byPos = {};
  state.myTeam.forEach(p => { (byPos[p.pos] = byPos[p.pos] || []).push(p); });
  listEl.innerHTML = ['QB', 'RB', 'WR', 'TE'].map(pos => {
    if (!byPos[pos]) return '';
    return `<div class="bba-pos-group">${pos}</div>` +
      byPos[pos].map(p => `
        <div class="bba-player-row bba-pos-border-${p.pos} bba-drafted">
          <div class="bba-player-info">
            <div class="bba-player-name">${p.name}</div>
            <div class="bba-player-meta">${p.team} · Bye ${p.bye} · ${p.dk_proj} pts</div>
          </div>
        </div>
      `).join('');
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
    if (!stackmates.length) {
      html += '<div class="bba-empty">None left on the board</div>';
    } else {
      html += stackmates.map(p => `
        <div class="bba-player-row bba-pos-border-${p.pos} bba-is-stack">
          <div class="bba-player-info">
            <div class="bba-player-name">${p.name} <span class="bba-pos bba-pos-${p.pos}">${p.pos}</span></div>
            <div class="bba-player-meta">${p.team} · ADP ${p.adp} · ${p.dk_proj} pts</div>
          </div>
          <div class="bba-player-btns">
            <button class="bba-btn-pick" data-id="${p.id}">My Pick</button>
            <button class="bba-btn-taken" data-id="${p.id}">Taken</button>
          </div>
        </div>`).join('');
    }
  }

  listEl.innerHTML = html || '<div class="bba-empty">No QB drafted yet — stacks form around your QB</div>';

  listEl.querySelectorAll('.bba-btn-pick').forEach(btn =>
    btn.addEventListener('click', e => myPick(e.currentTarget.dataset.id)));
  listEl.querySelectorAll('.bba-btn-taken').forEach(btn =>
    btn.addEventListener('click', e => markTaken(e.currentTarget.dataset.id)));
}

// ── Listen for settings changes from popup ────────────────────────────────────

bAPI.runtime.onMessage.addListener(msg => {
  if (msg.action === 'settingsUpdated') {
    state.numTeams        = msg.numTeams;
    state.myPosition      = msg.myPosition;
    state.stackIntensity  = msg.stackIntensity  || 'medium';
    state.diversifyStrength = msg.diversifyStrength != null ? msg.diversifyStrength : 0.5;
    state.isSetup         = true;
    state.available   = [...PLAYERS];
    state.myTeam      = [];
    state.overallPick = 1;
    state.isComplete  = false;
    render();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  initPlayers();
  loadSettings(() => {
    loadExposure().then(() => {
      createOverlay();
      render();
      const observer = new MutationObserver(onMutation);
      observer.observe(document.body, { childList: true, subtree: true });
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
