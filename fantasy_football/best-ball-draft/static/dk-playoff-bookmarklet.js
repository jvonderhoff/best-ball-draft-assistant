/* BBA playoff relay: a bookmarklet, run on your DK draft tab.
 *
 * Why it exists: since 2026-09-22 api.draftkings.com answers the BBA server's own
 * requests with Akamai's 403 "Access Denied", whatever the cookies. Your browser,
 * signed in on DK's own draft page, is not refused. So this reads the draft there,
 * the way the page itself does, and sends it to /playoff (POST /api/playoff/push).
 *
 * /playoff builds the bookmark from this file (templates/playoff.html, bookmarklet
 * link) and swaps its own origin in for the HOST placeholder below. Write the
 * placeholder only once in this file: an earlier draft named it here too, and
 * the page's swap then filled in the comment and left the code pointing nowhere. Keep it plain ES2017 with
 * no imports: it runs inside DK's page.
 *
 * What it reads, all endpoints the server used successfully before DK blocked it:
 *   /mycontests (same origin)       your entry id and draft group for this contest
 *   draftStatus every 3 s           the board: every slot, with userKey and pick
 *   draftables + playerpool, once   names for the board, and DK's ADP for /playoff
 * Your seat is worked out on the server, from your DK user id it already holds.
 */
(function () {
  var HOST = '__BBA_HOST__';
  var EVERY = 3000, KEEPALIVE = 10000, ERR_WAIT = 8000;
  if (window.__bbaPlayoff) { window.__bbaPlayoff.flash(); return; }
  var m = location.pathname.match(/\/draft\/snake\/(\d+)/);
  var S = { cid: m && m[1], eid: null, dg: null, names: null, pool: null, poolSent: false,
            sentPicks: -1, lastSent: 0, stopped: false, seat: null };
  window.__bbaPlayoff = S;

  var badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;color:#fff;'
    + 'font:600 13px/1.35 -apple-system,system-ui,sans-serif;padding:8px 12px;border-radius:8px;'
    + 'box-shadow:0 2px 10px rgba(0,0,0,.5);max-width:360px;cursor:pointer';
  badge.title = 'BBA playoff relay. Click to stop.';
  document.body.appendChild(badge);
  function show(text, bad) {
    badge.style.background = bad ? '#8b1a1a' : '#14532d';
    badge.textContent = 'BBA ' + text;
  }
  S.flash = function () {
    badge.style.outline = '3px solid #fff';
    setTimeout(function () { badge.style.outline = ''; }, 600);
  };
  badge.onclick = function () {
    S.stopped = true; window.__bbaPlayoff = null;
    show('stopped. Click the bookmark again to restart.', true);
    setTimeout(function () { badge.remove(); }, 4000);
  };
  if (!S.cid) {
    window.__bbaPlayoff = null;
    show('open your DK draft room first (draftkings.com/draft/snake/...)', true);
    setTimeout(function () { badge.remove(); }, 8000);
    return;
  }

  // The page's own traffic names the entry id too; catch it in case /mycontests
  // does not list a draft that has not started.
  var entryRe = new RegExp('/drafts/v1/(?:snake/)?' + S.cid + '/entries/(\\d+)');
  function sniff(url) { var x = entryRe.exec(String(url || '')); if (x && !S.eid) S.eid = x[1]; }
  var _fetch = window.fetch;
  window.fetch = function (req) {
    try { sniff(typeof req === 'string' ? req : req && req.url); } catch (e) {}
    return _fetch.apply(this, arguments);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { sniff(url); } catch (e) {}
    return _open.apply(this, arguments);
  };

  // `anon`: send no cookies. DK answers draftables with Access-Control-Allow-Origin
  // "*", which a browser refuses for any request that carries credentials -- so with
  // cookies the fetch dies as "Failed to fetch" and every pick arrives nameless
  // ("NO NAMES", draft 198275001, 2026-11-26). draftables needs no login; playerpool
  // and draftStatus do (401 without), and DK names its own origin on those.
  // `anon` also uses a fetch from a fresh iframe: omitting cookies alone still
  // failed on DK's page (b94093c, same draft), so DK's page likely wraps fetch and
  // puts them back. If this fails too, /playoff names the picks itself.
  function cleanFetch() {
    try {
      var f = document.createElement('iframe');
      f.style.display = 'none';
      document.body.appendChild(f);
      return f.contentWindow.fetch.bind(f.contentWindow);
    } catch (e) { return _fetch.bind(window); }
  }
  async function dk(url, anon) {
    var r = anon ? await cleanFetch()(url, { credentials: 'omit' })
      : await _fetch.call(window, url, { credentials: 'include' });
    if (!r.ok) throw new Error('DK ' + url.split('?')[0].split('/').slice(-2).join('/') + ' HTTP ' + r.status);
    return r.json();
  }

  // One object out of the JSON embedded in /mycontests, starting at `i`
  // (the same scan tools/capture-standings.py does with raw_decode).
  function objectAt(text, i) {
    var depth = 0, inStr = false, esc = false;
    for (var j = i; j < text.length; j++) {
      var c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return JSON.parse(text.slice(i, j + 1));
    }
    return null;
  }

  async function findEntry() {
    var html = await (await _fetch.call(window, '/mycontests', { credentials: 'include' })).text();
    var key = '{"ContestId":' + S.cid, i = html.indexOf(key);
    while (i >= 0 && !S.eid) {
      try {
        var o = objectAt(html, i);
        if (o && String(o.ContestId) === S.cid && o.UserContestId) {
          S.eid = String(o.UserContestId);
          if (o.DraftGroupId) S.dg = String(o.DraftGroupId);
          // For the saved draft's label on /playoff (My teams).
          S.contest = o.ContestName || null;
          S.fee = typeof o.BuyInAmount === 'number' ? o.BuyInAmount : null;
        }
      } catch (e) {}
      i = html.indexOf(key, i + key.length);
    }
  }

  async function loadNames() {
    var dr = await dk('https://api.draftkings.com/draftgroups/v1/draftgroups/' + S.dg + '/draftables?format=json', true);
    var list = dr.draftables || [];
    S.names = {};
    S.slim = list.map(function (d) {
      S.names[d.draftableId] = { name: d.displayName || ((d.firstName || '') + ' ' + (d.lastName || '')).trim(),
                                 pos: d.position || '', team: d.teamAbbreviation || d.teamAbbrev || '' };
      return { draftableId: d.draftableId, playerId: d.playerId, position: d.position,
               teamAbbreviation: d.teamAbbreviation || d.teamAbbrev };
    });
  }

  // DK's ADP for /playoff's bots. Optional: the board works without it. Not tied
  // to the names: when those fail the pool goes without draftables, and the server
  // joins it with the copy /playoff posts.
  async function loadPool() {
    try {
      var pp = await dk('https://api.draftkings.com/rankings/v1/draftgroups/' + S.dg + '/playerpool?format=json');
      var players = ((pp.playerPool || {}).draftablePlayers || []).map(function (p) {
        return { playerId: p.playerId, displayName: p.displayName, firstName: p.firstName, lastName: p.lastName,
                 averageDraftPosition: p.averageDraftPosition,
                 draftableRosterPositions: (p.draftableRosterPositions || []).map(function (s) {
                   return { draftableId: s && s.draftableId };
                 }) };
      });
      S.pool = { playerpool: { playerPool: { draftablePlayers: players } } };
      if (S.slim) S.pool.draftables = { draftables: S.slim };
    } catch (e) { S.poolError = e.message; }
  }

  async function send(board) {
    var body = { board: board, entry_id: S.eid, draft_group_id: S.dg, contest: S.contest, entry_fee: S.fee };
    var withPool = S.pool && !S.poolSent;
    if (withPool) body.pool = S.pool;
    var r;
    try {
      r = await _fetch.call(window, HOST + '/api/playoff/push/' + S.cid, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error('could not reach BBA (' + e.message + '). DK\'s page may block it.');
    }
    if (!r.ok) throw new Error('BBA server HTTP ' + r.status);
    var d = await r.json();
    if (withPool) S.poolSent = true;
    S.seat = d.my_position;
    S.seatKnown = d.seat_known;
    S.lastSent = Date.now();
  }

  function later(ms) { if (!S.stopped) setTimeout(tick, ms); }

  async function tick() {
    if (S.stopped) return;
    try {
      if (!S.eid) await findEntry();
      if (!S.eid) { show('looking for your entry in contest ' + S.cid + '...', true); return later(EVERY); }
      var st = await dk('https://api.draftkings.com/drafts/v1/' + S.cid + '/entries/' + S.eid + '/draftStatus?format=json');
      if (!S.dg && st.draftGroupId) S.dg = String(st.draftGroupId);
      // Names are retried every 30 s, never allowed to stop the board: a pick sent
      // as "Player #id" still uses a turn, and /playoff lists it as not matched.
      if (!S.names && S.dg && Date.now() - (S.namesTried || 0) > 30000) {
        S.namesTried = Date.now();
        try { await loadNames(); } catch (e) { S.namesError = e.message; }
      }
      if (!S.pool && !S.poolError && S.dg) await loadPool();
      var names = S.names || {};
      var board = (st.draftBoard || []).map(function (e) {
        var n = (e.draftableId && names[e.draftableId]) || {};
        return { pick_number: e.overallSelectionNumber, round: e.roundNumber, user_key: e.userKey || '',
                 draftable_id: e.draftableId ? String(e.draftableId) : null,
                 player_name: n.name || null, pos: n.pos || '', team: n.team || '' };
      });
      var made = board.filter(function (b) { return b.draftable_id; }).length;
      var done = board.length > 0 && made === board.length;
      if (made !== S.sentPicks || Date.now() - S.lastSent > KEEPALIVE || (S.pool && !S.poolSent)) {
        await send(board);
        S.sentPicks = made;
      }
      var seat = S.seat ? 'seat ' + S.seat : S.seatKnown === false ? 'seat unknown (set it on /playoff)' : 'seat ?';
      var pool = (S.namesError && !S.names ? ', NO NAMES (' + S.namesError + '; /playoff names them)' : '')
        + (S.poolSent ? ', ADP sent' : S.poolError ? ', no ADP (' + S.poolError + ')' : '');
      // The names and ADP state stays on the badge to the end: "draft complete"
      // alone hid a run whose names had all failed (draft 198275001).
      if (done) { show('draft complete: ' + made + ' picks sent' + pool + '. Click to close.'); return; }
      show('sending: ' + made + ' of ' + board.length + ' picks, ' + seat + pool);
      later(EVERY);
    } catch (e) {
      show(String(e.message || e) + ' (retrying)', true);
      later(ERR_WAIT);
    }
  }
  show('starting for contest ' + S.cid + '...');
  tick();
})();
