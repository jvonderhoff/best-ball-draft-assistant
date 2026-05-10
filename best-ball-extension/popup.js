const bAPI = typeof browser !== 'undefined' ? browser : chrome;

const NUM_TEAMS = 12; // DraftKings best ball is always 12 teams

const dkUsernameEl        = document.getElementById('dkUsername');
const stackIntensityEl    = document.getElementById('stackIntensity');
const diversifyStrengthEl = document.getElementById('diversifyStrength');
const saveBtn             = document.getElementById('saveBtn');
const savedMsg            = document.getElementById('savedMsg');
const playerInfo          = document.getElementById('playerInfo');

function loadSaved() {
  bAPI.storage.local.get(['dkUsername', 'stackIntensity', 'diversifyStrength'], result => {
    if (result.dkUsername)  dkUsernameEl.value = result.dkUsername;
    if (result.stackIntensity)    stackIntensityEl.value    = result.stackIntensity;
    if (result.diversifyStrength != null) diversifyStrengthEl.value = result.diversifyStrength;
  });
}

function save() {
  const dkUsername        = dkUsernameEl.value.trim();
  const stackIntensity    = stackIntensityEl.value;
  const diversifyStrength = parseFloat(diversifyStrengthEl.value);

  bAPI.storage.local.set({ dkUsername, stackIntensity, diversifyStrength }, () => {
    bAPI.tabs.query({ url: '*://*.draftkings.com/*' }, tabs => {
      tabs.forEach(tab => {
        bAPI.tabs.sendMessage(tab.id, {
          action: 'settingsUpdated',
          numTeams: NUM_TEAMS,
          myPosition: null, // auto-detected in content.js
          dkUsername,
          stackIntensity,
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
