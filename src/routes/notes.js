import express from 'express';
import { AssetPickerCursorError } from '../data/asset-picker-pagination.js';
import { NoteNotFoundError, NoteValidationError } from '../services/note-service.js';
import { BookNotEmptyError, BookNotFoundError, BookValidationError } from '../services/book-service.js';
import { ChapterNotFoundError, ChapterValidationError } from '../services/chapter-service.js';
import { buildAssetViewerUrl } from '../services/asset-presentation.js';

const NOTE_EXCERPT_MAX_LENGTH = 160;

const NOTICES = {
  book_reordered: { variant: 'success', text: 'Book order updated.' },
  book_reorder_invalid: {
    variant: 'error',
    text: 'The submitted book order is invalid. Submit every book exactly once.',
  },
  book_reorder_failed: { variant: 'error', text: 'Could not update the book order. No changes were made.' },
  note_reordered: { variant: 'success', text: 'Note order updated.' },
  note_reorder_invalid: {
    variant: 'error',
    text: 'The submitted note order is invalid. Submit every note exactly once.',
  },
  note_reorder_failed: { variant: 'error', text: 'Could not update the note order. No changes were made.' },
  chapter_reorder_invalid: {
    variant: 'error',
    text: 'The submitted chapter order is invalid. Submit every chapter exactly once.',
  },
  book_content_reorder_invalid: {
    variant: 'error',
    text: 'The submitted Book content order is invalid. Submit every Book content exactly once.',
  },
};

function resolveNotice(code) {
  return Object.prototype.hasOwnProperty.call(NOTICES, code) ? NOTICES[code] : null;
}

export function createNotesRouter({ appName, bookService, chapterService, noteService, markdownRenderer, projectService, assetRepository } = {}) {
  if (!bookService || typeof bookService.listBooks !== 'function') {
    throw new Error('createNotesRouter requires a bookService dependency.');
  }
  if (typeof bookService.listBookContents !== 'function') {
    throw new Error('createNotesRouter requires bookService.listBookContents support.');
  }
  if (!chapterService || typeof chapterService.listChapters !== 'function') {
    throw new Error('createNotesRouter requires a chapterService dependency.');
  }
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

  // GET /notes — ordered Books landing
  router.get('/', (req, res, next) => {
    try {
      renderBooksIndex(res, {
        appName,
        bookService,
        notice: resolveNotice(req.query.notice),
      });
    } catch (err) {
      next(err);
    }
  });

  // Book routes are registered before the legacy dynamic /:id Note routes.
  router.get('/books/new', (_req, res) => {
    res.render('notes/books/form.njk', buildBookFormModel({
      appName,
      book: null,
      values: { title: '' },
      errors: {},
      action: 'Create',
      submitUrl: '/notes/books',
    }));
  });

  router.post('/books', (req, res, next) => {
    const body = req.body || {};

    try {
      const book = bookService.createBook({ title: body.title });
      return res.redirect(`/notes/books/${book.id}`);
    } catch (err) {
      if (err instanceof BookValidationError) {
        return res.status(422).render('notes/books/form.njk', buildBookFormModel({
          appName,
          book: null,
          values: { title: body.title ?? '' },
          errors: err.errors || { general: err.message },
          action: 'Create',
          submitUrl: '/notes/books',
        }));
      }
      return next(err);
    }
  });

  // This literal route must precede POST /books/:bookId.
  router.post('/books/reorder', (req, res, next) => {
    try {
      const orderedIds = parseOrderedBookIds(req.body?.orderedBookIds);
      bookService.reorderBooks(orderedIds);
      return res.redirect('/notes?notice=book_reordered');
    } catch (err) {
      if (err instanceof BookValidationError) {
        try {
          renderBooksIndex(res, {
            status: 422,
            appName,
            bookService,
            notice: resolveNotice('book_reorder_invalid'),
          });
          return;
        } catch (renderError) {
          return next(renderError);
        }
      }
      return res.redirect('/notes?notice=book_reorder_failed');
    }
  });

  // This literal route must precede the dynamic /books/:bookId routes.
  router.get('/books/order', (_req, res, next) => {
    try {
      renderBooksOrder(res, { appName, bookService });
      return;
    } catch (err) {
      return next(err);
    }
  });

  router.get('/books/:bookId/edit', (req, res, next) => {
    const id = parseId(req.params.bookId);
    if (id === null) return next(createNotFound());

    try {
      const book = bookService.getBook(id);
      return res.render('notes/books/form.njk', buildBookFormModel({
        appName,
        book,
        values: { title: book.title },
        errors: {},
        action: 'Edit',
        submitUrl: `/notes/books/${id}`,
      }));
    } catch (err) {
      if (err instanceof BookNotFoundError) return next(createNotFound());
      if (err instanceof BookNotEmptyError) return next(err);
      return next(err);
    }
  });

  router.post('/books/:bookId', (req, res, next) => {
    const id = parseId(req.params.bookId);
    if (id === null) return next(createNotFound());
    const body = req.body || {};

    try {
      const book = bookService.updateBook(id, { title: body.title });
      return res.redirect(`/notes/books/${book.id}`);
    } catch (err) {
      if (err instanceof BookNotFoundError) return next(createNotFound());
      if (err instanceof BookValidationError) {
        try {
          const book = bookService.getBook(id);
          return res.status(422).render('notes/books/form.njk', buildBookFormModel({
            appName,
            book,
            values: { title: body.title ?? '' },
            errors: err.errors || { general: err.message },
            action: 'Edit',
            submitUrl: `/notes/books/${id}`,
          }));
        } catch (lookupError) {
          if (lookupError instanceof BookNotFoundError) return next(createNotFound());
          return next(lookupError);
        }
      }
      return next(err);
    }
  });

  router.post('/books/:bookId/delete', (req, res, next) => {
    const id = parseId(req.params.bookId);
    if (id === null) return next(createNotFound());

    try {
      bookService.deleteBook(id);
      return res.redirect('/notes');
    } catch (err) {
      if (err instanceof BookNotFoundError) return next(createNotFound());
      return next(err);
    }
  });

  router.get('/books/:bookId/chapters/new', (req, res, next) => {
    const bookId = parseId(req.params.bookId);
    if (bookId === null) return next(createNotFound());

    try {
      const book = bookService.getBook(bookId);
      return res.render('notes/chapters/form.njk', buildChapterFormModel({
        appName,
        book,
        chapter: null,
        values: { title: '' },
        errors: {},
        action: 'Create',
        submitUrl: `/notes/books/${bookId}/chapters`,
      }));
    } catch (err) {
      if (err instanceof BookNotFoundError) return next(createNotFound());
      return next(err);
    }
  });

  router.post('/books/:bookId/chapters', (req, res, next) => {
    const bookId = parseId(req.params.bookId);
    if (bookId === null) return next(createNotFound());
    const body = req.body || {};

    try {
      bookService.getBook(bookId);
      const chapter = chapterService.createChapter({ bookId, title: body.title });
      return res.redirect(`/notes/chapters/${chapter.id}`);
    } catch (err) {
      if (err instanceof BookNotFoundError) return next(createNotFound());
      if (err instanceof ChapterValidationError) {
        try {
          const book = bookService.getBook(bookId);
          return res.status(422).render('notes/chapters/form.njk', buildChapterFormModel({
            appName,
            book,
            chapter: null,
            values: { title: body.title ?? '' },
            errors: err.errors || { general: err.message },
            action: 'Create',
            submitUrl: `/notes/books/${bookId}/chapters`,
          }));
        } catch (lookupError) {
          if (lookupError instanceof BookNotFoundError) return next(createNotFound());
          return next(lookupError);
        }
      }
      return next(err);
    }
  });

  router.post('/books/:bookId/chapters/reorder', (req, res, next) => {
    const bookId = parseId(req.params.bookId);
    if (bookId === null) return next(createNotFound());

    try {
      const orderedIds = parseOrderedChapterIds(req.body?.orderedChapterIds);
      chapterService.reorderChapters(bookId, orderedIds);
      return res.redirect(`/notes/books/${bookId}`);
    } catch (err) {
      if (err instanceof BookNotFoundError) return next(createNotFound());
      if (err instanceof ChapterValidationError) {
        try {
          renderBookDetail(res, {
            status: 422,
            appName,
            bookService,
            chapterService,
            noteService,
            bookId,
            notice: resolveNotice('chapter_reorder_invalid'),
          });
          return;
        } catch (renderError) {
          if (renderError instanceof BookNotFoundError) return next(createNotFound());
          return next(renderError);
        }
      }
      return next(err);
    }
  });

  router.post('/books/:bookId/contents/reorder', (req, res, next) => {
    const bookId = parseId(req.params.bookId);
    if (bookId === null) return next(createNotFound());

    try {
      const orderedItems = parseOrderedBookItems(req.body?.orderedItems);
      bookService.reorderBookContents(bookId, orderedItems);
      return res.redirect(`/notes/books/${bookId}`);
    } catch (err) {
      if (err instanceof BookNotFoundError) return next(createNotFound());
      if (err instanceof BookValidationError) {
        try {
          renderBookDetail(res, {
            status: 422,
            appName,
            bookService,
            bookId,
            notice: resolveNotice('book_content_reorder_invalid'),
          });
          return;
        } catch (renderError) {
          if (renderError instanceof BookNotFoundError) return next(createNotFound());
          return next(renderError);
        }
      }
      return next(err);
    }
  });

  // GET /notes/books/:bookId/order — dedicated mixed Book-content ordering screen
  router.get('/books/:bookId/order', (req, res, next) => {
    const bookId = parseId(req.params.bookId);
    if (bookId === null) return next(createNotFound());

    try {
      renderBookOrder(res, {
        appName, bookService, bookId,
      });
      return;
    } catch (err) {
      if (err instanceof BookNotFoundError) return next(createNotFound());
      return next(err);
    }
  });

  router.get('/books/:bookId', (req, res, next) => {
    const id = parseId(req.params.bookId);
    if (id === null) return next(createNotFound());

    try {
      renderBookDetail(res, { appName, bookService, chapterService, noteService, bookId: id });
      return;
    } catch (err) {
      if (err instanceof BookNotFoundError) return next(createNotFound());
      return next(err);
    }
  });

  router.get('/chapters/:chapterId', (req, res, next) => {
    const chapterId = parseId(req.params.chapterId);
    if (chapterId === null) return next(createNotFound());

    try {
      renderChapterDetail(res, {
        appName, bookService, chapterService, noteService, chapterId,
      });
      return;
    } catch (err) {
      if (err instanceof ChapterNotFoundError || err instanceof BookNotFoundError) return next(createNotFound());
      return next(err);
    }
  });

  // GET /notes/chapters/:chapterId/notes/order — ordering screen shell
  router.get('/chapters/:chapterId/notes/order', (req, res, next) => {
    const chapterId = parseId(req.params.chapterId);
    if (chapterId === null) return next(createNotFound());

    try {
      renderChapterOrder(res, {
        appName, bookService, chapterService, noteService, chapterId,
      });
      return;
    } catch (err) {
      if (err instanceof ChapterNotFoundError || err instanceof BookNotFoundError) return next(createNotFound());
      return next(err);
    }
  });

  // Keep this literal hierarchy route before the dynamic /:id Note routes.
  router.post('/chapters/:chapterId/notes/reorder', (req, res, next) => {
    const chapterId = parseId(req.params.chapterId);
    if (chapterId === null) return next(createNotFound());

    try {
      const orderedIds = parseOrderedNoteIds(req.body?.orderedNoteIds);
      noteService.reorderNotes(chapterId, orderedIds);
      return res.redirect(`/notes/chapters/${chapterId}`);
    } catch (err) {
      if (err instanceof ChapterNotFoundError) return next(createNotFound());
      if (err instanceof NoteValidationError) {
        try {
          renderChapterDetail(res, {
            status: 422,
            appName,
            bookService,
            chapterService,
            noteService,
            chapterId,
            notice: resolveNotice('note_reorder_invalid'),
          });
          return;
        } catch (renderError) {
          if (renderError instanceof ChapterNotFoundError || renderError instanceof BookNotFoundError) {
            return next(createNotFound());
          }
          return next(renderError);
        }
      }
      return next(err);
    }
  });

  router.get('/chapters/:chapterId/edit', (req, res, next) => {
    const chapterId = parseId(req.params.chapterId);
    if (chapterId === null) return next(createNotFound());

    try {
      const chapter = chapterService.getChapter(chapterId);
      const book = bookService.getBook(chapter.book_id);
      return res.render('notes/chapters/form.njk', buildChapterFormModel({
        appName,
        book,
        chapter,
        values: { title: chapter.title },
        errors: {},
        action: 'Edit',
        submitUrl: `/notes/chapters/${chapterId}`,
      }));
    } catch (err) {
      if (err instanceof ChapterNotFoundError || err instanceof BookNotFoundError) return next(createNotFound());
      return next(err);
    }
  });

  router.post('/chapters/:chapterId', (req, res, next) => {
    const chapterId = parseId(req.params.chapterId);
    if (chapterId === null) return next(createNotFound());
    const body = req.body || {};

    try {
      const chapter = chapterService.updateChapter(chapterId, { title: body.title });
      return res.redirect(`/notes/chapters/${chapter.id}`);
    } catch (err) {
      if (err instanceof ChapterNotFoundError) return next(createNotFound());
      if (err instanceof ChapterValidationError) {
        try {
          const chapter = chapterService.getChapter(chapterId);
          const book = bookService.getBook(chapter.book_id);
          return res.status(422).render('notes/chapters/form.njk', buildChapterFormModel({
            appName,
            book,
            chapter,
            values: { title: body.title ?? '' },
            errors: err.errors || { general: err.message },
            action: 'Edit',
            submitUrl: `/notes/chapters/${chapterId}`,
          }));
        } catch (lookupError) {
          if (lookupError instanceof ChapterNotFoundError || lookupError instanceof BookNotFoundError) {
            return next(createNotFound());
          }
          return next(lookupError);
        }
      }
      return next(err);
    }
  });

  router.post('/chapters/:chapterId/delete', (req, res, next) => {
    const chapterId = parseId(req.params.chapterId);
    if (chapterId === null) return next(createNotFound());

    try {
      const chapter = chapterService.getChapter(chapterId);
      chapterService.deleteChapter(chapterId);
      return res.redirect(`/notes/books/${chapter.book_id}`);
    } catch (err) {
      if (err instanceof ChapterNotFoundError) return next(createNotFound());
      return next(err);
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

  // GET /notes/new?chapterId=:chapterId or ?bookId=:bookId — Create form
  router.get('/new', (req, res, next) => {
    const query = req.query || {};
    const hasChapterId = Object.hasOwn(query, 'chapterId');
    const hasBookId = Object.hasOwn(query, 'bookId');
    if (hasChapterId === hasBookId) return next(createNotFound());

    const chapterId = hasChapterId ? parseId(query.chapterId) : null;
    const bookId = hasBookId ? parseId(query.bookId) : null;
    if ((hasChapterId && chapterId === null) || (hasBookId && bookId === null)) {
      return next(createNotFound());
    }

    try {
      const chapter = hasChapterId ? chapterService.getChapter(chapterId) : null;
      const book = bookService.getBook(hasChapterId ? chapter.book_id : bookId);
      return res.render('notes/form.njk', buildNoteFormModel({
        appName,
        book,
        chapter,
        note: null,
        values: emptyFormValues({
          chapterId: hasChapterId ? chapterId : undefined,
          bookId: hasBookId ? bookId : undefined,
        }),
        projects: listProjectOptions(projectService),
        selectedAssets: [],
        errors: {},
        action: 'Create',
        submitUrl: '/notes',
      }));
    } catch (err) {
      if (err instanceof ChapterNotFoundError || err instanceof BookNotFoundError) {
        return next(createNotFound());
      }
      return next(err);
    }
  });

  // POST /notes — Create a note with independent project and asset associations.
  router.post('/', (req, res, next) => {
    const body = req.body || {};
    const hasChapterId = Object.hasOwn(body, 'chapterId');
    const hasBookId = Object.hasOwn(body, 'bookId');
    if (hasChapterId === hasBookId) return next(createNotFound());

    const chapterId = hasChapterId ? parseId(body.chapterId) : null;
    const bookId = hasBookId ? parseId(body.bookId) : null;
    if ((hasChapterId && chapterId === null) || (hasBookId && bookId === null)) {
      return next(createNotFound());
    }

    try {
      const note = noteService.createNote({
        ...(hasChapterId ? { chapterId } : { bookId }),
        ...parseNoteInput(body),
      });
      return res.redirect(`/notes/${note.id}`);
    } catch (err) {
      if (err instanceof ChapterNotFoundError || err instanceof BookNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof NoteValidationError) {
        try {
          const chapter = hasChapterId ? chapterService.getChapter(chapterId) : null;
          const book = hasChapterId
            ? bookService.getBook(chapter.book_id)
            : bookService.getBook(bookId);
          const values = buildFormValues(body, {
            chapterId: hasChapterId ? chapterId : undefined,
            bookId: hasBookId ? bookId : undefined,
          });
          return res.status(422).render('notes/form.njk', buildNoteFormModel({
            appName,
            book,
            chapter,
            note: null,
            values,
            projects: listProjectOptions(projectService),
            selectedAssets: listSelectedAssetOptions(assetRepository, values.assetIds),
            errors: err.errors || { general: err.message },
            action: 'Create',
            submitUrl: '/notes',
          }));
        } catch (lookupError) {
          if (lookupError instanceof ChapterNotFoundError || lookupError instanceof BookNotFoundError) {
            return next(createNotFound());
          }
          return next(lookupError);
        }
      }
      return next(err);
    }
  });

  // POST /notes/:id/move - move a Page to another Book or Chapter.
  // Registered before the dynamic Note routes.
  router.post('/:id/move', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    try {
      const target = parseMoveTarget(req.body || {});
      const moved = target.kind === 'chapter'
        ? noteService.moveNoteToChapter(id, target.id)
        : noteService.moveNote(id, { bookId: target.id });
      return res.redirect(moved.chapter_id === null
        ? `/notes/books/${moved.book_id}`
        : `/notes/chapters/${moved.chapter_id}`);
    } catch (err) {
      if (err instanceof NoteValidationError) {
        err.status = 422;
        return next(err);
      }
      if (err instanceof NoteNotFoundError
        || err instanceof ChapterNotFoundError
        || err instanceof BookNotFoundError) {
        return next(createNotFound());
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
      const { note, chapter, book } = loadNoteHierarchy({
        noteService, chapterService, bookService, id,
      });
      const contentHtml = markdownRenderer.renderMarkdown(note.content);
      const projects = resolveAssociatedProjects(note, projectService);
      const assets = resolveAssociatedAssets(note, assetRepository);
      const chapterOptions = listChapterOptions(bookService, chapterService);
      return res.render('notes/detail.njk', {
        appName, book, chapter, note, contentHtml, projects, assets, chapterOptions,
      });
    } catch (err) {
      if (err instanceof NoteNotFoundError || err instanceof ChapterNotFoundError || err instanceof BookNotFoundError) {
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
      const { note, chapter, book } = loadNoteHierarchy({
        noteService, chapterService, bookService, id,
      });
      const values = noteToFormValues(note);
      return res.render('notes/form.njk', buildNoteFormModel({
        appName,
        book,
        chapter,
        note,
        values,
        projects: listProjectOptions(projectService),
        selectedAssets: listSelectedAssetOptions(assetRepository, values.assetIds),
        errors: {},
        action: 'Edit',
        submitUrl: `/notes/${id}`,
        moveTargets: listChapterOptions(bookService, chapterService),
      }));
    } catch (err) {
      if (err instanceof NoteNotFoundError || err instanceof ChapterNotFoundError || err instanceof BookNotFoundError) {
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
    let hierarchy;

    try {
      hierarchy = loadNoteHierarchy({
        noteService, chapterService, bookService, id,
      });
      const note = noteService.updateNote(id, parseNoteInput(body));
      if (!note) {
        return next(createNotFound());
      }
      return res.redirect(`/notes/${note.id}`);
    } catch (err) {
      if (err instanceof NoteNotFoundError || err instanceof ChapterNotFoundError || err instanceof BookNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof NoteValidationError) {
        try {
          const { note, chapter, book } = hierarchy;
          const values = buildFormValues(body);
          return res.status(422).render('notes/form.njk', buildNoteFormModel({
            appName,
            book,
            chapter,
            note,
            values,
            projects: listProjectOptions(projectService),
            selectedAssets: listSelectedAssetOptions(assetRepository, values.assetIds),
            errors: err.errors || { general: err.message },
            action: 'Edit',
            submitUrl: `/notes/${id}`,
            moveTargets: listChapterOptions(bookService, chapterService),
          }));
        } catch (lookupError) {
          if (lookupError instanceof NoteNotFoundError || lookupError instanceof ChapterNotFoundError || lookupError instanceof BookNotFoundError) {
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
      const { note, chapter, book } = loadNoteHierarchy({
        noteService, chapterService, bookService, id,
      });
      noteService.deleteNote(id);
      return res.redirect(chapter ? `/notes/chapters/${chapter.id}` : `/notes/books/${book.id}`);
    } catch (err) {
      if (err instanceof NoteNotFoundError || err instanceof ChapterNotFoundError || err instanceof BookNotFoundError) {
        return next(createNotFound());
      }
      return next(err);
    }
  });

  return router;
}

function buildNoteFormModel({
  appName, book = null, chapter = null, note, values, projects, selectedAssets, errors, action, submitUrl,
  moveTargets = [],
}) {
  return {
    appName,
    book,
    chapter,
    note,
    values,
    projects,
    selectedAssets,
    selectedProjectIds: values.projectIds.map(String),
    selectedAssetIds: values.assetIds.map(String),
    errors,
    action,
    submitUrl,
    moveTargets,
  };
}

function buildBookFormModel({ appName, book, values, errors, action, submitUrl }) {
  return { appName, book, values, errors, action, submitUrl };
}

function buildChapterFormModel({ appName, book, chapter, values, errors, action, submitUrl }) {
  return { appName, book, chapter, values, errors, action, submitUrl };
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

function emptyFormValues({ chapterId = undefined, bookId = undefined } = {}) {
  return { title: '', content: '', projectIds: [], assetIds: [], chapterId, bookId };
}

function buildFormValues(body, { chapterId = undefined, bookId = undefined } = {}) {
  return {
    title: body.title ?? '',
    content: body.content ?? '',
    projectIds: normalizeProjectIds(body.projectIds),
    assetIds: normalizeAssetIds(body.assetIds),
    chapterId,
    bookId,
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

function loadNoteHierarchy({ noteService, chapterService, bookService, id }) {
  const note = noteService.getNote(id);
  const chapter = note.chapter_id === null ? null : chapterService.getChapter(note.chapter_id);
  const book = bookService.getBook(chapter ? chapter.book_id : note.book_id);
  return { note, chapter, book };
}

function listChapterOptions(bookService, chapterService) {
  return bookService.listBooks().map((book) => ({
    book,
    chapters: chapterService.listChapters(book.id),
  }));
}

function parseMoveTarget(body) {
  if (typeof body.targetContainer === 'string') {
    const match = /^(book|chapter):(.+)$/.exec(body.targetContainer);
    const id = match ? parseId(match[2]) : null;
    if (!match || id === null) {
      throw new NoteValidationError({
        targetContainer: 'targetContainer must identify a valid Book or Chapter.',
      });
    }
    return { kind: match[1], id };
  }

  if (Object.hasOwn(body, 'targetChapterId')) {
    const id = parseId(body.targetChapterId);
    if (id === null) {
      throw new NoteValidationError({
        targetChapterId: 'targetChapterId must be a canonical positive integer.',
      });
    }
    return { kind: 'chapter', id };
  }

  if (Object.hasOwn(body, 'targetBookId')) {
    const id = parseId(body.targetBookId);
    if (id === null) {
      throw new NoteValidationError({
        targetBookId: 'targetBookId must be a canonical positive integer.',
      });
    }
    return { kind: 'book', id };
  }

  throw new NoteValidationError({
    targetContainer: 'Choose a Book or Chapter destination.',
  });
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

function renderBooksIndex(res, { appName, bookService, notice = null, status = 200 }) {
  const books = bookService.listBooks();
  res.status(status).render('notes/books/index.njk', { appName, books, notice });
}

function renderBooksOrder(res, { appName, bookService, status = 200 }) {
  const books = bookService.listBooks();
  res.status(status).render('notes/books/order-index.njk', { appName, books });
}

function renderBookDetail(res, {
  appName, bookService, bookId, notice = null, status = 200,
}) {
  const book = bookService.getBook(bookId);
  const contents = bookService.listBookContents(bookId);
  const chapters = contents
    .filter(({ type }) => type === 'chapter')
    .map(({ chapter }) => chapter);
  const pages = contents
    .filter(({ type }) => type === 'page')
    .map(({ page }) => page);
  const canChangeOrder = contents.length >= 2;
  res.status(status).render('notes/books/detail.njk', {
    appName, book, contents, chapters, pages, canChangeOrder, notice,
  });
}

function renderBookOrder(res, {
  appName, bookService, bookId, status = 200,
}) {
  const book = bookService.getBook(bookId);
  const contents = bookService.listBookContents(bookId);
  res.status(status).render('notes/books/order.njk', { appName, book, contents });
}

function renderChapterDetail(res, {
  appName, bookService, chapterService, noteService, chapterId, notice = null, status = 200,
}) {
  const chapter = chapterService.getChapter(chapterId);
  const book = bookService.getBook(chapter.book_id);
  const notes = noteService.listNotesForChapter(chapterId);
  res.status(status).render('notes/chapters/detail.njk', {
    appName, book, chapter, notes, notice,
  });
}

function renderChapterOrder(res, {
  appName, bookService, chapterService, noteService, chapterId, status = 200,
}) {
  const chapter = chapterService.getChapter(chapterId);
  const book = bookService.getBook(chapter.book_id);
  const notes = noteService.listNotesForChapter(chapterId);
  res.status(status).render('notes/chapters/order.njk', {
    appName, book, chapter, notes,
  });
}

function parseOrderedBookIds(raw) {
  if (raw === undefined || raw === null) {
    throw new BookValidationError({ orderedBookIds: 'Submit the complete ordered book ID list.' });
  }
  if (Array.isArray(raw) || typeof raw !== 'string') {
    throw new BookValidationError({ orderedBookIds: 'Book IDs must be submitted as one comma-separated value.' });
  }
  if (raw === '') return [];
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) {
    throw new BookValidationError({ orderedBookIds: 'Book IDs must be canonical positive integers separated by commas.' });
  }

  const ids = raw.split(',').map((value) => Number(value));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new BookValidationError({ orderedBookIds: 'Book IDs must be safe positive integers.' });
  }
  return ids;
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

function parseOrderedChapterIds(raw) {
  if (raw === undefined || raw === null) {
    throw new ChapterValidationError({ orderedChapterIds: 'Submit the complete ordered chapter ID list.' });
  }
  if (Array.isArray(raw) || typeof raw !== 'string') {
    throw new ChapterValidationError({ orderedChapterIds: 'Chapter IDs must be submitted as one comma-separated value.' });
  }
  if (raw === '') return [];
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) {
    throw new ChapterValidationError({ orderedChapterIds: 'Chapter IDs must be canonical positive integers separated by commas.' });
  }

  const ids = raw.split(',').map((value) => Number(value));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ChapterValidationError({ orderedChapterIds: 'Chapter IDs must be safe positive integers.' });
  }
  return ids;
}

function parseOrderedBookItems(raw) {
  if (raw === undefined || raw === null) {
    throw new BookValidationError({
      orderedItems: 'Submit the complete ordered Book content list.',
    });
  }
  if (Array.isArray(raw) || typeof raw !== 'string') {
    throw new BookValidationError({
      orderedItems: 'Book contents must be submitted as one comma-separated value.',
    });
  }
  if (raw === '') return [];
  const match = raw.match(/^(?:chapter|page):[1-9]\d*(?:,(?:chapter|page):[1-9]\d*)*$/);
  if (!match || match[0] !== raw) {
    throw new BookValidationError({
      orderedItems: 'Book contents must use canonical chapter:id or page:id values separated by commas.',
    });
  }

  return raw.split(',').map((value) => {
    const separator = value.indexOf(':');
    const type = value.slice(0, separator);
    const idText = value.slice(separator + 1);
    const id = Number(idText);
    if (!Number.isSafeInteger(id) || String(id) !== idText) {
      throw new BookValidationError({
        orderedItems: 'Book content IDs must be safe canonical positive integers.',
      });
    }
    return { type, id };
  });
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
