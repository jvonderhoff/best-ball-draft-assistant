// Apply saved theme before page renders to avoid flash
(function () {
  const t = localStorage.getItem('bba_theme');
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
})();

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const next = isLight ? 'dark' : 'light';
  if (next === 'dark') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', next);
  }
  localStorage.setItem('bba_theme', next);
}
