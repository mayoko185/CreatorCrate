(() => {
  const STORAGE_KEY = 'creatorcrate:shell-navigation-continuity';
  const MAX_AGE_MS = 60_000;
  const root = document.documentElement;

  function clearDesktopContinuity() {
    delete root.dataset.shellNavigationContinuity;
    delete root.dataset.shellNavigationSubmenu;
  }

  function matchesNavigationTarget(targetHref) {
    if (targetHref === location.href) return true;

    try {
      const target = new URL(targetHref);
      return target.search === ''
        && location.search !== ''
        && target.origin === location.origin
        && target.pathname === location.pathname
        && target.hash === location.hash;
    } catch {
      return false;
    }
  }

  function readTransferredState() {
    try {
      const serialized = sessionStorage.getItem(STORAGE_KEY);
      sessionStorage.removeItem(STORAGE_KEY);
      if (!serialized) return null;

      const state = JSON.parse(serialized);
      if (
        !state
        || !matchesNavigationTarget(state.target)
        || !Number.isFinite(state.createdAt)
        || Date.now() - state.createdAt > MAX_AGE_MS
      ) {
        return null;
      }
      return state;
    } catch {
      return null;
    }
  }

  function restoreTransferredState(state) {
    if (!state) return;

    if (state.shell === 'mobile') {
      const observer = new MutationObserver(() => {
        const mobileNav = document.querySelector('details.mobile-nav');
        if (!mobileNav) return;
        mobileNav.open = true;
        observer.disconnect();
      });
      observer.observe(root, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', () => observer.disconnect(), { once: true });
      return;
    }

    if (state.shell !== 'desktop') return;
    root.dataset.shellNavigationContinuity = 'desktop';
    if (state.submenu === 'settings') {
      root.dataset.shellNavigationSubmenu = 'settings';
    }

    if (state.activation === 'keyboard' && state.focusKey) {
      const observer = new MutationObserver(() => {
        const link = document.querySelector(`.app-nav [data-nav-key="${CSS.escape(state.focusKey)}"]`);
        if (!link) return;
        link.focus({ preventScroll: true });
        clearDesktopContinuity();
        observer.disconnect();
      });
      observer.observe(root, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', () => {
        observer.disconnect();
        clearDesktopContinuity();
      }, { once: true });
      return;
    }

    const finishPointerContinuity = () => clearDesktopContinuity();
    document.addEventListener('pointermove', finishPointerContinuity, { once: true, capture: true });
    document.addEventListener('pointerdown', finishPointerContinuity, { once: true, capture: true });
    document.addEventListener('keydown', finishPointerContinuity, { once: true, capture: true });
    document.addEventListener('focusin', finishPointerContinuity, { once: true, capture: true });
  }

  function visibleDesktopSubmenu(sidebar) {
    const submenu = [...sidebar.querySelectorAll('.app-nav-children')]
      .find((candidate) => candidate.getBoundingClientRect().height > 0);
    return submenu?.previousElementSibling?.dataset.navKey || null;
  }

  function captureNavigation(event) {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
    ) {
      return;
    }

    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('.app-nav a, .mobile-nav a');
    if (!link || link.hasAttribute('download')) return;
    if (link.target && link.target.toLowerCase() !== '_self') return;

    const target = new URL(link.href, location.href);
    if (target.origin !== location.origin || !['http:', 'https:'].includes(target.protocol)) return;

    const mobileNav = link.closest('details.mobile-nav');
    let state = null;
    if (mobileNav?.open) {
      state = { shell: 'mobile' };
    } else if (link.closest('.app-nav')) {
      const sidebar = link.closest('.app-sidebar');
      const expanded = sidebar?.matches(':hover') || sidebar?.matches(':focus-within');
      if (expanded) {
        state = {
          shell: 'desktop',
          activation: event.detail === 0 ? 'keyboard' : 'pointer',
          focusKey: event.detail === 0 ? link.dataset.navKey || null : null,
          submenu: visibleDesktopSubmenu(sidebar),
        };
      }
    }

    try {
      if (!state) {
        sessionStorage.removeItem(STORAGE_KEY);
        return;
      }
      const serialized = JSON.stringify({
        ...state,
        target: target.href,
        createdAt: Date.now(),
      });
      sessionStorage.setItem(STORAGE_KEY, serialized);
      setTimeout(() => {
        try {
          if (event.defaultPrevented && sessionStorage.getItem(STORAGE_KEY) === serialized) {
            sessionStorage.removeItem(STORAGE_KEY);
          }
        } catch {
          // Navigation remains fully functional when storage is unavailable.
        }
      }, 0);
    } catch {
      // Navigation remains fully functional when storage is unavailable.
    }
  }

  restoreTransferredState(readTransferredState());
  document.addEventListener('click', captureNavigation);
})();
