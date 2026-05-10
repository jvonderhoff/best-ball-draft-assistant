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
  dkUsername: '',
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

function getDKDraftId() {
  // Extract draft ID from URL: /draft/snake/190384827
  const m = location.pathname.match(/\/draft\/snake\/(\d+)/);
  return m ? m[1] : null;
}

async function saveDraftToFlask({ contest = '', silent = false } = {}) {
  if (!state.myTeam.length) return false;
  try {
    const resp = await fetch('http://localhost:8000/api/drafts/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dk_draft_id: getDKDraftId(),
        my_position: state.myPosition || 0,
        picks: state.myTeam,
        contest,
      }),
    });
    const json = await resp.json();
    if (!silent && json.duplicate) console.log('[BBA] Draft already saved, skipping.');
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

const NUM_TEAMS = 12; // DraftKings best ball is always 12 teams

function loadSettings(cb) {
  bAPI.storage.local.get(['dkUsername', 'stackIntensity', 'diversifyStrength'], result => {
    state.numTeams          = NUM_TEAMS;
    state.dkUsername        = result.dkUsername        || '';
    state.stackIntensity    = result.stackIntensity    || 'medium';
    state.diversifyStrength = result.diversifyStrength != null ? result.diversifyStrength : 0.5;
    // Username alone is enough to activate the board; position is auto-detected
    state.isSetup = !!state.dkUsername;
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
  if (state.isComplete) saveDraftToFlask({ silent: true });
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

// ── Draft board reader ────────────────────────────────────────────────────────
// Reads the DraftBoardColumn_draft-board-column grid DK renders once picks happen.
// Each column: child[0] = header ("jvonderhoffQB3RB6WR8TE3"), child[1..20] = picks.
// Each pick child text: "1.7 7 C. McCaffrey RB SF" (all concatenated, no spaces).

let lastNameLookup = null;

function getLastNameLookup() {
  if (lastNameLookup) return lastNameLookup;
  lastNameLookup = {};
  for (const player of (typeof PLAYERS !== 'undefined' ? PLAYERS : [])) {
    const parts = player.name.split(' ');
    // Strip generation suffixes (Jr, Sr, II, III, IV) before keying by last name
    let last = parts[parts.length - 1];
    if (/^(Jr\.?|Sr\.?|II|III|IV|V)$/i.test(last)) last = parts[parts.length - 2] || last;
    const key = `${last.toLowerCase()}_${player.pos}_${player.team}`;
    if (!lastNameLookup[key]) lastNameLookup[key] = player;
  }
  return lastNameLookup;
}

function parsePickFromBoardText(text) {
  // "C. McCaffreyRBSF" | "J. Smith-NjigbaWRSEA" | "J. Cook IIIRBBUF" | "K. AllenWRFA"
  const m = text.match(/([A-Z]\.\s*[A-Za-z][A-Za-z '.‑\-]*?)\s*(QB|RB|WR|TE)\s*([A-Z]{2,3})/);
  if (!m) return null;
  const lastName = m[1].replace(/^[A-Z]\.\s*/, '').replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)\s*$/i, '').trim().toLowerCase();
  const pos = m[2], team = m[3];
  const lookup = getLastNameLookup();
  // Exact match (team on roster)
  const exact = lookup[`${lastName}_${pos}_${team}`];
  if (exact) return exact;
  // FA or unmatched team — fall back to last name + position only
  for (const [key, p] of Object.entries(lookup)) {
    if (key.startsWith(`${lastName}_${pos}_`)) return p;
  }
  return null;
}

function readDraftBoard() {
  const columns = [...document.querySelectorAll('.DraftBoardColumn_draft-board-column')];
  if (!columns.length) return { myPicks: 0, takenPicks: 0 };

  let myPicks = 0, takenPicks = 0;

  for (const col of columns) {
    const kids = [...col.children];
    if (kids.length < 2) continue;
    const headerText = kids[0].textContent.toLowerCase();
    const isMe = state.dkUsername && headerText.startsWith(state.dkUsername.toLowerCase().slice(0, 8));

    for (let i = 1; i < kids.length; i++) {
      const player = parsePickFromBoardText(kids[i].textContent);
      if (!player || state.drafted.has(player.id)) continue;

      state.drafted.add(player.id);
      state.available = state.available.filter(p => p.id !== player.id);
      if (isMe) { state.myTeam.push(player); myPicks++; }
      else takenPicks++;
    }
  }

  if (myPicks + takenPicks > 0) {
    state.overallPick = Math.max(state.overallPick, state.drafted.size + 1);
    state.isComplete = state.myTeam.length >= 20;
    render();
    if (state.isComplete) saveDraftToFlask({ silent: true }).then(ok => { if (ok) loadExposure(); });
  }
  return { myPicks, takenPicks };
}

// Fallback full-text scan (less precise — no "my team" attribution)
function scanPageForDraftedPlayers() {
  // Try the structured board first
  const { myPicks, takenPicks } = readDraftBoard();
  if (myPicks + takenPicks > 0) return myPicks + takenPicks;

  // Fallback: body text contains player name
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

// ── Pick detection ────────────────────────────────────────────────────────────

let lastDetectedPick = null;
let lastKnownOnClockUser = ''; // who was on the clock before the most recent pick

// Toast is only shown when dkUsername is not set (manual fallback)
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
  setTimeout(() => { if (document.getElementById('bba-toast') === toast) toast.remove(); }, 15000);
}

// ── DK API response processor (fed by pick-interceptor.js) ───────────────────

function _extractPlayerFromPickObj(pick) {
  const name = (
    pick.displayName ||
    `${pick.firstName || ''} ${pick.lastName || ''}`.trim() ||
    pick.playerName ||
    pick.name || ''
  ).toLowerCase();
  return name ? playerNameMap[name] : null;
}

function _isMyPickObj(pick) {
  if (!state.dkUsername) return false;
  const entryName = (pick.username || pick.entryName || pick.teamName || pick.draftTeamName || '').toLowerCase();
  return entryName.includes(state.dkUsername.toLowerCase());
}

// ── DK history sync (mycontests page) ────────────────────────────────────────

// Tracks draft group IDs we've already queued to avoid duplicate fetches.
const _syncedDraftIds = new Set();

// Extract snake/best-ball draft group IDs from a DK contest-list response.
// DK uses many response shapes; try all common locations.
function _extractDraftGroupIds(data) {
  const ids = new Set();
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    // Candidate fields that hold a draft group id
    for (const key of ['draftGroupId', 'DraftGroupId', 'draftKey', 'contestKey', 'contestId']) {
      if (obj[key] && /^\d+$/.test(String(obj[key]))) ids.add(String(obj[key]));
    }
    // Recurse into known wrapper keys
    for (const key of ['contests', 'entries', 'myContests', 'upcomingContests', 'liveContests',
                       'completedContests', 'data', 'payload', 'results']) {
      if (obj[key]) walk(obj[key]);
    }
  };
  walk(data);
  return [...ids];
}

// Fetch picks for one draft group ID directly from DK's API (authenticated via browser session).
async function _fetchDKDraftPicks(draftGroupId) {
  const paths = [
    `https://api.draftkings.com/drafts/v1/draftgroups/${draftGroupId}/picks`,
    `https://api.draftkings.com/drafts/v1/draftgroups/${draftGroupId}/selections`,
    `https://api.draftkings.com/lineups/v1/lineup/${draftGroupId}`,
  ];
  for (const url of paths) {
    try {
      const resp = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!resp.ok) continue;
      const data = await resp.json();
      console.log('[BBA] picks response from', url, data);
      return data;
    } catch (_) {}
  }
  return null;
}

// Import picks from one DK draft group into Flask.
async function syncDraftGroup(draftGroupId) {
  if (_syncedDraftIds.has(draftGroupId)) return;
  _syncedDraftIds.add(draftGroupId);

  const data = await _fetchDKDraftPicks(draftGroupId);
  if (!data) return;

  // Build pick list — try common response shapes
  const pickList = data.picks || data.selections || data.draftPicks ||
                   data.data?.picks || data.payload?.picks || [];
  if (!pickList.length) return;

  const myPicks = [];
  for (const pick of pickList) {
    const player = _extractPlayerFromPickObj(pick);
    if (!player) continue;
    if (_isMyPickObj(pick)) myPicks.push(player);
  }

  if (myPicks.length < 1) return;

  await fetch('http://localhost:8000/api/drafts/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dk_draft_id: draftGroupId,
      my_position: 0,
      picks: myPicks,
      contest: `DK draft ${draftGroupId}`,
    }),
  }).catch(() => {});
}

// Proactively fetch the user's my-contests list from DK (runs when on mycontests page).
async function fetchAndSyncMyContests() {
  if (!state.dkUsername) return;
  const endpoints = [
    'https://api.draftkings.com/contests/v1/contests/user?sport=NFL&maxResultsCount=100',
    `https://api.draftkings.com/entries/v1/entries?username=${encodeURIComponent(state.dkUsername)}&sport=NFL&maxResultsCount=100`,
    'https://api.draftkings.com/lineups/v1/getuserdraftlineups?sport=NFL',
  ];
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!resp.ok) { console.log('[BBA] mycontests probe', resp.status, url); continue; }
      const data = await resp.json();
      console.log('[BBA] mycontests response from', url, data);
      const ids = _extractDraftGroupIds(data);
      console.log('[BBA] found draft group IDs:', ids);
      for (const id of ids) syncDraftGroup(id);
      if (ids.length) break;
    } catch (e) { console.log('[BBA] mycontests fetch error', url, e); }
  }
}

function processDKResponse(url, data) {
  if (!data || typeof data !== 'object') return;

  // ── Contest-list detection ───────────────────────────────────────────────
  // When the user visits mycontests, DK fires API calls that contain their
  // contest/entry list. We extract draft group IDs and sync picks for each.
  if (/contest|entries|lineup|mycontest/i.test(url)) {
    const ids = _extractDraftGroupIds(data);
    if (ids.length) {
      console.log('[BBA] contest list detected from', url, '— draft IDs:', ids);
      ids.forEach(id => syncDraftGroup(id));
    }
  }

  // ── Current-draft pick detection ─────────────────────────────────────────
  const candidates = [
    data.picks, data.draftPicks, data.selections,
    data.data?.picks, data.payload?.picks,
    data.entries, data.roster,
  ];

  for (const list of candidates) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const first = list[0];
    const hasPlayerName = first.displayName || first.firstName || first.playerName || first.name;
    if (!hasPlayerName) continue;

    let applied = 0;
    for (const pick of list) {
      const player = _extractPlayerFromPickObj(pick);
      if (!player || state.drafted.has(player.id)) continue;
      const isMine = _isMyPickObj(pick);
      state.drafted.add(player.id);
      state.available = state.available.filter(p => p.id !== player.id);
      if (isMine) state.myTeam.push(player);
      applied++;
    }

    if (applied > 0) {
      state.overallPick = Math.max(state.overallPick, state.drafted.size + 1);
      state.isComplete = state.myTeam.length >= 20;
      if (overlayEl) render();
      if (state.isComplete) saveDraftToFlask({ silent: true }).then(ok => { if (ok) loadExposure(); });
      return;
    }
  }
}

// Extract player from DK pick text: "Jalen Hurts | QB PHI" or "Jalen Hurts | QB <span>PHI</span>"
function extractPlayerFromPickElement(el) {
  if (!el) return null;
  const text = el.textContent || '';
  const pipeIdx = text.indexOf(' | ');
  if (pipeIdx === -1) return null;
  const name = text.slice(0, pipeIdx).trim().toLowerCase();
  return playerNameMap[name] || null;
}

// Polling-based pick detection — more reliable than MutationObserver for React apps
// DK React updates existing nodes in-place; childList mutations often don't fire.

let lastPickPollText = '';
let pickPollInterval = null;

function findLastPickElement() {
  // DOM confirmed from live draft:
  // <div class="PickOrder_pick-order__last-drafted-player">
  //   <div class="PickOrder_pick-order__last-drafted-player__last-pick">Last Pick: </div>
  //   <div>Keenan Allen | WR <span class="PickOrder_normal-weight">FA</span></div>
  // </div>
  const labelEl = document.querySelector('[class*="last-drafted-player__last-pick"]');
  if (labelEl?.nextElementSibling) return labelEl.nextElementSibling;

  // Fallback: second child of the container
  const container = document.querySelector('[class*="last-drafted-player"]');
  if (container?.children?.length >= 2) return container.children[1];

  return null;
}

function pollForLastPick() {
  const playerEl = findLastPickElement();
  if (!playerEl) return;

  const text = playerEl.textContent?.trim();
  if (!text || text === lastPickPollText) return;
  lastPickPollText = text;

  const player = extractPlayerFromPickElement(playerEl);
  if (!player || player.id === lastDetectedPick || state.drafted.has(player.id)) return;

  lastDetectedPick = player.id;

  if (state.dkUsername) {
    // Auto-classify: if the user who was just on the clock is me, it's my pick
    const wasMyPick = lastKnownOnClockUser.toLowerCase().startsWith(
      state.dkUsername.toLowerCase().slice(0, Math.min(6, state.dkUsername.length))
    );
    if (wasMyPick) {
      myPick(player.id);
    } else {
      markTaken(player.id);
    }
  } else {
    showDetectionToast(player);
  }
}

function startPickPoller() {
  if (pickPollInterval) clearInterval(pickPollInterval);
  pickPollInterval = setInterval(pollForLastPick, 1500);
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
      <div id="bba-resync-link" style="display:none;padding:2px 12px 4px;font-size:0.72em;color:#78909c">
        <a id="bba-scan-link" style="cursor:pointer;color:#4fc3f7;text-decoration:none">↻ Resync board</a>
        <span id="bba-resync-status" style="margin-left:8px"></span>
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

  document.getElementById('bba-scan-link').addEventListener('click', () => {
    const status = document.getElementById('bba-resync-status');
    status.textContent = 'Scanning…';
    const found = scanPageForDraftedPlayers();
    status.textContent = found > 0 ? `+${found} synced` : 'Up to date';
    setTimeout(() => { status.textContent = ''; }, 3000);
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
  const banner = document.getElementById('bba-setup-banner');
  if (state.isSetup) { banner.style.display = 'none'; return; }
  const count = state.available.length;
  banner.style.display = 'flex';
  banner.innerHTML = `<span>⚙️ Not configured (${count} players loaded) — </span><a id="bba-open-setup">open setup</a>`;
  document.getElementById('bba-open-setup').addEventListener('click', () => bAPI.runtime.sendMessage({ action: 'openPopup' }));
}

function renderSyncBar() {
  const manualBar  = document.getElementById('bba-sync-bar');
  const resyncLink = document.getElementById('bba-resync-link');
  if (!state.isSetup) {
    manualBar.style.display  = 'none';
    resyncLink.style.display = 'none';
    return;
  }
  if (autoPositionDetected && state.myPosition) {
    // Position is known — hide the manual pick# bar, show a subtle resync link instead
    manualBar.style.display  = 'none';
    resyncLink.style.display = 'block';
  } else {
    // Still waiting for auto-detection — show manual controls as fallback
    manualBar.style.display  = 'block';
    resyncLink.style.display = 'none';
  }
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
    bar.textContent = `✓ Draft complete! ${state.myTeam.length} players · auto-saved`;
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
    state.numTeams          = NUM_TEAMS;
    state.dkUsername        = msg.dkUsername        || '';
    state.stackIntensity    = msg.stackIntensity    || 'medium';
    state.diversifyStrength = msg.diversifyStrength != null ? msg.diversifyStrength : 0.5;
    state.isSetup           = !!state.dkUsername;
    state.myPosition        = null; // will be re-detected
    autoPositionDetected    = false;
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
  if (!mv?.snakeDraft) return null;
  const entry = mv.snakeDraft.draftEntry || mv.snakeDraft.entry || mv.snakeDraft.userEntry || mv.snakeDraft.myEntry;
  const pos = entry?.draftPosition ?? entry?.pickPosition ?? entry?.slotPosition ?? entry?.draftSlot ?? null;
  return (pos && pos > 0) ? { position: pos } : null;
}

// Strategy 2: scan the scrollable pick order cards for my username
function tryDetectPositionFromDOM() {
  if (!state.dkUsername) return null;
  const me = state.dkUsername.toLowerCase();

  // Cards: "Pick 234jvonderhoff" — find my next pick and back-calculate position
  const cards = [...document.querySelectorAll('.PickOrder_pick-order__scrollable-pick-card-container')];
  for (const card of cards) {
    const parsed = parseStickyCard(card.textContent.trim());
    if (!parsed) continue;
    if (!parsed.username.toLowerCase().startsWith(me.slice(0, 5))) continue;
    const round = Math.ceil(parsed.pickNum / NUM_TEAMS);
    const pickInRound = ((parsed.pickNum - 1) % NUM_TEAMS) + 1;
    const position = round % 2 === 0 ? NUM_TEAMS - pickInRound + 1 : pickInRound;
    return { position, numTeams: NUM_TEAMS };
  }
  return null;
}


async function tryAutoDetectPosition() {
  if (autoPositionDetected || state.myPosition) return;

  // Strategy 1 — mvcVars (fastest, no DOM needed)
  const fromVars = tryDetectPositionFromMvcVars();
  if (fromVars?.position) {
    autoPositionDetected = true;
    state.myPosition = fromVars.position;
    render();
    return;
  }

  // Strategy 2 — pick order cards (requires React to have rendered)
  const fromDOM = tryDetectPositionFromDOM();
  if (fromDOM?.position) {
    autoPositionDetected = true;
    state.myPosition = fromDOM.position;
    render();
    return;
  }
}

// ── DraftKings pick order watcher ─────────────────────────────────────────────
// Polls the sticky "On the clock" card which DK always keeps visible.
// DOM confirmed: .PickOrder_pick-order__sticky-user-card-container
//   text: "On the clock: Pick 231LopesGotGame2-90"
// This gives us: current pick number (to sync state.overallPick) and who's on clock.

let dkTimerInterval = null;
let lastStickyText = '';

// Parse "...Pick 231SomeUsername..." → { pickNum, username }
function parseStickyCard(text) {
  const match = text.match(/Pick\s+(\d+)([A-Za-z0-9_@.\-]+)/);
  if (!match) return null;
  return { pickNum: parseInt(match[1]), username: match[2] };
}

// Find my upcoming pick card in the scrollable list
function findMyPickCard() {
  if (!state.dkUsername) return null;
  const me = state.dkUsername.toLowerCase();
  const cards = [...document.querySelectorAll('.PickOrder_pick-order__scrollable-pick-card-container')];
  for (const card of cards) {
    const parsed = parseStickyCard(card.textContent.trim());
    if (parsed && parsed.username.toLowerCase().startsWith(me.slice(0, 6))) return parsed;
  }
  return null;
}

function startTimerWatcher() {
  if (dkTimerInterval) clearInterval(dkTimerInterval);
  dkTimerInterval = setInterval(() => {
    const stickyEl = document.querySelector('.PickOrder_pick-order__sticky-user-card-container');
    if (!stickyEl) return;

    const text = stickyEl.textContent?.trim();
    if (!text || text === lastStickyText) return;

    // Save who was on the clock before this transition — used by pollForLastPick
    // to determine if the pick that just happened was mine
    const prevParsed = parseStickyCard(lastStickyText);
    if (prevParsed) lastKnownOnClockUser = prevParsed.username;

    lastStickyText = text;

    const parsed = parseStickyCard(text);
    if (!parsed) return;

    // Sync pick counter from DK's own UI — keeps us accurate mid-draft
    if (parsed.pickNum > 0) state.overallPick = parsed.pickNum;

    // Auto-detect draft position from the pick order cards (no banner — silent)
    if (!autoPositionDetected && state.dkUsername && !state.myPosition) {
      const myCard = findMyPickCard();
      if (myCard) {
        const round = Math.ceil(myCard.pickNum / NUM_TEAMS);
        const pickInRound = ((myCard.pickNum - 1) % NUM_TEAMS) + 1;
        const position = round % 2 === 0 ? NUM_TEAMS - pickInRound + 1 : pickInRound;
        autoPositionDetected = true;
        state.myPosition = position;
        render();
      }
    }

    const bar = document.getElementById('bba-turn-bar');
    if (!bar || state.isComplete) return;

    // Determine if it's my turn
    const onClockText = text.toLowerCase();
    const isOnClock = onClockText.includes('on the clock');
    let myTurn = false;

    if (state.dkUsername) {
      // Username match is most reliable
      myTurn = isOnClock && onClockText.includes(state.dkUsername.toLowerCase());
    } else if (state.isSetup) {
      myTurn = isMyTurn(state.overallPick, state.numTeams, state.myPosition);
    }

    if (myTurn) {
      bar.className = 'bba-turn-mine';
      bar.textContent = `YOUR PICK  •  Round ${currentRound(state.overallPick, state.numTeams)}  •  ${state.myTeam.length + 1}/20`;
      renderSuggestion();
      renderList();
    } else {
      bar.className = 'bba-turn-waiting';
      const round = currentRound(state.overallPick, state.numTeams || 12);
      const myCard = findMyPickCard();
      const away = myCard ? myCard.pickNum - parsed.pickNum : '?';
      bar.textContent = `Round ${round}  •  ${away} picks away  •  ${state.drafted.size} off board`;
    }
  }, 1000);
}

// ── Init ──────────────────────────────────────────────────────────────────────

let autoDetectRetryTimer = null;

function scheduleAutoDetectRetry(delay = 3000) {
  if (autoDetectRetryTimer) return;
  autoDetectRetryTimer = setTimeout(() => {
    autoDetectRetryTimer = null;
    // Read draft board on every retry — picks may have rendered since last attempt
    readDraftBoard();
    if (!autoPositionDetected) {
      tryAutoDetectPosition().then(() => {
        if (!autoPositionDetected) scheduleAutoDetectRetry(5000);
      });
    }
  }, delay);
}

function init() {
  initPlayers();

  // Listen for DK API responses captured by pick-interceptor.js (page context)
  window.addEventListener('__bba_api', e => processDKResponse(e.detail.url, e.detail.data));

  loadSettings(() => {
    loadExposure().then(() => {
      createOverlay();
      render();
      startPickPoller();
      startTimerWatcher();
      // Read board + detect position (React app may not be rendered yet — retry if needed)
      readDraftBoard();
      tryAutoDetectPosition().then(() => {
        if (!autoPositionDetected) scheduleAutoDetectRetry(3000);
      });
    });
  });
}

function onPageLoad() {
  const href = location.href;
  if (/draftkings\.com\/(draft|lineup)/.test(href)) {
    if (!document.getElementById('bba-root')) init();
  } else if (/draftkings\.com\/mycontests/.test(href)) {
    // On the mycontests page: register the interceptor and sync past drafts.
    window.addEventListener('__bba_api', e => processDKResponse(e.detail.url, e.detail.data));
    loadSettings(() => {
      // Give DK's page JS time to fire its own API calls first, then also probe proactively.
      setTimeout(fetchAndSyncMyContests, 2000);
    });
  }
}

onPageLoad();
window.addEventListener('popstate', onPageLoad);
