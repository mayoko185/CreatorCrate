/**
 * Project Detail "Related Notes" view model (WP3A).
 *
 * Composes the committed Notes read model (noteService.listRelatedNotesForProject)
 * with the shared asset presentation and the full Notes Page Markdown rendering
 * (WP6.1: the same renderMarkdown() and leading-title suppression the Notes Page
 * itself uses, so the expanded card shows the whole Page). It adds
 * no Note query and no association logic of its own: which Notes qualify, their
 * order, and which of this Project's Assets each one links are all taken from
 * the read model as returned.
 *
 * States:
 * - `ready`: at least one Note qualifies; the section renders its cards.
 * - `empty`: none qualifies; the section still renders (WP6.5), with its
 *   Create new note action and a "No related notes yet." empty state.
 * - `unavailable`: the read failed; the section shows an inline notice and the
 *   rest of Project Detail still renders. No error detail reaches the page.
 */

export function buildProjectRelatedNotesModel({
  projectId,
  noteService,
  markdownRenderer,
  workflowQueryService,
  isNsfwAsset = () => false,
  logError = null,
}) {
  try {
    const { notes } = noteService.listRelatedNotesForProject(projectId);
    if (!Array.isArray(notes) || notes.length === 0) {
      return { state: 'empty', notes: [] };
    }

    const assetsById = workflowQueryService.presentProjectRelatedNoteAssets(
      projectId,
      notes.flatMap((note) => note.assetIds ?? []),
    );

    return {
      state: 'ready',
      notes: notes.map((note) => presentNote(note, { assetsById, markdownRenderer, isNsfwAsset })),
    };
  } catch (error) {
    logError?.(error);
    return { state: 'unavailable', notes: [] };
  }
}

function presentNote(note, { assetsById, markdownRenderer, isNsfwAsset }) {
  const title = typeof note.title === 'string' && note.title.trim() !== '' ? note.title : 'Untitled page';
  const content = typeof note.content === 'string' ? note.content : '';
  const assetIds = Array.isArray(note.assetIds) ? note.assetIds : [];
  const assets = assetIds
    .map((assetId) => assetsById.get(assetId))
    .filter(Boolean)
    .map((asset) => ({ ...asset, nsfwBlur: Boolean(isNsfwAsset(asset)) }));
  // The complete Page, rendered and sanitized exactly as the Notes Page
  // renders it, with the leading heading that repeats the title suppressed.
  const contentHtml = content.trim() === ''
    ? ''
    : markdownRenderer.renderMarkdown(content, { suppressLeadingH1Matching: title });

  return {
    id: note.id,
    title,
    pageUrl: `/notes/${encodeURIComponent(String(note.id))}`,
    assets,
    contentHtml,
    updatedAt: note.updated_at ?? null,
    domIds: {
      card: `project-related-note-${note.id}`,
      title: `project-related-note-${note.id}-title`,
      preview: `project-related-note-${note.id}-preview`,
    },
  };
}
