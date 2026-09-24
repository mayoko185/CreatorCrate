import { enhanceProjectOptionColorPickers } from './client/project-option-color-picker.js';
import { enhanceProjectOptionMutations } from './client/settings-project-option-mutations.js';
import { enhanceProjectOptionReorder } from './client/settings-project-option-reorder.js';
import { enhanceReleaseSignatureManagers } from './client/release-signature-manager.js';
import { enhanceReleaseSignatures } from './client/release-signatures.js';
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
import {
  enhancePageDefaultsFetchSave,
  enhanceProjectAssetsDefaultsFetchSave,
  enhanceProjectsDefaultsFetchSave,
  enhanceReleasesDefaultsFetchSave,
} from './client/projects-defaults-fetch-save.js';
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
import { enhanceBookEditFetchSave } from './client/book-edit-fetch-save.js';
import { enhanceBookDefaultsFetchSave } from './client/book-defaults-fetch-save.js';
import { enhanceBookTransfer } from './client/book-transfer.js';
import { enhanceAssetEditDialog } from './client/asset-edit-dialog.js';
import {
  enhanceAssetViewerInfoCards,
  enhanceCalendarInfoCards,
  enhanceProjectInfoCards,
} from './client/info-cards.js';
import {
  enhanceDatePickers,
  enhanceTimePickers,
} from './client/pickers.js';
import { enhanceNumberInputs } from './client/number-input.js';
import { enhanceProjectAssetsDefaultsScope } from './client/project-assets-defaults-scope.js';
import { enhanceReleaseSocialPrepAutoLaunch } from './client/release-social-prep-auto-launch.js';
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
  beginAssetViewerDefaultsLiveRefresh,
  beginBookDetailDefaultsLiveRefresh,
  beginProjectAssetsDefaultsLiveRefresh,
  beginCalendarDefaultsLiveRefresh,
  beginProjectsDefaultsLiveRefresh,
  beginReleasesDefaultsLiveRefresh,
  createLiveRegionEngine,
  enhanceCalendarLiveFiltering,
  enhanceAssetLibraryLiveFiltering,
  enhanceProjectAssetsLiveFiltering,
  enhanceReleaseAssetsLiveFiltering,
  enhanceProjectsLiveFiltering,
  enhanceReleasesLiveFiltering,
  refreshAssetViewerLiveRegion,
  refreshCalendarLiveRegion,
  refreshBookDetailLiveRegion,
  refreshNotesBooksLiveRegion,
  refreshProjectAssetsDefaultsLiveRegion,
  refreshProjectsLiveRegion,
  refreshReleasesLiveRegion,
  refreshProjectAssetsLiveRegion,
} from './client/live-regions.js';
export {
  enhanceAssetAutoRenameOrdering,
  enhanceAssetEditDialog,
  enhanceAssetRenames,
  enhanceAssetSelection,
  enhanceNotesCodeBlocks,
  enhanceNotesEditor,
  enhanceNotesAssetPicker,
  enhanceNoteDialogUnsavedChanges,
  noteDialogIsDirty,
  enhanceAssetViewerInfoCards,
  enhanceCalendarInfoCards,
  enhanceProjectInfoCards,
  enhanceDatePickers,
  enhanceTimePickers,
  enhanceCategoryReorder,
  directorySlugFromDisplayName,
  enhanceCategorySlugAutofill,
  enhanceBookContentReorder,
  enhanceBookEditFetchSave,
  enhanceBookHierarchyReorder,
  enhanceBookReorder,
  enhanceBookDefaultsFetchSave,
  enhanceBookTransfer,
  enhanceChapterPageReorder,
  enhanceDashboardDefaultsDialog,
  enhanceCategoryDetails,
  enhanceProjectOptionMutations,
  enhanceProjectOptionReorder,
  enhanceReleaseSignatureManagers,
  enhanceReleaseSignatures,
  enhanceProjectOptionColorPickers,
  enhanceDefaultsFetchSave,
  enhanceAssetCategoryPreferencesFetchSave,
  enhanceNsfwFilterFetchSave,
  enhanceSocialPrepFetchSave,
  enhanceOpenLocallyFetchSave,
  enhanceSettingsFetchSave,
  enhanceProjectAssetsDefaultsFetchSave,
  enhanceProjectsDefaultsFetchSave,
  enhancePageDefaultsFetchSave,
  enhanceReleasesDefaultsFetchSave,
  enhanceAppConfirmationControls as enhanceConfirmations,
  enhanceNumberInputs,
  enhanceProjectAssetsDefaultsScope,
  enhanceReleaseSocialPrepAutoLaunch,
  AUTO_REFRESH_INTERVAL_MS,
  enhanceLogViewerAutoRefresh,
  formatLogTimestamp,
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
  beginAssetViewerDefaultsLiveRefresh,
  beginBookDetailDefaultsLiveRefresh,
  beginProjectAssetsDefaultsLiveRefresh,
  beginCalendarDefaultsLiveRefresh,
  beginProjectsDefaultsLiveRefresh,
  beginReleasesDefaultsLiveRefresh,
  createLiveRegionEngine,
  enhanceCalendarLiveFiltering,
  enhanceAssetLibraryLiveFiltering,
  enhanceProjectAssetsLiveFiltering,
  enhanceReleaseAssetsLiveFiltering,
  enhanceProjectsLiveFiltering,
  enhanceReleasesLiveFiltering,
  refreshAssetViewerLiveRegion,
  refreshCalendarLiveRegion,
  refreshBookDetailLiveRegion,
  refreshNotesBooksLiveRegion,
  refreshProjectAssetsDefaultsLiveRegion,
  refreshProjectsLiveRegion,
  refreshReleasesLiveRegion,
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
    enhanceReleaseSignatureManagers(document);
    enhanceProjectOptionColorPickers(document);
    enhanceDefaultsFetchSave(document);
    enhanceAssetCategoryPreferencesFetchSave(document);
    enhanceNsfwFilterFetchSave(document);
    enhanceSocialPrepFetchSave(document);
    enhanceOpenLocallyFetchSave(document);
    enhanceCategoryReorder(document);
    enhanceCategorySlugAutofill(document);
    enhanceBookReorder(document);
    enhanceBookEditFetchSave(document);
    enhanceBookDefaultsFetchSave(document);
    enhanceBookTransfer(document);
    enhanceChapterPageReorder(document);
    enhanceBookContentReorder(document);
    enhanceNotesEditor(document);
    enhanceNoteConnections(document);
    enhanceAssetAutoRenameOrdering(document);
    enhanceCategoryDetails(document);
    enhanceAssetSelection(document);
    enhanceAssetRenames(document);
    enhanceAssetGridSize(document);
    enhanceAssetListSize(document);
    enhanceProjectGridSize(document);
    enhanceProjectAssetCategoryFilter(document);
    enhanceDropdowns(document);
    enhanceReleaseSignatures(document);
    enhanceProjectsDefaultsFetchSave(document);
    enhanceReleasesDefaultsFetchSave(document);
    enhancePageDefaultsFetchSave(document, {
      formSelector: '#calendar-defaults-form',
      markerAttribute: 'data-calendar-defaults-fetch-save',
      beginRefresh: beginCalendarDefaultsLiveRefresh,
      refresh: refreshCalendarLiveRegion,
      refreshFailureMessage: 'Settings saved, but Calendar could not refresh. Refresh the page to see the saved defaults.',
    });
    enhancePageDefaultsFetchSave(document, {
      formSelector: '#asset-viewer-defaults-form',
      markerAttribute: 'data-asset-viewer-defaults-autosave',
      beginRefresh: beginAssetViewerDefaultsLiveRefresh,
      refresh: refreshAssetViewerLiveRegion,
      refreshFailureMessage: 'Settings saved, but Asset Viewer could not refresh. Refresh the page to see the saved defaults.',
    });
    enhanceProjectAssetsDefaultsScope(document);
    enhanceReleaseSocialPrepAutoLaunch(document);
    enhanceProjectAssetsDefaultsFetchSave(document);
    enhanceAppDialogs(document);
    enhanceAssetEditDialog(document);
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
    enhanceCalendarLiveFiltering(document);
    enhanceReleaseAssetsLiveFiltering(document);
    enhanceProjectAssetsLiveFiltering(document);
    enhanceAssetLibraryLiveFiltering(document);
    enhanceAssetViewerInfoCards(document);
    enhanceCalendarInfoCards(document);
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
