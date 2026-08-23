import {
  isEnhancementBound,
  liveRegionDocument,
  markEnhancementBound,
  setHidden,
} from './dom.js';
import {
  ASSET_SELECTION_FORM_SELECTOR,
  updateAssetSelectionState,
} from './asset-ordering.js';

const PROJECT_ASSET_CATEGORY_FILTER_SELECTOR = '[data-asset-category-filter]';
const ASSET_VIEWER_FILTER_DISCLOSURE_SELECTOR = '[data-asset-viewer-filter-disclosure]';
export const CC_DROPDOWN_SELECTOR = '[data-cc-dropdown]';
const CC_DROPDOWN_SEARCH_SELECTOR = '[data-cc-dropdown-search]';
const CC_DROPDOWN_OPTION_LIST_SELECTOR = '[data-cc-dropdown-option-list]';
const CC_DROPDOWN_NO_RESULTS_SELECTOR = '[data-cc-dropdown-no-results]';
const ASSET_VIEWER_FILTER_SINGLE_SELECT_SELECTOR = '[data-asset-viewer-filter-single-select]';
const ASSET_VIEWER_FILTER_MULTI_SELECT_SELECTOR = '[data-asset-viewer-filter-multi-select]';
const ASSET_VIEWER_FILTER_SINGLE_SELECT_SUMMARY_SELECTOR = '.asset-filter-multiselect-summary-current';
const CC_DROPDOWN_CURRENT_SUMMARY_SELECTOR = '[data-cc-dropdown-summary-current]';
const CC_DROPDOWN_NATIVE_SELECT_SELECTOR = '[data-cc-dropdown-native-select]';
const CC_DROPDOWN_SUMMARY_WIDTH_SELECTOR = '.asset-filter-multiselect-summary-width';
const SCROLLABLE_CATEGORY_DIALOG_BODY_CLASS = 'project-asset-category-management-dialog-body';
const PROJECT_EDIT_DIALOG_BODY_CLASS = 'project-edit-dialog-body';
const CC_DROPDOWN_PANEL_SELECTOR = '.asset-filter-multiselect-panel';
const CC_DROPDOWN_OVERLAY_ATTRIBUTE = 'data-cc-dropdown-overlay';
const CC_DROPDOWN_OVERLAY_STATE = '__creatorCrateDropdownOverlayState';
const CC_DROPDOWN_VIEWPORT_GUTTER = 8;
const CC_DROPDOWN_PANEL_GAP = 4;

function isScrollableDialogBody(dialogBody) {
  return Boolean(
    dialogBody?.classList?.contains?.(SCROLLABLE_CATEGORY_DIALOG_BODY_CLASS)
      || dialogBody?.classList?.contains?.(PROJECT_EDIT_DIALOG_BODY_CLASS)
      || dialogBody?.classList?.contains?.('processing-dialog-body')
      || dialogBody?.classList?.contains?.('processing-manage-body'),
  );
}

function captureDialogBodyScroll(disclosure) {
  const dialogBody = disclosure?.closest?.('.app-dialog-body');
  if (!dialogBody) return null;
  const scrollTop = Number(dialogBody.scrollTop) || 0;
  const scrollLeft = Number(dialogBody.scrollLeft) || 0;
  return { dialogBody, scrollTop, scrollLeft };
}

function restoreDialogBodyScroll(target) {
  const state = target?.__creatorCrateDropdownScrollState;
  if (state?.dialogBody && state.dialogBody.isConnected) {
    state.dialogBody.scrollTop = state.scrollTop;
    state.dialogBody.scrollLeft = state.scrollLeft;
  }
  if (target) target.__creatorCrateDropdownScrollState = null;
}

function dropdownPanelStyleSet(panel, property, value) {
  const style = panel?.style;
  if (!style) return false;
  if (typeof style.setProperty === 'function') style.setProperty(property, value);
  else style[property === 'max-height' ? 'maxHeight' : property === 'min-width' ? 'minWidth' : property] = value;
  return true;
}

function dropdownPanelStyleRemove(panel, property) {
  const style = panel?.style;
  if (!style) return;
  if (typeof style.removeProperty === 'function') style.removeProperty(property);
  else delete style[property === 'max-height' ? 'maxHeight' : property === 'min-width' ? 'minWidth' : property];
}

function cleanupScrollableDropdownPositioning(dropdown, { restoreScroll = true } = {}) {
  const state = dropdown?.[CC_DROPDOWN_OVERLAY_STATE];
  if (state) {
    state.body?.removeEventListener?.('scroll', dropdown.__creatorCrateDropdownRecordScroll);
    state.viewport?.removeEventListener?.('resize', state.reposition);
    state.viewport?.removeEventListener?.('scroll', state.reposition, true);
    if (restoreScroll && state.body) {
      state.body.scrollTop = state.lastScrollTop ?? state.body.scrollTop;
    }
    delete dropdown[CC_DROPDOWN_OVERLAY_STATE];
    delete dropdown.__creatorCrateDropdownRecordScroll;
  }

  const panel = dropdown?.querySelector?.(CC_DROPDOWN_PANEL_SELECTOR);
  if (!panel) return;
  panel.removeAttribute?.(CC_DROPDOWN_OVERLAY_ATTRIBUTE);
  ['position', 'left', 'top', 'width', 'min-width', 'max-height'].forEach((property) => {
    dropdownPanelStyleRemove(panel, property);
  });
}

function dropdownViewport(dropdown) {
  const document = dropdown?.ownerDocument || globalThis.document;
  const viewport = document?.defaultView || globalThis;
  const width = Number(viewport?.innerWidth) || Number(document?.documentElement?.clientWidth) || 0;
  const height = Number(viewport?.innerHeight) || Number(document?.documentElement?.clientHeight) || 0;
  return { viewport, width, height };
}

function positionScrollableCategoryDropdown(dropdown, dialogBody) {
  if (!dropdown || dropdown.open !== true || !isScrollableDialogBody(dialogBody)) return false;

  const summary = dropdown.querySelector?.('summary');
  const panel = dropdown.querySelector?.(CC_DROPDOWN_PANEL_SELECTOR);
  const summaryRect = summary?.getBoundingClientRect?.();
  const panelRect = panel?.getBoundingClientRect?.();
  const { width: viewportWidth, height: viewportHeight } = dropdownViewport(dropdown);
  if (!summaryRect || !panelRect || viewportWidth <= 0 || viewportHeight <= 0) return false;

  const triggerLeft = Number(summaryRect.left);
  const triggerTop = Number(summaryRect.top);
  const triggerBottom = Number(summaryRect.bottom);
  const triggerWidth = Number(summaryRect.width) || Number(summaryRect.right) - triggerLeft;
  if (![triggerLeft, triggerTop, triggerBottom, triggerWidth].every(Number.isFinite)) return false;
  if (triggerBottom <= CC_DROPDOWN_VIEWPORT_GUTTER || triggerTop >= viewportHeight - CC_DROPDOWN_VIEWPORT_GUTTER) {
    return false;
  }

  const initialPanelWidth = Number(panelRect.width);
  const cssMaxPanelWidth = Number.parseFloat(
    dropdown.ownerDocument?.defaultView?.getComputedStyle?.(panel)?.maxWidth,
  );
  const viewportMaxPanelWidth = viewportWidth - (CC_DROPDOWN_VIEWPORT_GUTTER * 2);
  const maxPanelWidth = Math.min(
    viewportMaxPanelWidth,
    Math.max(
      triggerWidth,
      Number.isFinite(cssMaxPanelWidth) ? cssMaxPanelWidth : viewportMaxPanelWidth,
    ),
  );
  const panelWidth = Math.min(
    maxPanelWidth,
    Math.max(1, initialPanelWidth || triggerWidth),
  );
  if (!dropdownPanelStyleSet(panel, 'position', 'fixed')
    || !dropdownPanelStyleSet(panel, 'left', '0px')
    || !dropdownPanelStyleSet(panel, 'top', '0px')
    || !dropdownPanelStyleSet(panel, 'width', `${panelWidth}px`)
    || !dropdownPanelStyleSet(panel, 'min-width', '0px')) {
    return false;
  }
  panel.setAttribute?.(CC_DROPDOWN_OVERLAY_ATTRIBUTE, '');

  const positionedPanelRect = panel.getBoundingClientRect?.() || panelRect;
  const naturalPanelHeight = Number(positionedPanelRect.height) || Number(panelRect.height) || 0;
  const spaceBelow = Math.max(1, viewportHeight - triggerBottom - CC_DROPDOWN_VIEWPORT_GUTTER);
  const spaceAbove = Math.max(1, triggerTop - CC_DROPDOWN_VIEWPORT_GUTTER);
  const opensAbove = naturalPanelHeight > spaceBelow && spaceAbove > spaceBelow;
  const availableHeight = opensAbove ? spaceAbove : spaceBelow;
  const maxPanelHeight = Math.max(1, Math.min(naturalPanelHeight || availableHeight, availableHeight));
  dropdownPanelStyleSet(panel, 'max-height', `${maxPanelHeight}px`);

  const finalPanelRect = panel.getBoundingClientRect?.() || positionedPanelRect;
  const renderedPanelHeight = Number(finalPanelRect.height) || maxPanelHeight;
  const left = Math.max(
    CC_DROPDOWN_VIEWPORT_GUTTER,
    Math.min(triggerLeft, viewportWidth - CC_DROPDOWN_VIEWPORT_GUTTER - panelWidth),
  );
  let top = opensAbove
    ? triggerTop - CC_DROPDOWN_PANEL_GAP - renderedPanelHeight
    : triggerBottom + CC_DROPDOWN_PANEL_GAP;
  top = Math.max(
    CC_DROPDOWN_VIEWPORT_GUTTER,
    Math.min(top, viewportHeight - CC_DROPDOWN_VIEWPORT_GUTTER - renderedPanelHeight),
  );
  dropdownPanelStyleSet(panel, 'left', `${left}px`);
  dropdownPanelStyleSet(panel, 'top', `${top}px`);
  return true;
}

function bindScrollableCategoryDropdownPositioning(dropdown, dialogBody) {
  const currentState = dropdown?.[CC_DROPDOWN_OVERLAY_STATE];
  if (currentState?.body === dialogBody) return;
  cleanupScrollableDropdownPositioning(dropdown);

  const { viewport } = dropdownViewport(dropdown);
  let lastScrollTop = Number(dialogBody.scrollTop) || 0;
  const reposition = () => {
    if (dropdown.open !== true) {
      cleanupScrollableDropdownPositioning(dropdown);
      return;
    }
    lastScrollTop = Number(dialogBody.scrollTop) || 0;
    if (positionScrollableCategoryDropdown(dropdown, dialogBody)) return;
    dropdown.open = false;
    dropdown.removeAttribute?.('open');
    cleanupScrollableDropdownPositioning(dropdown);
    dropdown.querySelector?.('summary')?.focus?.({ preventScroll: true });
    restoreDialogBodyScroll(dropdown);
  };

  const recordScroll = () => {
    lastScrollTop = Number(dialogBody.scrollTop) || 0;
  };

  dialogBody.addEventListener?.('scroll', recordScroll, { passive: true });
  viewport?.addEventListener?.('resize', reposition);
  viewport?.addEventListener?.('scroll', reposition, true);
  dropdown.__creatorCrateDropdownRecordScroll = recordScroll;
  dropdown[CC_DROPDOWN_OVERLAY_STATE] = {
    body: dialogBody,
    viewport,
    reposition,
    get lastScrollTop() { return lastScrollTop; },
  };
}

function closeScrollableCategoryDropdown(dropdown, restoreFocus = false) {
  dropdown.open = false;
  dropdown.removeAttribute?.('open');
  cleanupScrollableDropdownPositioning(dropdown);
  if (restoreFocus) dropdown.querySelector?.('summary')?.focus?.({ preventScroll: true });
  restoreDialogBodyScroll(dropdown);
}

export function cleanupScrollableCategoryDialogDropdowns(dialog) {
  const dialogBody = Array.from(dialog?.querySelectorAll?.('.app-dialog-body') || [])
    .find((candidate) => isScrollableDialogBody(candidate));
  if (!dialogBody) return;
  Array.from(dialogBody.querySelectorAll?.(CC_DROPDOWN_SELECTOR) || []).forEach((dropdown) => {
    if (dropdown.open === true) {
      dropdown.open = false;
      dropdown.removeAttribute?.('open');
    }
    cleanupScrollableDropdownPositioning(dropdown);
  });
  dialogBody.classList?.remove?.('cc-dropdown-dialog-open');
  dialogBody.closest?.('.app-dialog-card')?.classList?.remove?.('cc-dropdown-dialog-open');
}

export function updateAssetViewerFilterDisclosureState(disclosure) {
  disclosure?.querySelector?.('summary')?.setAttribute?.('aria-expanded', String(disclosure.open === true));
  const dialogBody = disclosure?.closest?.('.app-dialog-body');
  if (!dialogBody) return;

  const dialog = dialogBody.closest?.('[data-app-dialog]');
  const panel = disclosure?.querySelector?.(CC_DROPDOWN_PANEL_SELECTOR);
  if (isScrollableDialogBody(dialogBody)) {
    dialogBody.classList?.remove?.('cc-dropdown-dialog-open');
    dialogBody.closest?.('.app-dialog-card')?.classList?.remove?.('cc-dropdown-dialog-open');
    if (!panel) return;
    if (disclosure.open === true) {
      disclosure.__creatorCrateDropdownScrollState = captureDialogBodyScroll(disclosure);
      bindScrollableCategoryDropdownPositioning(disclosure, dialogBody);
      if (!positionScrollableCategoryDropdown(disclosure, dialogBody)) {
        closeScrollableCategoryDropdown(disclosure);
        return;
      }
    } else {
      cleanupScrollableDropdownPositioning(disclosure, { restoreScroll: false });
      restoreDialogBodyScroll(disclosure);
    }
    return;
  }

  const hasOpenDropdown = Boolean(dialog?.querySelector?.(`${CC_DROPDOWN_SELECTOR}[open]`));
  dialogBody.classList?.toggle?.('cc-dropdown-dialog-open', hasOpenDropdown);
  dialogBody.closest?.('.app-dialog-card')?.classList?.toggle?.('cc-dropdown-dialog-open', hasOpenDropdown);
}

function isAssetViewerFilterSingleSelect(disclosure) {
  return Object.hasOwn(disclosure?.dataset || {}, 'assetViewerFilterSingleSelect');
}

function isAssetViewerFilterMultiSelect(disclosure) {
  return Object.hasOwn(disclosure?.dataset || {}, 'assetViewerFilterMultiSelect');
}

function assetViewerFilterSingleSelectLabel(input) {
  const labelText = String(input?.closest?.('label')?.textContent || '').trim().replace(/\s+/g, ' ');
  return labelText || String(input?.value ?? '').trim();
}

function assetViewerFilterMultiSelectLabel(input) {
  return String(input?.closest?.('label')?.textContent || '').trim().replace(/\s+/g, ' ');
}

function updateAssetViewerFilterSingleSelectSummary(disclosure) {
  if (!isAssetViewerFilterSingleSelect(disclosure)) return;

  const selectedInput = disclosure.querySelector?.('input[type="radio"]:checked');
  const selectedLabel = assetViewerFilterSingleSelectLabel(selectedInput);
  if (!selectedInput || selectedLabel === '') return;

  const currentSummary = disclosure.querySelector?.(ASSET_VIEWER_FILTER_SINGLE_SELECT_SUMMARY_SELECTOR);
  if (currentSummary) currentSummary.textContent = selectedLabel;

  const summary = disclosure.querySelector?.('summary');
  const ariaLabel = summary?.getAttribute?.('aria-label');
  if (typeof ariaLabel !== 'string' || ariaLabel === '') return;

  const separator = ariaLabel.indexOf(':');
  summary.setAttribute(
    'aria-label',
    separator >= 0 ? `${ariaLabel.slice(0, separator + 1)} ${selectedLabel}` : selectedLabel,
  );
}

function updateAssetViewerFilterMultiSelectSummary(disclosure) {
  if (!isAssetViewerFilterMultiSelect(disclosure)) return;

  const inputs = Array.from(disclosure.querySelectorAll?.('input[type="checkbox"]') || []);
  const selectedInputs = inputs.filter((input) => input.checked);
  const summary = disclosure.querySelector?.('summary');
  const currentSummary = disclosure.querySelector?.(ASSET_VIEWER_FILTER_SINGLE_SELECT_SUMMARY_SELECTOR);
  if (!summary || !currentSummary) return;

  let summaryText;
  if (selectedInputs.length === 0) {
    summaryText = 'No tags selected';
  } else if (selectedInputs.length === 1) {
    summaryText = assetViewerFilterMultiSelectLabel(selectedInputs[0]) || '1 tag selected';
  } else {
    summaryText = `${selectedInputs.length} tags selected`;
  }

  currentSummary.textContent = summaryText;

  const ariaLabel = summary.getAttribute?.('aria-label');
  if (typeof ariaLabel === 'string' && ariaLabel !== '') {
    const separator = ariaLabel.indexOf(':');
    summary.setAttribute(
      'aria-label',
      separator >= 0 ? `${ariaLabel.slice(0, separator + 1)} ${summaryText}` : summaryText,
    );
  }
}

function creatorCrateDropdownMode(dropdown) {
  return dropdown?.dataset?.ccDropdownMode
    || dropdown?.getAttribute?.('data-cc-dropdown-mode')
    || null;
}

function creatorCrateDropdownIsSearchable(dropdown) {
  return dropdown?.dataset?.ccDropdownSearchable !== undefined
    || dropdown?.hasAttribute?.('data-cc-dropdown-searchable')
    || dropdown?.getAttribute?.('data-cc-dropdown-type') === 'searchable-single';
}

function creatorCrateDropdownSearchInput(dropdown) {
  return dropdown?.querySelector?.(CC_DROPDOWN_SEARCH_SELECTOR) || null;
}

function creatorCrateDropdownSearchOptionRows(dropdown) {
  const optionList = dropdown?.querySelector?.(CC_DROPDOWN_OPTION_LIST_SELECTOR);
  return Array.from(optionList?.querySelectorAll?.('.asset-filter-multiselect-option') || []);
}

function creatorCrateDropdownSearchOptionInput(option) {
  return option?.querySelector?.('input[type="radio"]') || null;
}

function updateCreatorCrateDropdownSearch(dropdown) {
  if (!creatorCrateDropdownIsSearchable(dropdown)) return;

  const search = creatorCrateDropdownSearchInput(dropdown);
  const noResults = dropdown?.querySelector?.(CC_DROPDOWN_NO_RESULTS_SELECTOR);
  const query = String(search?.value ?? '').trim().toLowerCase();
  let matchingOptionCount = 0;

  creatorCrateDropdownSearchOptionRows(dropdown).forEach((option) => {
    const input = creatorCrateDropdownSearchOptionInput(option);
    const value = String(input?.value ?? '');
    const label = assetViewerFilterSingleSelectLabel(input).toLowerCase();
    const matches = value === '' || query === '' || label.includes(query);
    setHidden(option, !matches);
    if (value !== '' && matches) matchingOptionCount += 1;
  });

  setHidden(noResults, query === '' || matchingOptionCount > 0);
}

function creatorCrateDropdownNativeSelect(dropdown) {
  return dropdown?.querySelector?.(CC_DROPDOWN_NATIVE_SELECT_SELECTOR)
    || dropdown?.parentElement?.querySelector?.(CC_DROPDOWN_NATIVE_SELECT_SELECTOR)
    || dropdown?.parentNode?.querySelector?.(CC_DROPDOWN_NATIVE_SELECT_SELECTOR)
    || null;
}

export function creatorCrateDropdownForNativeSelect(nativeSelect) {
  return nativeSelect?.parentElement?.querySelector?.(CC_DROPDOWN_SELECTOR)
    || nativeSelect?.parentNode?.querySelector?.(CC_DROPDOWN_SELECTOR)
    || nativeSelect?.closest?.('fieldset')?.querySelector?.(CC_DROPDOWN_SELECTOR)
    || null;
}

export function creatorCrateDropdownSummaryForNativeSelect(nativeSelect) {
  return creatorCrateDropdownForNativeSelect(nativeSelect)?.querySelector?.('summary') || null;
}

function creatorCrateDropdownInputs(dropdown, mode) {
  const type = mode === 'single' ? 'radio' : 'checkbox';
  return Array.from(dropdown?.querySelectorAll?.(`input[type="${type}"]`) || []);
}

function creatorCrateDropdownNativeOptions(nativeSelect) {
  return Array.from(nativeSelect?.options || nativeSelect?.querySelectorAll?.('option') || []);
}

function creatorCrateDropdownNativeValue(option) {
  return String(option?.value ?? option?.getAttribute?.('value') ?? '');
}

function creatorCrateDropdownIsDisabled(dropdown) {
  const nativeSelect = creatorCrateDropdownNativeSelect(dropdown);
  return Boolean(nativeSelect?.disabled || nativeSelect?.hasAttribute?.('disabled')
    || dropdown?.hasAttribute?.('data-cc-dropdown-config-disabled'));
}

function clearCreatorCrateElementChildren(element) {
  if (!element) return;
  if (typeof element.replaceChildren === 'function') {
    element.replaceChildren();
    return;
  }
  while (element.firstChild && typeof element.removeChild === 'function') {
    element.removeChild(element.firstChild);
  }
}

function syncCreatorCrateDropdownSummaryWidthFromNative(dropdown, nativeOptions) {
  const widthSizer = dropdown.querySelector?.(CC_DROPDOWN_SUMMARY_WIDTH_SELECTOR);
  const document = dropdown.ownerDocument || globalThis.document;
  if (!widthSizer || !document?.createElement) return;

  clearCreatorCrateElementChildren(widthSizer);
  nativeOptions.forEach((option) => {
    const span = document.createElement('span');
    span.textContent = option.textContent || creatorCrateDropdownNativeValue(option);
    widthSizer.appendChild?.(span);
  });
}

function syncCreatorCrateDropdownOptionsFromNative(dropdown) {
  const nativeSelect = creatorCrateDropdownNativeSelect(dropdown);
  const mode = creatorCrateDropdownMode(dropdown);
  if (!nativeSelect || !mode) return;

  const nativeOptions = creatorCrateDropdownNativeOptions(nativeSelect);
  syncCreatorCrateDropdownSummaryWidthFromNative(dropdown, nativeOptions);
  const nativeValues = new Set(nativeOptions.map(creatorCrateDropdownNativeValue));
  creatorCrateDropdownInputs(dropdown, mode)
    .filter((input) => !nativeValues.has(String(input.value ?? '')))
    .forEach((input) => input.closest?.('.asset-filter-multiselect-option')?.remove?.());

  const existingValues = new Set(
    creatorCrateDropdownInputs(dropdown, mode).map((input) => String(input.value ?? '')),
  );
  const panel = dropdown.querySelector?.(CC_DROPDOWN_OPTION_LIST_SELECTOR)
    || dropdown.querySelector?.('.asset-filter-multiselect-panel');
  const document = dropdown.ownerDocument || globalThis.document;
  if (!panel || !document?.createElement) return;

  const searchable = creatorCrateDropdownIsSearchable(dropdown);
  const optionList = searchable
    ? panel.querySelector?.(CC_DROPDOWN_OPTION_LIST_SELECTOR)
    : panel;
  const targetContainer = optionList || panel;

  nativeOptions.forEach((option, index) => {
    const value = creatorCrateDropdownNativeValue(option);
    if (existingValues.has(value)) return;

    const wrapper = document.createElement('div');
    wrapper.setAttribute?.('class', 'asset-filter-multiselect-option');
    if (searchable) wrapper.setAttribute?.('class', 'asset-filter-multiselect-option asset-project-filter-option');
    const label = document.createElement('label');
    const input = document.createElement('input');
    const span = document.createElement('span');
    const optionId = `${dropdown.id || 'cc-dropdown'}-native-option-${index}`;
    label.setAttribute?.('for', optionId);
    input.setAttribute?.('id', optionId);
    input.setAttribute?.('type', mode === 'single' ? 'radio' : 'checkbox');
    input.setAttribute?.('value', value);
    if (option.disabled) input.setAttribute?.('data-cc-dropdown-option-disabled', 'true');
    if (option.getAttribute?.('data-dialog-submitted-value') !== null) {
      input.setAttribute?.('data-dialog-submitted-value', '');
    }
    span.textContent = option.textContent || value;
    label.appendChild?.(input);
    label.appendChild?.(span);
    wrapper.appendChild?.(label);
    targetContainer.appendChild?.(wrapper);
    existingValues.add(value);
  });
}

function syncCreatorCrateDropdownInputsFromNative(dropdown) {
  const nativeSelect = creatorCrateDropdownNativeSelect(dropdown);
  const mode = creatorCrateDropdownMode(dropdown);
  if (!nativeSelect || !mode) return;

  const selectedValues = mode === 'multiple'
    ? new Set(creatorCrateDropdownNativeOptions(nativeSelect)
      .filter((option) => option.selected)
      .map((option) => String(option.value)))
    : new Set([String(nativeSelect.value ?? '')]);
  creatorCrateDropdownInputs(dropdown, mode).forEach((input) => {
    input.checked = selectedValues.has(String(input.value ?? ''));
  });
}

export function syncCreatorCrateDropdownDisabledState(dropdown) {
  const mode = creatorCrateDropdownMode(dropdown);
  if (!mode) return;
  const disabled = creatorCrateDropdownIsDisabled(dropdown);
  creatorCrateDropdownInputs(dropdown, mode).forEach((input) => {
    const optionDisabled = input.getAttribute?.('data-cc-dropdown-option-disabled') === 'true';
    input.disabled = disabled || optionDisabled;
  });
  const searchInput = creatorCrateDropdownSearchInput(dropdown);
  if (searchInput) {
    searchInput.disabled = disabled;
    if (disabled) searchInput.setAttribute?.('disabled', '');
    else searchInput.removeAttribute?.('disabled');
  }
  const summary = dropdown.querySelector?.('summary');
  if (summary) {
    summary.disabled = disabled;
    summary.tabIndex = disabled ? -1 : 0;
    if (disabled) summary.setAttribute?.('aria-disabled', 'true');
    else summary.removeAttribute?.('aria-disabled');
  }
  if (disabled) dropdown.setAttribute?.('data-cc-dropdown-disabled', '');
  else dropdown.removeAttribute?.('data-cc-dropdown-disabled');
}

function syncCreatorCrateDropdownNativeFromInputs(dropdown) {
  const nativeSelect = creatorCrateDropdownNativeSelect(dropdown);
  const mode = creatorCrateDropdownMode(dropdown);
  if (!nativeSelect || !mode) return;

  const inputs = creatorCrateDropdownInputs(dropdown, mode);
  if (mode === 'single') {
    nativeSelect.value = inputs.find((input) => input.checked)?.value ?? '';
    return;
  }

  const selectedValues = new Set(
    inputs.filter((input) => input.checked).map((input) => String(input.value ?? '')),
  );
  creatorCrateDropdownNativeOptions(nativeSelect).forEach((option) => {
    option.selected = selectedValues.has(String(option.value ?? ''));
  });
}

function creatorCrateDropdownDispatchesNativeChange(dropdown) {
  return dropdown?.dataset?.ccDropdownDispatchNativeChange !== undefined
    || dropdown?.hasAttribute?.('data-cc-dropdown-dispatch-native-change');
}

function dispatchCreatorCrateDropdownNativeChange(nativeSelect) {
  if (!nativeSelect?.dispatchEvent) return;
  const document = nativeSelect.ownerDocument;
  const EventConstructor = document?.defaultView?.Event || globalThis.Event;
  if (typeof EventConstructor !== 'function') return;
  nativeSelect.dispatchEvent(new EventConstructor('change', { bubbles: true }));
}

export function syncCreatorCrateDropdownFromNative(nativeSelect) {
  const dropdown = creatorCrateDropdownForNativeSelect(nativeSelect);
  if (!dropdown) return;
  syncCreatorCrateDropdownOptionsFromNative(dropdown);
  syncCreatorCrateDropdownInputsFromNative(dropdown);
  syncCreatorCrateDropdownDisabledState(dropdown);
  updateCreatorCrateDropdownSummary(dropdown);
  updateCreatorCrateDropdownSearch(dropdown);
}

function updateCreatorCrateDropdownSummary(dropdown) {
  const mode = creatorCrateDropdownMode(dropdown);
  const currentSummary = dropdown?.querySelector?.(CC_DROPDOWN_CURRENT_SUMMARY_SELECTOR)
    || dropdown?.querySelector?.(ASSET_VIEWER_FILTER_SINGLE_SELECT_SUMMARY_SELECTOR);
  const summary = dropdown?.querySelector?.('summary');
  if (!mode || !currentSummary || !summary) return;

  let summaryText;
  if (mode === 'single') {
    const selectedInput = dropdown.querySelector?.('input[type="radio"]:checked');
    summaryText = assetViewerFilterSingleSelectLabel(selectedInput);
    if (!selectedInput || summaryText === '') return;
  } else if (mode === 'multiple') {
    const selectedInputs = creatorCrateDropdownInputs(dropdown, mode).filter((input) => input.checked);
    const emptySummary = dropdown.dataset?.ccDropdownEmptySummary
      ?? dropdown.getAttribute?.('data-cc-dropdown-empty-summary')
      ?? 'None selected';
    const countLabel = dropdown.dataset?.ccDropdownCountLabel
      ?? dropdown.getAttribute?.('data-cc-dropdown-count-label')
      ?? 'items';
    if (selectedInputs.length === 0) {
      summaryText = emptySummary;
    } else if (selectedInputs.length === 1) {
      summaryText = assetViewerFilterMultiSelectLabel(selectedInputs[0])
        || `1 ${countLabel.replace(/s$/, '')} selected`;
    } else {
      summaryText = `${selectedInputs.length} ${countLabel} selected`;
    }
  } else {
    return;
  }

  currentSummary.textContent = summaryText;
  summary.setAttribute?.('title', summaryText);
  const ariaLabel = summary.getAttribute?.('aria-label');
  if (typeof ariaLabel !== 'string' || ariaLabel === '') return;

  const separator = ariaLabel.indexOf(':');
  summary.setAttribute(
    'aria-label',
    separator >= 0 ? `${ariaLabel.slice(0, separator + 1)} ${summaryText}` : summaryText,
  );
}

export function initializeCreatorCrateDropdown(dropdown) {
  const nativeSelect = creatorCrateDropdownNativeSelect(dropdown);
  if (nativeSelect) {
    dropdown.removeAttribute?.('hidden');
    nativeSelect.hidden = true;
    nativeSelect.setAttribute?.('hidden', '');
    syncCreatorCrateDropdownOptionsFromNative(dropdown);
    syncCreatorCrateDropdownInputsFromNative(dropdown);
  }
  syncCreatorCrateDropdownDisabledState(dropdown);
  updateAssetViewerFilterDisclosureState(dropdown);
  updateCreatorCrateDropdownSummary(dropdown);
  updateCreatorCrateDropdownSearch(dropdown);
}

function handleCreatorCrateDropdownChange(dropdown, event) {
  const mode = creatorCrateDropdownMode(dropdown);
  const nativeSelect = creatorCrateDropdownNativeSelect(dropdown);
  if (!mode) return;

  if (event.target === nativeSelect) {
    syncCreatorCrateDropdownFromNative(nativeSelect);
    return;
  }

  if (mode === 'single' && event.target?.type === 'radio') {
    creatorCrateDropdownInputs(dropdown, mode).forEach((input) => {
      input.checked = input === event.target;
    });
    syncCreatorCrateDropdownNativeFromInputs(dropdown);
    if (creatorCrateDropdownDispatchesNativeChange(dropdown)) {
      dispatchCreatorCrateDropdownNativeChange(nativeSelect);
    }
    const form = nativeSelect?.form || dropdown.closest?.('form');
    if (form?.matches?.(ASSET_SELECTION_FORM_SELECTOR)) {
      updateAssetSelectionState(form, liveRegionDocument(dropdown) || form);
    }
    updateCreatorCrateDropdownSummary(dropdown);
    dropdown.open = false;
    dropdown.removeAttribute?.('open');
    syncCreatorCrateDropdownDisabledState(dropdown);
    updateAssetViewerFilterDisclosureState(dropdown);
    dropdown.querySelector?.('summary')?.focus?.({ preventScroll: true });
    restoreDialogBodyScroll(dropdown);
  } else if (mode === 'multiple' && event.target?.type === 'checkbox') {
    syncCreatorCrateDropdownNativeFromInputs(dropdown);
    if (creatorCrateDropdownDispatchesNativeChange(dropdown)) {
      dispatchCreatorCrateDropdownNativeChange(nativeSelect);
    }
    syncCreatorCrateDropdownDisabledState(dropdown);
    updateCreatorCrateDropdownSummary(dropdown);
  }
}

function getAssetDisclosures(scope, selector) {
  return Array.from(scope?.querySelectorAll?.(selector) || []);
}

function findAssetDisclosure(disclosures, selector, target) {
  const disclosure = target?.closest?.(selector);
  return disclosures.includes(disclosure) ? disclosure : null;
}

function closeAssetDisclosures(disclosures, except = null) {
  disclosures.forEach((disclosure) => {
    if (disclosure === except || disclosure.open !== true) return;
    disclosure.open = false;
    disclosure.removeAttribute?.('open');
    updateAssetViewerFilterDisclosureState(disclosure);
  });
}

function enhanceAssetDisclosures(scope, {
  selector,
  boundKey,
  initialize,
  onChange,
} = {}) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const disclosures = getAssetDisclosures(scope, selector);
  disclosures.forEach((disclosure) => initialize?.(disclosure));
  if (disclosures.length === 0) return 0;

  if (!isEnhancementBound(scope, boundKey)) {
    markEnhancementBound(scope, boundKey);

    scope.addEventListener?.('click', (event) => {
      const currentDisclosures = getAssetDisclosures(scope, selector);
      const current = findAssetDisclosure(currentDisclosures, selector, event.target);
      if (current && creatorCrateDropdownIsDisabled(current)) {
        event.preventDefault?.();
        current.open = false;
        current.removeAttribute?.('open');
        updateAssetViewerFilterDisclosureState(current);
        return;
      }
      closeAssetDisclosures(currentDisclosures, current);
    });

    scope.addEventListener?.('change', (event) => {
      const currentDisclosures = getAssetDisclosures(scope, selector);
      const disclosure = findAssetDisclosure(currentDisclosures, selector, event.target);
      if (!disclosure) return;
      onChange?.(disclosure, event);
    }, true);

    scope.addEventListener?.('input', (event) => {
      const currentDisclosures = getAssetDisclosures(scope, selector);
      const disclosure = findAssetDisclosure(currentDisclosures, selector, event.target);
      if (!disclosure || !creatorCrateDropdownIsSearchable(disclosure)) return;
      if (event.target !== creatorCrateDropdownSearchInput(disclosure)) return;
      updateCreatorCrateDropdownSearch(disclosure);
    });

    scope.addEventListener?.('keydown', (event) => {
      const currentDisclosures = getAssetDisclosures(scope, selector);
      const targetDisclosure = findAssetDisclosure(currentDisclosures, selector, event.target);
      if (event.key === 'Enter'
        && !event.isComposing
        && targetDisclosure
        && creatorCrateDropdownIsSearchable(targetDisclosure)
        && event.target === creatorCrateDropdownSearchInput(targetDisclosure)) {
        event.preventDefault?.();
        return;
      }
      if (event.key !== 'Escape') return;

      const active = targetDisclosure?.open === true
        ? targetDisclosure
        : currentDisclosures.find((disclosure) => disclosure.open === true);
      if (!active) return;

      event.preventDefault?.();
      event.stopPropagation?.();
      active.open = false;
      active.removeAttribute?.('open');
      updateAssetViewerFilterDisclosureState(active);
      active.querySelector?.('summary')?.focus?.({ preventScroll: true });
      restoreDialogBodyScroll(active);
    }, true);

    scope.addEventListener?.('toggle', (event) => {
      const currentDisclosures = getAssetDisclosures(scope, selector);
      const disclosure = currentDisclosures.includes(event.target) ? event.target : null;
      if (!disclosure) return;

      updateAssetViewerFilterDisclosureState(disclosure);
      if (disclosure.open === true) {
        if (creatorCrateDropdownIsDisabled(disclosure)) {
          disclosure.open = false;
          disclosure.removeAttribute?.('open');
          updateAssetViewerFilterDisclosureState(disclosure);
          return;
        }
        disclosure.__creatorCrateDropdownScrollState = captureDialogBodyScroll(disclosure);
        closeAssetDisclosures(currentDisclosures, disclosure);
      } else {
        restoreDialogBodyScroll(disclosure);
      }
    }, true);
  }

  return disclosures.length;
}

export function enhanceAssetViewerFilterDisclosures(scope = globalThis.document) {
  return enhanceAssetDisclosures(scope, {
    selector: ASSET_VIEWER_FILTER_DISCLOSURE_SELECTOR,
    boundKey: 'assetViewerFilterDisclosuresBound',
    initialize: (disclosure) => {
      updateAssetViewerFilterDisclosureState(disclosure);
      updateAssetViewerFilterSingleSelectSummary(disclosure);
      updateAssetViewerFilterMultiSelectSummary(disclosure);
    },
    onChange: (disclosure, event) => {
      if (event.target?.type === 'radio') {
        updateAssetViewerFilterSingleSelectSummary(disclosure);
      } else if (event.target?.type === 'checkbox') {
        updateAssetViewerFilterMultiSelectSummary(disclosure);
      }
    },
  });
}

export function enhanceDropdowns(scope = globalThis.document) {
  return enhanceAssetDisclosures(scope, {
    selector: CC_DROPDOWN_SELECTOR,
    boundKey: 'creatorCrateDropdownsBound',
    initialize: initializeCreatorCrateDropdown,
    onChange: handleCreatorCrateDropdownChange,
  });
}

function getProjectAssetCategoryFilterInput(option) {
  return option?.querySelector?.('input[name="category"]') || null;
}

function updateProjectAssetCategoryFilter(filter, options, presenceControl, syncPresence = false) {
  let selectedOption = options.find((option) => getProjectAssetCategoryFilterInput(option)?.checked);
  let selectedInput = getProjectAssetCategoryFilterInput(selectedOption);
  const selectedPresence = selectedInput?.getAttribute?.('data-asset-category-presence') || 'all';

  const presenceControls = Array.isArray(presenceControl) ? presenceControl : [presenceControl];
  const selectedPresenceControl = presenceControls.find((control) => (
    control?.type === 'radio' ? control.checked : control?.value
  ));
  let effectivePresence = selectedPresenceControl?.type === 'radio'
    ? selectedPresenceControl.getAttribute?.('value') || selectedPresenceControl.value
    : selectedPresenceControl?.value;

  if (syncPresence && selectedPresence) {
    presenceControls.forEach((control) => {
      if (control?.type === 'radio') {
        control.checked = String(control.value || control.getAttribute?.('value') || '') === selectedPresence;
      } else {
        control.value = selectedPresence;
      }
    });
    effectivePresence = selectedPresence;
  } else if (effectivePresence === 'missing' && selectedPresence !== 'missing') {
    const missingInput = options
      .map(getProjectAssetCategoryFilterInput)
      .find((input) => input?.value === 'all'
        && input?.getAttribute?.('data-asset-category-presence') === 'missing');
    if (missingInput) missingInput.checked = true;
  } else if (effectivePresence !== 'missing' && selectedPresence === 'missing') {
    const allInput = options
      .map(getProjectAssetCategoryFilterInput)
      .find((input) => input?.value === 'all'
        && input?.getAttribute?.('data-asset-category-presence') === 'all');
    if (allInput) allInput.checked = true;
  }

  const dropdown = filter?.matches?.(CC_DROPDOWN_SELECTOR)
    ? filter
    : filter?.querySelector?.(CC_DROPDOWN_SELECTOR);
  updateCreatorCrateDropdownSummary(dropdown);
}

export function enhanceProjectAssetCategoryFilter(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const filters = scope.querySelectorAll(PROJECT_ASSET_CATEGORY_FILTER_SELECTOR);
  filters.forEach((filter) => {
    const options = Array.from(filter.querySelectorAll?.('.asset-filter-multiselect-option') || [])
      .filter((option) => getProjectAssetCategoryFilterInput(option));
    const form = filter.closest?.('form');
    const presenceControl = typeof form?.querySelectorAll === 'function'
      ? [
        ...Array.from(form.querySelectorAll('select[name="presence"]')),
        ...Array.from(form.querySelectorAll('input[name="presence"]')),
      ]
      : [form?.querySelector?.('select[name="presence"]') || form?.querySelector?.('input[name="presence"]')]
        .filter(Boolean);

    if (!isEnhancementBound(filter, 'projectAssetCategoryFilterBound')) {
      markEnhancementBound(filter, 'projectAssetCategoryFilterBound');
      options.forEach((option) => {
        getProjectAssetCategoryFilterInput(option)?.addEventListener?.('change', () => {
          updateProjectAssetCategoryFilter(filter, options, presenceControl, true);
        });
      });
      presenceControl.forEach((control) => control.addEventListener?.('change', () => {
        updateProjectAssetCategoryFilter(filter, options, presenceControl);
      }));
    }

    updateProjectAssetCategoryFilter(filter, options, presenceControl);
  });

  return filters.length;
}
