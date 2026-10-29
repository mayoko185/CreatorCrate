import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';

// New Project and Edit Project share the Project form fields. A host that
// renders both (the Projects page, in a later package) prefixes the Edit
// Project ids, so ids, labels and field-error references never cross dialogs.

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });

const formModel = (overrides = {}) => ({
  values: { title: 'Saved title', status: 'tbd', projectType: 'comic' },
  errors: {},
  statuses: [{ value: 'tbd', label: 'TBD' }, { value: 'ready', label: 'Ready' }],
  projectTypes: [{ value: 'comic', label: 'Comic' }],
  tags: [{ id: 1, displayName: 'Alpha' }, { id: 2, displayName: 'Beta' }],
  selectedTagIds: ['2'],
  ...overrides,
});

function renderHost({ editErrors = {}, project = { id: 7 } } = {}) {
  return env.renderString(`
    {% import "partials/project-create-dialog.njk" as projectCreateDialog %}
    {% import "partials/project-edit-dialog.njk" as projectEditDialog %}
    {{ projectCreateDialog.render(createForm, '/projects', 'csrf-token') }}
    {{ projectEditDialog.render(project, editForm, 'csrf-token', false, '', 'edit-project-') }}
  `, {
    createForm: formModel({ values: { status: 'tbd', projectType: 'comic' }, selectedTagIds: [] }),
    editForm: formModel({ errors: editErrors }),
    project,
  });
}

const dialogHtml = (html, id) => html.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?</dialog>`))?.[0] || '';
const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

describe('Edit Project dialog beside New Project', () => {
  it('keeps every id unique and every label inside its own dialog', () => {
    const html = renderHost();
    const all = ids(html);
    expect(all.filter((id, index) => all.indexOf(id) !== index)).toEqual([]);

    for (const dialogId of ['project-create-dialog', 'project-edit-dialog']) {
      const dialog = dialogHtml(html, dialogId);
      const own = new Set(ids(dialog));
      const targets = [...dialog.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)].map((match) => match[1]);
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.filter((target) => !own.has(target))).toEqual([]);
    }

    const edit = dialogHtml(html, 'project-edit-dialog');
    expect(edit).toContain('<input type="text" id="edit-project-title" name="title"');
    expect(edit).toContain('id="edit-project-project-tags-form"');
    expect(edit).toContain('aria-describedby="edit-project-patreonUrl-help"');
    const create = dialogHtml(html, 'project-create-dialog');
    expect(create).toContain('<input type="text" id="title" name="title"');
    expect(create).toContain('id="project-tags-form"');
  });

  it('routes field errors to the prefixed Edit Project references only', () => {
    const html = renderHost({ editErrors: { title: 'Title is required.', status: 'Pick a status.', general: 'Fix it.' } });
    const edit = dialogHtml(html, 'project-edit-dialog');
    const create = dialogHtml(html, 'project-create-dialog');

    for (const field of ['status', 'projectType', 'tagIds']) {
      expect(edit).toContain(`data-dialog-field="${field}" data-dialog-error-ref="edit-project-${field}-error"`);
      expect(create).toContain(`data-dialog-field="${field}" data-dialog-error-ref="${field}-error"`);
    }
    expect(edit).toContain('aria-describedby="edit-project-title-error" aria-invalid="true"');
    expect(edit).toContain('<span class="field-error-message" id="edit-project-title-error">Title is required.</span>');
    expect(edit).toContain('id="edit-project-status-error"');
    expect(edit).toMatch(/<p data-dialog-error-text>Fix it\.<\/p>/);
    expect(create).not.toContain('field-error-message');
    expect(create).not.toContain('aria-invalid="true"');
  });

  it('renders a targetless async dialog when the host has no project loaded yet', () => {
    const html = renderHost({ project: null });
    const edit = dialogHtml(html, 'project-edit-dialog');

    expect(edit).toContain('<form id="project-edit-form" method="post" action=""');
    expect(edit).toContain('data-dialog-async="true"');
    expect(edit).not.toContain('data-project-edit-loaded-id');
    expect(edit).toContain('data-project-edit-action="archive"');
    expect(edit).toContain('data-project-edit-action="delete"');
    expect(edit).not.toMatch(/action="\/projects\/[^"]*\/(archive|delete)"/);
  });
});
