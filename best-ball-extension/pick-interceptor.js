// Runs at document_start — injects into the PAGE context (not extension context)
// so it can intercept DraftKings' own fetch/XHR calls before CORS applies.
(function () {
  const script = document.createElement('script');
  script.textContent = `(function () {
  function dispatch(url, data) {
    window.dispatchEvent(new CustomEvent('__bba_api', { detail: { url, data } }));
  }

  // Wrap fetch
  const _fetch = window.fetch;
  window.fetch = function (...args) {
    const req = args[0];
    const url = typeof req === 'string' ? req : req?.url || '';
    const p = _fetch.apply(this, args);
    if (/draftkings\\.com|dk\\.com/i.test(url)) {
      p.then(r => r.clone().json().then(d => dispatch(url, d)).catch(() => {})).catch(() => {});
    }
    return p;
  };

  // Wrap XHR
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__bbaUrl = u;
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__bbaUrl || '';
    if (/draftkings\\.com|dk\\.com/i.test(url)) {
      this.addEventListener('load', function () {
        try { dispatch(this.__bbaUrl, JSON.parse(this.responseText)); } catch (e) {}
      });
    }
    return _send.apply(this, arguments);
  };
})();`;
  const root = document.documentElement;
  root.insertBefore(script, root.firstChild);
  script.remove();
})();
