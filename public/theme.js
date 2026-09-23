(() => {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const storageKey = 'appearance';
  const valid = (value) => ['system', 'light', 'dark'].includes(value);
  let preference = 'system';
  try {
    const stored = localStorage.getItem(storageKey);
    if (valid(stored)) preference = stored;
  } catch { /* The system preference works even when storage is blocked. */ }

  const apply = () => {
    root.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    root.style.colorScheme = root.dataset.theme;
  };
  apply();
  media.addEventListener('change', apply);

  document.addEventListener('DOMContentLoaded', () => {
    const control = document.querySelector('[data-theme-control]');
    const select = document.querySelector('#appearance');
    if (!control || !select) return;
    control.hidden = false;
    select.value = preference;
    select.addEventListener('change', () => {
      preference = valid(select.value) ? select.value : 'system';
      apply();
      try {
        if (preference === 'system') localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, preference);
      } catch { /* Keep the selected theme for this page without storage. */ }
    });
    window.addEventListener('storage', (event) => {
      if (event.key !== storageKey && event.key !== null) return;
      preference = valid(event.newValue) ? event.newValue : 'system';
      select.value = preference;
      apply();
    });
  });
})();
