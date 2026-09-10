import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { buildNewProjectFormModel, createFormValues } from '../src/routes/project-create-form.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const BUILT_IN_PROJECT_TYPES = ['images', 'comic', 'animation', 'wallpaper'];
const BUILT_IN_PROJECT_TYPE_OPTIONS = BUILT_IN_PROJECT_TYPES.map((value) => ({
  value,
  label: value.replace(/\b\w/g, (character) => character.toUpperCase()),
  color: '#123456',
}));

function buildFormModel(options = {}) {
  return buildNewProjectFormModel({
    tagService: { listTags: () => [] },
    pageDefaultsService: {
      resolve: () => 'tbd',
      getSavedDefault(_page, option) {
        return option === 'status' ? 'tbd' : 'images';
      },
      getOptionCatalogue(page, option) {
        if (page === 'new_project' && option === 'status') {
          return ['tbd', 'planned', 'in-progress', 'ready', 'completed']
            .map((value) => ({ value, label: `Label ${value}`, color: '#123456' }));
        }
        return BUILT_IN_PROJECT_TYPE_OPTIONS;
      },
    },
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
  const isAllowedProjectType = BUILT_IN_PROJECT_TYPES.includes(selectedProjectType);
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
    expect(model.projectTypes).toEqual(BUILT_IN_PROJECT_TYPE_OPTIONS);
  });

  it('observes newly added Status and Type options without rebuilding the app', async () => {
    app.locals.projectOptionCatalogueService.addOption('status', {
      name: 'Client Review',
      color: '#123456',
    });
    app.locals.projectOptionCatalogueService.addOption('projectType', {
      name: 'Interactive Story',
      color: '#654321',
    });

    const response = await agent.get('/projects/new').expect(200);
    expect(response.text).toContain('name="status" type="radio" value="client-review"');
    expect(response.text).toContain('name="projectType" type="radio" value="interactive-story"');
  });

  it('uses changed saved Status and Type defaults for the next shared form and omitted create', async () => {
    const status = app.locals.projectOptionCatalogueService.addOption('status', {
      name: 'Client Review',
      color: '#123456',
    });
    const projectType = app.locals.projectOptionCatalogueService.addOption('projectType', {
      name: 'Interactive Story',
      color: '#654321',
    });
    app.locals.pageDefaultsService.saveDefault('new_project', 'status', status.value);
    app.locals.pageDefaultsService.saveDefault('new_project', 'projectType', projectType.value);

    const form = await agent.get('/projects/new').expect(200);
    expect(form.text).toContain(`name="status" type="radio" value="${status.value}" checked`);
    expect(form.text).toContain(`name="projectType" type="radio" value="${projectType.value}" checked`);

    const created = await postForm('/projects', { title: 'Configured Defaults Project' }).expect(302);
    const id = Number(created.headers.location.replace('/projects/', ''));
    expect(db.prepare('SELECT status, project_type FROM projects WHERE id = ?').get(id))
      .toEqual({ status: status.value, project_type: projectType.value });

    app.locals.pageDefaultsService.saveDefault('new_project', 'status', 'ready');
    app.locals.pageDefaultsService.saveDefault('new_project', 'projectType', 'comic');
    const changed = await agent.get('/projects').expect(200);
    const dialog = changed.text.match(/<dialog id="project-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(dialog).toContain('name="status" type="radio" value="ready" checked');
    expect(dialog).toContain('name="projectType" type="radio" value="comic" checked');
  });

  it('renders persisted labels and catalogue order while preserving values, selection, and archive exclusion', async () => {
    const status = app.locals.projectOptionCatalogueService.addOption('status', {
      name: 'Client QA Label',
      color: '#123456',
    });
    const projectType = app.locals.projectOptionCatalogueService.addOption('projectType', {
      name: 'Visual Novel Label',
      color: '#654321',
    });
    app.locals.projectOptionCatalogueService.reorderOptions('status', [
      status.value, 'tbd', 'planned', 'in-progress', 'ready', 'completed',
    ]);
    app.locals.projectOptionCatalogueService.reorderOptions('projectType', [
      projectType.value, ...BUILT_IN_PROJECT_TYPES,
    ]);

    const response = await agent.get(
      `/projects/new?status=${status.value}&projectType=${projectType.value}`,
    ).expect(200);
    const statusField = response.text.match(/id="project-status-form"[\s\S]*?<\/fieldset>/)?.[0] || '';
    const typeField = extractProjectTypeField(response.text);

    expect(statusField).toContain(`value="${status.value}" checked`);
    expect(statusField).toContain('Client QA Label');
    expect(statusField.indexOf(status.value)).toBeLessThan(statusField.indexOf('value="tbd"'));
    expect(statusField).not.toContain('value="archived"');
    expect(typeField).toContain(`value="${projectType.value}" checked`);
    expect(typeField).toContain('Visual Novel Label');
    expect(typeField.indexOf(projectType.value)).toBeLessThan(typeField.indexOf('value="images"'));

    const location = await createProject({
      title: 'Custom option selection',
      status: status.value,
      projectType: projectType.value,
    });
    const edit = await agent.get(`${location}?edit=1`).expect(200);
    const editStatusField = edit.text.match(/id="project-status-form"[\s\S]*?<\/fieldset>/)?.[0] || '';
    const editTypeField = extractProjectTypeField(edit.text);
    expect(editStatusField).toContain(`name="status" type="radio" value="${status.value}" checked`);
    expect(editStatusField).not.toContain('value="archived"');
    expect(editTypeField).toContain(`name="projectType" type="radio" value="${projectType.value}" checked`);
    const stored = db.prepare('SELECT status, project_type FROM projects WHERE id = ?')
      .get(Number(location.replace('/projects/', '')));
    expect(stored).toEqual({ status: status.value, project_type: projectType.value });
  });

  it('drops legacy Project scheduling keys from query and submitted form values', () => {
    const legacyValues = {
      title: 'Legacy scheduling input',
      plannedDate: '2026-01-01',
      publishedDate: '2026-01-02',
      planned_date: '2026-01-03',
      published_date: '2026-01-04',
    };

    expect(createFormValues(legacyValues)).toEqual({ title: 'Legacy scheduling input' });

    const queryModel = buildFormModel({ query: legacyValues });
    const submittedModel = buildFormModel({ values: legacyValues });
    for (const key of ['plannedDate', 'publishedDate', 'planned_date', 'published_date']) {
      expect(queryModel.values).not.toHaveProperty(key);
      expect(submittedModel.values).not.toHaveProperty(key);
    }
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
    expect(model.projectEditForm.projectTypes.map(({ value }) => value)).toEqual(BUILT_IN_PROJECT_TYPES);
    expect(model.projectEditForm.values).not.toHaveProperty('plannedDate');
    expect(model.projectEditForm.values).not.toHaveProperty('publishedDate');
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
    expect(createModel.projectTypes.map(({ value }) => value)).toEqual(BUILT_IN_PROJECT_TYPES);

    const location = await createProject({ projectType: 'comic' });
    renderSpy.mockClear();

    await postForm(location, {
      title: 'Project Type Test',
      status: 'tbd',
      projectType: 'not-a-project-type',
    }).expect(422);

    const editModel = lastRenderModel(renderSpy, 'projects/detail.njk');
    expect(editModel.projectEditForm.values.projectType).toBe('not-a-project-type');
    expect(editModel.projectEditForm.projectTypes.map(({ value }) => value)).toEqual(BUILT_IN_PROJECT_TYPES);
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
