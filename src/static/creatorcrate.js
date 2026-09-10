import { enhanceProjectOptionColorPickers } from './client/project-option-color-picker.js';
import { enhanceProjectOptionMutations } from './client/settings-project-option-mutations.js';
import { enhanceProjectOptionReorder } from './client/settings-project-option-reorder.js';
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
  directorySlugFromDisplayName,
  enhanceCategorySlugAutofill,
} from './client/category-slug-autofill.js';
import {
  enhanceBookContentReorder,
  enhanceBookHierarchyReorder,
  enhanceBookReorder,
  enhanceChapterPageReorder,
  enhanceDashboardDefaultsDialog,
} from './client/dedicated-reorder.js';
import { enhanceCategoryDetails } from './client/category-details.js';
import { enhanceDefaultsFetchSave } from './client/settings-defaults-fetch-save.js';
import { enhanceAssetCategoryPreferencesFetchSave } from './client/settings-asset-category-preferences-fetch-save.js';
import { enhanceNsfwFilterFetchSave } from './client/settings-nsfw-filter-fetch-save.js';
import { enhanceSocialPrepFetchSave } from './client/settings-social-prep-fetch-save.js';
import { enhanceOpenLocallyFetchSave } from './client/settings-open-locally-fetch-save.js';
import { enhanceSettingsFetchSave } from './client/settings-fetch-save.js';
import { enhanceProjectsDefaultsFetchSave } from './client/projects-defaults-fetch-save.js';
import {
  enhanceNotesCodeBlocks,
  enhanceNotesEditor,
} from './client/notes-editor.js';
import { enhanceNotesAssetPicker } from './client/notes-asset-picker.js';
import { enhanceNoteConnections } from './client/note-connections.js';
import {
  enhanceNoteDialogUnsavedChanges,
  noteDialogIsDirty,
} from './client/note-dialog-dirty.js';
import { enhanceBookCoverUploads } from './client/book-cover-upload.js';
import {
  enhanceAssetViewerInfoCards,
  enhanceProjectInfoCards,
} from './client/info-cards.js';
import {
  enhanceDatePickers,
  enhanceTimePickers,
} from './client/pickers.js';
import { enhanceNumberInputs } from './client/number-input.js';
import { enhanceProjectAssetsDefaultsScope } from './client/project-assets-defaults-scope.js';
import {
  AUTO_REFRESH_INTERVAL_MS,
  enhanceLogViewerAutoRefresh,
  formatLogTimestamp,
} from './client/log-viewer.js';
import {
  enhanceAssetViewerFilterDisclosures,
  enhanceDropdowns,
  enhanceProjectAssetCategoryFilter,
  syncCreatorCrateDropdownFromNative,
} from './client/dropdowns.js';

import {
  enhanceAssetGridDetails,
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
  beginProjectsDefaultsLiveRefresh,
  createLiveRegionEngine,
  enhanceAssetLibraryLiveFiltering,
  enhanceProjectAssetsLiveFiltering,
  enhanceReleaseAssetsLiveFiltering,
  enhanceProjectsLiveFiltering,
  enhanceReleasesLiveFiltering,
  refreshProjectsLiveRegion,
  refreshProjectAssetsLiveRegion,
} from './client/live-regions.js';
export {
  enhanceAssetAutoRenameOrdering,
  enhanceAssetRenames,
  enhanceAssetSelection,
  enhanceNotesCodeBlocks,
  enhanceNotesEditor,
  enhanceNotesAssetPicker,
  enhanceNoteDialogUnsavedChanges,
  noteDialogIsDirty,
  enhanceAssetViewerInfoCards,
  enhanceProjectInfoCards,
  enhanceDatePickers,
  enhanceTimePickers,
  enhanceCategoryReorder,
  directorySlugFromDisplayName,
  enhanceCategorySlugAutofill,
  enhanceBookContentReorder,
  enhanceBookHierarchyReorder,
  enhanceBookReorder,
  enhanceChapterPageReorder,
  enhanceDashboardDefaultsDialog,
  enhanceCategoryDetails,
  enhanceProjectOptionMutations,
  enhanceProjectOptionReorder,
  enhanceProjectOptionColorPickers,
  enhanceDefaultsFetchSave,
  enhanceAssetCategoryPreferencesFetchSave,
  enhanceNsfwFilterFetchSave,
  enhanceSocialPrepFetchSave,
  enhanceOpenLocallyFetchSave,
  enhanceSettingsFetchSave,
  enhanceProjectsDefaultsFetchSave,
  enhanceAppConfirmationControls as enhanceConfirmations,
  enhanceNumberInputs,
  enhanceProjectAssetsDefaultsScope,
  AUTO_REFRESH_INTERVAL_MS,
  enhanceLogViewerAutoRefresh,
  formatLogTimestamp,
  enhanceAssetGridDetails,
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
  beginProjectsDefaultsLiveRefresh,
  createLiveRegionEngine,
  enhanceAssetLibraryLiveFiltering,
  enhanceProjectAssetsLiveFiltering,
  enhanceReleaseAssetsLiveFiltering,
  enhanceProjectsLiveFiltering,
  enhanceReleasesLiveFiltering,
  refreshProjectsLiveRegion,
  refreshProjectAssetsLiveRegion,
};


if (typeof document !== 'undefined') {
  const run = () => {
    enhancePreviewMedia(document);
    enhanceNumberInputs(document);
    enhanceNotesCodeBlocks(document);
    enhanceProjectCards(document);
    enhanceAutoSubmit(document);
    enhanceProjectOptionMutations(document);
    enhanceProjectOptionReorder(document);
    enhanceProjectOptionColorPickers(document);
    enhanceDefaultsFetchSave(document);
    enhanceAssetCategoryPreferencesFetchSave(document);
    enhanceNsfwFilterFetchSave(document);
    enhanceSocialPrepFetchSave(document);
    enhanceOpenLocallyFetchSave(document);
    enhanceCategoryReorder(document);
    enhanceCategorySlugAutofill(document);
    enhanceBookReorder(document);
    enhanceChapterPageReorder(document);
    enhanceBookContentReorder(document);
    enhanceNotesEditor(document);
    enhanceNoteConnections(document);
    enhanceAssetAutoRenameOrdering(document);
    enhanceCategoryDetails(document);
    enhanceAssetSelection(document);
    enhanceAssetRenames(document);
    enhanceAssetGridSize(document);
    enhanceAssetGridDetails(document);
    enhanceAssetListSize(document);
    enhanceProjectGridSize(document);
    enhanceProjectAssetCategoryFilter(document);
    enhanceDropdowns(document);
    enhanceProjectsDefaultsFetchSave(document);
    enhanceProjectAssetsDefaultsScope(document);
    enhanceAppDialogs(document);
    enhanceNoteDialogUnsavedChanges(document);
    enhanceBookHierarchyReorder(document);
    enhanceLogViewerAutoRefresh(document);
    enhanceAssetViewerFilterDisclosures(document);
    enhanceAppConfirmationControls(document);
    enhanceBookCoverUploads(document);
    enhanceDashboardDefaultsDialog(document);
    enhanceProjectAssetCategoryManagement(document);
    enhanceProjectsLiveFiltering(document);
    enhanceReleasesLiveFiltering(document);
    enhanceReleaseAssetsLiveFiltering(document);
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
