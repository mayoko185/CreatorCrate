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
    const formBody = formTemplate.slice(formStart, formEnd);

    expect(formTemplate).toContain('class="project-form notes-form notes-workspace"');
    expect(formTemplate).toContain('class="notes-workspace-context"');
    expect(formTemplate).toContain('Book workspace');
    expect(formTemplate).toContain('>Hierarchy</h2>');
    expect(formTemplate).toContain('>Back to Chapter</a>');
    expect(formTemplate).toContain('class="notes-workspace-editor"');
    expect(formTemplate).toContain('class="notes-connections"');
    expect(formTemplate).toContain('>Connections</h2>');

    expect(formBody).toContain('data-notes-editor-form');
    expect(formBody).toContain('data-notes-editor-host');
    expect(formBody).toContain('data-notes-editor-source');
    expect(formBody).toContain('name="projectIds[]"');
    expect(formBody).toContain('name="assetIds[]"');
    expect(formBody).toContain('>Projects</legend>');
    expect(formBody).toContain('>Assets</legend>');
  });

  it('uses a viewport-aware editor minimum and a single-column responsive fallback', () => {
    expect(notesEditorJs).toContain("minHeight: '60vh'");
    expect(notesCss).toContain('min-height: clamp(30rem, 60vh, 52rem) !important;');
    expect(notesCss).toContain('@media (max-width: 1023px)');
    expect(notesCss).toContain('grid-template-areas: "context" "editor" "connections";');
  });
});
