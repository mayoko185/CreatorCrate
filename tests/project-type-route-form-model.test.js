import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { PROJECT_TYPES } from '../src/data/project-repository.js';
import { buildNewProjectFormModel } from '../src/routes/project-create-form.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function buildFormModel(options = {}) {
  return buildNewProjectFormModel({
    tagService: { listTags: () => [] },
    pageDefaultsService: { resolve: () => 'tbd' },
    ...options,
  });
}

function lastRenderModel(renderSpy, view) {
  const call = [...renderSpy.mock.calls].reverse().find(([renderedView]) => renderedView === view);
  if (!call) throw new Error(`Expected ${view} to be rendered.`);
  return call[1];
}

function extractProjectTypeField(html) {
  return html.match(/<fieldset class="field asset-filter-multiselect-field[^"]*">\s*<legend>Project type[\s\S]*?<\/fieldset>/)?.[0] || '';
}

function expectProjectTypeDropdown(html, selectedProjectType, { error = false } = {}) {
  const field = extractProjectTypeField(html);
  const isAllowedProjectType = PROJECT_TYPES.includes(selectedProjectType);
  const selectedLabel = selectedProjectType.replace(/\b\w/g, (character) => character.toUpperCase());

  expect(field).not.toBe('');
  expect(field).toContain('asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown');
  expect(field).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
  expect(field).toContain('id="project-type-form-trigger" aria-controls="project-type-form-options"');
  expect(field).toContain('class="asset-filter-multiselect-panel" role="radiogroup" aria-label="Project type options"');
  expect(field).not.toContain('<select');
  expect(field).toContain('name="projectType"');
  expect(field).toContain('value="images"');
  expect(field).toContain('value="comic"');
  expect(field).toContain('value="animation"');
  expect(field).toContain('value="wallpaper"');
  expect(field).toContain('Images');
  expect(field).toContain('Comic');
  expect(field).toContain('Animation');
  expect(field).toContain('Wallpaper');
  if (isAllowedProjectType) {
    expect(field).toMatch(new RegExp(`name="projectType"[^>]*value="${selectedProjectType}"[^>]*checked`));
    expect(field).toContain(`data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">${selectedLabel}</span>`);
    expect(field).toContain(`aria-label="Project type: ${selectedLabel}"`);
  } else {
    expect(field.match(/name="projectType"[^>]*checked/g) || []).toHaveLength(0);
    expect(field).toContain('data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current"></span>');
    expect(field).toContain('aria-label="Project type: "');
  }
  expect(field.includes('aria-describedby="projectType-error"')).toBe(error);
  expect(field.includes('aria-invalid="true"')).toBe(error);
  return field;
}

describe('Project Type route and form models', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-type-form-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function postForm(url, values) {
    return agent
      .post(url)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(new URLSearchParams({ ...values, _csrf: csrfToken }).toString());
  }

  async function createProject(values = {}) {
    const response = await postForm('/projects', {
      title: 'Project Type Test',
      status: 'tbd',
      ...values,
    }).expect(302);
    return response.headers.location;
  }

  it('new-project form model defaults Project Type to images and exposes all options', () => {
    const model = buildFormModel();

    expect(model.values.projectType).toBe('images');
    expect(model.projectTypes).toEqual(PROJECT_TYPES);
  });

  it('passes explicit Project Type values through create and edit posts', async () => {
    const location = await createProject({ projectType: 'comic' });
    const id = Number(location.replace('/projects/', ''));

    expect(db.prepare('SELECT project_type FROM projects WHERE id = ?').get(id).project_type).toBe('comic');

    await postForm(location, {
      title: 'Project Type Test',
      status: 'tbd',
      projectType: 'wallpaper',
    }).expect(302);

    expect(db.prepare('SELECT project_type FROM projects WHERE id = ?').get(id).project_type).toBe('wallpaper');
  });

  it('maps the stored Project Type into the normal edit form model', async () => {
    const location = await createProject({ projectType: 'animation' });
    const renderSpy = vi.spyOn(app.response, 'render');

    await agent.get(`${location}?edit=1`).expect(200);

    const model = lastRenderModel(renderSpy, 'projects/detail.njk');
    expect(model.projectEditForm.values.projectType).toBe('animation');
    expect(model.projectEditForm.projectTypes).toEqual(PROJECT_TYPES);
  });

  it('preserves submitted Project Type values and options on create and edit validation rerenders', async () => {
    const renderSpy = vi.spyOn(app.response, 'render');

    await postForm('/projects', {
      title: 'Invalid create type',
      status: 'tbd',
      projectType: 'not-a-project-type',
    }).expect(422);

    const createModel = lastRenderModel(renderSpy, 'projects/form.njk');
    expect(createModel.values.projectType).toBe('not-a-project-type');
    expect(createModel.projectTypes).toEqual(PROJECT_TYPES);

    const location = await createProject({ projectType: 'comic' });
    renderSpy.mockClear();

    await postForm(location, {
      title: 'Project Type Test',
      status: 'tbd',
      projectType: 'not-a-project-type',
    }).expect(422);

    const editModel = lastRenderModel(renderSpy, 'projects/detail.njk');
    expect(editModel.projectEditForm.values.projectType).toBe('not-a-project-type');
    expect(editModel.projectEditForm.projectTypes).toEqual(PROJECT_TYPES);
  });

  it('renders the shared Project Type dropdown for new, standalone, and edit forms', async () => {
    const [newProjectDialog, standalone] = await Promise.all([
      agent.get('/projects').expect(200),
      agent.get('/projects/new').expect(200),
    ]);

    const createDialog = newProjectDialog.text.match(/<dialog id="project-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expectProjectTypeDropdown(createDialog, 'images');
    expectProjectTypeDropdown(standalone.text, 'images');
    expect(createDialog).toContain('id="project-status-form-trigger"');
    expect(standalone.text).toContain('id="project-status-form-trigger"');

    for (const projectType of ['comic', 'animation', 'wallpaper']) {
      const location = await createProject({ projectType, title: `Stored ${projectType}` });
      const edit = await agent.get(`${location}?edit=1`).expect(200);
      const editDialog = edit.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expectProjectTypeDropdown(editDialog, projectType);
      expect(editDialog).toContain('id="project-status-form-trigger"');
    }
  });

  it('renders the Project Type validation error on invalid create and edit submissions', async () => {
    const create = await postForm('/projects', {
      title: 'Invalid create type',
      status: 'tbd',
      projectType: 'not-a-project-type',
    }).expect(422);

    expectProjectTypeDropdown(create.text, 'not-a-project-type', { error: true });
    expect(create.text).toContain('Project type must be one of: images, comic, animation, wallpaper.');
    expect(create.text).toContain('id="projectType-error"');

    const location = await createProject({ projectType: 'comic' });
    const edit = await postForm(location, {
      title: 'Project Type Test',
      status: 'tbd',
      projectType: 'not-a-project-type',
    }).expect(422);

    expectProjectTypeDropdown(edit.text, 'not-a-project-type', { error: true });
    expect(edit.text).toContain('Project type must be one of: images, comic, animation, wallpaper.');
    expect(edit.text).toContain('id="projectType-error"');
  });
});
