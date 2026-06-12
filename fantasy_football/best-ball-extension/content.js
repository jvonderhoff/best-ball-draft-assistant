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
  rbPriority: 'strong',
  diversifyStrength: 0.5,
  isSetup: false,
  isComplete: false,
  draftedAt: null,    // ISO timestamp of when pick 20 was detected
  entryFee: null,     // entry fee pulled from DK API
  draftGroupId: null, // DK internal group ID extracted from draftables API URL
  useCustomRankings: false,  // toggle: custom rankings vs DK ADP
};

let exposure = {};
// Map of player_id → custom_rank (populated when custom rankings are loaded)
let customRankMap = {};
// Cache of draftId → { entryFee, draftedAt } — persisted in sessionStorage so it
// survives navigation from mycontests → draft page within the same browser session.
const _CACHE_KEY = 'bba_draft_meta';
function _loadMetaCache() {
  try { return JSON.parse(sessionStorage.getItem(_CACHE_KEY) || '{}'); } catch { return {}; }
}
function _saveMetaCache(cache) {
  try { sessionStorage.setItem(_CACHE_KEY, JSON.stringify(cache)); } catch {}
}
const draftMetaCache = _loadMetaCache();

// Send a message to background.js which relays it to the native db_writer.py.
// No HTTP server needed — Firefox launches db_writer.py on demand.
function nativeCall(msg, timeoutMs = 5000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      console.log('[BBA] nativeCall timeout for action:', msg.action);
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    bAPI.runtime.sendMessage(msg, response => {
      clearTimeout(timer);
      resolve(response || { ok: false });
    });
  });
}

async function loadExposure() {
  try {
    const result = await nativeCall({ action: 'getExposure' });
    if (!result.ok) return;
    exposure = result.data?.players || {};
  } catch (_) {}
}

async function loadCustomRankings() {
  try {
    const result = await nativeCall({ action: 'getRankings' });
    if (!result.ok || !result.data?.length) {
      console.log('[BBA] No custom rankings found in DB');
      return false;
    }
    // Build player_id → custom_rank map
    customRankMap = {};
    result.data.forEach(r => { customRankMap[r.player_id] = r.custom_rank; });
    console.log(`[BBA] Loaded ${Object.keys(customRankMap).length} custom rankings`);
    return true;
  } catch (e) {
    console.log('[BBA] loadCustomRankings error:', e);
    return false;
  }
}

// Apply or remove custom ranking ADPs from state.available.
// Matches Flask applyCustomRanks: ranked players get custom_rank as adp,
// unranked players keep their original DK ADP unchanged.
function applyRankingMode() {
  const adpLookup = {};
  if (typeof PLAYERS !== 'undefined') PLAYERS.forEach(p => { adpLookup[p.id] = p.adp; });

  if (state.useCustomRankings && Object.keys(customRankMap).length) {
    state.available = state.available.map(p => ({
      ...p,
      adp: customRankMap[p.id] ?? (adpLookup[p.id] ?? p.adp),
    }));
  } else {
    state.available = state.available.map(p => ({
      ...p,
      adp: adpLookup[p.id] ?? p.adp,
    }));
  }
  state.available.sort((a, b) => a.adp - b.adp);
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

// ── Live-draft push to Flask ──────────────────────────────────────────────────
// Pushes the current draft state to the local Flask server so the /recommend
// mobile page can poll it.  Fire-and-forget — never blocks the overlay.

const FLASK_BASE = 'https://192.168.1.161:8000';

// Route all Flask calls through background.js — content scripts can't reach
// the self-signed cert directly, but background.js (extension context) can.
function flaskPost(endpoint, body) {
  return new Promise(resolve => {
    bAPI.runtime.sendMessage({ action: 'flaskPost', endpoint, body }, r => resolve(r || {}));
  });
}

function pushLiveState() {
  const draftId = getDKDraftId();
  if (!draftId) return;
  const payload = {
    draft_id:    draftId,
    overall_pick: state.overallPick,
    my_position: state.myPosition,
    num_teams:   state.numTeams || 12,
    my_team:     state.myTeam,
    taken_ids:   [...state.drafted],
  };
  flaskPost('/api/live-draft/push', payload); // routed through background to bypass cert issue
}

const IS_AUTO_TAB = new URLSearchParams(location.search).get('bba_auto') === '1';

async function saveDraftToFlask({ contest = '', silent = false } = {}) {
  if (!state.myTeam.length) {
    console.log('[BBA] saveDraftToFlask: no picks in myTeam — skipping');
    return false;
  }
  const draftId = getDKDraftId();
  // Prefer cache from mycontests page, then API extraction, then DOM scrape
  console.log('[BBA] draftMetaCache keys:', Object.keys(draftMetaCache), '— looking up:', draftId);
  const cached = draftMetaCache[String(draftId)] || {};
  if (cached.draftedAt && !state.draftedAt) state.draftedAt = cached.draftedAt;
  if (cached.entryFee != null && state.entryFee == null) state.entryFee = cached.entryFee;
  const domFee = getDKEntryFee();
  const entryFee = state.entryFee ?? domFee;
  console.log('[BBA] saveDraftToFlask: entry fee —', `cached=${cached.entryFee}`, `state=${state.entryFee}`, `dom=${domFee}`, `→ using ${entryFee}`);
  console.log('[BBA] saveDraftToFlask: posting', state.myTeam.length, 'picks for draft', draftId, 'drafted_at:', state.draftedAt || '(using now)');
  try {
    const result = await nativeCall({
      action: 'saveDraft',
      dk_draft_id: draftId,
      drafted_at: (state.draftedAt || new Date().toISOString()).slice(0, 10),
      my_position: state.myPosition || 0,
      picks: state.myTeam,
      contest,
      entry_fee: entryFee,
    });
    if (result.duplicate) {
      console.log('[BBA] Draft already in DB — updated drafted_at/entry_fee for id', result.draft_id);
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
// Live player list — starts as the static players.js array, overwritten by Render fetch.
let livePlayers = (typeof PLAYERS !== 'undefined') ? [...PLAYERS] : [];

function initPlayers() {
  if (!livePlayers.length) return;
  state.available = [...livePlayers];
  playerNameMap = {};
  livePlayers.forEach(p => { playerNameMap[p.name.toLowerCase()] = p; });
}

async function fetchPlayersFromRender() {
  try {
    const result = await nativeCall({ action: 'getPlayers' });
    if (!result.ok || !Array.isArray(result.data) || !result.data.length) return;
    livePlayers = result.data;
    // Re-init with fresh data and re-render if already running
    initPlayers();
    if (state.isSetup) render();
    console.log(`[BBA] Players refreshed from Render: ${livePlayers.length}`);
  } catch (e) {
    console.log('[BBA] fetchPlayersFromRender failed, using static players.js:', e);
  }
}

const NUM_TEAMS = 12; // DraftKings best ball is always 12 teams

function loadSettings(cb) {
  bAPI.storage.local.get(['dkUsername', 'stackIntensity', 'rbPriority', 'diversifyStrength'], result => {
    state.numTeams          = NUM_TEAMS;
    state.dkUsername        = result.dkUsername        || 'jvonderhoff';
    state.stackIntensity    = result.stackIntensity    || 'medium';
    state.rbPriority        = result.rbPriority        || 'strong';
    state.diversifyStrength = result.diversifyStrength != null ? result.diversifyStrength : 0.5;
    // Username alone is enough to activate the board; position is auto-detected
    state.isSetup = !!state.dkUsername;
    cb();
  });
}

// ── Draft actions ─────────────────────────────────────────────────────────────

function setComplete() {
  if (!state.isComplete && state.myTeam.length >= 20) {
    state.isComplete = true;
    // Don't set draftedAt here — API responses set it if available.
    // saveDraftToFlask falls back to new Date() only if still null at save time.
  }
}

function markTaken(playerId, silent = false) {
  if (state.drafted.has(playerId)) return;
  state.drafted.add(playerId);
  state.available = state.available.filter(p => p.id !== playerId);
  state.overallPick++;
  setComplete();
  if (!silent) render();
  pushLiveState();
}

function myPick(playerId) {
  const player = state.available.find(p => p.id === playerId);
  if (!player) return;
  state.drafted.add(playerId);
  state.available = state.available.filter(p => p.id !== playerId);
  state.myTeam.push(player);
  state.overallPick++;
  setComplete();
  render();
  pushLiveState();
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
  pushLiveState();
}

// ── Queue management ──────────────────────────────────────────────────────────

// Finds the player's row in DK's available-player list and clicks its queue button.
// The Add to Queue icon SVG has aria-label="Add to Queue icon".
// It may only appear on hover — we dispatch a mouseenter first to reveal it.
function addToDKQueue(player) {
  const lastName = player.name.split(' ').filter(w => !/^(Jr\.?|Sr\.?|II|III|IV|V)$/i.test(w)).pop() || '';
  const nameEls = [...document.querySelectorAll('[class*="PlayerCell_player-name"]')];

  console.log('[BBA] addToDKQueue', player.name, '— scanning', nameEls.length, 'name elements');

  for (const nameEl of nameEls) {
    // Walk up manually past BaseTable__row-cell to reach the full BaseTable__row
    let row = nameEl.parentElement;
    while (row) {
      const cls = row.className || '';
      if (cls.includes('BaseTable__row') && !cls.includes('BaseTable__row-cell')) break;
      row = row.parentElement;
    }
    if (!row) continue;

    // Match by last name + position + team
    const rowText = row.textContent;
    if (!rowText.includes(lastName)) continue;
    if (!rowText.includes(player.pos)) continue;
    if (!rowText.includes(player.team)) continue;

    console.log('[BBA] Found row for', player.name, row);

    // Hover the row first — DK may hide the queue icon until mouseenter
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    // Give React a tick to show the button, then click it
    setTimeout(() => {
      const qSvg = row.querySelector('[aria-label="Add to Queue icon"]') ||
                   document.querySelector('[aria-label="Add to Queue icon"]');
      const qBtn = qSvg ? (qSvg.closest('button') || qSvg.parentElement || qSvg) : null;

      if (qBtn) {
        qBtn.click();
        console.log('[BBA] ✓ Clicked queue button for', player.name);
      } else {
        console.log('[BBA] ✗ Queue icon not found after hover for', player.name,
          '— all SVGs in row:', [...row.querySelectorAll('svg')].map(s => s.getAttribute('aria-label')));
      }
    }, 80);

    return true;
  }

  console.log('[BBA] ✗ No matching row found for', player.name, '(lastName:', lastName, 'pos:', player.pos, 'team:', player.team, ')');
  return false;
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

// Try to extract the entry fee from the DK draft page.
// Looks for dollar amounts like "$3", "$25", "$33" in the page.
function getDKEntryFee() {
  // Common DK selectors for entry fee
  for (const sel of [
    '[class*="entry-fee"]', '[class*="entryFee"]', '[class*="buy-in"]',
    '[class*="buyin"]', '[class*="contest-fee"]',
  ]) {
    const el = document.querySelector(sel);
    if (el) {
      const m = el.textContent.match(/\$(\d+(?:\.\d+)?)/);
      if (m) return parseFloat(m[1]);
    }
  }
  // Fallback: scan all text nodes for a dollar amount near "entry" or "fee"
  const allText = document.body?.innerText || '';
  const feeMatch = allText.match(/entry\s+fee[^\n]{0,30}\$(\d+(?:\.\d+)?)/i)
                || allText.match(/\$(\d+(?:\.\d+)?)[^\n]{0,20}entry/i);
  if (feeMatch) return parseFloat(feeMatch[1]);
  return null;
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
    const usernameMatch = state.dkUsername && headerText.startsWith(state.dkUsername.toLowerCase().slice(0, 8));
    // Fall back to configured draft position when username match fails (e.g. completed drafts
    // where DK no longer renders is-active-user or username in column headers).
    const positionMatch = !usernameMatch && state.myPosition > 0 && (colIdx + 1) === state.myPosition;
    const isMe = usernameMatch || positionMatch;

    // Derive draft position from column index — DK renders columns left-to-right, pick 1 to N
    if (usernameMatch && !state.myPosition) {
      state.myPosition = colIdx + 1;
      autoPositionDetected = true;
    }

    for (let i = 1; i < kids.length; i++) {
      const cell = kids[i];
      const player = parsePlayerFromBoardText(cell.textContent);

      // Prefer the dedicated pick-number element DK renders (avoids text-concatenation ambiguity).
      const pickNumEl = cell.querySelector('[class*="pick-number"]');
      const pick_number = pickNumEl ? parseInt(pickNumEl.textContent.trim(), 10) || null : null;

      if (!player) continue;

      if (state.drafted.has(player.id)) {
        // Already drafted — but if it's in my column and not yet in myTeam,
        // it was mis-classified by the poller (race condition). Rescue it.
        if (isMe && !state.myTeam.some(p => p.id === player.id)) {
          state.myTeam.push({ ...player, pick_number });
          myPicks++;
        }
        continue;
      }

      state.drafted.add(player.id);
      state.available = state.available.filter(p => p.id !== player.id);
      if (isMe) { state.myTeam.push({ ...player, pick_number }); myPicks++; }
      else takenPicks++;
    }
  }

  if (myPicks + takenPicks > 0) {
    state.overallPick = Math.max(state.overallPick, state.drafted.size + 1);
    setComplete();
    render();
    pushLiveState();
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

// ── Automatic board scan (runs on every DK draft page) ───────────────────────
// Replaces the manual console snippet. Scans each board column separately,
// auto-detects the user's column, and fetches pick endpoints — all every 15s.

let _boardScanTimer  = null;
let _boardScanDraftId = null;

function domScan(draftId, username) {
  const columns = Array.from(document.querySelectorAll('.DraftBoardColumn_draft-board-column'));
  console.log(`[BBA] domScan draft=${draftId} columns=${columns.length}`);

  if (columns.length) {
    // Auto-detect user's column via DK's is-active-user class, or username text fallback
    const myUser = (username || '').toLowerCase();
    const myActiveEl = document.querySelector('[class*="is-active-user"]');
    let myColIdx = myActiveEl
      ? columns.findIndex(col => col.contains(myActiveEl))
      : columns.findIndex(col => {
          const card = col.querySelector('[class*="summary-card"]');
          return card && myUser && card.textContent.toLowerCase().startsWith(myUser);
        });
    // Fall back to configured draft position for completed drafts where DK no longer
    // renders the active-user marker or username in column headers.
    if (myColIdx === -1 && state.myPosition > 0) myColIdx = state.myPosition - 1;

    console.log(`[BBA] domScan myColIdx=${myColIdx} user=${myUser}`);

    if (myColIdx >= 0) {
      flaskPost('/api/dk-my-column', { draft_id: draftId, my_column_idx: myColIdx })
        .then(d => console.log('[BBA] dk-my-column:', d));
    }

    let totalCells = 0;
    columns.forEach((col, idx) => {
      const cells = Array.from(col.querySelectorAll('[class*="draft-cell"]'));
      totalCells += cells.length;
      const txt = cells.length
        ? cells.map(c => c.textContent).join('\n')
        : col.textContent.trim();
      if (txt.length > 10) {
        flaskPost('/api/dk-dom-text', { draft_id: draftId, text: txt.slice(0, 40000), board_text: true, column_idx: idx })
          .then(d => { if (d && d.picks_found) console.log(`[BBA] col[${idx}] → ${d.picks_found} picks`); });
      }
    });
    console.log(`[BBA] domScan sent ${columns.length} columns, ${totalCells} total cells`);
    return;
  }

  // Fallback: full body text if board columns not found yet
  console.log('[BBA] domScan: no columns found — falling back to body text');
  const txt = document.body.textContent || '';
  if (txt.length > 100) {
    flaskPost('/api/dk-dom-text', { draft_id: draftId, text: txt.slice(0, 200000), board_text: true })
      .then(d => console.log('[BBA] body fallback scan:', d));
  }
}

function fetchPickEndpoints(draftId) {
  const urls = [
    `https://www.draftkings.com/draft/snake/${draftId}/picks`,
    `https://api.draftkings.com/draft/v1/draftgroups/${draftId}/draftboard`,
    `https://api.draftkings.com/lineups/v1/draftselections?draftGroupId=${draftId}`,
  ];
  urls.forEach(url => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.withCredentials = true;
    xhr.onload = function () {
      try {
        const data = JSON.parse(this.responseText);
        console.log('[BBA] fetchPickEndpoints hit:', url.split('?')[0].split('/').slice(-2).join('/'));
        flaskPost('/api/dk-intercept', { url, draft_id: draftId, data, direct: true });
      } catch (e) {}
    };
    xhr.send();
  });
}

function startBoardScan(draftId, username) {
  // Clear any scan running for a different draft
  if (_boardScanTimer && _boardScanDraftId !== draftId) {
    clearInterval(_boardScanTimer);
    _boardScanTimer = null;
  }
  if (_boardScanTimer) return; // already running for this draft

  _boardScanDraftId = draftId;
  console.log('[BBA] Auto board scan starting for draft', draftId, '— username:', username);

  function scan() {
    console.log('[BBA] Board scan tick for draft', draftId);
    domScan(draftId, username);
    fetchPickEndpoints(draftId);
  }

  // First scan after a short delay (let the board render), then every 15s
  setTimeout(scan, 2500);
  _boardScanTimer = setInterval(scan, 15000);
}

function stopBoardScan() {
  if (_boardScanTimer) {
    clearInterval(_boardScanTimer);
    _boardScanTimer = null;
    _boardScanDraftId = null;
  }
}

// ── Find draft IDs via DK's entries API ──────────────────────────────────────
// DK's mycontests page is server-side rendered so there are no links to scrape.
// Instead we call DK's own entries/contests API with the user's auth cookies.

async function findMyDraftIds() {
  const candidates = new Set();

  // Call DK's entries API with the user's auth cookies.
  // We look for entries that contain a /draft/snake/ URL or have snake-draft-specific fields.
  const entryUrls = [
    'https://www.draftkings.com/api/lineups/getentries?sport=1',
    'https://www.draftkings.com/api/lineups/getentries',
    'https://www.draftkings.com/api/contests/getentries',
    'https://api.draftkings.com/lineups/v1/lineups?sport=1&statuses=live',
    'https://api.draftkings.com/entries/v1/entries?sport=1',
  ];

  const extractSnakeIds = (data) => {
    const raw = JSON.stringify(data);
    // Any /draft/snake/ID in the response is reliable
    [...raw.matchAll(/\/draft\/snake\/(\d{7,10})/g)].forEach(m => candidates.add(m[1]));
    // Walk for draftGroupId fields within snake-draft-looking entries
    const walk = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 5) return;
      if (Array.isArray(obj)) { obj.slice(0, 200).forEach(x => walk(x, depth + 1)); return; }
      const objStr = JSON.stringify(obj).toLowerCase();
      if (objStr.includes('snake') || objStr.includes('best ball') || objStr.includes('/draft/snake/')) {
        for (const key of ['draftGroupId', 'DraftGroupId', 'draftKey', 'gameSetId']) {
          const v = obj[key];
          if (v && /^\d{7,10}$/.test(String(v))) candidates.add(String(v));
        }
      }
      for (const v of Object.values(obj)) { if (v && typeof v === 'object') walk(v, depth + 1); }
    };
    walk(data);
  };

  // 1. Inject into page context to read window globals inaccessible to content scripts
  const pageIds = await new Promise(resolve => {
    const evtName = '__bba_draft_ids_' + Date.now();
    const handler = e => { window.removeEventListener(evtName, handler); resolve(e.detail || []); };
    window.addEventListener(evtName, handler);
    setTimeout(() => { window.removeEventListener(evtName, handler); resolve([]); }, 2000);

    const s = document.createElement('script');
    s.textContent = `(function() {
      var ids = [];
      var raw = '';
      // Read window globals DK might use
      ['__NEXT_DATA__','__REDUX_STATE__','__APP_STATE__','dkApp','draftState','__DK__'].forEach(function(k) {
        try { if (window[k]) raw += JSON.stringify(window[k]); } catch(e) {}
      });
      // Also grab all window keys that look like DK state
      try {
        Object.keys(window).forEach(function(k) {
          if (/draft|contest|lineup|entry/i.test(k)) {
            try { raw += JSON.stringify(window[k]); } catch(e) {}
          }
        });
      } catch(e) {}
      // Extract /draft/snake/ID patterns
      var re = /\\/draft\\/snake\\/(\\d{7,10})/g, m;
      while ((m = re.exec(raw)) !== null) ids.push(m[1]);
      window.dispatchEvent(new CustomEvent('${evtName.replace(/'/g, "\\'")}', { detail: ids }));
    })();`;
    document.head.appendChild(s);
    s.remove();
  });
  if (pageIds.length) {
    console.log('[BBA] page context snake IDs:', pageIds);
    pageIds.forEach(id => candidates.add(id));
  } else {
    console.log('[BBA] page context: no snake IDs found in window globals');
  }

  // 2. DK API endpoints
  await Promise.all(entryUrls.map(async url => {
    try {
      const r = await fetch(url, { credentials: 'include' });
      console.log('[BBA] findMyDraftIds', url.split('/').slice(-2).join('/'), '→', r.status);
      if (!r.ok) return;
      const data = await r.json();
      console.log('[BBA] findMyDraftIds hit:', url.split('?')[0].split('/').slice(-2).join('/'), Object.keys(data));
      extractSnakeIds(data);
    } catch (e) {
      console.log('[BBA] findMyDraftIds fetch failed:', url, e.message);
    }
  }));

  // Also check /draft/snake/ links in the DOM (rendered entries)
  document.querySelectorAll('a[href*="/draft/snake/"]').forEach(a => {
    const m = a.href.match(/\/draft\/snake\/(\d+)/);
    if (m) candidates.add(m[1]);
  });

  const ids = [...candidates];
  console.log('[BBA] findMyDraftIds found:', ids);
  return ids;
}

function syncDraftIds(ids) {
  // Register with Flask
  flaskPost('/api/dk-known-drafts', { draft_ids: ids });

  // Fetch pick data for each draft
  ids.forEach((did, i) => {
    setTimeout(() => {
      [
        `https://www.draftkings.com/draft/snake/${did}/picks`,
        `https://api.draftkings.com/lineups/v1/draftselections?draftGroupId=${did}`,
      ].forEach(ep => {
        fetch(ep, { credentials: 'include' })
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (data) flaskPost('/api/dk-intercept', { url: ep, draft_id: did, data, direct: true }); })
          .catch(() => {});
      });
    }, i * 400);
  });
}

// ── "Find My Drafts" button injected on mycontests page ──────────────────────

function injectFindDraftsButton() {
  if (document.getElementById('bba-find-drafts')) return;

  const btn = document.createElement('button');
  btn.id = 'bba-find-drafts';
  btn.textContent = '🔍 Find My Drafts';
  Object.assign(btn.style, {
    position: 'fixed', bottom: '20px', right: '20px', zIndex: '999999',
    padding: '10px 18px', background: '#4fc3f7', color: '#0a0e1a',
    border: 'none', borderRadius: '6px', fontWeight: '700',
    fontSize: '14px', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
  });

  btn.addEventListener('click', async () => {
    btn.textContent = '⏳ Scanning…';
    btn.disabled = true;

    const ids = await findMyDraftIds().catch(() => []);

    if (!ids.length) {
      btn.textContent = '⚠ No drafts found';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = '🔍 Find My Drafts'; }, 3000);
      return;
    }

    syncDraftIds(ids);
    btn.textContent = `✓ Found ${ids.length} draft(s) — syncing…`;
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '🔍 Find My Drafts'; }, 4000);
  });

  document.body.appendChild(btn);
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


// Try to extract the entry fee from a DK API response.
function _extractEntryFee(data) {
  const keywords = ['entryfee', 'entry_fee', 'buyin', 'buy_in', 'fee',
                    'entryamount', 'contestfee', 'entryprice'];
  const roots = [data, data.draft, data.draftGroup, data.contest,
                 data.data, data.payload, data.result, data.metadata];
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    // Case-insensitive match against all own keys
    for (const key of Object.keys(root)) {
      if (!keywords.includes(key.toLowerCase())) continue;
      const val = root[key];
      if (val == null) continue;
      const n = parseFloat(val);
      if (!isNaN(n) && n >= 0) return n;
    }
  }
  return null;
}

// Try to extract the actual draft start/creation time from a DK API response.
// DK uses various field names across different endpoints — check them all.
function _extractDraftTime(data) {
  const keywords = ['starttime', 'start_time', 'startdate', 'start_date',
                    'draftstarttime', 'draft_start_time', 'createdat', 'created_at',
                    'scheduledstarttime', 'conteststarttime', 'eventstarttime'];
  const roots = [data, data.draft, data.draftGroup, data.contest,
                 data.data, data.payload, data.result, data.metadata];
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    for (const key of Object.keys(root)) {
      if (!keywords.includes(key.toLowerCase())) continue;
      const val = root[key];
      if (!val) continue;
      const d = new Date(val);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2024) return d.toISOString();
    }
  }
  return null;
}

function processDKResponse(url, data) {
  if (!data || typeof data !== 'object') return;

  // Log every intercepted API call
  console.log('[BBA] API intercepted:', url, Object.keys(data));
  // If the response contains any ISO date strings, log the relevant snippet
  const raw = JSON.stringify(data);
  const dateMatch = raw.match(/"([^"]*(?:start|draft|creat|time|date)[^"]*)":\s*"(20\d\d-\d\d-\d\d[^"]{0,30})"/i);
  if (dateMatch) console.log('[BBA] Date field found in', url, '→', dateMatch[1], '=', dateMatch[2]);

  // Capture draftGroupId from draftables URL pattern
  const dgMatch = url.match(/draftgroups\/v\d+\/draftgroups\/(\d+)/i);
  if (dgMatch && !state.draftGroupId) {
    state.draftGroupId = dgMatch[1];
    console.log('[BBA] draftGroupId captured:', state.draftGroupId);
  }

  // ── Draft metadata extraction ────────────────────────────────────────────
  // Only set once — first valid value from any DK API response wins.
  const ts = _extractDraftTime(data);
  if (ts) {
    state.draftedAt = ts;
    console.log('[BBA] Draft timestamp from API:', ts);
  }
  // Scan top-level and one level deep (competitions, contests, draftGroup arrays)
  const feeRoots = [data, ...(Array.isArray(data.competitions) ? data.competitions : []),
                    ...(Array.isArray(data.contests) ? data.contests : [])];
  for (const root of feeRoots) {
    const fee = _extractEntryFee(root);
    if (fee != null && fee > (state.entryFee ?? 0)) {
      state.entryFee = fee;
      console.log('[BBA] Entry fee from API:', fee, '(from', url, ')');
      break;
    }
  }
  // Log competitions keys so we can see what fields are available
  if (Array.isArray(data.competitions) && data.competitions.length && state.entryFee == null) {
    console.log('[BBA] competitions[0] keys:', Object.keys(data.competitions[0]), JSON.stringify(data.competitions[0]).slice(0, 300));
  }

  // ── mycontests metadata cache ────────────────────────────────────────────
  // When DK loads the mycontests page it fires an API with one entry per draft.
  // Cache fee + drafted_at per draft ID so they're available on the draft page.
  if (/draftkings\.com\/mycontests/i.test(location.href)) {
    console.log('[BBA] mycontests page — intercepted:', url, Object.keys(data));
  }
  if (/mycontest|entries|userlineup|lineup|gametypes/i.test(url)) {
    const lists = [data.entries, data.contests, data.lineups,
                   data.data?.entries, data.payload?.entries,
                   data.userContests, data.upcomingContests];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        // Try every plausible ID field
        const id = entry.draftGroupId || entry.DraftGroupId || entry.gameSetId ||
                   entry.entryId || entry.EntryId || entry.lineupId;
        if (!id) continue;
        const fee = _extractEntryFee(entry);
        const ts  = _extractDraftTime(entry);
        if (fee != null || ts) {
          draftMetaCache[String(id)] = { entryFee: fee, draftedAt: ts };
          _saveMetaCache(draftMetaCache);
          console.log('[BBA] Cached meta for draft', id, '— fee:', fee, 'draftedAt:', ts);
        }
      }
      // Log first entry raw so we can see actual field names
      if (list.length) console.log('[BBA] mycontests first entry keys:', Object.keys(list[0]), JSON.stringify(list[0]).slice(0, 500));
      break;
    }
  }

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
      setComplete();
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
  if (!playerEl) {
    // Log once every 30s so we know if the element is simply missing
    if (!pollForLastPick._noElLogged || Date.now() - pollForLastPick._noElLogged > 30000) {
      pollForLastPick._noElLogged = Date.now();
      console.log('[BBA] pollForLastPick: last-pick element not found in DOM');
    }
    return;
  }

  const text = playerEl.textContent?.trim();
  if (!text || text === lastPickPollText) return;
  lastPickPollText = text;

  console.log('[BBA] Last pick text:', text);

  const player = extractPlayerFromPickElement(playerEl);
  if (!player) {
    console.log('[BBA] Could not match player from text:', JSON.stringify(text),
      '— parsed name:', JSON.stringify(text.slice(0, text.indexOf(' | ')).trim().toLowerCase()));
    return;
  }
  if (player.id === lastDetectedPick || state.drafted.has(player.id)) return;

  lastDetectedPick = player.id;
  console.log('[BBA] Detected pick:', player.name, player.pos, player.team);

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
          <button id="bba-ranking-toggle" title="Switch between DK ADP and your custom rankings">ADP</button>
          <button id="bba-resync" title="Resync picks from draft board">⟳</button>
          <button id="bba-save" title="Save draft to DB">💾</button>
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
      <div id="bba-resize-handle" title="Drag to resize"></div>
    </div>
  `;

  document.body.appendChild(root);
  overlayEl = root;

  document.getElementById('bba-toggle').addEventListener('click', togglePanel);
  document.getElementById('bba-close').addEventListener('click', togglePanel);
  document.getElementById('bba-undo').addEventListener('click', undoLast);
  document.getElementById('bba-ranking-toggle').addEventListener('click', async () => {
    const btn = document.getElementById('bba-ranking-toggle');
    if (!state.useCustomRankings) {
      btn.textContent = '⏳';
      btn.disabled = true;
      const loaded = await loadCustomRankings();
      if (!loaded) {
        btn.textContent = 'ADP';
        btn.disabled = false;
        btn.title = 'No custom rankings saved — set them at localhost:8000/rankings';
        return;
      }
      state.useCustomRankings = true;
    } else {
      state.useCustomRankings = false;
    }
    applyRankingMode();
    updateRankingToggleBtn();
    render();
  });

  document.getElementById('bba-resync').addEventListener('click', () => {
    const btn = document.getElementById('bba-resync');
    btn.style.opacity = '0.5';
    // Only read the board if the columns are already visible — never auto-navigate
    const cols = document.querySelectorAll('.DraftBoardColumn_draft-board-column');
    if (cols.length) {
      readDraftBoard();
      setTimeout(() => { btn.style.opacity = ''; highlightStackPlayers(); }, 300);
    } else {
      // Board tab not active — prompt user to switch to it manually
      btn.style.opacity = '';
      btn.title = 'Switch to the Draftboard tab first, then click ⟳';
      setTimeout(() => { btn.title = 'Resync picks from draft board'; }, 4000);
    }
  });

  document.getElementById('bba-save').addEventListener('click', async () => {
    const btn = document.getElementById('bba-save');
    if (!state.myTeam.length) {
      // No picks tracked — try reading the board first
      const cols = document.querySelectorAll('.DraftBoardColumn_draft-board-column');
      if (cols.length) {
        readDraftBoard();
        await new Promise(r => setTimeout(r, 400));
      }
    }
    if (!state.myTeam.length) {
      btn.title = 'No picks found — switch to Draftboard tab and click ⟳ first';
      setTimeout(() => { btn.title = 'Save draft to DB'; }, 4000);
      return;
    }
    btn.style.opacity = '0.5';
    await fetchDraftMeta();

    // If entry fee still unknown, ask the user
    if (state.entryFee == null) {
      const input = prompt('Entry fee for this draft? (e.g. 3)', '');
      if (input !== null && input.trim() !== '') {
        const parsed = parseFloat(input.trim().replace('$', ''));
        if (!isNaN(parsed)) state.entryFee = parsed;
      }
    }

    const ok = await saveDraftToFlask({ contest: getDKContestName(), silent: false });
    btn.style.opacity = '';
    btn.title = ok ? '✓ Saved!' : 'Save failed — check console';
    setTimeout(() => { btn.title = 'Save draft to DB'; }, 3000);
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
  let startX, startY, startLeft, startTop;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX; startY = e.clientY;
    const rect = target.getBoundingClientRect();
    startLeft = rect.left;
    startTop  = rect.top;
    // Switch from right-anchored to left-anchored so free dragging works in both directions
    target.style.right = 'auto';
    target.style.left  = startLeft + 'px';
    const onMove = e => {
      target.style.left = (startLeft + (e.clientX - startX)) + 'px';
      target.style.top  = (startTop  + (e.clientY - startY)) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
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
    .bba-stack-name { color: #81c784 !important; font-weight: 700 !important; }
  `;
  document.head.appendChild(_stackHighlightStyle);
}

function highlightStackPlayers() {
  if (!state.myTeam.length) return;
  _ensureStackStyles();

  const myTeams = new Set(state.myTeam.map(p => p.team));
  const teamPattern = /^[A-Z]{2,3}$/;

  // Reset previous highlights
  document.querySelectorAll('.bba-stack-name').forEach(el => {
    el.classList.remove('bba-stack-name');
  });

  // DOM structure confirmed from live DK draft room:
  //   PlayerCell_player-name-container
  //     ← PlayerCell_player-details-container
  //       ← PlayerCell_player-cell  (one grid cell)
  //         ← BaseTable__row-cell   (sibling cells hold pos, team, etc.)
  //           ← BaseTable__row      (full player row — scan this for team text)
  //             ← BaseTable__body   (the available-player list)
  //
  // The roster section doesn't use PlayerCell_ classes, so scoping to
  // PlayerCell_player-name-container naturally excludes it.

  const nameEls = [...document.querySelectorAll('[class*="PlayerCell_player-name-container"]')];
  if (!nameEls.length) return;

  for (const nameEl of nameEls) {
    // Walk up to the full row (skip BaseTable__row-cell — it only contains one cell,
    // not the team abbreviation which lives in a sibling cell)
    let row = nameEl.parentElement;
    while (row) {
      const cls = row.className || '';
      if (cls.includes('BaseTable__row') && !cls.includes('BaseTable__row-cell')) break;
      row = row.parentElement;
    }
    if (!row) continue;

    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node, foundTeam = null;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (teamPattern.test(t) && myTeams.has(t)) { foundTeam = t; break; }
    }
    if (!foundTeam) continue;

    nameEl.classList.add('bba-stack-name');
  }
}

function startStackHighlightObserver() {
  if (_stackHighlightObserver) return;

  // Debounce: wait 120ms after the last DOM mutation before highlighting.
  // React re-renders the player list in multiple batches; running mid-render
  // means some rows aren't in the DOM yet and get missed.
  let _highlightTimer = null;
  _stackHighlightObserver = new MutationObserver(() => {
    if (!state.myTeam.length) return;
    clearTimeout(_highlightTimer);
    _highlightTimer = setTimeout(highlightStackPlayers, 120);
  });
  _stackHighlightObserver.observe(document.body, { childList: true, subtree: true });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function updateRankingToggleBtn() {
  const btn = document.getElementById('bba-ranking-toggle');
  if (!btn) return;
  btn.disabled = false;
  if (state.useCustomRankings) {
    btn.textContent = 'My Ranks';
    btn.title = 'Using your custom rankings — click to switch to DK ADP';
    btn.style.color = '#4fc3f7';
  } else {
    btn.textContent = 'ADP';
    btn.title = 'Using DK ADP — click to switch to your custom rankings';
    btn.style.color = '';
  }
}

function render() {
  if (!overlayEl) return;
  renderSetupBanner();
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

  const nextMyPick = nextMyOverallPick(state.overallPick + 1, state.numTeams, state.myPosition);
  const recs = getTopRecommendations(state.available, state.myTeam, state.overallPick, state.stackIntensity, 10, nextMyPick);
  if (!recs.length) { box.style.display = 'none'; return; }

  const myTurn = isMyTurn(state.overallPick, state.numTeams, state.myPosition);

  const recsHTML = recs.map(r => `
    <div class="bba-rec-alt">
      <div class="bba-rec-alt-info">
        <span class="bba-rec-alt-name">${r.player.name}</span>
        <span class="bba-pos bba-pos-${r.player.pos}">${r.player.pos}</span>
        <span class="bba-rec-alt-meta">${r.player.team} · ${state.useCustomRankings ? 'Rank' : 'ADP'} ${Math.round(r.player.adp)}</span>
        ${r.reason ? `<span class="bba-rec-alt-reason">${r.reason}</span>` : ''}
      </div>
      <button class="bba-btn-queue-sm" data-id="${r.player.id}">+ Queue</button>
    </div>
  `).join('');

  box.style.display = 'block';
  box.innerHTML = `
    <div class="bba-rec-label">${myTurn ? 'Your Pick' : 'Suggestions'}</div>
    <div class="bba-rec-alts">${recsHTML}</div>
  `;

  box.querySelectorAll('.bba-btn-queue-sm').forEach(btn =>
    btn.addEventListener('click', e => {
      const player = state.available.find(p => p.id === e.currentTarget.dataset.id);
      if (player) addToDKQueue(player);
    }));
}


// ── Listen for settings changes from popup ────────────────────────────────────

bAPI.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'findDrafts') {
    findMyDraftIds().then(ids => {
      sendResponse({ found: ids.length });
      if (ids.length) syncDraftIds(ids);
    }).catch(() => sendResponse({ found: 0 }));
    return true; // async
  }

  if (msg.action === 'settingsUpdated') {
    state.numTeams          = NUM_TEAMS;
    state.dkUsername        = msg.dkUsername        || '';
    state.stackIntensity    = msg.stackIntensity    || 'medium';
    state.rbPriority        = msg.rbPriority        || 'strong';
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

// On load: click the Draftboard tab once to sync all picks, then never touch
// tab navigation again. The user can navigate freely after initial sync.
function scheduleBoardRead(delay = 2000) {
  setTimeout(() => {
    const columns = document.querySelectorAll('.DraftBoardColumn_draft-board-column');
    if (columns.length) {
      readDraftBoard();
    } else {
      tryClickDraftboardTab();
      setTimeout(() => readDraftBoard(), 1500);
    }
  }, delay);
}

// Passively watch for the DraftBoardColumn elements to appear in the DOM.
// When the user switches to the Draftboard tab (even briefly), we auto-read
// the full board and catch up on any picks pollForLastPick missed.
// Never auto-clicks anything — user navigates freely.
let _boardTabWatcher = null;
function startBoardTabWatcher() {
  if (_boardTabWatcher) return;
  let lastColumnCount = 0;
  _boardTabWatcher = setInterval(() => {
    if (state.isComplete) { clearInterval(_boardTabWatcher); return; }
    const columns = document.querySelectorAll('.DraftBoardColumn_draft-board-column');
    if (columns.length && columns.length !== lastColumnCount) {
      lastColumnCount = columns.length;
      readDraftBoard();
    }
  }, 1500);
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

async function fetchDraftMeta() {
  const draftId = getDKDraftId();
  if (!draftId) return;

  // 1. Scan inline <script> tags for a date near the draft ID
  if (!state.draftedAt) {
    const scripts = [...document.querySelectorAll('script:not([src])')];
    for (const s of scripts) {
      const txt = s.textContent;
      if (!txt.includes(draftId)) continue;
      const m = txt.match(/"(20\d\d-\d\d-\d\dT[^"]{5,30})"/);
      if (m) {
        const d = new Date(m[1]);
        if (!isNaN(d.getTime())) {
          state.draftedAt = d.toISOString().slice(0, 10);
          console.log('[BBA] Draft date from page HTML:', state.draftedAt);
          break;
        }
      }
    }
  }

  // 2. Use the draftGroupId captured from intercepted API calls to fetch
  //    contest metadata — this endpoint has the entry fee.
  const groupId = state.draftGroupId;
  if (groupId && state.entryFee == null) {
    const urls = [
      `https://api.draftkings.com/draftgroups/v1/draftgroups/${groupId}`,
      `https://api.draftkings.com/lineups/v1/gametypes/${groupId}`,
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { credentials: 'include' });
        console.log('[BBA] fetchDraftMeta:', url, '→', r.status);
        if (!r.ok) continue;
        const data = await r.json();
        console.log('[BBA] fetchDraftMeta keys:', Object.keys(data), JSON.stringify(data).slice(0, 400));
        const fee = _extractEntryFee(data);
        if (fee != null) { state.entryFee = fee; console.log('[BBA] Entry fee from group meta:', fee); break; }
      } catch (e) {
        console.log('[BBA] fetchDraftMeta error for', url, e.message);
      }
    }
  }
}

function init() {
  initPlayers();

  loadSettings(() => {
    fetchPlayersFromRender();  // fire-and-forget — updates livePlayers from Render
    fetchDraftMeta();          // fire-and-forget — populates draftedAt + entryFee
    loadExposure().then(() => {
      createOverlay();
      render();
      startPickPoller();
      startTimerWatcher();
      scheduleBoardRead(500);
      startBoardTabWatcher();
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

function scrapeMyContestsFees() {
  // DK uses React routing — real hrefs may not exist. Instead scan the full
  // page HTML for draft IDs and extract the entry fee from the same row/block.
  const html = document.body.innerHTML;

  // Find all draft snake IDs embedded anywhere in the page
  const idMatches = [...html.matchAll(/\/draft\/snake\/(\d+)/g)];
  const draftIds = [...new Set(idMatches.map(m => m[1]))];
  console.log('[BBA] scrapeMyContestsFees: found draft IDs in page HTML:', draftIds);

  if (!draftIds.length) {
    // Log all unique URL-like patterns in the page to find DK's link format
    const urlPatterns = [...new Set([...html.matchAll(/(?:href|data-[a-z]+)="([^"]{5,80})"/g)].map(m => m[1]))].slice(0, 20);
    console.log('[BBA] scrapeMyContestsFees: URL patterns in page HTML:', urlPatterns);
    // Also log any element whose text is "EDIT" to find the draft link structure
    const editBtns = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && e.textContent.trim() === 'EDIT');
    editBtns.slice(0, 3).forEach(e => console.log('[BBA] EDIT element:', e.tagName, e.className, e.closest('a,button')?.href || e.closest('[data-id],[data-draftid]')?.dataset));
    return;
  }

  // For each draft ID, find the element containing that ID and scan nearby text for a fee
  for (const draftId of draftIds) {
    // Find any element whose text/href contains the draft ID
    const el = [...document.querySelectorAll('a, button, [data-draft-id], [data-id]')]
      .find(e => (e.href || e.getAttribute('href') || e.dataset.draftId || e.dataset.id || '').includes(draftId));
    const row = el?.closest('tr, [class*="row"], [class*="Row"], [class*="item"], [class*="entry"], [class*="contest"]');
    const text = (row || document.body).textContent;

    // Scan for a standalone $N (whole dollar, no decimals)
    const fees = [...text.matchAll(/\$(\d+)(?!\d*\.)/g)].map(m => parseFloat(m[1]));
    // Pick the smallest non-zero dollar amount — that's most likely the entry fee
    const fee = fees.filter(f => f > 0).sort((a, b) => a - b)[0];
    if (fee != null) {
      const existing = draftMetaCache[draftId] || {};
      draftMetaCache[draftId] = { ...existing, entryFee: fee };
      _saveMetaCache(draftMetaCache);
      console.log('[BBA] Scraped fee for draft', draftId, '→ $' + fee);
    } else {
      console.log('[BBA] scrapeMyContestsFees: no fee found for draft', draftId, '— row text:', (row?.textContent || '').slice(0, 200));
    }
  }
}

function onLocationChange() {
  const href = location.href;
  if (href === _lastHref) return;
  _lastHref = href;

  if (/draftkings\.com\/(draft|lineups?|contest\/draftboard)/.test(href)) {
    if (!document.getElementById('bba-root')) init();
    const draftId = getDKDraftId();
    if (draftId) loadSettings(() => startBoardScan(draftId, state.dkUsername || ''));
  } else if (/draftkings\.com\/mycontests/.test(href)) {
    stopBoardScan();
    console.log('[BBA] mycontests page detected');
    setTimeout(injectFindDraftsButton, 1500);
    // Scrape entry fees from the mycontests table rows after the page renders
    setTimeout(scrapeMyContestsFees, 2000);
  }
}

// DK uses React Router (pushState) for internal navigation — popstate alone is not enough.
// Poll location.href at a low rate to catch SPA navigations.
onLocationChange();
setInterval(onLocationChange, 1000);
window.addEventListener('popstate', onLocationChange);
