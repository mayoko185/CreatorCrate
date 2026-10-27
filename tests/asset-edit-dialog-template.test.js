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

describe('asset edit dialog dismissal', () => {
  it('renders Edit Asset with normal backdrop dismissal and a close button', () => {
    const html = renderAssetEditDialog();
    const dialog = html.match(/<dialog id="asset-edit-dialog"[^>]*>/)?.[0] || '';

    expect(dialog).toContain('data-app-dialog');
    expect(dialog).not.toContain('data-dialog-backdrop-static');
    expect(html).toContain('data-dialog-close aria-label="Close Edit Asset"');
  });

  it('renders the current asset as the reset source beside submitted failure values', () => {
    const html = renderAssetEditDialog({
      asset: { id: 42, filename: 'confirmed.png', category_id: 3 },
      canMutate: true,
      canManageTags: true,
      assetTagOptions: [{ value: '2', label: 'Confirmed tag' }],
      selectedAssetTagIds: ['2'],
      confirmedAssetTagIds: ['2'],
      submittedFilename: 'failed-draft.png',
      submittedDestinationCategory: 'uncategorized',
      enabledCategories: [{ id: 3, displayName: 'Current' }],
    });

    expect(html).toContain('value="failed-draft.png" data-confirmed-value="confirmed.png"');
    expect(html).toMatch(/<select id="move-destination" name="destinationCategory"[^>]* data-confirmed-value="3">/);
    expect(html).toContain('data-confirmed-tag-ids="2"');
    expect(html).not.toContain('data-dialog-reset-on-close');
  });
});

describe('asset edit dialog Move destination', () => {
  function moveForm(overrides = {}) {
    const html = renderAssetEditDialog({
      asset: { id: 42, filename: 'confirmed.png', category_id: 3 },
      canMutate: true,
      submittedDestinationCategory: '3',
      enabledCategories: [{ id: 3, displayName: 'Renders' }, { id: 4, displayName: 'Sketches' }],
      ...overrides,
    });
    return formsFor(html, '/projects/7/assets/42/move')[0] || '';
  }

  it('backs the shared dropdown with the #move-destination native select and one submitted field', () => {
    const form = moveForm();
    const native = form.match(/<select id="move-destination"[^>]*>[\s\S]*?<\/select>/)?.[0] || '';

    expect(native).toMatch(/^<select id="move-destination" name="destinationCategory" class="cc-dropdown-native-select" data-cc-dropdown-native-select aria-label="Destination" data-confirmed-value="3">/);
    expect([...native.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((match) => [match[1], Boolean(match[2]), match[3]]))
      .toEqual([['uncategorized', false, 'Uncategorized'], ['3', true, 'Renders'], ['4', false, 'Sketches']]);
    expect(form.match(/name="destinationCategory"/g)).toHaveLength(1);
    expect(form).not.toMatch(/<input[^>]*type="hidden"[^>]*name="destinationCategory"/);

    const dropdown = form.match(/<details[^>]*id="move-destination-dropdown"[^>]*>[\s\S]*?<\/details>/)?.[0] || '';
    expect(dropdown).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(dropdown).toContain('data-cc-viewport-disclosure');
    expect(dropdown).toMatch(/^<details[^>]* hidden/);
    expect(dropdown).toContain('aria-label="Destination: Renders"');
    expect(dropdown).toMatch(/<span data-cc-dropdown-summary-current[^>]*>Renders<\/span>/);
    const radios = [...dropdown.matchAll(/<input id="[^"]*" type="radio" value="([^"]*)"( checked)?>/g)].map((match) => [match[1], Boolean(match[2])]);
    expect(radios).toEqual([['uncategorized', false], ['3', true], ['4', false]]);
    expect(form).toContain('<legend>Destination</legend>');
  });

  it('shows a rejected draft destination while keeping the confirmed reset value', () => {
    const form = moveForm({ submittedDestinationCategory: '4' });

    expect(form).toContain('data-confirmed-value="3"');
    expect(form).toContain('<option value="4" selected>Sketches</option>');
    expect(form).toContain('aria-label="Destination: Sketches"');
  });

  it('keeps category ID 1 as a quoted confirmed value beside a rejected draft', () => {
    const form = moveForm({
      asset: { id: 42, filename: 'first.png', category_id: 1 },
      submittedDestinationCategory: '4',
      enabledCategories: [{ id: 1, displayName: 'Renders' }, { id: 4, displayName: 'WIP' }],
    });

    expect(form).toMatch(/<select id="move-destination" name="destinationCategory"[^>]* data-confirmed-value="1">/);
    expect(form).toContain('<option value="1">Renders</option>');
    expect(form).toContain('<option value="4" selected>WIP</option>');
  });

  it('confirms Uncategorized for an asset without a category', () => {
    const form = moveForm({
      asset: { id: 42, filename: 'loose.png', category_id: null },
      submittedDestinationCategory: 'uncategorized',
    });

    expect(form).toContain('data-confirmed-value="uncategorized"');
    expect(form).toContain('<option value="uncategorized" selected>Uncategorized</option>');
    expect(form).toContain('aria-label="Destination: Uncategorized"');
  });
});

describe('asset edit dialog Book primary image controls', () => {
  it('renders the Book set form for an eligible archived-project asset', () => {
    const html = renderAssetEditDialog({
      project: { id: 7, status: 'archived' },
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

  it('keeps the Book and project primary-image controls distinct', () => {
    const html = renderAssetEditDialog({
      canSetAsPrimaryImage: true,
      bookPrimaryImageOptions: [{ id: 11, value: '11', label: 'Book' }],
    });

    expect(html).toContain('action="/projects/7/assets/42/primary-image"');
    expect(html).toContain('Set as primary image');
    expect(html).toContain('action="/projects/7/assets/42/book-primary-image"');
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

  it('renders the correct Book section boundary for each eligibility and usage state', () => {
    const removalOnly = renderAssetEditDialog({
      canSetAsBookPrimaryImage: false,
      bookPrimaryImageUsages: [{ id: 21, title: 'Existing Book' }],
    });
    expect(removalOnly).toContain('Existing Book');
    expect(removalOnly).toContain('asset-book-primary-image-remove-form');
    expect(removalOnly).not.toContain('asset-book-primary-image-set-form');

    const hidden = renderAssetEditDialog({ canSetAsBookPrimaryImage: false });
    expect(hidden).not.toContain('asset-book-primary-image-section');

    const eligibleWithoutBooks = renderAssetEditDialog();
    expect(eligibleWithoutBooks).toContain('No Books available.');
    expect(eligibleWithoutBooks).toContain('href="/notes/books/new"');
    expect(eligibleWithoutBooks).not.toContain('asset-book-primary-image-set-form');
  });
});
