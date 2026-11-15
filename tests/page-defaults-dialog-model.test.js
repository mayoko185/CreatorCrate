import { describe, expect, it } from 'vitest';
import {
  buildPageDefaultsDialogModel,
  handlePageDefaultsPost,
} from '../src/routes/page-defaults.js';


const labels = {
  fields: {
    view: 'View',
    sort: 'Sort',
    order: 'Order',
  },
  options: {
    view: { grid: 'Grid', list: 'List' },
    sort: { updated: 'Updated', created: 'Created', title: 'Title', published: 'Published' },
    order: { asc: 'Ascending', desc: 'Descending' },
  },
};

describe('page defaults dialog model', () => {
  it('renders a supplied live catalogue and keeps static options unchanged', () => {
    const optionCatalogues = {
      sort: [
        { value: 'all', label: 'All projects' },
        { value: 'recent', label: 'Recently updated' },
      ],
    };
    const calls = [];
    const pageDefaultsService = {
      resolvePageDefaults(...args) {
        calls.push(args);
        return { view: 'grid', sort: 'all', order: 'desc' };
      },
    };

    const model = buildPageDefaultsDialogModel({
      pageDefaultsService,
      page: 'projects',
      labels,
      optionCatalogues,
    });

    expect(calls).toEqual([['projects', {}, optionCatalogues]]);
    expect(model.fields.find((field) => field.name === 'sort')).toMatchObject({
      selectedValue: 'all',
      options: optionCatalogues.sort,
    });
    expect(model.fields.find((field) => field.name === 'view').options).toEqual([
      { value: 'grid', label: 'Grid' },
      { value: 'list', label: 'List' },
    ]);
  });


  it('keeps the existing service call contract when no catalogue is supplied', () => {
    const calls = [];
    const model = buildPageDefaultsDialogModel({
      pageDefaultsService: {
        resolvePageDefaults(...args) {
          calls.push(args);
          return { view: 'grid', sort: 'created', order: 'desc' };
        },
      },
      page: 'projects',
      labels,
    });

    expect(calls).toEqual([['projects']]);
    expect(model.fields.find((field) => field.name === 'sort').options).toEqual([
      { value: 'updated', label: 'Updated' },
      { value: 'created', label: 'Created' },
      { value: 'title', label: 'Title' },
      { value: 'published', label: 'Published' },
    ]);
  });

  it('preserves a rejected submitted value outside the supplied live catalogue', () => {
    const model = buildPageDefaultsDialogModel({
      pageDefaultsService: { resolvePageDefaults: () => ({}) },
      page: 'projects',
      labels,
      optionCatalogues: { sort: [{ value: 'all', label: 'All projects' }] },
      submittedValues: { view: 'grid', sort: 'retired', order: 'desc' },
      errors: { sort: 'Value is not supported.' },
    });

    expect(model.fields.find((field) => field.name === 'sort')).toMatchObject({
      selectedValue: 'retired',
      options: [{ value: 'all', label: 'All projects' }],
      showSubmittedValue: true,
      submittedOptionValue: 'retired',
    });
  });


  it('passes supplied live catalogues through the shared post handler', () => {
    const optionCatalogues = { tag: [{ value: '42', label: 'Featured projects' }] };
    const values = {
      view: 'grid',
      gridStyle: 'cropped',
      sort: 'created',
      order: 'desc',
      status: 'all',
      projectType: 'all',
      tag: '42',
    };
    const validationCalls = [];
    const saveCalls = [];
    let success;

    handlePageDefaultsPost({ body: values }, {}, expect.unreachable, {
      page: 'projects',
      optionCatalogues,
      pageDefaultsService: {
        validatePageDefaults(...args) {
          validationCalls.push(args);
          return values;
        },
        saveDefault(...args) {
          saveCalls.push(args);
        },
      },
      onSuccess(result) {
        success = result;
      },
    });

    expect(validationCalls).toEqual([['projects', values, optionCatalogues]]);
    expect(saveCalls).toEqual([
      ['projects', 'view', 'grid'],
      ['projects', 'gridStyle', 'cropped'],
      ['projects', 'sort', 'created'],
      ['projects', 'order', 'desc'],
      ['projects', 'status', 'all'],
      ['projects', 'projectType', 'all'],
      ['projects', 'tag', '42', optionCatalogues.tag],
    ]);
    expect(success).toEqual({ validatedValues: values });
  });

  it('marks Project Assets Extension and Tag as multi-select fields', () => {
    const optionCatalogues = {
      extension: [
        { value: 'all', label: 'All extensions' },
        { value: 'jpg', label: '.jpg' },
        { value: 'png', label: '.png' },
      ],
      tag: [
        { value: 'all', label: 'All tags' },
        { value: '1', label: 'First tag' },
        { value: '2', label: 'Second tag' },
      ],
    };
    const model = buildPageDefaultsDialogModel({
      pageDefaultsService: {
        resolvePageDefaults: () => ({
          view: 'grid',
          gridSize: 'default',
          listSize: 'large',
          sort: 'filename',
          order: 'asc',
          pageSize: '25',
          extension: ['jpg', 'png'],
          tag: ['1', '2'],
        }),
      },
      page: 'projectAssets',
      labels: {
        fields: {
          view: 'View', gridSize: 'Grid size', listSize: 'List size', sort: 'Sort',
          order: 'Order', pageSize: 'Page size', extension: 'Extension', tag: 'Tag',
        },
        options: {},
      },
      optionCatalogues,
    });

    expect(model.fields.find((field) => field.name === 'extension')).toMatchObject({
      multi: true,
      selectedValues: ['jpg', 'png'],
      options: [{ value: 'jpg', label: '.jpg' }, { value: 'png', label: '.png' }],
    });
    expect(model.fields.find((field) => field.name === 'tag')).toMatchObject({
      multi: true,
      selectedValues: ['1', '2'],
      options: [{ value: '1', label: 'First tag' }, { value: '2', label: 'Second tag' }],
    });
    expect(model.fields.find((field) => field.name === 'view')).toMatchObject({
      selectedValue: 'grid',
    });
    expect(model.fields.find((field) => field.name === 'view')).not.toHaveProperty('multi');
    expect(model.fields.map((field) => field.name)).not.toContain('gridDetails');
  });

  it('marks only Asset Viewer Extension, Category (WP2) and Tag as multi-select fields', () => {
    const model = buildPageDefaultsDialogModel({
      pageDefaultsService: {
        resolvePageDefaults: () => ({
          view: 'grid', sort: 'filename', order: 'asc', pageSize: '25',
          extension: ['jpg', 'png'], category: ['uncategorized', 'videos'], presence: 'all', tag: ['1', '2'],
        }),
      },
      page: 'assetViewer',
      labels: {
        fields: {
          view: 'View', sort: 'Sort', order: 'Order', pageSize: 'Page size',
          extension: 'Extension', category: 'Category', presence: 'Presence', tag: 'Tag',
        },
        options: {},
      },
      optionCatalogues: {
        extension: [
          { value: 'all', label: 'All extensions' },
          { value: 'jpg', label: '.jpg' },
          { value: 'png', label: '.png' },
        ],
        category: [
          { value: 'all', label: 'All categories' },
          { value: 'uncategorized', label: 'Uncategorized' },
          { value: 'videos', label: 'Videos' },
        ],
        tag: [
          { value: 'all', label: 'All tags' },
          { value: '1', label: 'First tag' },
          { value: '2', label: 'Second tag' },
        ],
      },
    });

    expect(model.fields.filter((field) => field.multi).map((field) => field.name))
      .toEqual(['extension', 'category', 'tag']);
    expect(model.fields.find((field) => field.name === 'category')).toMatchObject({
      selectedValues: ['uncategorized', 'videos'],
      emptySummary: 'All categories',
      options: [{ value: 'uncategorized', label: 'Uncategorized' }, { value: 'videos', label: 'Videos' }],
    });
    expect(model.fields.find((field) => field.name === 'extension').emptySummary).toBe('All extensions');
    expect(model.fields.find((field) => field.name === 'extension')).toMatchObject({
      selectedValues: ['jpg', 'png'],
      options: [{ value: 'jpg', label: '.jpg' }, { value: 'png', label: '.png' }],
    });
    expect(model.fields.find((field) => field.name === 'tag')).toMatchObject({
      selectedValues: ['1', '2'],
      options: [{ value: '1', label: 'First tag' }, { value: '2', label: 'Second tag' }],
    });
    expect(model.fields.filter((field) => !field.multi).map((field) => field.name))
      .toEqual(['view', 'gridStyle', 'sort', 'order', 'pageSize', 'presence']);
  });

  it('WP2 renders Projects Status, Type and Tag as multivalue fields whose empty selection keeps the all label', () => {
    const model = buildPageDefaultsDialogModel({
      pageDefaultsService: {
        resolvePageDefaults: () => ({
          view: 'grid', gridStyle: 'uncropped', sort: 'created', order: 'desc',
          status: ['planned', 'archived'], projectType: 'all', tag: ['7'],
        }),
      },
      page: 'projects',
      labels: { fields: {}, options: {} },
      optionCatalogues: {
        status: [
          { value: 'all', label: 'All active' },
          { value: 'planned', label: 'Planned' },
          { value: 'archived', label: 'Archived' },
        ],
        projectType: [{ value: 'all', label: 'All types' }, { value: 'comic', label: 'Comic' }],
        tag: [{ value: 'all', label: 'All tags' }, { value: '7', label: 'Seven' }],
      },
    });

    expect(model.fields.filter((field) => field.multi).map((field) => field.name))
      .toEqual(['status', 'projectType', 'tag']);
    expect(model.fields.find((field) => field.name === 'status')).toMatchObject({
      selectedValues: ['planned', 'archived'],
      emptySummary: 'All active',
      options: [{ value: 'planned', label: 'Planned' }, { value: 'archived', label: 'Archived' }],
    });
    expect(model.fields.find((field) => field.name === 'projectType')).toMatchObject({
      selectedValues: [],
      emptySummary: 'All types',
    });
    expect(model.fields.find((field) => field.name === 'tag').emptySummary).toBe('All tags');
    expect(model.fields.find((field) => field.name === 'view')).not.toHaveProperty('emptySummary');
  });

  it('F2 keeps submitted singleton, multiple and all multivalue selections on a validation rerender', () => {
    const model = buildPageDefaultsDialogModel({
      pageDefaultsService: { resolvePageDefaults: expect.unreachable },
      page: 'projects',
      labels: { fields: {}, options: {} },
      // A non-JSON form post: one checked option arrives as a plain string.
      submittedValues: {
        view: 'grid', gridStyle: 'stretched', sort: 'created', order: 'desc',
        status: 'planned', projectType: 'comic', tag: '7',
      },
      errors: { gridStyle: 'Grid style "stretched" is not supported.' },
      optionCatalogues: {
        status: [{ value: 'all', label: 'All active' }, { value: 'planned', label: 'Planned' }],
        projectType: [{ value: 'all', label: 'All types' }, { value: 'comic', label: 'Comic' }],
        tag: [{ value: 'all', label: 'All tags' }, { value: '7', label: 'Seven' }],
      },
    });
    const field = (name) => model.fields.find((candidate) => candidate.name === name);

    expect(field('status').selectedValues).toEqual(['planned']);
    expect(field('projectType').selectedValues).toEqual(['comic']);
    expect(field('tag').selectedValues).toEqual(['7']);
    expect(field('gridStyle')).toMatchObject({ error: 'Grid style "stretched" is not supported.' });

    const rerender = (status) => buildPageDefaultsDialogModel({
      pageDefaultsService: { resolvePageDefaults: expect.unreachable },
      page: 'projects',
      labels: { fields: {}, options: {} },
      submittedValues: { view: 'grid', gridStyle: 'stretched', sort: 'created', order: 'desc', status, projectType: 'all', tag: 'all' },
      errors: { gridStyle: 'invalid' },
    }).fields;
    const [multiple, all, empty] = [['planned', 'archived'], 'all', undefined].map(rerender);
    expect(multiple.find(({ name }) => name === 'status').selectedValues).toEqual(['planned', 'archived']);
    for (const fields of [all, empty]) {
      for (const name of ['status', 'projectType', 'tag']) {
        expect(fields.find((candidate) => candidate.name === name).selectedValues).toEqual([]);
      }
    }
  });

  it('maps omitted Asset Viewer multi-select controls to neutral all', () => {
    const validationCalls = [];

    handlePageDefaultsPost({ body: {
      view: 'grid', sort: 'filename', order: 'asc', pageSize: '25', category: 'all', presence: 'all',
    } }, {}, expect.unreachable, {
      page: 'assetViewer',
      pageDefaultsService: {
        validatePageDefaults(...args) {
          validationCalls.push(args);
          return args[1];
        },
        saveDefault() {},
      },
      onSuccess() {},
    });

    expect(validationCalls[0][1]).toMatchObject({ extension: 'all', tag: 'all' });
  });

  it('preserves repeated Project Assets values and maps an omitted multi-select to all', () => {
    const values = {
      view: 'grid',
      gridSize: 'default',
      listSize: 'large',
      sort: 'filename',
      order: 'asc',
      pageSize: '25',
      extension: ['jpg', 'png'],
      tag: ['1', '2'],
    };
    const validationCalls = [];

    handlePageDefaultsPost({ body: values }, {}, expect.unreachable, {
      page: 'projectAssets',
      optionCatalogues: {
        extension: [{ value: 'jpg' }, { value: 'png' }],
        tag: [{ value: '1' }, { value: '2' }],
      },
      pageDefaultsService: {
        validatePageDefaults(...args) {
          validationCalls.push(args);
          return args[1];
        },
        saveDefault() {},
      },
      onSuccess() {},
    });

    handlePageDefaultsPost({ body: {
      view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename',
      order: 'asc', pageSize: '25',
    } }, {}, expect.unreachable, {
      page: 'projectAssets',
      pageDefaultsService: {
        validatePageDefaults(...args) {
          validationCalls.push(args);
          return args[1];
        },
        saveDefault() {},
      },
      onSuccess() {},
    });

    expect(validationCalls[0][1]).toMatchObject({
      extension: ['jpg', 'png'],
      tag: ['1', '2'],
    });
    expect(validationCalls[1][1]).toMatchObject({
      extension: 'all',
      tag: 'all',
    });
  });
});
