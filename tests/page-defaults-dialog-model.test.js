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
});
