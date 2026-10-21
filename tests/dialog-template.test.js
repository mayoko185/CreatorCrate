import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });

function renderDialogCard(cardAttributes) {
  const html = env.renderString(
    `{% import "partials/dialog.njk" as dialog %}
{% call dialog.render('test-dialog', 'Test dialog', false, '', '', '', cardAttributes) %}{% endcall %}`,
    { cardAttributes },
  );
  return html.match(/<div class="app-dialog-card" role="document"[^>]*>/)?.[0] || '';
}

describe('shared dialog template', () => {
  it('renders only literal true as a bare card attribute', () => {
    const card = renderDialogCard([
      ['data-number-one', 1],
      ['data-string-one', '1'],
      ['data-number-two', 2],
      ['data-enabled', true],
      ['data-label', 'normal value'],
      ['data-escaped', 'A&B"'],
    ]);

    expect(card).toContain('data-number-one="1"');
    expect(card).toContain('data-string-one="1"');
    expect(card).toContain('data-number-two="2"');
    expect(card).toMatch(/ data-enabled(?:\s|>)/);
    expect(card).not.toContain('data-enabled=');
    expect(card).toContain('data-label="normal value"');
    expect(card).toContain('data-escaped="A&amp;B&quot;"');
  });
});

const ID_REFERENCE_ATTRIBUTES = ['for', 'aria-describedby', 'aria-controls', 'aria-labelledby',
  'data-date-picker-for', 'data-time-picker-for', 'form'];

function duplicateIds(html) {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

function unresolvedIdReferences(html) {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  return ID_REFERENCE_ATTRIBUTES.flatMap((attribute) => [...html.matchAll(new RegExp(`\\s${attribute}="([^"]*)"`, 'g'))]
    .flatMap((match) => match[1].split(/\s+/).filter((id) => id && !ids.has(id)).map((id) => `${attribute}=${id}`)));
}

function renderReleaseDialogs({ editErrors = {}, release = { id: 7, published_date: null } } = {}) {
  return env.renderString(
    `{% import "partials/release-create-dialog.njk" as releaseCreateDialog %}
{% import "partials/release-edit-dialog.njk" as releaseEditDialog %}
{{ releaseCreateDialog.render(createForm, 'token', configuration, platforms, false, '24h', '/', 'release-create-field-') }}
{{ releaseEditDialog.render(release, editForm, 'token', configuration, platforms, '24h', 'release-edit-field-') }}`,
    {
      createForm: { values: {}, errors: {}, projects: [{ id: 1, title: 'Project' }], selectedProjectId: null, isFreshCreate: true },
      release,
      editForm: {
        values: { title: 'Release', selectedPlatforms: ['x'], plannedDate: '2031-01-02' },
        errors: editErrors,
      },
      configuration: { entries: [{ id: 'sig-1', name: 'Signature' }] },
      platforms: [{ value: 'x', label: 'X' }, { value: 'bluesky', label: 'Bluesky' }],
    },
  );
}

describe('release Edit dialog hosted beside New Release', () => {
  it('namespaces every field, dropdown and picker id so both dialogs resolve their own references', () => {
    for (const editErrors of [{}, { title: 'Required.', plannedDate: 'Bad date.', selectedPlatforms: 'Invalid platform selection.' }]) {
      const html = renderReleaseDialogs({ editErrors });
      const editDialog = html.match(/<dialog id="release-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      expect(duplicateIds(html)).toEqual([]);
      // Only Manage signatures points outside, at the page's shared signatures dialog.
      expect([...new Set(unresolvedIdReferences(html))]).toEqual(['aria-controls=release-signatures-dialog']);
      expect(editDialog).toContain('id="release-edit-field-signature"');
      expect(editDialog).toContain('id="release-edit-field-platforms"');
      expect(editDialog).toMatch(/<label for="release-edit-field-title">/);
      expect(editDialog).toContain('data-date-picker-for="release-edit-field-plannedDate"');
      expect(editDialog).toContain('data-dialog-error-ref="release-edit-field-selectedPlatforms-error"');
      expect(editDialog).toContain('data-dialog-async="true"');
      // The single async Edit path: always closed, no legacy return or reset state.
      expect(editDialog).not.toMatch(/<dialog id="release-edit-dialog"[^>]*\sopen[\s>]/);
      expect(editDialog).not.toContain('name="returnTo"');
      expect(editDialog).not.toContain('data-dialog-return-location');
      expect(editDialog).not.toContain('data-dialog-reset-values');
      expect(editDialog).not.toContain('data-release-edit-deep-link');
      expect(editDialog).toMatch(/<div class="error-summary" role="alert" data-dialog-error hidden>/);
      expect(editDialog).not.toContain('data-release-create-fresh');
      expect(editDialog).toMatch(/name="selectedPlatforms"[^>]*value="x"[^>]*checked/);
    }
  });

  it('always renders one Archive action, hidden and targetless unless the release is archivable', () => {
    const archiveOf = (release) => {
      const html = renderReleaseDialogs({ release });
      const actions = html.match(/<details[^>]*data-release-edit-action="archive"[\s\S]*?<\/details>/g) || [];
      expect(actions).toHaveLength(1);
      expect(duplicateIds(html)).toEqual([]);
      return actions[0];
    };

    const eligible = archiveOf({ id: 7, published_date: null });
    expect(eligible).not.toMatch(/<details[^>]*hidden/);
    expect(eligible).toContain('action="/releases/7/archive"');
    expect(eligible).toContain('data-confirm="Archive this release? This cannot be undone."');
    for (const release of [{ id: 7, published_date: '2031-01-03' }, { id: '', published_date: null }]) {
      const archive = archiveOf(release);
      expect(archive).toMatch(/<details[^>]*data-release-edit-action="archive" hidden>/);
      expect(archive).toContain('<form method="post" action="">');
      expect(archive).toContain('data-confirm="Archive this release? This cannot be undone."');
    }
  });

  it('keeps server-rendered error associations on the namespaced ids', () => {
    const html = renderReleaseDialogs({ editErrors: { title: 'Required.', selectedPlatforms: 'Invalid platform selection.' } });
    const editDialog = html.match(/<dialog id="release-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

    expect(editDialog).toMatch(/id="release-edit-field-title" name="title"[^>]*aria-describedby="release-edit-field-title-error" aria-invalid="true"/);
    expect(editDialog).toContain('<span class="field-error-message" id="release-edit-field-selectedPlatforms-error">Invalid platform selection.</span>');
    expect(editDialog).toMatch(/<summary id="release-edit-field-platforms-trigger"[^>]*aria-describedby="release-edit-field-selectedPlatforms-error"/);
  });
});
