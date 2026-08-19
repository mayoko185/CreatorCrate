import { isEnhancementBound, markEnhancementBound } from './dom.js';

export function enhanceClickableCards(scope, {
  cardSelector,
  linkSelector,
  interactiveSelector,
  boundKey,
  keyboardActivation = false,
}) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const cards = scope.querySelectorAll(cardSelector);
  cards.forEach((card) => {
    if (isEnhancementBound(card, boundKey)) return;

    const link = card.querySelector?.(linkSelector);
    if (!link || typeof link.click !== 'function') return;

    markEnhancementBound(card, boundKey);
    card.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0
        || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const interactive = event.target?.closest?.(interactiveSelector);
      if (interactive && interactive !== card
        && (typeof card.contains !== 'function' || card.contains(interactive))) return;

      link.click();
    });
    if (keyboardActivation) {
      card.addEventListener('keydown', (event) => {
        if (event.target !== card || !['Enter', ' '].includes(event.key)
          || card.closest?.('[data-auto-rename-asset]')) return;
        event.preventDefault();
        link.click();
      });
    }
  });
  return cards.length;
}
