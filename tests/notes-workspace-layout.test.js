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
  it('keeps hierarchy, editor, and Connections inside the normal note form', () => {
    const formStart = formTemplate.indexOf('<form id="note-form"');
    const formEnd = formTemplate.indexOf('</form>', formStart);
    const formBody = formTemplate.slice(formTemplate.indexOf('>', formStart) + 1, formEnd);

    expect(formTemplate).toContain('class="project-form notes-form notes-workspace"');
    expect(formTemplate).toContain('class="notes-workspace-context"');
    expect(formTemplate).toContain('Book workspace');
    expect(formTemplate).toContain('>Hierarchy</h2>');
    expect(formTemplate).toContain('{% include "partials/notes-hierarchy.njk" %}');
    expect(formTemplate).toContain('>Back to Chapter</a>');
    expect(formTemplate).toContain('class="notes-workspace-editor"');
    expect(formTemplate).toContain('class="notes-connections"');
    expect(formTemplate).toContain('>Connections</h2>');

    expect(formTemplate).toContain('data-notes-editor-form');
    expect(formBody).toContain('data-notes-editor-host');
    expect(formBody).toContain('data-notes-editor-source');
    expect(formBody).toContain('name="projectIds[]"');
    expect(formBody).toContain('name="assetIds[]"');
    expect(formBody).toContain('>Projects</legend>');
    expect(formBody).toContain('>Assets</legend>');
    expect(formBody).not.toContain('<form');
  });

  it('uses one CSS-owned editor minimum and a single-column responsive fallback', () => {
    expect(notesEditorJs).not.toContain("minHeight: '60vh'");
    expect(notesCss).toContain('--notes-editor-min-height: clamp(20rem, 60vh, 42rem);');
    expect(notesCss).toContain('min-height: var(--notes-editor-min-height);');
    expect(formTemplate).not.toContain('data-notes-editor-source rows=');
    expect(notesCss).toContain('@media (max-width: 1023px)');
    expect(notesCss).toContain('grid-template-areas: "context" "editor" "connections";');
  });

  it('keeps Edit-only movement and deletion in separate valid forms', () => {
    const mainFormEnd = formTemplate.indexOf('</form>');
    const moveFormStart = formTemplate.indexOf('<form id="note-move-form"');
    const deleteFormStart = formTemplate.indexOf('<form id="note-delete-form"');

    expect(formTemplate).toContain("{% set submitLabel = 'Save' if action == 'Edit' else 'Create' %}");
    expect(formTemplate).toContain('form="note-form">{{ submitLabel }}</button>');
    expect(formTemplate).toContain('class="notes-workspace-secondary"');
    expect(formTemplate).toContain('class="notes-workspace-disclosure notes-workspace-disclosure--move"');
    expect(formTemplate).toContain('class="notes-workspace-disclosure notes-workspace-disclosure--delete"');
    expect(moveFormStart).toBeGreaterThan(mainFormEnd);
    expect(deleteFormStart).toBeGreaterThan(moveFormStart);
    expect(formTemplate.slice(mainFormEnd, moveFormStart)).not.toContain('<form');
    expect(formTemplate).toContain('name="targetContainer"');
    expect(formTemplate).toContain('action="/notes/{{ note.id }}/move"');
    expect(formTemplate).toContain('action="/notes/{{ note.id }}/delete"');
    expect(formTemplate).toContain('data-confirm="Delete this Page permanently? This cannot be undone."');
  });
});
