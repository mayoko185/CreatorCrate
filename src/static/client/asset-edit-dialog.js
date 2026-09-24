import { isEnhancementBound, markEnhancementBound } from './dom.js';
import {
  initializeCreatorCrateDropdown,
  syncCreatorCrateDropdownFromNative,
  updateAssetViewerFilterDisclosureState,
} from './dropdowns.js';

export function enhanceAssetEditDialog(scope = globalThis.document) {
  const dialog = scope?.getElementById?.('asset-edit-dialog');
  const state = dialog?.__creatorCrateAppDialogState;
  if (!state || isEnhancementBound(dialog, 'assetEditResetBound')) return;
  markEnhancementBound(dialog, 'assetEditResetBound');

  const previousOnClose = state.onClose;
  state.onClose = (...args) => {
    dialog.querySelectorAll('form').forEach((form) => form.reset());

    const filename = dialog.querySelector('#rename-filename');
    if (filename) filename.value = filename.getAttribute('data-confirmed-value') ?? filename.defaultValue;

    const destination = dialog.querySelector('#move-destination');
    if (destination) destination.value = destination.getAttribute('data-confirmed-value') ?? destination.value;

    const tags = dialog.querySelector('#asset-tags-form');
    if (tags) {
      const confirmed = new Set((dialog.querySelector('#asset-edit-form')?.getAttribute('data-confirmed-tag-ids') || '')
        .split(',').filter(Boolean));
      tags.querySelectorAll('input[type="checkbox"]').forEach((option) => {
        option.checked = confirmed.has(option.value);
      });
      initializeCreatorCrateDropdown(tags);
    }

    dialog.querySelectorAll('select').forEach(syncCreatorCrateDropdownFromNative);
    dialog.querySelectorAll('details').forEach((details) => {
      details.open = false;
      updateAssetViewerFilterDisclosureState(details);
    });
    previousOnClose?.(...args);
  };
}
