// Presentation only: keeps the responsive drawer reachable by touch and keyboard.
export function createNavigation({ document = globalThis.document, window = document.defaultView } = {}) {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('menuButton');
  const dismiss = document.getElementById('menuClose');
  const backdrop = document.getElementById('menuBackdrop');
  const main = document.querySelector('main');
  const compact = window.matchMedia('(max-width: 980px)');
  function close({ restoreFocus = true } = {}) {
    const wasOpen = sidebar.classList.contains('open');
    sidebar.classList.remove('open');
    sidebar.inert = compact.matches;
    main.inert = false;
    backdrop.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('menu-open');
    if (wasOpen && restoreFocus && compact.matches) toggle.focus();
  }
  function open() {
    if (!compact.matches) return;
    sidebar.inert = false;
    sidebar.classList.add('open');
    backdrop.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    document.body.classList.add('menu-open');
    main.inert = true;
    dismiss.focus();
  }
  toggle.addEventListener('click', open);
  dismiss.addEventListener('click', () => close());
  backdrop.addEventListener('click', () => close());
  document.addEventListener('keydown', (event) => {
    if (!compact.matches || !sidebar.classList.contains('open')) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const controls = [...sidebar.querySelectorAll('button:not([disabled]), a[href]')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  compact.addEventListener('change', () => close());
  close({ restoreFocus: false });
  return { close };
}
