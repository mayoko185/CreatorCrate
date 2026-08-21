import {
  enhancePreview,
  enhancePreviewMedia,
  enhanceProjectCards,
  markPreviewFailed,
  markPreviewLoaded,
} from './client/preview.js';
import {
  enhanceAssetAutoRenameOrdering,
  enhanceAssetRenames,
  enhanceAssetSelection,
} from './client/asset-ordering.js';
import { enhanceCategoryReorder } from './client/category-reorder.js';
import {
  enhanceBookContentReorder,
  enhanceBookReorder,
  enhanceChapterPageReorder,
  enhanceDashboardDefaultsDialog,
} from './client/dedicated-reorder.js';
import { enhanceCategoryDetails } from './client/category-details.js';
import {
  enhanceNotesCodeBlocks,
  enhanceNotesEditor,
} from './client/notes-editor.js';
import { enhanceNotesAssetPicker } from './client/notes-asset-picker.js';
import {
  enhanceAssetViewerInfoCards,
  enhanceProjectInfoCards,
} from './client/info-cards.js';
import {
  enhanceDatePickers,
  enhanceTimePickers,
} from './client/pickers.js';
import { enhanceNumberInputs } from './client/number-input.js';
import {
  enhanceAssetViewerFilterDisclosures,
  enhanceDropdowns,
  enhanceProjectAssetCategoryFilter,
  syncCreatorCrateDropdownFromNative,
} from './client/dropdowns.js';

import {
  enhanceAssetGridSize,
  enhanceAssetListSize,
  enhanceProjectGridSize,
} from './client/size-preferences.js';
import {
  closeAppDialogById,
  enhanceAppDialogs,
  enhanceAutoSubmit,
  enhanceProjectAssetCategoryManagement,
  openAppDialogById,
} from './client/app-dialogs.js';
import {
  enhanceAppConfirmationControls,
  requestAppConfirmation,
} from './client/confirm-dialog.js';
import {
  enhanceProjectAssetsPreviewSlideshow,
  enhanceSlideshow,
} from './client/slideshow.js';

import {
  createLiveRegionEngine,
  enhanceAssetLibraryLiveFiltering,
  enhanceProjectAssetsLiveFiltering,
  enhanceProjectsLiveFiltering,
  enhanceReleasesLiveFiltering,
  refreshProjectAssetsLiveRegion,
} from './client/live-regions.js';
export {
  enhanceAssetAutoRenameOrdering,
  enhanceAssetRenames,
  enhanceAssetSelection,
  enhanceNotesCodeBlocks,
  enhanceNotesEditor,
  enhanceNotesAssetPicker,
  enhanceAssetViewerInfoCards,
  enhanceProjectInfoCards,
  enhanceDatePickers,
  enhanceTimePickers,
  enhanceCategoryReorder,
  enhanceBookContentReorder,
  enhanceBookReorder,
  enhanceChapterPageReorder,
  enhanceDashboardDefaultsDialog,
  enhanceCategoryDetails,
  enhanceAppConfirmationControls as enhanceConfirmations,
  enhanceNumberInputs,
  enhanceAssetGridSize,
  enhanceAssetListSize,
  enhanceProjectGridSize,
  closeAppDialogById,
  enhanceAppConfirmationControls,
  enhanceAppDialogs,
  enhanceAutoSubmit,
  enhanceProjectAssetCategoryManagement,
  openAppDialogById,
  requestAppConfirmation,
  enhanceSlideshow,
  enhanceProjectAssetsPreviewSlideshow,
  syncCreatorCrateDropdownFromNative,
  enhanceAssetViewerFilterDisclosures,
  enhanceDropdowns,
  enhanceProjectAssetCategoryFilter,
  enhancePreview,
  enhancePreviewMedia,
  enhanceProjectCards,
  markPreviewFailed,
  markPreviewLoaded,
};

export {
  createLiveRegionEngine,
  enhanceAssetLibraryLiveFiltering,
  enhanceProjectAssetsLiveFiltering,
  enhanceProjectsLiveFiltering,
  enhanceReleasesLiveFiltering,
  refreshProjectAssetsLiveRegion,
};


if (typeof document !== 'undefined') {
  const run = () => {
    enhancePreviewMedia(document);
    enhanceNumberInputs(document);
    enhanceNotesCodeBlocks(document);
    enhanceProjectCards(document);
    enhanceAutoSubmit(document);
    enhanceCategoryReorder(document);
    enhanceBookReorder(document);
    enhanceChapterPageReorder(document);
    enhanceBookContentReorder(document);
    enhanceNotesEditor(document);
    enhanceNotesAssetPicker(document);
    enhanceAssetAutoRenameOrdering(document);
    enhanceCategoryDetails(document);
    enhanceAssetSelection(document);
    enhanceAssetRenames(document);
    enhanceAssetGridSize(document);
    enhanceAssetListSize(document);
    enhanceProjectGridSize(document);
    enhanceProjectAssetCategoryFilter(document);
    enhanceDropdowns(document);
    enhanceAssetViewerFilterDisclosures(document);
    enhanceAppDialogs(document);
    enhanceAppConfirmationControls(document);
    enhanceDashboardDefaultsDialog(document);
    enhanceProjectAssetCategoryManagement(document);
    enhanceProjectsLiveFiltering(document);
    enhanceReleasesLiveFiltering(document);
    enhanceProjectAssetsLiveFiltering(document);
    enhanceAssetLibraryLiveFiltering(document);
    enhanceAssetViewerInfoCards(document);
    enhanceProjectInfoCards(document);
    enhanceDatePickers(document);
    enhanceTimePickers(document);
    enhanceSlideshow(document);
    enhanceProjectAssetsPreviewSlideshow(document);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}
