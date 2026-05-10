let currentState = null;
let allPlayers = [];
let exposureData = {};   // player_id -> { exposure_rate, times_drafted, ... }
let totalDrafts = 0;
let currentFilter = '';
let currentSearch = '';

const API_BASE = '/api';

// DOM elements
const teamContainer = document.getElementById('teamContainer');
const playersContainer = document.getElementById('playersContainer');
const pickNum = document.getElementById('pickNum');
const projPoints = document.getElementById('projPoints');
const playerCount = document.getElementById('playerCount');
const resetBtn = document.getElementById('resetBtn');
const searchInput = document.getElementById('searchInput');
const suggestionBox = document.getElementById('suggestionBox');
const suggestionContent = document.getElementById('suggestionContent');
const needsContainer = document.getElementById('needsContainer');
const turnStatus = document.getElementById('turnStatus');
const setupModal = document.getElementById('setupModal');
const filterButtons = document.querySelectorAll('.filter-btn');

// Setup modal
const numTeamsSelect = document.getElementById('numTeams');
const myPositionSelect = document.getElementById('myPosition');
const startDraftBtn = document.getElementById('startDraftBtn');

document.addEventListener('DOMContentLoaded', () => {
    populatePositionSelect();
    numTeamsSelect.addEventListener('change', populatePositionSelect);
    startDraftBtn.addEventListener('click', submitSetup);
    resetBtn.addEventListener('click', resetDraft);
    searchInput.addEventListener('input', e => { currentSearch = e.target.value; renderPlayers(); });
    filterButtons.forEach(btn => {
        btn.addEventListener('click', e => {
            filterButtons.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentFilter = e.target.dataset.filter;
            renderPlayers();
        });
    });

    refreshState();
    setInterval(refreshState, 1500);
});

function populatePositionSelect() {
    const n = parseInt(numTeamsSelect.value);
    myPositionSelect.innerHTML = '';
    for (let i = 1; i <= n; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `Pick ${i}`;
        myPositionSelect.appendChild(opt);
    }
}

async function submitSetup() {
    const num_teams = parseInt(numTeamsSelect.value);
    const my_position = parseInt(myPositionSelect.value);
    const resp = await fetch(`${API_BASE}/draft/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ num_teams, my_position })
    });
    const result = await resp.json();
    if (result.success) {
        setupModal.classList.add('hidden');
        applyState(result.draft_state);
    }
}

// --- State ---

async function refreshState() {
    try {
        const resp = await fetch(`${API_BASE}/draft/state`);
        const state = await resp.json();
        applyState(state);
    } catch (e) {
        console.error('State refresh failed', e);
    }
}

function applyState(state) {
    currentState = state;
    allPlayers = state.available_players || [];
    if (state.exposure) {
        exposureData = state.exposure.players || {};
        totalDrafts  = state.exposure.total_drafts || 0;
    }

    if (!state.is_setup) {
        setupModal.classList.remove('hidden');
        return;
    }

    setupModal.classList.add('hidden');
    renderTurnStatus();
    renderSuggestion();
    renderTeam();
    renderPlayers();
    updateStats();
    updateTeamNeeds();

    if (state.is_complete) showDraftComplete();
}

// --- Turn status banner ---

function renderTurnStatus() {
    const s = currentState;
    turnStatus.classList.remove('hidden', 'my-turn', 'waiting');

    if (s.is_complete) {
        turnStatus.classList.add('waiting');
        turnStatus.textContent = 'Draft complete!';
        return;
    }

    if (s.is_my_turn) {
        turnStatus.classList.add('my-turn');
        turnStatus.textContent =
            `YOUR PICK  —  Pick #${s.overall_pick} overall  |  Round ${s.current_round}  |  My pick #${s.pick_number} of 20`;
    } else {
        turnStatus.classList.add('waiting');
        const until = s.picks_until_my_turn;
        turnStatus.textContent =
            `Pick #${s.overall_pick} overall  |  Round ${s.current_round}  —  Your next pick in ${until} pick${until === 1 ? '' : 's'}  (overall pick #${s.next_my_pick})`;
    }
}

// --- Suggestion ---

function renderSuggestion() {
    const s = currentState;
    if (!s.is_my_turn || !s.suggestion || s.is_complete) {
        suggestionBox.classList.add('hidden');
        return;
    }

    const p = s.suggestion.player;
    suggestionBox.classList.remove('hidden');
    suggestionContent.innerHTML = `
        <div class="suggestion-player">
            <div class="player-name">${p.name} <span class="pos-badge pos-${p.pos}">${p.pos}</span></div>
            <div class="player-meta">${p.team} &nbsp;|&nbsp; Bye: ${p.bye} &nbsp;|&nbsp; ADP: ${p.adp} &nbsp;|&nbsp; ${p.dk_proj} pts</div>
            <div class="suggestion-reason">${s.suggestion.reason}</div>
        </div>
        <button class="btn btn-success suggestion-draft-btn" onclick="pickPlayer('${p.id}')">My Pick</button>
    `;
}

// --- API actions ---

async function pickPlayer(playerId) {
    const resp = await fetch(`${API_BASE}/draft/pick/${playerId}`, { method: 'POST' });
    const result = await resp.json();
    if (resp.ok) applyState({ ...result.draft_state, available_players: result.draft_state.available_players || allPlayers.filter(p => p.id !== playerId) });
    else alert('Error: ' + result.error);
    refreshState();
}

async function markTaken(playerId) {
    const resp = await fetch(`${API_BASE}/draft/taken/${playerId}`, { method: 'POST' });
    const result = await resp.json();
    if (resp.ok) applyState({ ...result.draft_state, available_players: allPlayers.filter(p => p.id !== playerId) });
    else alert('Error: ' + result.error);
    refreshState();
}

async function resetDraft() {
    if (!confirm('Reset draft and return to setup?')) return;
    await fetch(`${API_BASE}/draft/reset`, { method: 'POST' });
    currentState = null;
    allPlayers = [];
    setupModal.classList.remove('hidden');
    turnStatus.classList.add('hidden');
    suggestionBox.classList.add('hidden');
    teamContainer.innerHTML = '<p class="empty-state">Your picks will appear here...</p>';
    playersContainer.innerHTML = '';
    needsContainer.innerHTML = '<p class="empty-state">Start drafting to see team needs</p>';
    pickNum.textContent = '0';
    projPoints.textContent = '0';
}

// --- Rendering ---

function renderTeam() {
    const team = currentState.my_team || [];
    if (team.length === 0) {
        teamContainer.innerHTML = '<p class="empty-state">Your picks will appear here...</p>';
        return;
    }

    const groups = {};
    team.forEach(p => { (groups[p.pos] = groups[p.pos] || []).push(p); });

    let html = '';
    ['QB', 'RB', 'WR', 'TE'].forEach(pos => {
        if (!groups[pos]) return;
        html += `<div class="position-label">${pos}</div>`;
        groups[pos].forEach(p => {
            html += `
                <div class="player-card pos-${p.pos} drafted">
                    <div class="player-info">
                        <div class="player-name">${p.name}</div>
                        <div class="player-meta"><span>${p.team}</span><span>Bye ${p.bye}</span></div>
                    </div>
                    <div class="player-stats">
                        <div class="player-proj">${p.dk_proj} pts</div>
                    </div>
                </div>`;
        });
    });

    teamContainer.innerHTML = html;
}

function renderPlayers() {
    let players = [...allPlayers];
    if (currentFilter) players = players.filter(p => p.pos === currentFilter);
    if (currentSearch) {
        const q = currentSearch.toLowerCase();
        players = players.filter(p => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q));
    }
    players.sort((a, b) => a.adp - b.adp);
    playerCount.textContent = `${players.length} players`;

    if (players.length === 0) {
        playersContainer.innerHTML = '<p class="empty-state">No players match</p>';
        return;
    }

    const isMyTurn = currentState?.is_my_turn;

    playersContainer.innerHTML = players.map(p => {
        const exp = exposureData[p.id];
        const expBadge = exp
            ? `<span class="exposure-badge" title="Drafted in ${exp.times_drafted}/${totalDrafts} drafts">${Math.round(exp.exposure_rate * 100)}%</span>`
            : '';
        return `
        <div class="player-card pos-${p.pos}">
            <div class="player-info">
                <div class="player-name">${p.name} ${expBadge}</div>
                <div class="player-meta">
                    <span>${p.pos}</span><span>${p.team}</span><span>Bye ${p.bye}</span>
                </div>
            </div>
            <div class="player-stats">
                <div class="player-adp">ADP ${p.adp}</div>
                <div class="player-proj">${p.dk_proj} pts</div>
            </div>
            <div class="player-actions">
                <button class="btn-my-pick ${isMyTurn ? '' : 'dim'}" onclick="pickPlayer('${p.id}')">My Pick</button>
                <button class="btn-taken" onclick="markTaken('${p.id}')">Taken</button>
            </div>
        </div>`;
    }).join('');
}

function updateStats() {
    pickNum.textContent = currentState.pick_number - 1;
    projPoints.textContent = currentState.team_projection || 0;

    const reqStatus = document.getElementById('requirementStatus');
    const reqMessage = document.getElementById('reqMessage');
    reqMessage.textContent = currentState.requirement_message || '';
    reqStatus.classList.toggle('valid', currentState.meets_requirements);
    reqStatus.classList.toggle('invalid', !currentState.meets_requirements);
}

function updateTeamNeeds() {
    const needs = currentState.team_needs || {};
    const items = Object.entries(needs).filter(([, count]) => count > 0);
    if (items.length === 0) {
        needsContainer.innerHTML = '<p class="empty-state">Team fully staffed!</p>';
        return;
    }
    needsContainer.innerHTML = items.map(([pos, count]) => `
        <div class="need-item">
            <span class="pos">${pos}</span>
            <span class="count">${count}</span>
        </div>
    `).join('');
}

function showDraftComplete() {
    if (document.querySelector('.complete-banner')) return;
    const total = currentState.team_projection || 0;
    const banner = document.createElement('div');
    banner.className = 'complete-banner';
    banner.innerHTML = `
        Draft complete! Projected <strong>${total} pts</strong>
        <input id="contestName" type="text" placeholder="Contest name (optional)" />
        <button id="saveDraftBtn">Save Draft</button>
        <a href="/history" target="_blank">View History</a>
    `;
    document.body.insertBefore(banner, document.body.firstChild);
    document.getElementById('saveDraftBtn').addEventListener('click', saveDraft);
}

async function saveDraft() {
    const contest = document.getElementById('contestName')?.value || '';
    const resp = await fetch(`${API_BASE}/drafts/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contest })
    });
    const result = await resp.json();
    if (result.success) {
        const btn = document.getElementById('saveDraftBtn');
        btn.textContent = '✓ Saved';
        btn.disabled = true;
    }
}
