import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { enhanceProjectOptionColorPickers } from './project-option-color-picker.js';
import { enhanceDedicatedReorder, NOTES_REORDER_INTERACTIVE_SELECTOR } from './dedicated-reorder.js';
import {
  captureRegionFocus, restoreRegionFocus, enhanceSettingsFetchSave, queueSettingsFetchSave,
} from './settings-fetch-save.js';

const REGION = '[data-settings-project-option-editor]';
const CARD = '[data-project-option-card]';

// Public replacement seam: callers replacing one catalogue can enhance that region alone.
export function enhanceProjectOptionReorder(scope = globalThis.document) {
  const regions = [...(scope?.querySelectorAll?.(REGION) || [])];
  if (scope?.matches?.(REGION)) regions.unshift(scope);
  let bound = 0;
  for (const region of regions) {
    if (isEnhancementBound(region, 'projectOptionReorderBound')) continue;
    const list = region.querySelector('[data-project-option-list]');
    const cards = [...(list?.querySelectorAll(CARD) || [])];
    if (!list || !cards.length) continue;
    const document = region.ownerDocument;
    const form = document.createElement('form');
    form.hidden = true;
    form.method = 'post';
    form.action = region.dataset.projectOptionReorderUrl;
    const csrf = document.createElement('input');
    csrf.type = 'hidden';
    csrf.name = '_csrf';
    csrf.value = region.querySelector('[name="_csrf"]')?.value || '';
    csrf.setAttribute('data-autosubmit', 'fetch');
    form.append(csrf);
    region.append(form);
    const live = document.createElement('p');
    live.className = 'help-text';
    live.setAttribute('data-project-option-reorder-live', '');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    live.id = `${region.id}-reorder-help`;
    live.textContent = 'Drag cards to reorder, or focus a card and use Up, Down, Home, or End.';
    region.insertBefore(live, list);
    let pending = false;
    const restore = () => {
      const focus = captureRegionFocus(region);
      cards.forEach((card, index) => {
        list.append(card);
        card.setAttribute('aria-posinset', String(index + 1));
      });
      pending = false;
      list.removeAttribute('aria-busy');
      live.textContent = 'Could not confirm the option order. The previous order was restored. Reload to check the saved order.';
      restoreRegionFocus(region, focus);
    };
    const reconcile = (html, success) => {
      if (!region.isConnected) return;
      const parsed = new document.defaultView.DOMParser().parseFromString(html || '', 'text/html');
      const next = [...parsed.querySelectorAll(REGION)]
        .find((node) => node.dataset.settingsProjectOptionEditor === region.dataset.settingsProjectOptionEditor);
      if (!next) { restore(); return; }
      const focus = captureRegionFocus(region);
      const announcement = live.textContent;
      region.replaceWith(next);
      enhanceProjectOptionReorder(next);
      enhanceProjectOptionColorPickers(next);
      next.dispatchEvent(new document.defaultView.CustomEvent('project-option-region-replaced', {
        bubbles: true,
      }));
      const nextLive = next.querySelector('[data-project-option-reorder-live]');
      if (nextLive) nextLive.textContent = success ? announcement : 'Could not update the option order. The saved order was restored.';
      restoreRegionFocus(next, focus);
    };
    enhanceSettingsFetchSave(form, {
      onSuccess: ({ html }) => reconcile(html, true),
      onError: ({ html }) => reconcile(html, false),
    });
    cards.forEach((card) => {
      card.draggable = true;
      card.tabIndex = 0;
      card.setAttribute('aria-describedby', live.id);
      card.dataset.projectOptionLabel = card.querySelector('.project-option-label')?.textContent.trim() || card.dataset.projectOptionValue;
      card.setAttribute('aria-label', `Reorder ${card.dataset.projectOptionLabel}`);
    });
    enhanceDedicatedReorder(region, {
      listSelector: '[data-project-option-list]', itemSelector: CARD,
      wholeCardKeyboard: true, pointerDragSurfaceSelector: CARD,
      pointerDragExcludedSelector: NOTES_REORDER_INTERACTIVE_SELECTOR,
      form, liveSelector: '[data-project-option-reorder-live]',
      positionSelector: '[data-project-option-order-position]',
      idDataset: 'projectOptionValue', idAttribute: 'data-project-option-value',
      labelDataset: 'projectOptionLabel', labelAttribute: 'data-project-option-label',
      label: 'Option', bindingKey: 'projectOptionReorderBound',
      isBusy: () => pending
        || region.hasAttribute('data-project-option-mutation-pending')
        || !region.isConnected,
      syncInput: (values) => {
        form.querySelectorAll('[name="orderedValues[]"]').forEach((input) => input.remove());
        values.forEach((value) => {
          const input = document.createElement('input');
          input.type = 'hidden'; input.name = 'orderedValues[]'; input.value = value;
          form.append(input);
        });
        return true;
      },
      onOrderChange: () => {
        pending = true;
        list.setAttribute('aria-busy', 'true');
        if (!queueSettingsFetchSave(csrf)) restore();
      },
    });
    markEnhancementBound(region, 'projectOptionReorderBound');
    bound += 1;
  }
  return bound;
}
