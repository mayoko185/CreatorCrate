import express from 'express';
import { AssetPickerCursorError } from '../data/asset-picker-pagination.js';
import { NoteNotFoundError, NoteValidationError } from '../services/note-service.js';
import { buildAssetViewerUrl } from '../services/asset-presentation.js';

const NOTE_EXCERPT_MAX_LENGTH = 160;

const NOTICES = {
  note_reordered: { variant: 'success', text: 'Note order updated.' },
  note_reorder_invalid: {
    variant: 'error',
    text: 'The submitted note order is invalid. Submit every note exactly once.',
  },
  note_reorder_failed: { variant: 'error', text: 'Could not update the note order. No changes were made.' },
};

function resolveNotice(code) {
  return Object.prototype.hasOwnProperty.call(NOTICES, code) ? NOTICES[code] : null;
}

export function createNotesRouter({ appName, noteService, markdownRenderer, projectService, assetRepository } = {}) {
  if (!noteService || typeof noteService.listNotes !== 'function') {
    throw new Error('createNotesRouter requires a noteService dependency.');
  }
  if (!projectService || typeof projectService.list !== 'function' || typeof projectService.findById !== 'function') {
    throw new Error('createNotesRouter requires a projectService dependency.');
  }
  if (!projectService.repository || typeof projectService.repository.searchAssetPickerProjects !== 'function') {
    throw new Error('createNotesRouter requires a projectService repository with asset-picker search support.');
  }
  if (!assetRepository || typeof assetRepository.findAssetsForNoteAssociation !== 'function') {
    throw new Error('createNotesRouter requires an assetRepository dependency.');
  }
  if (!markdownRenderer || typeof markdownRenderer.renderMarkdown !== 'function') {
    throw new Error('createNotesRouter requires a markdownRenderer dependency.');
  }

  const router = express.Router();
  const projectRepository = projectService.repository;

  // GET /notes — ordered Notes index
  router.get('/', (req, res, next) => {
    try {
      renderNotesIndex(res, {
        appName,
        noteService,
        notice: resolveNotice(req.query.notice),
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /notes/reorder — persist the complete canonical Notes order.
  // Registered before the dynamic /:id routes so "reorder" cannot be parsed
  // as a note ID.
  router.post('/reorder', (req, res, next) => {
    try {
      const orderedIds = parseOrderedNoteIds(req.body?.orderedNoteIds);
      noteService.reorderNotes(orderedIds);
      return res.redirect('/notes?notice=note_reordered');
    } catch (err) {
      if (err instanceof NoteValidationError) {
        try {
          renderNotesIndex(res, {
            status: 422,
            appName,
            noteService,
            notice: resolveNotice('note_reorder_invalid'),
          });
          return;
        } catch (renderError) {
          return next(renderError);
        }
      }
      return res.redirect('/notes?notice=note_reorder_failed');
    }
  });

  // GET /notes/asset-picker/projects — bounded project search for the future
  // browser picker. Keep this before /:id so asset-picker is never a note ID.
  router.get('/asset-picker/projects', (req, res, next) => {
    try {
      const query = parseRequiredPickerQuery(req.query.q);
      const limit = parsePickerLimit(req.query.limit, { defaultValue: 20, max: 20 });
      const cursor = parsePickerCursor(req.query.cursor);
      const result = projectRepository.searchAssetPickerProjects({ query, limit, cursor });
      return res.json({
        items: result.rows.map(toPickerProject),
        nextCursor: result.nextCursor,
      });
    } catch (err) {
      return handlePickerError(err, res, next);
    }
  });

  // GET /notes/asset-picker/assets — bounded project-scoped asset search.
  router.get('/asset-picker/assets', (req, res, next) => {
    try {
      const projectId = parseCanonicalPositiveInteger(req.query.projectId, 'projectId');
      const query = parseOptionalPickerQuery(req.query.q);
      const limit = parsePickerLimit(req.query.limit, { defaultValue: 25, max: 25 });
      const cursor = parsePickerCursor(req.query.cursor);
      const project = projectService.findById(projectId);
      if (!project) {
        return res.status(404).json({ status: 'error', message: 'Project not found.' });
      }

      const result = assetRepository.searchAssetsForPicker({ projectId, query, limit, cursor });
      return res.json({
        project: toPickerProject(project),
        items: result.rows.map(toPickerAsset),
        nextCursor: result.nextCursor,
      });
    } catch (err) {
      return handlePickerError(err, res, next);
    }
  });

  // GET /notes/new — Create form
  router.get('/new', (_req, res, next) => {
    try {
      res.render('notes/form.njk', buildNoteFormModel({
        appName,
        note: null,
        values: emptyFormValues(),
        projects: listProjectOptions(projectService),
        selectedAssets: [],
        errors: {},
        action: 'Create',
        submitUrl: '/notes',
      }));
    } catch (err) {
      next(err);
    }
  });

  // POST /notes — Create a note with independent project and asset associations.
  router.post('/', (req, res, next) => {
    const body = req.body || {};

    try {
      const note = noteService.createNote(parseNoteInput(body));
      return res.redirect(`/notes/${note.id}`);
    } catch (err) {
      if (err instanceof NoteValidationError) {
        const values = buildFormValues(body);
        return res.status(422).render('notes/form.njk', buildNoteFormModel({
          appName,
          note: null,
          values,
          projects: listProjectOptions(projectService),
          selectedAssets: listSelectedAssetOptions(assetRepository, values.assetIds),
          errors: err.errors || { general: err.message },
          action: 'Create',
          submitUrl: '/notes',
        }));
      }
      return next(err);
    }
  });

  // GET /notes/:id — Note detail
  router.get('/:id', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    try {
      const note = noteService.getNote(id);
      const contentHtml = markdownRenderer.renderMarkdown(note.content);
      const projects = resolveAssociatedProjects(note, projectService);
      const assets = resolveAssociatedAssets(note, assetRepository);
      return res.render('notes/detail.njk', { appName, note, contentHtml, projects, assets });
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        return next(createNotFound());
      }
      return next(err);
    }
  });

  // GET /notes/:id/edit — Edit form
  router.get('/:id/edit', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    try {
      const note = noteService.getNote(id);
      const values = noteToFormValues(note);
      return res.render('notes/form.njk', buildNoteFormModel({
        appName,
        note,
        values,
        projects: listProjectOptions(projectService),
        selectedAssets: listSelectedAssetOptions(assetRepository, values.assetIds),
        errors: {},
        action: 'Edit',
        submitUrl: `/notes/${id}`,
      }));
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        return next(createNotFound());
      }
      return next(err);
    }
  });

  // POST /notes/:id — Update note fields and replace independent associations.
  router.post('/:id', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    const body = req.body || {};

    try {
      const note = noteService.updateNote(id, parseNoteInput(body));
      if (!note) {
        return next(createNotFound());
      }
      return res.redirect(`/notes/${note.id}`);
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof NoteValidationError) {
        try {
          const note = noteService.getNote(id);
          const values = buildFormValues(body);
          return res.status(422).render('notes/form.njk', buildNoteFormModel({
            appName,
            note,
            values,
            projects: listProjectOptions(projectService),
            selectedAssets: listSelectedAssetOptions(assetRepository, values.assetIds),
            errors: err.errors || { general: err.message },
            action: 'Edit',
            submitUrl: `/notes/${id}`,
          }));
        } catch (lookupError) {
          if (lookupError instanceof NoteNotFoundError) {
            return next(createNotFound());
          }
          return next(lookupError);
        }
      }
      return next(err);
    }
  });

  // POST /notes/:id/delete — Permanently delete a note.
  router.post('/:id/delete', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    try {
      noteService.deleteNote(id);
      return res.redirect('/notes');
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        return next(createNotFound());
      }
      return next(err);
    }
  });

  return router;
}

function buildNoteFormModel({ appName, note, values, projects, selectedAssets, errors, action, submitUrl }) {
  return {
    appName,
    note,
    values,
    projects,
    selectedAssets,
    selectedProjectIds: values.projectIds.map(String),
    selectedAssetIds: values.assetIds.map(String),
    errors,
    action,
    submitUrl,
  };
}

function parseNoteInput(body) {
  const input = {
    title: body.title,
    content: body.content,
    projectIds: normalizeProjectIds(body.projectIds),
  };

  if (Object.hasOwn(body, 'assetIds')) {
    input.assetIds = normalizeAssetIds(body.assetIds);
  }

  return input;
}

function emptyFormValues() {
  return { title: '', content: '', projectIds: [], assetIds: [] };
}

function buildFormValues(body) {
  return {
    title: body.title ?? '',
    content: body.content ?? '',
    projectIds: normalizeProjectIds(body.projectIds),
    assetIds: normalizeAssetIds(body.assetIds),
  };
}

function noteToFormValues(note) {
  return {
    title: note.title,
    content: note.content,
    projectIds: note.projectIds || [],
    assetIds: note.assetIds || [],
  };
}

function listProjectOptions(projectService) {
  const { rows } = projectService.list({
    includeArchived: true,
    sortBy: 'title',
    order: 'asc',
    limit: Number.MAX_SAFE_INTEGER,
  });

  return rows.map(toProjectOption);
}

function resolveAssociatedProjects(note, projectService) {
  return (note.projectIds || [])
    .map((projectId) => projectService.findById(projectId))
    .filter(Boolean)
    .map(toProjectOption);
}

function resolveAssociatedAssets(note, assetRepository) {
  return assetRepository
    .findAssetsForNoteAssociation(note.assetIds || [])
    .map((asset) => ({
      ...toAssetOption(asset),
      projectId: asset.project_id,
      projectTitle: asset.project_title,
    }));
}

function listSelectedAssetOptions(assetRepository, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];

  return assetRepository.findAssetsForNoteAssociation(ids).map((asset) => ({
    ...toAssetOption(asset),
    projectId: asset.project_id,
    projectTitle: asset.project_title,
    isProjectArchived: Boolean(asset.project_is_archived),
  }));
}

function toAssetOption(asset) {
  return {
    id: asset.id,
    filename: asset.filename,
    relativePath: asset.relative_path,
    isPresent: Boolean(asset.is_present),
    viewerUrl: buildAssetViewerUrl(asset.project_id, asset.id),
  };
}

function toProjectOption(project) {
  return { id: project.id, title: project.title };
}

class PickerRequestError extends Error {}

function parseRequiredPickerQuery(value) {
  const query = parseOptionalPickerQuery(value);
  if (query.length < 2) {
    throw new PickerRequestError('q must contain 2 to 100 characters.');
  }
  return query;
}

function parseOptionalPickerQuery(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw new PickerRequestError('q must be a string.');
  }

  const query = value.trim();
  if (query.length > 100) {
    throw new PickerRequestError('q must contain at most 100 characters.');
  }
  return query;
}

function parsePickerLimit(value, { defaultValue, max }) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new PickerRequestError(`limit must be an integer from 1 to ${max}.`);
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > max) {
    throw new PickerRequestError(`limit must be an integer from 1 to ${max}.`);
  }
  return limit;
}

function parsePickerCursor(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new PickerRequestError('cursor must be a string.');
  }
  return value;
}

function parseCanonicalPositiveInteger(value, fieldName) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new PickerRequestError(`${fieldName} must be a canonical positive integer.`);
  }

  const id = Number(value);
  if (!Number.isSafeInteger(id) || String(id) !== value) {
    throw new PickerRequestError(`${fieldName} must be a canonical positive integer.`);
  }
  return id;
}

function toPickerProject(project) {
  return {
    id: project.id,
    title: project.title,
    archived: Boolean(project.is_archived ?? (project.archived_at != null || project.status === 'archived')),
  };
}

function toPickerAsset(asset) {
  return {
    id: asset.id,
    filename: asset.filename,
    relativePath: asset.relative_path,
    isPresent: Boolean(asset.is_present),
  };
}

function handlePickerError(err, res, next) {
  if (err instanceof PickerRequestError) {
    return res.status(400).json({ status: 'error', message: err.message });
  }
  if (err instanceof AssetPickerCursorError) {
    return res.status(400).json({ status: 'error', message: 'Invalid cursor.' });
  }
  return next(err);
}

function normalizeProjectIds(raw) {
  const values = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]);
  return values.map(normalizeProjectId);
}

function normalizeAssetIds(raw) {
  const values = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]);
  return values
    .filter((value) => value !== '')
    .map(normalizeAssetId);
}

function normalizeProjectId(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return value;

  const id = Number(value);
  return Number.isSafeInteger(id) && String(id) === value ? id : value;
}

function normalizeAssetId(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return value;

  const id = Number(value);
  return Number.isSafeInteger(id) && String(id) === value ? id : value;
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== value) {
    return null;
  }
  return id;
}

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

function buildNoteListItem(note) {
  return {
    id: note.id,
    title: note.title || 'Untitled note',
    updatedAt: note.updated_at || null,
    excerpt: buildExcerpt(note.content),
  };
}

function renderNotesIndex(res, { appName, noteService, notice = null, status = 200 }) {
  const notes = noteService.listNotes().map(buildNoteListItem);
  res.status(status).render('notes/index.njk', { appName, notes, notice });
}

/**
 * Parse the batch reorder form contract: one `orderedNoteIds` field whose
 * value is a comma-separated list of canonical positive integer IDs. An empty
 * string represents the complete empty set; a missing or non-string field is
 * invalid. Completeness and membership remain service-owned validation.
 */
function parseOrderedNoteIds(raw) {
  if (raw === undefined || raw === null) {
    throw new NoteValidationError({
      orderedNoteIds: 'Submit the complete ordered note ID list.',
    });
  }
  if (Array.isArray(raw) || typeof raw !== 'string') {
    throw new NoteValidationError({
      orderedNoteIds: 'Note IDs must be submitted as one comma-separated value.',
    });
  }
  if (raw === '') return [];
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) {
    throw new NoteValidationError({
      orderedNoteIds: 'Note IDs must be canonical positive integers separated by commas.',
    });
  }

  const ids = raw.split(',').map((value) => Number(value));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new NoteValidationError({
      orderedNoteIds: 'Note IDs must be safe positive integers.',
    });
  }
  return ids;
}

function buildExcerpt(content) {
  const plainText = typeof content === 'string'
    ? content.replace(/\s+/g, ' ').trim()
    : '';

  if (plainText.length <= NOTE_EXCERPT_MAX_LENGTH) {
    return plainText;
  }

  return `${plainText
    .slice(0, NOTE_EXCERPT_MAX_LENGTH - 1)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd()}…`;
}
