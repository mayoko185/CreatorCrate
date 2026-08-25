import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });

function renderAssetEditDialog(overrides = {}) {
  return env.render('partials/asset-edit-dialog.njk', {
    _csrf: 'csrf-token',
    asset: { id: 42 },
    assetEditDialogOpen: true,
    bookPrimaryImageOptions: [],
    bookPrimaryImageUsages: [],
    canManageTags: false,
    canMutate: false,
    canRemovePrimaryImage: false,
    canSetAsBookPrimaryImage: true,
    canSetAsPrimaryImage: false,
    context: { returnTo: '/projects/7/assets', scope: 'project' },
    contextFields: ['returnTo', 'scope'],
    formError: null,
    isPrimaryImage: false,
    isPrimaryImageAvailable: false,
    project: { id: 7 },
    ...overrides,
  });
}

function formsFor(html, action) {
  return html.match(new RegExp(`<form[^>]*action="${action}"[^>]*>[\\s\\S]*?</form>`, 'g')) || [];
}

describe('asset edit dialog Book primary image controls', () => {
  it('renders the set form and Book dropdown for an eligible asset', () => {
    const html = renderAssetEditDialog({
      bookPrimaryImageOptions: [
        { id: 11, value: '11', label: 'Alpha Book' },
        { id: 12, value: '12', label: 'Beta Book' },
      ],
    });

    expect(html).toContain('Book primary image');
    expect(html).toContain('Alpha Book');
    expect(html).toContain('Beta Book');
    expect(html).toContain('name="bookId"');
    expect(html).toContain('name="_csrf" value="csrf-token"');
    expect(html).toContain('action="/projects/7/assets/42/book-primary-image"');
    expect(html).toContain('Set as book primary image');
  });

  it('renders one removal form for each Book using the asset', () => {
    const html = renderAssetEditDialog({
      canSetAsBookPrimaryImage: false,
      bookPrimaryImageUsages: [
        { id: 21, title: 'First Book' },
        { id: 22, title: 'Second Book' },
      ],
    });
    const forms = formsFor(html, '/projects/7/assets/42/book-primary-image/remove');

    expect(html).toContain('First Book');
    expect(html).toContain('Second Book');
    expect(forms).toHaveLength(2);
    expect(forms[0]).toContain('name="bookId" value="21"');
    expect(forms[1]).toContain('name="bookId" value="22"');
    expect(forms[0]).toContain('aria-label="Remove book primary image from First Book"');
    expect(forms[1]).toContain('aria-label="Remove book primary image from Second Book"');
    for (const form of forms) {
      expect(form).toContain('name="_csrf" value="csrf-token"');
      expect(form).toContain('name="returnTo" value="/projects/7/assets"');
      expect(form).toContain('name="scope" value="project"');
    }
  });

  it('keeps removal controls available when an ineligible asset has Book usages', () => {
    const html = renderAssetEditDialog({
      canSetAsBookPrimaryImage: false,
      bookPrimaryImageUsages: [{ id: 21, title: 'Existing Book' }],
    });

    expect(html).toContain('Existing Book');
    expect(html).toContain('asset-book-primary-image-remove-form');
    expect(html).not.toContain('asset-book-primary-image-set-form');
  });

  it('hides the Book section when an ineligible asset has no usages', () => {
    const html = renderAssetEditDialog({ canSetAsBookPrimaryImage: false });

    expect(html).not.toContain('asset-book-primary-image-section');
  });

  it('renders the normal empty state when an eligible asset has no Books', () => {
    const html = renderAssetEditDialog();

    expect(html).toContain('No Books available.');
    expect(html).toContain('href="/notes/books/new"');
    expect(html).not.toContain('asset-book-primary-image-set-form');
  });

  it('uses the supplied eligibility flag without deriving it from project archive state', () => {
    const html = renderAssetEditDialog({
      project: { id: 7, status: 'archived' },
      bookPrimaryImageOptions: [{ id: 11, value: '11', label: 'Archived Project Book' }],
    });

    expect(html).toContain('asset-book-primary-image-set-form');
    expect(html).toContain('Archived Project Book');
  });

  it('keeps the distinct project primary-image controls intact', () => {
    const html = renderAssetEditDialog({
      canSetAsPrimaryImage: true,
      bookPrimaryImageOptions: [{ id: 11, value: '11', label: 'Book' }],
    });

    expect(html).toContain('action="/projects/7/assets/42/primary-image"');
    expect(html).toContain('Set as primary image');
    expect(html).toContain('action="/projects/7/assets/42/book-primary-image"');
  });
});
