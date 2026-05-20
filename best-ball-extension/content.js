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

// Send a message to background.js which relays it to the native db_writer.py.
// No HTTP server needed — Firefox launches db_writer.py on demand.
function nativeCall(msg) {
  return new Promise(resolve => {
    bAPI.runtime.sendMessage(msg, response => resolve(response || { ok: false }));
  });
}

async function loadExposure() {
  try {
    const result = await nativeCall({ action: 'getExposure' });
    if (!result.ok) return;
    exposure = result.data?.players || {};
  } catch (_) {}
}

async function refreshPlayersInDB() {
  if (typeof PLAYERS === 'undefined' || !PLAYERS.length) return;
  try {
    const result = await nativeCall({ action: 'refreshPlayers', players: PLAYERS });
    console.log('[BBA] refreshPlayers:', result.ok ? `${result.count} players upserted` : result.error);
  } catch (_) {}
}

function getDKDraftId() {
  // Extract draft ID from URL: /draft/snake/190384827
  const m = location.pathname.match(/\/draft\/snake\/(\d+)/);
  return m ? m[1] : null;
}

// True when this tab was opened by the extension's "Get lineups" flow.
const IS_AUTO_TAB = new URLSearchParams(location.search).get('bba_auto') === '1';

async function saveDraftToFlask({ contest = '', silent = false } = {}) {
  if (!state.myTeam.length) {
    console.log('[BBA] saveDraftToFlask: no picks in myTeam — skipping');
    return false;
  }
  const draftId = getDKDraftId();
  console.log('[BBA] saveDraftToFlask: posting', state.myTeam.length, 'picks for draft', draftId);
  try {
    const result = await nativeCall({
      action: 'saveDraft',
      dk_draft_id: draftId,
      my_position: state.myPosition || 0,
      picks: state.myTeam,
      contest,
    });
    if (result.duplicate) {
      console.log('[BBA] Draft already in DB, skipping.');
    } else if (result.ok) {
      console.log('[BBA] Draft saved — id', result.draft_id);
    } else {
      console.log('[BBA] Save failed:', result);
    }
    if (IS_AUTO_TAB && (result.ok || result.duplicate)) {
      setTimeout(() => bAPI.runtime.sendMessage({ action: 'closeTab' }), 5000);
    }
    return result.ok;
  } catch (err) {
    console.log('[BBA] saveDraftToFlask error:', err);
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

const NUM_TEAMS = 12; // DraftKings best ball is always 12 teams

function loadSettings(cb) {
  bAPI.storage.local.get(['dkUsername', 'stackIntensity', 'diversifyStrength'], result => {
    state.numTeams          = NUM_TEAMS;
    state.dkUsername        = result.dkUsername        || 'jvonderhoff';
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
// Each pick cell contains a [class*="pick-number"] child with the overall pick number (e.g. "7").
// The cell textContent concatenates slot + player info with no spaces, so we read the
// pick number from the DOM element directly rather than parsing the concatenated string.

let lastNameLookup = null;

function getLastNameLookup() {
  if (lastNameLookup) return lastNameLookup;
  lastNameLookup = {};
  for (const player of (typeof PLAYERS !== 'undefined' ? PLAYERS : [])) {
    const parts = player.name.split(' ');
    let last = parts[parts.length - 1];
    const hasSuffix = /^(Jr\.?|Sr\.?|II|III|IV|V)$/i.test(last);
    const suffix = hasSuffix ? last.toLowerCase().replace(/\./g, '') : null;
    if (hasSuffix) last = parts[parts.length - 2] || last;

    const baseKey = `${last.toLowerCase()}_${player.pos}_${player.team}`;
    // Only store the base key if no entry yet (lower ADP wins on collision)
    if (!lastNameLookup[baseKey]) lastNameLookup[baseKey] = player;

    // Also store a suffix-qualified key so "B. Robinson Jr." finds Brian,
    // not Bijan, when both are RB/ATL.
    if (suffix) {
      const suffixKey = `${last.toLowerCase()}_${suffix}_${player.pos}_${player.team}`;
      lastNameLookup[suffixKey] = player;
    }
  }
  return lastNameLookup;
}

// Returns the matched player from the concatenated board cell text.
// Format: "16.3183B. Robinson Jr.RBATL(BYE 11)"
// Step 1: find position+team anchor, Step 2: look backwards for the name.
function parsePlayerFromBoardText(text) {
  // Step 1 — find pos and team anchor (e.g. "RBATL")
  const posTeamM = text.match(/(QB|RB|WR|TE)([A-Z]{2,3})/);
  if (!posTeamM) return null;

  const pos  = posTeamM[1];
  const team = posTeamM[2];

  // Step 2 — extract text before the position, find "X. Name" pattern
  const before = text.slice(0, posTeamM.index);
  const nameM  = before.match(/[A-Z]\.\s*([\w][A-Za-z'.‑\- ]*)/);
  if (!nameM) return null;

  // Step 3 — detect generation suffix, strip it, take final word as last name
  const suffixM  = nameM[1].match(/\s+(Jr\.?|Sr\.?|II|III|IV|V)\s*$/i);
  const suffix   = suffixM ? suffixM[1].toLowerCase().replace(/\./g, '') : null;
  const fullName = nameM[1].replace(/\s*(Jr\.?|Sr\.?|II|III|IV|V)\s*$/i, '').trim();
  const lastName = fullName.split(/\s+/).pop().toLowerCase();

  const lookup = getLastNameLookup();

  // Try suffix-qualified key first — disambiguates same-last-name same-team players
  // (e.g. Bijan Robinson vs Brian Robinson Jr., both RB/ATL)
  if (suffix) {
    const suffixKey = `${lastName}_${suffix}_${pos}_${team}`;
    if (lookup[suffixKey]) return lookup[suffixKey];
    // Fallback: suffix key ignoring team
    for (const [key, p] of Object.entries(lookup)) {
      if (key.startsWith(`${lastName}_${suffix}_${pos}_`)) return p;
    }
  }

  const exact = lookup[`${lastName}_${pos}_${team}`];
  if (exact) return exact;
  // Fallback: ignore team in case of trades or stale team data
  for (const [key, p] of Object.entries(lookup)) {
    if (key.startsWith(`${lastName}_${pos}_`)) return p;
  }
  return null;
}

// Try to extract the contest name from the DK draft page.
// DK usually puts "Contest Name | DraftKings" in the page title.
function getDKContestName() {
  const title = document.title || '';
  const stripped = title.replace(/\s*\|\s*draftkings.*$/i, '').trim();
  if (stripped && stripped.toLowerCase() !== 'draftkings') return stripped;

  // Fallback: look for a heading element that contains contest-like text
  for (const sel of ['h1', '[class*="contest-name"]', '[class*="league-name"]', '[class*="draft-title"]']) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) return el.textContent.trim();
  }
  return '';
}

function readDraftBoard() {
  const columns = [...document.querySelectorAll('.DraftBoardColumn_draft-board-column')];
  if (!columns.length) return { myPicks: 0, takenPicks: 0 };

  let myPicks = 0, takenPicks = 0;

  for (let colIdx = 0; colIdx < columns.length; colIdx++) {
    const col = columns[colIdx];
    const kids = [...col.children];
    if (kids.length < 2) continue;
    const headerText = kids[0].textContent.toLowerCase();
    const isMe = state.dkUsername && headerText.startsWith(state.dkUsername.toLowerCase().slice(0, 8));

    // Derive draft position from column index — DK renders columns left-to-right, pick 1 to N
    if (isMe && !state.myPosition) {
      state.myPosition = colIdx + 1;
      autoPositionDetected = true;
    }

    for (let i = 1; i < kids.length; i++) {
      const cell = kids[i];
      const player = parsePlayerFromBoardText(cell.textContent);

      // Prefer the dedicated pick-number element DK renders (avoids text-concatenation ambiguity).
      const pickNumEl = cell.querySelector('[class*="pick-number"]');
      const pick_number = pickNumEl ? parseInt(pickNumEl.textContent.trim(), 10) || null : null;

      if (!player || state.drafted.has(player.id)) continue;

      state.drafted.add(player.id);
      state.available = state.available.filter(p => p.id !== player.id);
      if (isMe) { state.myTeam.push({ ...player, pick_number }); myPicks++; }
      else takenPicks++;
    }
  }

  if (myPicks + takenPicks > 0) {
    state.overallPick = Math.max(state.overallPick, state.drafted.size + 1);
    state.isComplete = state.myTeam.length >= 20;
    render();
    if (state.isComplete) saveDraftToFlask({ silent: true, contest: getDKContestName() }).then(ok => { if (ok) loadExposure(); });
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

// Check whether a candidate ID is a best ball snake draft (not a DFS contest).
// Strategy: fetch /draft/snake/{id} and inspect the final URL after redirects.
// DFS contest IDs will redirect to /draft/contest/{id}; snake draft IDs stay on /draft/snake/.
// Falls back to scanning the HTML for distinguishing strings.
async function _isBestBallDraft(draftGroupId) {
  try {
    const resp = await fetch(`https://www.draftkings.com/draft/snake/${draftGroupId}`, {
      credentials: 'include',
    });
    if (!resp.ok) return false;
    // If the server redirected us to a /draft/contest/ URL, it's a DFS contest
    if (resp.url.includes('/draft/contest/')) return false;
    // Scan the HTML for DFS-specific strings
    const html = await resp.text();
    if (html.includes('/draft/contest/')) return false;
    // A valid snake draft page URL will contain /draft/snake/
    return resp.url.includes('/draft/snake/') || /best.?ball/i.test(html);
  } catch (_) {
    return false;
  }
}

// Open a best ball draft in a new tab so the extension can read the board and auto-import.
// Returns true if a tab was opened (pick import happens asynchronously in that tab).
async function syncDraftGroup(draftGroupId) {
  if (_syncedDraftIds.has(draftGroupId)) return false;

  const isBestBall = await _isBestBallDraft(draftGroupId);
  if (!isBestBall) {
    console.log('[BBA] skipping non-best-ball ID:', draftGroupId);
    return false;
  }

  _syncedDraftIds.add(draftGroupId);
  console.log('[BBA] opening best ball draft in new tab:', draftGroupId);
  bAPI.runtime.sendMessage({ action: 'openTab', url: `https://www.draftkings.com/draft/snake/${draftGroupId}` });
  return true;
}

// Called by processDKResponse when it detects picks from an API response (live draft path).
async function importPicksFromAPIResponse(draftGroupId, myPicks) {
  if (!myPicks.length) return false;
  try {
    const result = await nativeCall({
      action: 'saveDraft',
      dk_draft_id: draftGroupId,
      my_position: 0,
      picks: myPicks,
      contest: `DK draft ${draftGroupId}`,
    });
    return result.ok && !result.duplicate;
  } catch (_) { return false; }
}

// ── "Get lineups" button injected on mycontests page ─────────────────────────

function injectGetLineupsButton() {
  if (document.getElementById('bba-get-lineups')) return;

  const btn = document.createElement('button');
  btn.id = 'bba-get-lineups';
  btn.textContent = '🏈 Get lineups';
  Object.assign(btn.style, {
    position: 'fixed', bottom: '20px', right: '20px', zIndex: '999999',
    padding: '10px 18px', background: '#4fc3f7', color: '#0a0e1a',
    border: 'none', borderRadius: '6px', fontWeight: '700',
    fontSize: '14px', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
  });

  btn.addEventListener('click', async () => {
    btn.textContent = '⏳ Syncing…';
    btn.disabled = true;
    const count = await fetchAndSyncMyContests();
    btn.textContent = count > 0 ? `✓ Imported ${count} draft(s)` : '⚠ No drafts found — check console';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '🏈 Get lineups'; }, 4000);
  });

  document.body.appendChild(btn);
}

// Scan the mycontests DOM for draft IDs, then sync picks for each.
async function fetchAndSyncMyContests() {
  const html = document.body.innerHTML;

  // Scan for any 9-digit number starting with 1 that looks like a DK draft group ID
  const allIds = [...new Set(
    [...html.matchAll(/\b(1\d{8})\b/g)].map(m => m[1])
  )];
  console.log('[BBA] candidate IDs found:', allIds);

  if (!allIds.length) {
    console.log('[BBA] No candidate IDs found in page HTML');
    return 0;
  }

  // Clear session dedup so a manual button click always retries
  allIds.forEach(id => _syncedDraftIds.delete(id));

  let imported = 0;
  for (const id of allIds) {
    const ok = await syncDraftGroup(id);
    if (ok) imported++;
  }
  return imported;
}

function processDKResponse(url, data) {
  if (!data || typeof data !== 'object') return;

  // Log every intercepted API call so we can see what data DK sends on a completed draft page
  console.log('[BBA] API intercepted:', url, Object.keys(data));

  // ── Contest-list detection ───────────────────────────────────────────────
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

      <div id="bba-resync-link" style="display:none;padding:2px 12px 4px;font-size:0.72em;color:#78909c">
        <a id="bba-scan-link" style="cursor:pointer;color:#4fc3f7;text-decoration:none">↻ Resync board</a>
        <span id="bba-resync-status" style="margin-left:8px"></span>
      </div>

      <div id="bba-turn-bar"></div>
      <div id="bba-suggestion"></div>
      <div id="bba-resize-handle" title="Drag to resize"></div>
    </div>
  `;

  document.body.appendChild(root);
  overlayEl = root;

  document.getElementById('bba-toggle').addEventListener('click', togglePanel);
  document.getElementById('bba-close').addEventListener('click', togglePanel);
  document.getElementById('bba-undo').addEventListener('click', undoLast);

  document.getElementById('bba-scan-link').addEventListener('click', () => {
    const status = document.getElementById('bba-resync-status');
    status.textContent = 'Scanning…';
    const found = scanPageForDraftedPlayers();
    status.textContent = found > 0 ? `+${found} synced` : 'Up to date';
    setTimeout(() => { status.textContent = ''; }, 3000);
  });

  makeDraggable(document.getElementById('bba-header'), document.getElementById('bba-panel'));
  makeResizable(document.getElementById('bba-resize-handle'), document.getElementById('bba-panel'));
  startStackHighlightObserver();
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

// ── Stack highlighting — DK player list tab ───────────────────────────────────
// Injects a left-border highlight on player rows whose team matches a team
// already on my roster.  Works by scanning for team-abbreviation text nodes
// inside player rows, so it doesn't depend on DK's internal class names.

let _stackHighlightStyle = null;
let _stackHighlightObserver = null;

function _ensureStackStyles() {
  if (_stackHighlightStyle) return;
  _stackHighlightStyle = document.createElement('style');
  _stackHighlightStyle.id = 'bba-stack-highlight-style';
  _stackHighlightStyle.textContent = `
    .bba-stack-row {
      border-left: 3px solid #4fc3f7 !important;
      background: rgba(79,195,247,0.07) !important;
    }
    .bba-stack-row-owned {
      border-left: 3px solid #81c784 !important;
      background: rgba(129,199,132,0.10) !important;
    }
  `;
  document.head.appendChild(_stackHighlightStyle);
}

function highlightStackPlayers() {
  if (!state.myTeam.length) return;
  _ensureStackStyles();

  const myTeams = new Set(state.myTeam.map(p => p.team));
  const teamPattern = /^[A-Z]{2,3}$/;

  // DK uses "PlayerCell_player-name" inside player rows.
  // Find each name element, walk up to its row container, then scan the
  // whole row for a team-abbreviation text node.
  const nameEls = [...document.querySelectorAll('[class*="PlayerCell_player-name"], [class*="player-name__"]')];

  // Reset previous highlights
  document.querySelectorAll('.bba-stack-row, .bba-stack-row-owned').forEach(el => {
    el.classList.remove('bba-stack-row', 'bba-stack-row-owned');
  });

  if (!nameEls.length) return;

  for (const nameEl of nameEls) {
    // The row container is a few levels up from the name element
    const row = nameEl.closest('[class*="PlayerCell_player-cell"], [class*="player-cell__"]')
               || nameEl.parentElement?.parentElement?.parentElement
               || nameEl.parentElement;
    if (!row) continue;

    // Walk all text nodes in the row to find a team abbreviation
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node, foundTeam = null;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (teamPattern.test(t) && myTeams.has(t)) { foundTeam = t; break; }
    }
    if (!foundTeam) continue;

    // Green = I already own someone from this team; blue = potential stack partner
    row.classList.add(state.myTeam.some(p => p.team === foundTeam)
      ? 'bba-stack-row-owned'
      : 'bba-stack-row');
  }
}

function startStackHighlightObserver() {
  if (_stackHighlightObserver) return;

  // Re-highlight whenever DK updates its player list (React re-renders)
  _stackHighlightObserver = new MutationObserver(() => {
    if (state.myTeam.length) highlightStackPlayers();
  });
  _stackHighlightObserver.observe(document.body, { childList: true, subtree: true });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  if (!overlayEl) return;
  renderSetupBanner();
  renderSyncBar();
  renderTurnBar();
  renderSuggestion();
  highlightStackPlayers();
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
  const resyncLink = document.getElementById('bba-resync-link');
  resyncLink.style.display = (state.isSetup && autoPositionDetected && state.myPosition) ? 'block' : 'none';
}

function renderTurnBar() {
  const bar = document.getElementById('bba-turn-bar');
  if (!state.isSetup) {
    bar.className = 'bba-turn-waiting';
    bar.textContent = 'Configure setup to begin';
    return;
  }
  if (state.isComplete) {
    bar.className = 'bba-turn-waiting';
    bar.textContent = `✓ Draft complete · ${state.myTeam.length} picks · next targets below`;
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
  if (!state.isSetup || !state.available.length) { box.style.display = 'none'; return; }

  const recs = getTopRecommendations(state.available, state.myTeam, state.myTeam.length + 1, state.stackIntensity, exposure, state.diversifyStrength, 5);
  if (!recs.length) { box.style.display = 'none'; return; }

  const [top, ...rest] = recs;
  const p = top.player;

  const restHTML = rest.map(r => `
    <div class="bba-rec-alt">
      <div class="bba-rec-alt-info">
        <span class="bba-rec-alt-name">${r.player.name}</span>
        <span class="bba-pos bba-pos-${r.player.pos}">${r.player.pos}</span>
        <span class="bba-rec-alt-meta">${r.player.team} · ADP ${r.player.adp}</span>
        ${r.reason ? `<span class="bba-rec-alt-reason">${r.reason}</span>` : ''}
      </div>
      <div class="bba-rec-alt-btns">
        <button class="bba-btn-pick-sm" data-id="${r.player.id}">Pick</button>
        <button class="bba-btn-taken-sm" data-id="${r.player.id}">✕</button>
      </div>
    </div>
  `).join('');

  const myTurn = isMyTurn(state.overallPick, state.numTeams, state.myPosition);
  box.style.display = 'block';
  box.innerHTML = `
    <div class="bba-rec-label">${myTurn ? 'Your Pick' : 'Target'}</div>
    <div class="bba-rec-body">
      <div>
        <div class="bba-rec-name">${p.name} <span class="bba-pos bba-pos-${p.pos}">${p.pos}</span></div>
        <div class="bba-rec-meta">${p.team} · Bye ${p.bye} · ADP ${p.adp}</div>
        ${top.reason ? `<div class="bba-rec-reason">${top.reason}</div>` : ''}
      </div>
      <button class="bba-btn-pick" data-id="${p.id}">My Pick</button>
    </div>
    <div class="bba-rec-alts">${restHTML}</div>
  `;

  box.querySelector('.bba-btn-pick').addEventListener('click', e => myPick(e.target.dataset.id));
  box.querySelectorAll('.bba-btn-pick-sm').forEach(btn =>
    btn.addEventListener('click', e => { myPick(e.currentTarget.dataset.id); }));
  box.querySelectorAll('.bba-btn-taken-sm').forEach(btn =>
    btn.addEventListener('click', e => { markTaken(e.currentTarget.dataset.id); }));
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

// On completed-draft pages DK shows a "Lineup" tab by default; the board DOM only
// exists after clicking "Draftboard". Click it automatically so readDraftBoard() works.
function tryClickDraftboardTab() {
  const candidates = [
    ...document.querySelectorAll('[role="tab"]'),
    ...document.querySelectorAll('button'),
    ...document.querySelectorAll('a'),
    ...document.querySelectorAll('li'),
    ...document.querySelectorAll('[class*="tab"]'),
  ];
  for (const el of candidates) {
    if (/draft\s*board/i.test(el.textContent.trim())) {
      console.log('[BBA] clicking draftboard tab:', el.tagName, JSON.stringify(el.textContent.trim()));
      el.click();
      return true;
    }
  }
  console.log('[BBA] draftboard tab not found — tabs on page:',
    candidates.filter(el => el.textContent.trim().length < 30).map(el => el.textContent.trim()).filter(Boolean).slice(0, 15)
  );
  return false;
}

// Dedicated board-read loop — runs independently of position detection.
// Keeps trying until 20 picks are found or MAX_ATTEMPTS is reached.
let _boardReadAttempts = 0;
const _MAX_BOARD_ATTEMPTS = 12;

function scheduleBoardRead(delay = 2000) {
  if (state.isComplete || _boardReadAttempts >= _MAX_BOARD_ATTEMPTS) return;
  setTimeout(() => {
    _boardReadAttempts++;
    const columns = document.querySelectorAll('.DraftBoardColumn_draft-board-column');
    if (!columns.length) {
      tryClickDraftboardTab();
      scheduleBoardRead(1500);
      return;
    }
    const { myPicks, takenPicks } = readDraftBoard();
    if (!state.isComplete && myPicks + takenPicks === 0) {
      scheduleBoardRead(2000);
    }
  }, delay);
}

let autoDetectRetryTimer = null;

function scheduleAutoDetectRetry(delay = 3000) {
  if (autoDetectRetryTimer) return;
  autoDetectRetryTimer = setTimeout(() => {
    autoDetectRetryTimer = null;
    if (!autoPositionDetected) {
      tryAutoDetectPosition().then(() => {
        if (!autoPositionDetected) scheduleAutoDetectRetry(5000);
      });
    }
  }, delay);
}

function init() {
  initPlayers();

  loadSettings(() => {
    Promise.all([loadExposure(), refreshPlayersInDB()]).then(() => {
      createOverlay();
      render();
      startPickPoller();
      startTimerWatcher();
      // Start board-read loop: tries tab click + board read until 20 picks found
      scheduleBoardRead(500);
      tryAutoDetectPosition().then(() => {
        if (!autoPositionDetected) scheduleAutoDetectRetry(3000);
      });
    });
  });
}

// ── Navigation & startup ──────────────────────────────────────────────────────

// Register the API interceptor once for the entire lifetime of the content script.
// pick-interceptor.js wraps fetch/XHR at document_start so events can arrive before
// init() runs — the listener must be registered as early as possible.
window.addEventListener('__bba_api', e => processDKResponse(e.detail.url, e.detail.data));

let _lastHref = '';

function onLocationChange() {
  const href = location.href;
  if (href === _lastHref) return;
  _lastHref = href;

  if (/draftkings\.com\/(draft|lineup)/.test(href)) {
    if (!document.getElementById('bba-root')) init();
  } else if (/draftkings\.com\/mycontests/.test(href)) {
    console.log('[BBA] mycontests page detected');
    loadSettings(() => injectGetLineupsButton());
  }
}

// DK uses React Router (pushState) for internal navigation — popstate alone is not enough.
// Poll location.href at a low rate to catch SPA navigations.
onLocationChange();
setInterval(onLocationChange, 1000);
window.addEventListener('popstate', onLocationChange);
