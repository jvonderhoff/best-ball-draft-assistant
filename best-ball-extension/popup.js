const bAPI = typeof browser !== 'undefined' ? browser : chrome;

const numTeamsEl       = document.getElementById('numTeams');
const myPositionEl     = document.getElementById('myPosition');
const stackIntensityEl    = document.getElementById('stackIntensity');
const diversifyStrengthEl = document.getElementById('diversifyStrength');
const saveBtn          = document.getElementById('saveBtn');
const savedMsg         = document.getElementById('savedMsg');
const playerInfo       = document.getElementById('playerInfo');

function populatePositions() {
  const n = parseInt(numTeamsEl.value);
  myPositionEl.innerHTML = '';
  for (let i = 1; i <= n; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Pick ${i}`;
    myPositionEl.appendChild(opt);
  }
}

function loadSaved() {
  bAPI.storage.local.get(['numTeams', 'myPosition', 'stackIntensity'], result => {
    if (result.numTeams) {
      numTeamsEl.value = result.numTeams;
      populatePositions();
    }
    if (result.myPosition) {
      myPositionEl.value = result.myPosition;
    }
    if (result.stackIntensity)    stackIntensityEl.value    = result.stackIntensity;
    if (result.diversifyStrength != null) diversifyStrengthEl.value = result.diversifyStrength;
  });
}

function save() {
  const numTeams       = parseInt(numTeamsEl.value);
  const myPosition     = parseInt(myPositionEl.value);
  const stackIntensity    = stackIntensityEl.value;
  const diversifyStrength = parseFloat(diversifyStrengthEl.value);

  bAPI.storage.local.set({ numTeams, myPosition, stackIntensity, diversifyStrength }, () => {
    bAPI.tabs.query({ url: '*://*.draftkings.com/*' }, tabs => {
      tabs.forEach(tab => {
        bAPI.tabs.sendMessage(tab.id, { action: 'settingsUpdated', numTeams, myPosition, stackIntensity, diversifyStrength })
          .catch(() => {});
      });
    });

    savedMsg.style.display = 'block';
    setTimeout(() => { savedMsg.style.display = 'none'; }, 2000);
  });
}

// Show how many players are bundled
function showPlayerCount() {
  if (typeof PLAYERS !== 'undefined') {
    playerInfo.textContent = `${PLAYERS.length} players loaded (2026 season)`;
  } else {
    playerInfo.textContent = 'No player data — run generate_players.py first';
  }
}

numTeamsEl.addEventListener('change', populatePositions);
saveBtn.addEventListener('click', save);

populatePositions();
loadSaved();
showPlayerCount();
