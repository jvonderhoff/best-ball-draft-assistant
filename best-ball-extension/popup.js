const bAPI = typeof browser !== 'undefined' ? browser : chrome;

const NUM_TEAMS = 12; // DraftKings best ball is always 12 teams

const dkUsernameEl        = document.getElementById('dkUsername');
const stackIntensityEl    = document.getElementById('stackIntensity');
const rbPriorityEl        = document.getElementById('rbPriority');
const diversifyStrengthEl = document.getElementById('diversifyStrength');
const saveBtn             = document.getElementById('saveBtn');
const savedMsg            = document.getElementById('savedMsg');
const playerInfo          = document.getElementById('playerInfo');

function loadSaved() {
  bAPI.storage.local.get(['dkUsername', 'stackIntensity', 'rbPriority', 'diversifyStrength'], result => {
    dkUsernameEl.value = result.dkUsername || 'jvonderhoff';
    if (result.stackIntensity)            stackIntensityEl.value    = result.stackIntensity;
    if (result.rbPriority)                rbPriorityEl.value        = result.rbPriority;
    if (result.diversifyStrength != null) diversifyStrengthEl.value = result.diversifyStrength;
  });
}

function save() {
  const dkUsername        = dkUsernameEl.value.trim();
  const stackIntensity    = stackIntensityEl.value;
  const rbPriority        = rbPriorityEl.value;
  const diversifyStrength = parseFloat(diversifyStrengthEl.value);

  bAPI.storage.local.set({ dkUsername, stackIntensity, rbPriority, diversifyStrength }, () => {
    bAPI.tabs.query({ url: '*://*.draftkings.com/*' }, tabs => {
      tabs.forEach(tab => {
        bAPI.tabs.sendMessage(tab.id, {
          action: 'settingsUpdated',
          numTeams: NUM_TEAMS,
          myPosition: null, // auto-detected in content.js
          dkUsername,
          stackIntensity,
          rbPriority,
          diversifyStrength,
        }).catch(() => {});
      });
    });

    savedMsg.style.display = 'block';
    setTimeout(() => { savedMsg.style.display = 'none'; }, 2000);
  });
}

function showPlayerCount() {
  if (typeof PLAYERS !== 'undefined') {
    playerInfo.textContent = `${PLAYERS.length} players loaded (2026 season)`;
  } else {
    playerInfo.textContent = 'No player data — run generate_players.py first';
  }
}

saveBtn.addEventListener('click', save);
loadSaved();
showPlayerCount();

// ── Find My Drafts ─────────────────────────────────────────────────────────
const findDraftsBtn    = document.getElementById('findDraftsBtn');
const findDraftsStatus = document.getElementById('findDraftsStatus');
const draftsList       = document.getElementById('draftsList');

function showStatus(msg, color) {
  findDraftsStatus.style.display = 'block';
  findDraftsStatus.style.color = color || '#78909c';
  findDraftsStatus.textContent = msg;
}

findDraftsBtn.addEventListener('click', () => {
  showStatus('Scanning page for draft links…', '#4fc3f7');
  findDraftsBtn.disabled = true;

  bAPI.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab) { showStatus('No active tab found.', '#ef5350'); findDraftsBtn.disabled = false; return; }
    if (!tab.url || !tab.url.includes('draftkings.com')) {
      showStatus('Navigate to draftkings.com/mycontests first.', '#ff9800');
      findDraftsBtn.disabled = false;
      return;
    }
    bAPI.tabs.sendMessage(tab.id, { action: 'findDrafts' }, response => {
      findDraftsBtn.disabled = false;
      if (bAPI.runtime.lastError || !response) {
        showStatus('Could not reach page — try refreshing DK.', '#ef5350');
        return;
      }
      if (response.found === 0) {
        showStatus('No draft links found. Try scrolling down first.', '#ff9800');
        return;
      }
      showStatus(`Found ${response.found} draft(s) — fetching picks…`, '#81c784');
      setTimeout(loadDraftStatus, 3000);
    });
  });
});

async function loadDraftStatus() {
  try {
    const FLASK = 'https://192.168.1.161:8000';
    const r = await fetch(`${FLASK}/api/drafts/list`);
    const data = await r.json();
    const drafts = data.drafts || [];
    if (!drafts.length) { draftsList.innerHTML = ''; return; }

    draftsList.innerHTML = drafts.map(d => {
      let urgency = '', color = '#546e7a';
      if (d.my_position) {
        const wait = picksUntilMyTurn(d.overall_pick, d.num_teams || 12, d.my_position);
        if (wait === 0)      { urgency = '🔴 YOUR TURN'; color = '#ef5350'; }
        else if (wait <= 3)  { urgency = `⚡ ${wait} away`; color = '#ff9800'; }
        else                 { urgency = `${wait} picks`; }
      } else {
        urgency = d.scanned ? `${d.pick_count} picks` : '⏳ pending';
      }
      return `<div style="padding:5px 0;border-bottom:1px solid #1a2f4d;display:flex;justify-content:space-between;align-items:center;">
        <span style="color:#4fc3f7;font-size:0.82em;font-weight:700">#${d.draft_id}</span>
        <span style="color:${color};font-size:0.78em;font-weight:${color!=='#546e7a'?'700':'400'}">${urgency}</span>
      </div>`;
    }).join('');
  } catch {
    // Flask unreachable — silently skip
  }
}

// Load draft status on popup open and refresh every 8s
loadDraftStatus();
setInterval(loadDraftStatus, 8000);
