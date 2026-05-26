// Bookmarklet payload — loaded from draftkings.com to send session to BBA server
(function () {
  var server = location.protocol === 'https:'
    ? 'http://' + (window._bbaServer || 'SERVER_IP') + ':8000'
    : 'http://' + location.hostname.replace('www.draftkings.com', window._bbaServer || 'SERVER_IP') + ':8000';

  // Derive the server IP from the script src (the bookmarklet loaded this file from our server)
  var scripts = document.querySelectorAll('script[src*=":8000/static/dk-auth.js"]');
  if (scripts.length) {
    var m = scripts[scripts.length - 1].src.match(/http:\/\/([^:]+):8000/);
    if (m) server = 'http://' + m[1] + ':8000';
  }

  var payload = {
    cookie:  document.cookie,
    storage: (function () {
      try { return JSON.stringify(localStorage); } catch (e) { return '{}'; }
    })(),
    href: location.href,
  };

  fetch(server + '/api/dk-auth', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var msg = d.ok
        ? '✓ BBA: auth sent! Keys: ' + (d.cookie_keys || []).join(', ')
        : '✗ BBA: ' + JSON.stringify(d);
      // Show a brief toast
      var div = document.createElement('div');
      Object.assign(div.style, {
        position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
        background: d.ok ? '#1b5e20' : '#b71c1c',
        color: '#fff', padding: '10px 18px', borderRadius: '8px',
        fontFamily: 'sans-serif', fontSize: '14px', fontWeight: '700',
        zIndex: '2147483647', boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
        whiteSpace: 'nowrap',
      });
      div.textContent = msg;
      document.body.appendChild(div);
      setTimeout(function () { div.remove(); }, 5000);
    })
    .catch(function (e) {
      alert('BBA auth error: ' + e.message + '\nMake sure Flask is running on your Mac.');
    });
})();
