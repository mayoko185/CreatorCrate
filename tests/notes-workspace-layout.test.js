import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const formTemplate = fs.readFileSync(
  fileURLToPath(new URL('../src/views/notes/form.njk', import.meta.url)),
  'utf8',
);
const notesCss = fs.readFileSync(
  fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url)),
  'utf8',
);
const notesEditorJs = fs.readFileSync(
  fileURLToPath(new URL('../src/static/creatorcrate.js', import.meta.url)),
  'utf8',
);

describe('Notes workspace layout contract', () => {
  it('keeps the Book navigator, Connections, Page actions, and editor inside the normal note form', () => {
    const formStart = formTemplate.indexOf('<form id="note-form"');
    const formEnd = formTemplate.indexOf('</form>', formStart);
    const formBody = formTemplate.slice(formTemplate.indexOf('>', formStart) + 1, formEnd);
    const contextAside = formTemplate.match(/<aside class="notes-workspace-context"[\s\S]*?<\/aside>/)?.[0] || '';
    const sidebarStart = formTemplate.indexOf('<div class="notes-page-sidebar">');
    const contextStart = formTemplate.indexOf('<aside class="notes-workspace-context"');
    const connectionsStart = formTemplate.indexOf('<aside class="notes-connections"');
    const actionsStart = formTemplate.indexOf('<section class="notes-workspace-secondary"');
    const editorStart = formTemplate.indexOf('<section class="notes-workspace-editor"');

    expect(formTemplate).toContain('class="project-form notes-form notes-workspace"');
    expect(formTemplate).toContain('<div class="notes-page-workspace-layout">');
    expect(formTemplate).toContain('<div class="notes-page-sidebar">');
    expect(formTemplate).toContain('<aside class="notes-workspace-context" aria-label="Book contents">');
    expect(formTemplate).toContain('{% include "partials/book-navigator.njk" %}');
    expect(contextAside).toMatch(/<aside class="notes-workspace-context" aria-label="Book contents">\s*\{% include "partials\/book-navigator\.njk" %\}\s*<\/aside>/);
    expect(contextAside).not.toContain('Book workspace');
    expect(contextAside).not.toContain('>Hierarchy</h2>');
    expect(contextAside).not.toContain('{% include "partials/notes-hierarchy.njk" %}');
    expect(contextAside).not.toContain('notes-workspace-back');
    expect(contextAside).not.toContain('notes-workspace-context-note');
    expect(contextAside).not.toContain('Back to Chapter');
    expect(contextAside).not.toContain('Back to Book');
    expect(formTemplate).not.toContain('aria-labelledby="notes-context-heading"');
    expect(formTemplate).not.toContain('id="notes-context-heading"');
    expect(formTemplate).not.toContain('{% include "partials/notes-page-nav.njk" %}');
    expect(formTemplate).toContain('class="notes-workspace-editor"');
    expect(formTemplate).toContain('class="notes-connections"');
    expect(formTemplate).toContain('>Connections</h2>');
    expect(formTemplate).toContain('class="notes-workspace-secondary"');
    expect(formTemplate).toContain('<p class="notes-workspace-kicker" id="notes-page-actions-heading">Page actions</p>');
    expect(formTemplate).not.toContain('Secondary actions');
    expect(formTemplate).not.toContain('<h2 id="notes-page-actions-heading">Page actions</h2>');
    expect(sidebarStart).toBeGreaterThan(formStart);
    expect(sidebarStart).toBeLessThan(editorStart);
    expect(contextStart).toBeGreaterThan(sidebarStart);
    expect(connectionsStart).toBeGreaterThan(contextStart);
    expect(actionsStart).toBeGreaterThan(connectionsStart);
    expect(actionsStart).toBeLessThan(editorStart);

    expect(formTemplate).toContain('data-notes-editor-form');
    expect(formBody).toContain('data-notes-editor-host');
    expect(formBody).toContain('data-notes-editor-source');
    expect(formBody).toContain('{{ dropdown.multiSelect({');
    expect(formBody).toContain('name: "projectIds[]"');
    expect(formBody).toContain('name="assetIds[]"');
    expect(formBody).toContain('label: "Projects"');
    expect(formBody).toContain('>Assets</legend>');
    expect(formBody).not.toContain('<form');
  });

  it('keeps the editor minimum on the component and fallback, not structural wrappers', () => {
    expect(notesEditorJs).not.toContain("minHeight: '60vh'");
    expect(notesCss).toContain('--notes-editor-min-height: clamp(16rem, 40vh, 28rem);');
    const wrapperRule = notesCss.match(/\.notes-workspace \.notes-editor,\s*\.notes-workspace \.notes-editor-host\s*\{[^}]*\}/)?.[0] || '';
    const fallbackRule = notesCss.match(/\.notes-workspace \[data-notes-editor-source\]\s*\{[^}]*\}/)?.[0] || '';
    const editorRootRule = notesCss.match(/\.notes-workspace \.notes-editor \.toastui-editor-defaultUI\s*\{[^}]*\}/)?.[0] || '';
    const editorMainRule = notesCss.match(/\.notes-workspace \.notes-editor \.toastui-editor-defaultUI > \.toastui-editor-main\s*\{[^}]*\}/)?.[0] || '';
    const mainContainerRule = notesCss.match(/\.notes-workspace \.notes-editor \.toastui-editor-main-container\s*\{[^}]*\}/)?.[0] || '';
    const writingSurfaceRule = notesCss.match(/\.notes-workspace \.notes-editor \.toastui-editor-ww-container,[\s\S]*?\{[^}]*\}/)?.[0] || '';
    expect(wrapperRule).not.toContain('min-height');
    expect(fallbackRule).toContain('min-height: var(--notes-editor-min-height);');
    expect(editorRootRule).toContain('min-height: var(--notes-editor-min-height);');
    expect(editorRootRule).toContain('display: flex;');
    expect(editorRootRule).toContain('flex-direction: column;');
    expect(editorMainRule).toContain('flex: 1 1 auto;');
    expect(editorMainRule).toContain('min-height: 0;');
    expect(mainContainerRule).toContain('position: absolute;');
    expect(mainContainerRule).toContain('inset: 0;');
    expect(writingSurfaceRule).toContain('height: 100%;');
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

  it('keeps Edit-only movement and deletion in separate valid forms', () => {
    const mainFormEnd = formTemplate.indexOf('</form>');
    const moveFormStart = formTemplate.indexOf('<form id="note-move-form"');
    const deleteFormStart = formTemplate.indexOf('<form id="note-delete-form"');

    expect(formTemplate).toContain("{% set submitLabel = 'Save' if action == 'Edit' else 'Create' %}");
    expect(formTemplate).toContain('form="note-form">{{ submitLabel }}</button>');
    expect(formTemplate).toContain('class="notes-workspace-disclosure notes-workspace-disclosure--move"');
    expect(formTemplate).toContain('class="notes-workspace-disclosure notes-workspace-disclosure--delete"');
    expect(formTemplate).toContain('name="targetContainer" required form="note-move-form"');
    expect(formTemplate).toContain('type="submit" form="note-move-form">Move Page</button>');
    expect(formTemplate).toContain('type="submit" form="note-delete-form" data-confirm=');
    expect(formTemplate).toContain('<form id="note-move-form" method="post" action="/notes/{{ note.id }}/move" hidden>');
    expect(formTemplate).toContain('<form id="note-delete-form" method="post" action="/notes/{{ note.id }}/delete" hidden>');
    expect(moveFormStart).toBeGreaterThan(mainFormEnd);
    expect(deleteFormStart).toBeGreaterThan(moveFormStart);
    expect(formTemplate.slice(mainFormEnd, moveFormStart)).not.toContain('<form');
    expect(formTemplate).toContain('name="targetContainer"');
    expect(formTemplate).toContain('action="/notes/{{ note.id }}/move"');
    expect(formTemplate).toContain('action="/notes/{{ note.id }}/delete"');
    expect(formTemplate).toContain('data-confirm="Delete this Page permanently? This cannot be undone."');
    expect(formTemplate).toContain('<div class="notes-page-workspace-layout">');
    expect(notesCss).toContain('.notes-workspace-secondary {');
    expect(notesCss).not.toMatch(/\.notes-workspace-secondary\s*\{[^}]*grid-column:\s*2;/);
    expect(notesCss).toContain('.notes-workspace-secondary { grid-area: actions; }');
    expect(notesCss).toContain('.notes-workspace > .notes-page-sidebar { display: contents; }');
  });
});
