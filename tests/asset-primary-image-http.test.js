import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

// WP10A2: the four existing Project/Book primary-image routes answer the Edit
// Asset dialog's enhanced submission (Accept: application/json) as JSON, with
// the real services, repositories and rules, while the native form contract
// (redirects and re-rendered viewer pages) stays as it was.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset primary-image actions — enhanced JSON', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let app;
  let agent;
  let csrfToken;
  let fixtureCount = 0;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-primary-image-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createProject(files = ['first.png', 'second.png'], extra = {}) {
    fixtureCount += 1;
    const project = app.locals.projectService.create({ title: `Primary Http ${fixtureCount}`, status: 'tbd' });
    const directory = path.join(projectsRoot, project.project_dir);
    fs.mkdirSync(directory, { recursive: true });
    for (const filename of files) {
      if (filename.endsWith('.png')) {
        await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
          .png().toFile(path.join(directory, filename));
      } else {
        fs.writeFileSync(path.join(directory, filename), extra[filename] || 'bytes');
      }
    }
    app.locals.assetScanner.scanProjectAssets(project.id);
    const assetId = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?')
      .get(project.id, filename).id;
    return { projectId: project.id, directory, assetId };
  }

  const postJson = (route, body) => agent
    .post(route)
    .set('Accept', 'application/json')
    .type('form')
    .send(body);

  const projectPrimary = (projectId) => app.locals.projectPrimaryImageService.getPrimaryImage(projectId)?.id ?? null;
  const bookPrimary = (bookId) => app.locals.bookPrimaryImageService.getPrimaryImage(bookId)?.id ?? null;
  const tagRows = () => db.prepare('SELECT * FROM asset_tags ORDER BY asset_id, tag_id').all();
  const assetRow = (id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  const archive = (projectId) => agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
  const expectNativeRedirect = (response, fixture, assetId, notice) => {
    const location = new URL(response.headers.location, 'http://localhost');
    expect(location.pathname).toBe(`/projects/${fixture.projectId}/assets/${assetId}`);
    expect(location.searchParams.get('notice')).toBe(notice);
    expect(location.searchParams.get('edit')).toBe('1');
    return location;
  };
  const markMissing = (fixture, filename) => {
    fs.rmSync(path.join(fixture.directory, filename));
    app.locals.assetScanner.scanProjectAssets(fixture.projectId);
  };

  describe('A. Project Set', () => {
    it('sets the displayed asset once and answers with the stored selection', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const tagsBefore = tagRows();
      const rowBefore = assetRow(first);
      const set = vi.spyOn(app.locals.projectPrimaryImageService, 'setPrimaryImage');

      const response = await postJson(`/projects/${fixture.projectId}/assets/${first}/primary-image`, {
        _csrf: csrfToken, category: 'all', search: 'first',
      }).expect(200);

      expect(response.body).toEqual({
        status: 'success',
        outcome: 'committed',
        action: 'primary-image-set',
        message: 'The primary image was set.',
        projectId: fixture.projectId,
        assetId: first,
        primaryImage: { projectId: fixture.projectId, assetId: first },
        refreshRequired: true,
      });
      expect(set).toHaveBeenCalledExactlyOnceWith(fixture.projectId, first);
      expect(projectPrimary(fixture.projectId)).toBe(first);
      expect(tagRows()).toEqual(tagsBefore);
      expect(assetRow(first)).toEqual(rowBefore);
    });

    it('replaces another selection and accepts a repeated Set of the same asset', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const second = fixture.assetId('second.png');
      await app.locals.projectPrimaryImageService.setPrimaryImage(fixture.projectId, first);

      await postJson(`/projects/${fixture.projectId}/assets/${second}/primary-image`, { _csrf: csrfToken }).expect(200);
      expect(projectPrimary(fixture.projectId)).toBe(second);
      const again = await postJson(`/projects/${fixture.projectId}/assets/${second}/primary-image`, { _csrf: csrfToken }).expect(200);
      expect(again.body.primaryImage).toEqual({ projectId: fixture.projectId, assetId: second });
      expect(projectPrimary(fixture.projectId)).toBe(second);
    });

    it('refuses missing, malformed and cross-project identities as JSON 404 without a selection', async () => {
      const owner = await createProject();
      const other = await createProject(['other.png']);
      const ownerAsset = owner.assetId('first.png');
      const otherAsset = other.assetId('other.png');
      const cases = [
        [`/projects/not-a-project/assets/${ownerAsset}/primary-image`, 'PROJECT_NOT_FOUND'],
        [`/projects/999999/assets/${ownerAsset}/primary-image`, 'PROJECT_NOT_FOUND'],
        [`/projects/${owner.projectId}/assets/not-an-asset/primary-image`, 'ASSET_NOT_FOUND'],
        [`/projects/${owner.projectId}/assets/999999/primary-image`, 'ASSET_NOT_FOUND'],
        [`/projects/${owner.projectId}/assets/${otherAsset}/primary-image`, 'ASSET_NOT_FOUND'],
      ];
      for (const [route, code] of cases) {
        const response = await postJson(route, { _csrf: csrfToken }).expect(404);
        expect(response.body).toEqual({
          status: 'error',
          code,
          outcome: 'refused',
          message: code === 'PROJECT_NOT_FOUND' ? 'This project no longer exists.' : 'This asset no longer exists in this project.',
        });
      }
      expect(projectPrimary(owner.projectId)).toBeNull();
      expect(projectPrimary(other.projectId)).toBeNull();
    });

    it('refuses an unsupported source and a missing-at-scan asset', async () => {
      const fixture = await createProject(['first.png', 'clip.webm', 'notes.txt']);
      for (const filename of ['clip.webm', 'notes.txt']) {
        const response = await postJson(`/projects/${fixture.projectId}/assets/${fixture.assetId(filename)}/primary-image`, {
          _csrf: csrfToken,
        }).expect(422);
        expect(response.body).toEqual({
          status: 'error', code: 'ASSET_UNSUPPORTED', outcome: 'refused',
          message: 'This asset type cannot be selected as the primary image.',
        });
      }
      const first = fixture.assetId('first.png');
      markMissing(fixture, 'first.png');
      const missing = await postJson(`/projects/${fixture.projectId}/assets/${first}/primary-image`, { _csrf: csrfToken }).expect(409);
      expect(missing.body).toEqual(expect.objectContaining({ code: 'ASSET_MISSING', outcome: 'refused' }));
      expect(projectPrimary(fixture.projectId)).toBeNull();
    });

    it('refuses an archived project before any selection change', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      await archive(fixture.projectId);
      const response = await postJson(`/projects/${fixture.projectId}/assets/${first}/primary-image`, { _csrf: csrfToken }).expect(409);
      expect(response.body).toEqual({
        status: 'error', code: 'PROJECT_ARCHIVED', outcome: 'refused', message: 'This project is archived and read-only.',
      });
      expect(projectPrimary(fixture.projectId)).toBeNull();
    });

    it('rejects a bad or missing CSRF token and an unauthenticated request before the service', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const set = vi.spyOn(app.locals.projectPrimaryImageService, 'setPrimaryImage');
      const route = `/projects/${fixture.projectId}/assets/${first}/primary-image`;

      const bad = await postJson(route, { _csrf: 'deliberately-invalid-csrf-token' }).expect(403);
      expect(bad.body).toEqual(expect.objectContaining({ status: 'error' }));
      await postJson(route, {}).expect(403);
      const anonymous = await request(app).post(route).set('Accept', 'application/json').type('form').send({});
      expect([401, 403]).toContain(anonymous.status);
      expect(anonymous.body).toEqual(expect.objectContaining({ status: 'error' }));
      expect(set).not.toHaveBeenCalled();
      expect(projectPrimary(fixture.projectId)).toBeNull();
    });

    it('answers a database failure with a safe 500 whose outcome is unknown', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      vi.spyOn(app.locals.projectPrimaryImageService, 'setPrimaryImage').mockImplementation(() => {
        const error = new Error('SQLITE_BUSY at C:\\secret\\path');
        error.code = 'DATABASE_ERROR';
        throw error;
      });
      const response = await postJson(`/projects/${fixture.projectId}/assets/${first}/primary-image`, { _csrf: csrfToken }).expect(500);
      expect(response.body).toEqual({
        status: 'error', code: 'PRIMARY_IMAGE_FAILED', outcome: 'unknown',
        message: 'The primary image change could not be confirmed.',
      });
      expect(JSON.stringify(response.body)).not.toMatch(/SQLITE|secret/);
    });

    it('keeps the native redirect and failure re-render', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const native = await agent.post(`/projects/${fixture.projectId}/assets/${first}/primary-image`)
        .type('form').send({ _csrf: csrfToken, search: 'first' }).expect(302);
      expect(expectNativeRedirect(native, fixture, first, 'primary-image-set').searchParams.get('search')).toBe('first');
      await archive(fixture.projectId);
      const refused = await agent.post(`/projects/${fixture.projectId}/assets/${first}/primary-image`)
        .type('form').send({ _csrf: csrfToken }).expect(409);
      expect(refused.headers['content-type']).toMatch(/text\/html/);
      expect(refused.text).toContain('This project is archived and read-only.');
      await agent.post(`/projects/${fixture.projectId}/assets/999999/primary-image`)
        .type('form').send({ _csrf: csrfToken }).expect(404);
    });
  });

  describe('B. Project Remove', () => {
    it('removes the displayed asset’s selection once and confirms its absence', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      await app.locals.projectPrimaryImageService.setPrimaryImage(fixture.projectId, first);
      const clear = vi.spyOn(app.locals.projectPrimaryImageService, 'clearPrimaryImage');

      const response = await postJson(`/projects/${fixture.projectId}/assets/${first}/primary-image/remove`, {
        _csrf: csrfToken,
      }).expect(200);
      expect(response.body).toEqual({
        status: 'success',
        outcome: 'committed',
        action: 'primary-image-removed',
        message: 'The primary image was removed.',
        projectId: fixture.projectId,
        assetId: first,
        primaryImage: { projectId: fixture.projectId, assetId: null },
        refreshRequired: true,
      });
      // The displayed asset is the expected selection.
      expect(clear).toHaveBeenCalledExactlyOnceWith(fixture.projectId, first);
      expect(projectPrimary(fixture.projectId)).toBeNull();
    });

    it('refuses a stale removal and leaves the newer selection in place', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const second = fixture.assetId('second.png');
      await app.locals.projectPrimaryImageService.setPrimaryImage(fixture.projectId, first);
      // Another tab changes the selection after this Remove form was rendered.
      await app.locals.projectPrimaryImageService.setPrimaryImage(fixture.projectId, second);

      const response = await postJson(`/projects/${fixture.projectId}/assets/${first}/primary-image/remove`, {
        _csrf: csrfToken,
      }).expect(409);
      expect(response.body).toEqual({
        status: 'error', code: 'STALE_CLEAR', outcome: 'refused',
        message: 'The primary image changed before it could be removed.',
      });
      expect(projectPrimary(fixture.projectId)).toBe(second);
    });

    it('refuses a removal when no primary image is selected', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const response = await postJson(`/projects/${fixture.projectId}/assets/${first}/primary-image/remove`, {
        _csrf: csrfToken,
      }).expect(409);
      expect(response.body.code).toBe('STALE_CLEAR');
      expect(projectPrimary(fixture.projectId)).toBeNull();
    });

    it('refuses missing identities and an archived project', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      await app.locals.projectPrimaryImageService.setPrimaryImage(fixture.projectId, first);
      expect((await postJson(`/projects/999999/assets/${first}/primary-image/remove`, { _csrf: csrfToken }).expect(404)).body.code)
        .toBe('PROJECT_NOT_FOUND');
      expect((await postJson(`/projects/${fixture.projectId}/assets/999999/primary-image/remove`, { _csrf: csrfToken }).expect(409)).body.code)
        // The service compares the expected asset before any asset lookup.
        .toBe('STALE_CLEAR');
      await archive(fixture.projectId);
      const archived = await postJson(`/projects/${fixture.projectId}/assets/${first}/primary-image/remove`, { _csrf: csrfToken }).expect(409);
      expect(archived.body).toEqual(expect.objectContaining({ code: 'PROJECT_ARCHIVED', outcome: 'refused' }));
      expect(projectPrimary(fixture.projectId)).toBe(first);
    });

    it('keeps the native redirect and stale re-render', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const second = fixture.assetId('second.png');
      await app.locals.projectPrimaryImageService.setPrimaryImage(fixture.projectId, first);
      const native = await agent.post(`/projects/${fixture.projectId}/assets/${first}/primary-image/remove`)
        .type('form').send({ _csrf: csrfToken }).expect(302);
      expectNativeRedirect(native, fixture, first, 'primary-image-removed');
      await app.locals.projectPrimaryImageService.setPrimaryImage(fixture.projectId, second);
      const stale = await agent.post(`/projects/${fixture.projectId}/assets/${first}/primary-image/remove`)
        .type('form').send({ _csrf: csrfToken }).expect(409);
      expect(stale.text).toContain('The primary image changed before it could be removed.');
      expect(projectPrimary(fixture.projectId)).toBe(second);
    });
  });

  describe('C. Book Set', () => {
    it('sets the chosen Book once and answers with the Book and stored asset', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const book = app.locals.bookService.createBook({ title: 'Json Book' });
      const other = app.locals.bookService.createBook({ title: 'Other Json Book' });
      const set = vi.spyOn(app.locals.bookPrimaryImageService, 'setPrimaryImage');
      const tagsBefore = tagRows();

      const response = await postJson(`/projects/${fixture.projectId}/assets/${first}/book-primary-image`, {
        _csrf: csrfToken, bookId: String(book.id),
      }).expect(200);
      expect(response.body).toEqual({
        status: 'success',
        outcome: 'committed',
        action: 'book-primary-image-set',
        message: 'The book primary image was set.',
        projectId: fixture.projectId,
        assetId: first,
        bookId: book.id,
        primaryImage: { bookId: book.id, assetId: first },
        refreshRequired: true,
      });
      expect(set).toHaveBeenCalledExactlyOnceWith(book.id, first);
      expect(bookPrimary(book.id)).toBe(first);
      expect(bookPrimary(other.id)).toBeNull();
      expect(projectPrimary(fixture.projectId)).toBeNull();
      expect(tagRows()).toEqual(tagsBefore);
    });

    it('allows an eligible asset of an archived project, as the Book service does', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const book = app.locals.bookService.createBook({ title: 'Archived Source Book' });
      await archive(fixture.projectId);

      const response = await postJson(`/projects/${fixture.projectId}/assets/${first}/book-primary-image`, {
        _csrf: csrfToken, bookId: String(book.id),
      }).expect(200);
      expect(response.body.primaryImage).toEqual({ bookId: book.id, assetId: first });
      expect(bookPrimary(book.id)).toBe(first);
      // The Project rule still applies to the Project selection.
      await postJson(`/projects/${fixture.projectId}/assets/${first}/primary-image`, { _csrf: csrfToken }).expect(409);
    });

    it('sets two different Books independently and repeats a Set harmlessly', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const one = app.locals.bookService.createBook({ title: 'Book One' });
      const two = app.locals.bookService.createBook({ title: 'Book Two' });
      for (const book of [one, two, one]) {
        await postJson(`/projects/${fixture.projectId}/assets/${first}/book-primary-image`, {
          _csrf: csrfToken, bookId: String(book.id),
        }).expect(200);
      }
      expect(bookPrimary(one.id)).toBe(first);
      expect(bookPrimary(two.id)).toBe(first);
    });

    it('refuses an invalid or missing Book, an ineligible source and a wrong project URL', async () => {
      const fixture = await createProject(['first.png', 'clip.webm']);
      const other = await createProject(['other.png']);
      const first = fixture.assetId('first.png');
      const book = app.locals.bookService.createBook({ title: 'Guarded Book' });
      const set = vi.spyOn(app.locals.bookPrimaryImageService, 'setPrimaryImage');
      const route = `/projects/${fixture.projectId}/assets/${first}/book-primary-image`;

      const invalid = await postJson(route, { _csrf: csrfToken, bookId: 'not-a-book' }).expect(422);
      expect(invalid.body).toEqual({ status: 'error', code: 'INVALID_ID', outcome: 'refused', message: 'Choose a valid book.' });
      const absent = await postJson(route, { _csrf: csrfToken }).expect(422);
      expect(absent.body.code).toBe('INVALID_ID');
      expect(set).not.toHaveBeenCalled();

      const missingBook = await postJson(route, { _csrf: csrfToken, bookId: '999999' }).expect(404);
      expect(missingBook.body).toEqual({ status: 'error', code: 'BOOK_NOT_FOUND', outcome: 'refused', message: 'This Book no longer exists.' });

      const video = await postJson(`/projects/${fixture.projectId}/assets/${fixture.assetId('clip.webm')}/book-primary-image`, {
        _csrf: csrfToken, bookId: String(book.id),
      }).expect(422);
      expect(video.body).toEqual(expect.objectContaining({ code: 'ASSET_UNSUPPORTED', outcome: 'refused' }));

      set.mockClear();
      const foreign = await postJson(`/projects/${fixture.projectId}/assets/${other.assetId('other.png')}/book-primary-image`, {
        _csrf: csrfToken, bookId: String(book.id),
      }).expect(404);
      expect(foreign.body).toEqual(expect.objectContaining({ code: 'ASSET_NOT_FOUND', outcome: 'refused' }));
      const noProject = await postJson(`/projects/999999/assets/${first}/book-primary-image`, {
        _csrf: csrfToken, bookId: String(book.id),
      }).expect(404);
      expect(noProject.body.code).toBe('PROJECT_NOT_FOUND');
      expect(set).not.toHaveBeenCalled();

      markMissing(fixture, 'first.png');
      const missingAsset = await postJson(route, { _csrf: csrfToken, bookId: String(book.id) }).expect(422);
      expect(missingAsset.body).toEqual(expect.objectContaining({ code: 'ASSET_MISSING', outcome: 'refused' }));
      expect(bookPrimary(book.id)).toBeNull();
    });

    it('rejects CSRF failures before the service', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const book = app.locals.bookService.createBook({ title: 'Csrf Book' });
      const set = vi.spyOn(app.locals.bookPrimaryImageService, 'setPrimaryImage');
      await postJson(`/projects/${fixture.projectId}/assets/${first}/book-primary-image`, {
        _csrf: 'deliberately-invalid-csrf-token', bookId: String(book.id),
      }).expect(403);
      const anonymous = await request(app).post(`/projects/${fixture.projectId}/assets/${first}/book-primary-image`)
        .set('Accept', 'application/json').type('form').send({ bookId: String(book.id) });
      expect([401, 403]).toContain(anonymous.status);
      expect(set).not.toHaveBeenCalled();
      expect(bookPrimary(book.id)).toBeNull();
    });

    it('keeps the native redirect', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const book = app.locals.bookService.createBook({ title: 'Native Book' });
      const native = await agent.post(`/projects/${fixture.projectId}/assets/${first}/book-primary-image`)
        .type('form').send({ _csrf: csrfToken, bookId: String(book.id) }).expect(302);
      expectNativeRedirect(native, fixture, first, 'book-primary-image-set');
      await agent.post(`/projects/${fixture.projectId}/assets/${first}/book-primary-image`)
        .type('form').send({ _csrf: csrfToken, bookId: '999999' }).expect(404);
    });
  });

  describe('D. Book Remove', () => {
    it('removes only the named Book’s selection once and confirms its absence', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const one = app.locals.bookService.createBook({ title: 'Remove One' });
      const two = app.locals.bookService.createBook({ title: 'Remove Two' });
      await app.locals.bookPrimaryImageService.setPrimaryImage(one.id, first);
      await app.locals.bookPrimaryImageService.setPrimaryImage(two.id, first);
      const clear = vi.spyOn(app.locals.bookPrimaryImageService, 'clearPrimaryImage');

      const response = await postJson(`/projects/${fixture.projectId}/assets/${first}/book-primary-image/remove`, {
        _csrf: csrfToken, bookId: String(one.id),
      }).expect(200);
      expect(response.body).toEqual({
        status: 'success',
        outcome: 'committed',
        action: 'book-primary-image-removed',
        message: 'The book primary image was removed.',
        projectId: fixture.projectId,
        assetId: first,
        bookId: one.id,
        primaryImage: { bookId: one.id, assetId: null },
        refreshRequired: true,
      });
      expect(clear).toHaveBeenCalledExactlyOnceWith(one.id, first);
      expect(bookPrimary(one.id)).toBeNull();
      expect(bookPrimary(two.id)).toBe(first);
    });

    it('refuses a stale removal and keeps the newer Book selection', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const second = fixture.assetId('second.png');
      const book = app.locals.bookService.createBook({ title: 'Stale Book' });
      await app.locals.bookPrimaryImageService.setPrimaryImage(book.id, first);
      await app.locals.bookPrimaryImageService.setPrimaryImage(book.id, second);

      const response = await postJson(`/projects/${fixture.projectId}/assets/${first}/book-primary-image/remove`, {
        _csrf: csrfToken, bookId: String(book.id),
      }).expect(409);
      expect(response.body).toEqual({
        status: 'error', code: 'STALE_CLEAR', outcome: 'refused',
        message: 'The book primary image changed before it could be removed.',
      });
      expect(bookPrimary(book.id)).toBe(second);
    });

    it('refuses a missing Book and answers an operational failure safely', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const book = app.locals.bookService.createBook({ title: 'Failure Book' });
      await app.locals.bookPrimaryImageService.setPrimaryImage(book.id, first);
      const route = `/projects/${fixture.projectId}/assets/${first}/book-primary-image/remove`;

      expect((await postJson(route, { _csrf: csrfToken, bookId: '999999' }).expect(404)).body.code).toBe('BOOK_NOT_FOUND');

      vi.spyOn(app.locals.bookPrimaryImageService, 'clearPrimaryImage').mockImplementation(() => {
        const error = new Error('disk I/O error at /var/secret');
        error.code = 'DATABASE_ERROR';
        throw error;
      });
      const failed = await postJson(route, { _csrf: csrfToken, bookId: String(book.id) }).expect(500);
      expect(failed.body).toEqual({
        status: 'error', code: 'BOOK_PRIMARY_IMAGE_FAILED', outcome: 'unknown',
        message: 'The book primary image change could not be confirmed.',
      });
      expect(JSON.stringify(failed.body)).not.toMatch(/disk|secret/);
      expect(bookPrimary(book.id)).toBe(first);
    });

    it('allows removal for an archived project asset and keeps the native redirect', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const book = app.locals.bookService.createBook({ title: 'Archived Remove Book' });
      await app.locals.bookPrimaryImageService.setPrimaryImage(book.id, first);
      await archive(fixture.projectId);
      await postJson(`/projects/${fixture.projectId}/assets/${first}/book-primary-image/remove`, {
        _csrf: csrfToken, bookId: String(book.id),
      }).expect(200);
      expect(bookPrimary(book.id)).toBeNull();

      await app.locals.bookPrimaryImageService.setPrimaryImage(book.id, first);
      const native = await agent.post(`/projects/${fixture.projectId}/assets/${first}/book-primary-image/remove`)
        .type('form').send({ _csrf: csrfToken, bookId: String(book.id) }).expect(302);
      expectNativeRedirect(native, fixture, first, 'book-primary-image-removed');
      expect(bookPrimary(book.id)).toBeNull();
    });
  });

  describe('Asset detail markers for the page refresh', () => {
    it('renders the saved selection on the always-present primary-image regions', async () => {
      const fixture = await createProject();
      const first = fixture.assetId('first.png');
      const one = app.locals.bookService.createBook({ title: 'Marker One' });
      const two = app.locals.bookService.createBook({ title: 'Marker Two' });
      const url = `/projects/${fixture.projectId}/assets/${first}`;

      let page = await agent.get(url).expect(200);
      expect(page.text).toContain('data-asset-viewer-region="project-primary-image" data-primary-image-selected="false"');
      expect(page.text).toContain('data-asset-viewer-region="book-primary-image" data-book-primary-image-book-ids=""');
      expect(page.text).toContain('data-asset-viewer-region="book-primary-image-usages"');

      await app.locals.projectPrimaryImageService.setPrimaryImage(fixture.projectId, first);
      await app.locals.bookPrimaryImageService.setPrimaryImage(one.id, first);
      await app.locals.bookPrimaryImageService.setPrimaryImage(two.id, first);
      page = await agent.get(url).expect(200);
      expect(page.text).toContain('data-primary-image-selected="true"');
      const ids = page.text.match(/data-book-primary-image-book-ids="([^"]*)"/)[1].split(',').map(Number).sort((a, b) => a - b);
      expect(ids).toEqual([one.id, two.id].sort((a, b) => a - b));
      expect(page.text.match(/aria-live=/g)).toHaveLength(1);

      // A missing asset with a retained selection keeps its regions (now empty of forms).
      markMissing(fixture, 'first.png');
      await app.locals.projectPrimaryImageService.clearPrimaryImage(fixture.projectId, first);
      await app.locals.bookPrimaryImageService.clearPrimaryImage(one.id, first);
      await app.locals.bookPrimaryImageService.clearPrimaryImage(two.id, first);
      page = await agent.get(url).expect(200);
      expect(page.text).toContain('data-asset-viewer-region="project-primary-image" data-primary-image-selected="false"');
      expect(page.text).not.toContain('asset-primary-image-section');
      expect(page.text).not.toContain('asset-book-primary-image-section');
    });
  });
});
