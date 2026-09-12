import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';

const formTemplate = fs.readFileSync(
  fileURLToPath(new URL('../src/views/notes/form.njk', import.meta.url)),
  'utf8',
).replace(/\{% include "notes\/(connections-fields|writing-fields)\.njk" %\}/g, (_match, name) => (
  fs.readFileSync(new URL(`../src/views/notes/${name}.njk`, import.meta.url), 'utf8')
));
const notesCss = fs.readFileSync(
  fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url)),
  'utf8',
);
const notesEditorJs = fs.readFileSync(
  fileURLToPath(new URL('../src/static/client/notes-editor.js', import.meta.url)),
  'utf8',
);

describe('Notes workspace layout contract', () => {

  it('reduces only Page contents horizontal spacing using the compact body token', () => {
    expect(formTemplate.match(/notes-page-contents-body/g)).toHaveLength(1);
    expect(formTemplate).toMatch(/Page contents<\/h3>\s*<div class="project-form-section-body project-edit-dialog-section-body notes-page-contents-body">/);
    expect(notesCss).toMatch(/\.project-form-dialog \.notes-page-contents-body\s*\{\s*padding-inline: var\(--space-md\);\s*\}/);
    expect(notesCss).toMatch(/\.project-form-dialog \.project-edit-dialog-section-body\s*\{[^}]*padding: var\(--space-md\) var\(--space-lg\) var\(--space-lg\);/);
    expect(notesCss).toMatch(/\.project-form \.project-form-section-body\s*\{\s*display: flex;\s*flex-direction: column;\s*gap: var\(--space-lg\);\s*\}/);
  });

  it.each(['Create', 'Edit'])('stretches sections and retains the Connections styling ancestor in the %s Note dialog', (action) => {
    const env = nunjucks.configure(fileURLToPath(new URL('../src/views', import.meta.url)), {
      autoescape: true, noCache: true,
    });
    const html = env.render('notes/form.njk', {
      noteDialogId: action === 'Edit' ? 'note-edit-dialog' : 'note-create-dialog',
      noteDialogTitle: action + ' Page', noteDialogOpen: true,
      book: { id: 1, title: 'Book' }, note: { id: 2 }, bookContents: [],
      noteFormModel: {
        action, submitUrl: action === 'Edit' ? '/notes/2' : '/notes',
        values: { title: 'Page', content: 'Writing', bookId: '1' }, errors: {},
        projects: [{ id: 3, title: 'Archived project' }], selectedProjectIds: ['3'],
        selectedAssetIds: ['4'], moveTargets: [{ book: { id: 1, title: 'Book' }, chapters: [{ id: 8, title: 'Chapter' }] }],
        selectedAssets: [{ id: 4, filename: 'missing.png', relativePath: 'folder/missing.png',
          projectTitle: 'Archived project', isProjectArchived: true, isPresent: false }],
      },
    });
    const dialogId = action === 'Edit' ? 'note-edit-dialog' : 'note-create-dialog';
    expect(html).toContain(`id="${dialogId}"`);
    expect(html).toMatch(/<form[^>]*class="[^"]*notes-workspace[^"]*"[^>]*>(?:\s*<input[^>]*>)*\s*<section class="settings-section project-form-section project-edit-dialog-section"/);
    const workspaceRule = notesCss.match(/#note-edit-dialog \.notes-workspace,\s*#note-create-dialog \.notes-workspace\s*\{([^}]*)\}/)?.[1] || '';
    expect(workspaceRule).toMatch(/display:\s*flex;/);
    expect(workspaceRule).toMatch(/flex-direction:\s*column;/);
    expect(workspaceRule).toMatch(/align-items:\s*stretch;/);
    expect(workspaceRule).not.toMatch(/align-items:\s*(?:start|flex-start);/);
    // Detail-page workspaces keep their grid alignment; only these dialogs stretch.
    const baseWorkspaceRule = notesCss.match(/(?:^|\})\s*\.notes-workspace\s*\{([^}]*)\}/)?.[1] || '';
    expect(baseWorkspaceRule).toMatch(/display:\s*grid;/);
    expect(baseWorkspaceRule).toMatch(/align-items:\s*start;/);
    const connections = html.match(/<section[^>]*aria-labelledby="notes-connections-heading"[^>]*>[\s\S]*?<\/section>/)?.[0];
    expect(connections).toBeTruthy();
    expect(connections).toMatch(/<div class="project-form-section-body project-edit-dialog-section-body">[\s\S]*<\/div>\s*<\/section>/);
    for (const marker of [
      'name="projectIds[]"', 'name="assetIds[]"', 'data-cc-dropdown-searchable',
      'asset-project-filter-panel', 'asset-project-filter-search-label',
      'data-note-retained-assets', 'data-note-assets',
      'id="note-projects-form-search"', 'id="note-assets-form-search"',
    ]) expect(connections).toContain(marker);
    expect(html.indexOf('aria-label="Book contents"')).toBeLessThan(html.indexOf('aria-labelledby="notes-editor-heading"'));
    expect(html.indexOf('aria-labelledby="notes-editor-heading"')).toBeLessThan(html.indexOf(connections));
    expect(html).not.toMatch(/notes-page-sidebar|notes-page-workspace-layout/);
    const sections = [...html.matchAll(/<section[^>]*aria-labelledby="(notes-[^"]+-heading)"[^>]*>([\s\S]*?)<\/section>/g)];
    expect(sections).toHaveLength(action === 'Edit' ? 4 : 3);
    for (const [section, headingId, body] of sections) {
      expect(section).toContain('settings-section project-form-section project-edit-dialog-section');
      expect(body.trim()).toMatch(new RegExp('^<h3 id="' + headingId + '">'));
      expect(body).toContain('project-form-section-body project-edit-dialog-section-body');
    }
    expect(html.match(/<h3[^>]*>Page contents<\/h3>/g)).toHaveLength(1);
    expect(html).not.toMatch(/Writing surface|>Page content<|Current container:|Target container/);
    expect(html.match(/id="content-editor"/g)).toHaveLength(1);
    expect(html.match(/id="content"/g)).toHaveLength(1);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    let formDepth = 0;
    for (const [tag] of html.matchAll(/<\/?form\b[^>]*>/g)) {
      formDepth += tag.startsWith('</') ? -1 : 1;
      expect(formDepth).toBeGreaterThanOrEqual(0);
      expect(formDepth).toBeLessThanOrEqual(1);
    }
    expect(formDepth).toBe(0);
    if (action === 'Edit') {
      expect(html).toMatch(/<option value="book:1" selected>Book: Book/);
      expect(html).toMatch(/<select[^>]*id="note-move-target"[^>]*name="targetContainer"[^>]*required form="note-move-form"/);
      expect(html).toContain('<legend class="sr-only">Move Page destination</legend>');
      expect(html).toContain('class="asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown" id="note-move-dropdown"');
      expect(html).toContain('class="asset-filter-multiselect-panel" role="radiogroup" aria-label="Page destinations"');
    }
  });

  it('defaults the shared Move dropdown to the current Chapter with unchanged typed destinations', () => {
    const env = nunjucks.configure(fileURLToPath(new URL('../src/views', import.meta.url)), { autoescape: true });
    const html = env.render('notes/form.njk', {
      noteDialogId: 'note-edit-dialog', noteDialogTitle: 'Edit Page',
      book: { id: 1, title: 'Book' }, chapter: { id: 8, title: 'Chapter' }, note: { id: 2 },
      noteFormModel: { action: 'Edit', values: {}, errors: {}, projects: [], selectedProjectIds: [],
        selectedAssetIds: [], selectedAssets: [], moveTargets: [
          { book: { id: 1, title: 'Book' }, chapters: [{ id: 8, title: 'Chapter' }] },
          { book: { id: 3, title: 'Other' }, chapters: [{ id: 9, title: 'Other chapter' }] },
        ] },
    });
    const select = html.match(/<select id="note-move-target"[\s\S]*?<\/select>/)[0];
    expect(select.match(/ selected/g)).toHaveLength(1);
    expect(select).toContain('<option value="chapter:8" selected>');
    for (const value of ['book:1', 'book:3', 'chapter:8', 'chapter:9']) expect(select).toContain('value="' + value + '"');
    expect(html).toMatch(/type="radio" value="chapter:8" checked/);
    expect(html).toContain('action="/notes/2/move"');
    expect(html).toContain('action="/notes/2/delete"');
  });

  it('lightens only Note detail copy blocks using an existing surface token', () => {
    expect(notesCss).toMatch(/\.notes-page-detail-content \.notes-content pre\s*\{\s*background: var\(--surface-hover\);\s*\}/);
    expect(notesCss).toMatch(/\.notes-content pre\s*\{[^}]*background: var\(--bg\);/);
    expect(notesCss).toMatch(/\.notes-content pre > code\s*\{[^}]*background: transparent;/);
  });

  it('keeps enhanced code Copy controls visible when hover is unavailable', () => {
    const baseCopyRule = notesCss.match(/\.notes-content pre > \.notes-code-copy\s*\{[^}]*\}/)?.[0] || '';
    const hoverCapabilityRules = notesCss.match(/@media\s*\(hover:\s*hover\)\s*\{([\s\S]*?)\n\s{6}\}/)?.[1] || '';

    expect(baseCopyRule).not.toContain('opacity:');
    expect(baseCopyRule).not.toContain('pointer-events:');
    expect(hoverCapabilityRules).toMatch(/pre\.notes-code-block-enhanced > \.notes-code-copy\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/);
    expect(hoverCapabilityRules).toMatch(/pre\.notes-code-block-enhanced:hover > \.notes-code-copy,[\s\S]*pre\.notes-code-block-enhanced:focus-within > \.notes-code-copy\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/);
  });

  it('reuses dialog scrollbar declarations only on the four Notes scroll owners', () => {
    const owners = [
      '.notes-workspace .notes-editor .toastui-editor-ww-container .toastui-editor-contents',
      '.notes-workspace .notes-editor .toastui-editor-md-container .ProseMirror',
      '.notes-workspace .notes-editor .toastui-editor-md-container .toastui-editor-md-preview',
      '.notes-workspace .notes-editor textarea[data-notes-editor-source]',
    ];
    const rules = [...notesCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
      selectors: selectors.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((selector) => selector.trim()),
      declarations: body.split(';').map((value) => value.trim()).filter(Boolean),
    }));
    const treatments = [
      ['', ['scrollbar-color: var(--border-strong) transparent', 'scrollbar-width: thin']],
      ['::-webkit-scrollbar', ['width: 0.5rem']],
      ['::-webkit-scrollbar-track', ['background: transparent']],
      ['::-webkit-scrollbar-thumb', [
        'background: var(--border-strong)', 'border: 2px solid var(--surface-card)', 'border-radius: 999px',
      ]],
      ['::-webkit-scrollbar-thumb:hover', ['background: var(--muted)']],
    ];
    for (const [suffix, declarations] of treatments) {
      const dialogDeclarations = rules
        .filter((rule) => rule.selectors.includes(`.app-dialog-body${suffix}`))
        .flatMap((rule) => rule.declarations);
      expect(dialogDeclarations).toEqual(expect.arrayContaining(declarations));
      for (const owner of ['.app-dialog-body', ...owners]) {
        const matches = rules.filter((rule) => rule.selectors.includes(`${owner}${suffix}`)
          && (suffix || rule.declarations.some((value) => value.startsWith('scrollbar-'))));
        expect(matches).toHaveLength(1);
        expect(matches[0].declarations).toEqual(declarations);
        // No broad textarea, host, toolbar, popup, or unscoped library selectors.
        expect(matches[0].selectors).toEqual(['.app-dialog-body', ...owners].map((selector) => `${selector}${suffix}`));
      }
    }
  });

  it('targets the installed editor internal overflow surfaces rather than the hidden-overflow wrappers', () => {
    const vendorCss = fs.readFileSync(new URL('../node_modules/@toast-ui/editor/dist/toastui-editor.css', import.meta.url), 'utf8');
    for (const selector of [
      '.toastui-editor-ww-container .toastui-editor-contents',
      '.toastui-editor-md-container .toastui-editor-md-preview',
      '.ProseMirror',
    ]) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(vendorCss).toMatch(new RegExp(`${escaped}\\s*\\{[^}]*overflow(?:-y)?: auto;`));
    }
    expect(formTemplate).toContain('<div class="notes-editor" data-notes-editor-host-wrapper>');
    expect(formTemplate).toContain('<textarea id="content" name="content" data-notes-editor-source');
  });

  it('uses New Project sizing and single-column sections for both Create and Edit', () => {
    const createTemplate = fs.readFileSync(new URL('../src/views/notes/form.njk', import.meta.url), 'utf8');
    const wrapper = fs.readFileSync(new URL('../src/views/notes/create-dialog.njk', import.meta.url), 'utf8');
    expect(wrapper).toContain('{% include "notes/form.njk" %}');
    expect(createTemplate).toContain('noteFormModel.action');
    expect(notesCss).toContain('#note-edit-dialog .notes-workspace,');
    expect(notesCss).toContain('#note-edit-dialog .notes-workspace-context,');
    expect(createTemplate).toContain("'project-form-dialog'");
    expect(createTemplate).toContain('app-dialog-body project-edit-dialog-body');
    expect(createTemplate).toContain('project-edit-dialog-form');
    expect(createTemplate.match(/<section class="settings-section project-form-section project-edit-dialog-section"/g)).toHaveLength(2);
    expect(createTemplate.indexOf('partials/book-navigator.njk')).toBeLessThan(createTemplate.indexOf('notes/writing-fields.njk'));
    expect(createTemplate.indexOf('notes/writing-fields.njk')).toBeLessThan(createTemplate.indexOf('notes/connections-fields.njk'));
    expect(createTemplate).not.toMatch(/notes-page-sidebar|notes-page-workspace-layout|class="notes-workspace-editor"/);
    expect(notesCss).toMatch(/#project-create-dialog,\s*#note-create-dialog,[^{]*\{\s*width: min\(51rem, calc\(100vw - 2rem\)\)/);
    expect(notesCss).toMatch(/#note-create-dialog \.notes-workspace\s*\{\s*display: flex;\s*flex-direction: column;/);
    expect(notesCss).toMatch(/#note-create-dialog \.notes-workspace-context\s*\{\s*position: static;/);
  });

  it('orders Book contents, writing, then connections with actions outside the Edit form', () => {
    const formStart = formTemplate.indexOf('<form id="note-form"');
    const formEnd = formTemplate.indexOf('</form>', formStart);
    const formBody = formTemplate.slice(formTemplate.indexOf('>', formStart) + 1, formEnd);
    const contents = formBody.indexOf('aria-label="Book contents"');
    const writing = formBody.indexOf('aria-labelledby="notes-editor-heading"');
    const connections = formBody.indexOf('aria-labelledby="notes-connections-heading"');
    expect(contents).toBeGreaterThanOrEqual(0);
    expect(writing).toBeGreaterThan(contents);
    expect(connections).toBeGreaterThan(writing);
    expect(formTemplate).not.toMatch(/notes-page-workspace-layout|notes-page-sidebar|class="notes-workspace-editor"/);
    expect(formBody).toContain('data-notes-editor-host');
    expect(formBody).toContain('data-notes-editor-source');
    expect(formBody).toContain('name: "projectIds[]"');
    expect(formBody).toContain('name="assetIds[]"');
    expect(formBody).not.toContain('<form');
    expect(formBody).not.toContain('Move Page');
    expect(formBody).not.toContain('Delete Page');
    expect(formTemplate.indexOf('notes-workspace-secondary')).toBeGreaterThan(formEnd);
  });

  it('keeps the editor minimum on the component and fallback, not structural wrappers', () => {
    expect(notesEditorJs).not.toContain("minHeight: '60vh'");
    expect(notesCss).toContain('--notes-editor-min-height: clamp(24rem, 55vh, 36rem);');
    expect(notesCss.match(/--notes-editor-min-height\s*:/g)).toHaveLength(1);
    expect(notesEditorJs).toContain("height: 'auto'");
    const wrapperRule = notesCss.match(/\.notes-workspace \.notes-editor,\s*\.notes-workspace \.notes-editor-host\s*\{[^}]*\}/)?.[0] || '';
    const fallbackRule = notesCss.match(/\.notes-workspace \[data-notes-editor-source\]\s*\{[^}]*\}/)?.[0] || '';
    const editorRootRule = notesCss.match(/\.notes-workspace \.notes-editor \.toastui-editor-defaultUI\s*\{[^}]*\}/)?.[0] || '';
    const editorMainRule = notesCss.match(/\.notes-workspace \.notes-editor \.toastui-editor-defaultUI > \.toastui-editor-main\s*\{[^}]*\}/)?.[0] || '';
    const mainContainerRule = notesCss.match(/\.notes-workspace \.notes-editor \.toastui-editor-main-container\s*\{[^}]*\}/)?.[0] || '';
    const writingSurfaceRule = notesCss.match(/\.notes-workspace \.notes-editor \.toastui-editor-ww-container,[\s\S]*?\{[^}]*\}/)?.[0] || '';
    expect(wrapperRule).not.toContain('min-height');
    expect(fallbackRule).toContain('min-height: var(--notes-editor-min-height);');
    expect(fallbackRule).toContain('width: 100%;');
    expect(fallbackRule).toContain('resize: vertical;');
    expect(editorRootRule).toContain('min-height: var(--notes-editor-min-height);');
    expect(editorRootRule).toContain('display: flex;');
    expect(editorRootRule).toContain('flex-direction: column;');
    expect(editorMainRule).toContain('flex: 1 1 auto;');
    expect(editorMainRule).toContain('min-height: 0;');
    expect(mainContainerRule).toContain('position: absolute;');
    expect(mainContainerRule).toContain('inset: 0;');
    expect(writingSurfaceRule).toContain('height: 100%;');
    expect(writingSurfaceRule).toContain('.toastui-editor-md-container');
    expect(formTemplate).not.toContain('data-notes-editor-source rows=');
    expect(notesCss).toContain('@media (max-width: 1023px)');
    expect(notesCss).toContain('.notes-page-workspace-layout');
    expect(notesCss).toContain('--notes-page-workspace-columns: minmax(12rem, 16rem) minmax(0, 1fr);');
    expect(notesCss).toContain('grid-template-columns: var(--notes-page-workspace-columns);');
    expect(notesCss).toContain('grid-template-areas: "sidebar editor";');
    expect(notesCss).toContain('grid-template-areas: "context" "editor" "connections" "actions";');
    expect(notesCss).not.toContain('grid-template-columns: minmax(10rem, 12rem) minmax(0, 1fr) minmax(15rem, 18rem);');
    expect(notesCss).not.toContain('grid-template-areas: "context editor connections";');
    expect(notesCss).not.toContain('grid-template-areas: ". . actions";');
    expect(notesCss).not.toContain('.notes-workspace-back');
    expect(notesCss).not.toContain('.notes-workspace-context-note');
    expect(notesCss).not.toContain('.notes-workspace-book-nav');
    expect(notesCss).not.toContain('.notes-workspace-context .notes-hierarchy');
    expect(notesCss).not.toContain('.notes-hierarchy');
    expect(notesCss).toContain('.notes-book-nav {');
  });

  it('shares the taller writing surface across Create and Edit inside viewport-bounded scrolling dialogs', () => {
    const createTemplate = fs.readFileSync(new URL('../src/views/notes/create-dialog.njk', import.meta.url), 'utf8');
    expect(createTemplate).toContain('{% include "notes/form.njk" %}');
    expect(formTemplate).toContain('notes-form notes-workspace"');
    expect(formTemplate).toContain('data-notes-editor-host');
    expect(formTemplate).toContain('data-notes-editor-source');
    for (const selector of ['app-dialog', 'app-dialog-card']) {
      const rule = notesCss.match(new RegExp(`\\.${selector}\\s*\\{[^}]*\\}`))?.[0] || '';
      expect(rule).toContain('max-height: calc(100vh - 2rem);');
    }
    const bodyRule = notesCss.match(/\.app-dialog-body\s*\{\s*display: flex;[^}]*\}/)?.[0] || '';
    expect(bodyRule).toContain('min-height: 0;');
    expect(bodyRule).toContain('overflow-y: auto;');
    expect(notesCss).toContain('.app-dialog-card { max-height: calc(100vh - 1rem); }');
  });

  it('keeps Edit-only movement and deletion in separate valid forms', () => {
    const mainFormEnd = formTemplate.indexOf('</form>');
    const moveFormStart = formTemplate.indexOf('<form id="note-move-form"');
    const deleteFormStart = formTemplate.indexOf('<form id="note-delete-form"');

    expect(formTemplate).toContain("{{ 'Save' if noteFormModel.action == 'Edit' else 'Create' }}");
    expect(formTemplate).toContain('form="note-form" data-dialog-submit');
    expect(formTemplate).toContain('class="notes-workspace-disclosure notes-workspace-disclosure--move"');
    expect(formTemplate).toContain('class="notes-workspace-disclosure notes-workspace-disclosure--delete"');
    expect(formTemplate).toContain("name: 'targetContainer'");
    expect(formTemplate).toContain('type="submit" form="note-move-form">Move Page</button>');
    expect(formTemplate).toContain('type="submit" form="note-delete-form" data-confirm=');
    expect(formTemplate).toContain('<form id="note-move-form" method="post" action="/notes/{{ note.id }}/move" hidden>');
    expect(formTemplate).toContain('<form id="note-delete-form" method="post" action="/notes/{{ note.id }}/delete" hidden>');
    expect(moveFormStart).toBeGreaterThan(mainFormEnd);
    expect(deleteFormStart).toBeGreaterThan(moveFormStart);
    expect(formTemplate.slice(mainFormEnd, moveFormStart)).not.toContain('<form');
    expect(formTemplate).toContain("['form', 'note-move-form']");
    expect(formTemplate).toContain('action="/notes/{{ note.id }}/move"');
    expect(formTemplate).toContain('action="/notes/{{ note.id }}/delete"');
    expect(formTemplate).toContain('data-confirm="Delete this Page permanently? This cannot be undone."');
    expect(formTemplate).not.toContain('<div class="notes-page-workspace-layout">');
    expect(notesCss).toContain('.notes-workspace-secondary {');
    expect(notesCss).not.toMatch(/\.notes-workspace-secondary\s*\{[^}]*grid-column:\s*2;/);
    expect(notesCss).toContain('.notes-workspace-secondary { grid-area: actions; }');
    expect(notesCss).toContain('.notes-workspace > .notes-page-sidebar { display: contents; }');
  });
});
