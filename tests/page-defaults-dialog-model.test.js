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
      ['projects', 'sort', 'created'],
      ['projects', 'order', 'desc'],
      ['projects', 'status', 'all'],
      ['projects', 'projectType', 'all'],
      ['projects', 'tag', '42', optionCatalogues.tag],
    ]);
    expect(success).toEqual({ validatedValues: values });
  });

  it('marks only Project Assets Extension and Tag as multi-select fields', () => {
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
          gridDetails: 'shown',
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
          view: 'View', gridSize: 'Grid size', listSize: 'List size', gridDetails: 'Grid card details', sort: 'Sort',
          order: 'Order', pageSize: 'Page size', extension: 'Extension', tag: 'Tag',
        },
        options: { gridDetails: { shown: 'Show details below previews', hidden: 'Hide details below previews' } },
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
    expect(model.fields.find((field) => field.name === 'gridDetails')).toMatchObject({
      selectedValue: 'shown',
      options: [
        { value: 'shown', label: 'Show details below previews' },
        { value: 'hidden', label: 'Hide details below previews' },
      ],
    });
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
