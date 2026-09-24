import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';

export const PROJECT_ASSET_CATEGORIES_CHANGED = 'project-asset-categories-changed';

function syncRenderedCategorySelect(current, rendered, { useRenderedSelection = false } = {}) {
  if (!current || !rendered) return false;
  const previous = current.value;
  const renderedValue = rendered.value;
  current.replaceChildren(...Array.from(rendered.options).map((option) => option.cloneNode(true)));
  const valid = Array.from(current.options).some((option) => option.value === previous && !option.disabled);
  current.value = !useRenderedSelection && valid ? previous : renderedValue;

  const dropdown = current.nextElementSibling;
  const renderedDropdown = rendered.nextElementSibling;
  const panel = dropdown?.querySelector?.('.asset-filter-multiselect-panel');
  const renderedPanel = renderedDropdown?.querySelector?.('.asset-filter-multiselect-panel');
  if (panel && renderedPanel) {
    panel.replaceChildren(...Array.from(renderedPanel.childNodes).map((node) => node.cloneNode(true)));
  }
  syncCreatorCrateDropdownFromNative(current);
  return valid;
}

export function syncProjectAssetCategoryConsumers(document, renderedPage) {
  for (const current of document.querySelectorAll('[data-processing-category-select]')) {
    const rendered = renderedPage.getElementById(current.id);
    if (!rendered) continue;
    const valid = syncRenderedCategorySelect(current, rendered);
    const root = current.closest('[data-processing-root]');
    if (!valid && root && !root.__ccProcessingJob && !root.__ccProcessingBusy
      && root.querySelector('[data-processing-scope-option="category"]')?.checked) {
      const fallback = root.querySelector('[data-processing-scope-option="project"]')
        || root.querySelector('[data-processing-scope-option="selected"]');
      if (fallback) fallback.checked = true;
    }
  }

  const output = document.querySelector('[data-processing-field="outputCategorySlug"]');
  if (output) {
    const rendered = renderedPage.getElementById(output.id);
    const previous = output.value;
    syncRenderedCategorySelect(output, rendered);
    const root = output.closest('[data-processing-root]');
    if (previous !== output.value && !root?.__ccProcessingJob && !root?.__ccProcessingBusy) {
      const Event = document.defaultView?.Event || globalThis.Event;
      if (typeof Event === 'function') output.dispatchEvent?.(new Event('change', { bubbles: true }));
    }
  }

  const manager = document.getElementById('project-asset-category-management-dialog');
  const currentDefault = manager?.querySelector('[name="defaultCategory"]');
  const renderedDefault = renderedPage.getElementById(currentDefault?.id);
  if (currentDefault && renderedDefault && !manager.__creatorCrateAppDialogState?.assetBrowserDefault?.pending) {
    syncRenderedCategorySelect(currentDefault, renderedDefault, { useRenderedSelection: true });
    const currentFallback = manager.querySelector('[data-asset-browser-default-fallback]');
    const renderedFallback = renderedPage.getElementById(currentFallback?.id);
    if (currentFallback && renderedFallback) {
      currentFallback.replaceChildren(...Array.from(renderedFallback.childNodes).map((node) => node.cloneNode(true)));
      currentFallback.hidden = renderedFallback.hidden;
    }
    const state = manager.__creatorCrateAppDialogState?.assetBrowserDefault;
    if (state) state.confirmedValue = currentDefault.value;
  }
}

export function notifyProjectAssetCategoriesChanged(element) {
  const document = element?.ownerDocument;
  const Event = document?.defaultView?.Event || globalThis.Event;
  if (document?.dispatchEvent && typeof Event === 'function') {
    document.dispatchEvent(new Event(PROJECT_ASSET_CATEGORIES_CHANGED));
  }
}

export function confirmedProjectAssetCategoryRedirect(response, notice) {
  if (!response?.ok || !response.redirected || !response.url) return false;
  try {
    return new URL(response.url).searchParams.get('notice') === notice;
  } catch {
    return false;
  }
}
