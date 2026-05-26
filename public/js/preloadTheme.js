(function () {
  var theme = localStorage.getItem('theme');
  if (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    theme = 'dark';
  }
  if (theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }
})();
