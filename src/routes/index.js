import express from 'express';
import {
  DASHBOARD_DEFAULTS_VERSION,
  DASHBOARD_ITEM_COUNT_MAX,
  DASHBOARD_ITEM_COUNT_MIN,
  DASHBOARD_SECTION_REGISTRY,
} from '../services/dashboard-defaults-service.js';
import { renderDashboardPage } from './dashboard-render.js';

const DASHBOARD_DEFAULTS_SAVED_NOTICE = 'dashboard_defaults_saved';
const DASHBOARD_DEFAULTS_SAVED_MESSAGE = 'Dashboard defaults saved successfully.';
const DASHBOARD_DEFAULTS_VALIDATION_MESSAGE = 'Dashboard defaults could not be saved. Fix the invalid fields and try again.';

function getDashboardDefaultsService(req) {
  const service = req.app?.locals?.dashboardDefaultsService;
  if (!service) {
    throw new Error('Dashboard requires app.locals.dashboardDefaultsService.');
  }
  return service;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEnhancedRequest(req) {
  return String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
}

function parseVisibility(value) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 2
    && values.every((item) => typeof item === 'string')
    && new Set(values).size === 2
    && values.includes('0')
    && values.includes('1')) {
    return true;
  }
  if (values.length === 1 && values[0] === '0') return false;
  if (values.length === 1 && values[0] === '1') return true;
  return null;
}

function flattenDashboardDefaultsErrors(errors) {
  const flatErrors = {};
  if (typeof errors.order === 'string') flatErrors.order = errors.order;

  for (const [sectionId, sectionErrors] of Object.entries(errors.sections || {})) {
    for (const [field, message] of Object.entries(sectionErrors)) {
      flatErrors[`sections[${sectionId}][${field}]`] = message;
    }
  }
  return flatErrors;
}

function parseDashboardDefaultsSubmission(body) {
  const rawBody = isPlainObject(body) ? body : {};
  const sectionIds = DASHBOARD_SECTION_REGISTRY.map(({ id }) => id);
  const sectionIdSet = new Set(sectionIds);
  const rawSections = isPlainObject(rawBody.sections) ? rawBody.sections : {};
  const errors = { sections: {} };
  const values = {
    orderedSectionIds: rawBody.orderedSectionIds,
    sections: {},
  };
  let order = null;

  if (typeof rawBody.orderedSectionIds !== 'string') {
    errors.order = 'Section order is required.';
  } else {
    const submittedOrder = rawBody.orderedSectionIds.split(',');
    const duplicates = submittedOrder.filter((sectionId, index) => submittedOrder.indexOf(sectionId) !== index);
    const unknownIds = submittedOrder.filter((sectionId) => !sectionIdSet.has(sectionId));
    const missingIds = sectionIds.filter((sectionId) => !submittedOrder.includes(sectionId));

    if (duplicates.length > 0) {
      errors.order = 'Section order contains duplicate sections.';
    } else if (unknownIds.length > 0) {
      errors.order = 'Section order contains an unsupported section.';
    } else if (missingIds.length > 0 || submittedOrder.length !== sectionIds.length) {
      errors.order = 'Section order must include every Dashboard section exactly once.';
    } else {
      order = submittedOrder;
    }
  }

  if (Object.keys(rawSections).some((sectionId) => !sectionIdSet.has(sectionId))) {
    errors.order = 'Submitted configuration contains an unsupported section.';
  }

  for (const sectionId of sectionIds) {
    const rawSection = isPlainObject(rawSections[sectionId]) ? rawSections[sectionId] : {};
    const sectionErrors = {};
    const visible = parseVisibility(rawSection.visible);
    const itemCount = rawSection.itemCount;

    if (visible === null) {
      sectionErrors.visible = 'Show section must be explicitly enabled or disabled.';
    }

    let parsedItemCount = null;
    if (typeof itemCount !== 'string' || itemCount === '') {
      sectionErrors.itemCount = 'Items to show is required.';
    } else if (!/^\d+$/.test(itemCount)) {
      sectionErrors.itemCount = 'Items to show must be an integer.';
    } else {
      parsedItemCount = Number(itemCount);
      if (!Number.isSafeInteger(parsedItemCount)) {
        sectionErrors.itemCount = 'Items to show must be an integer.';
      } else if (parsedItemCount < DASHBOARD_ITEM_COUNT_MIN || parsedItemCount > DASHBOARD_ITEM_COUNT_MAX) {
        sectionErrors.itemCount = `Items to show must be between ${DASHBOARD_ITEM_COUNT_MIN} and ${DASHBOARD_ITEM_COUNT_MAX}.`;
      }
    }

    values.sections[sectionId] = {
      visible: visible === null ? false : visible,
      itemCount,
    };
    if (Object.keys(sectionErrors).length > 0) errors.sections[sectionId] = sectionErrors;
  }

  const valid = !errors.order && Object.keys(errors.sections).length === 0;
  if (valid) {
    return {
      valid,
      values: {
        version: DASHBOARD_DEFAULTS_VERSION,
        order,
        sections: Object.fromEntries(sectionIds.map((sectionId) => [sectionId, {
          visible: values.sections[sectionId].visible,
          itemCount: Number(values.sections[sectionId].itemCount),
        }])),
      },
    };
  }

  return { valid, errors, values, validOrder: order };
}

export function createIndexRouter({
  appName,
  workflowQueryService,
  pageDefaultsService,
  tagService,
} = {}) {
  if (!pageDefaultsService) {
    throw new Error('createIndexRouter requires a pageDefaultsService dependency.');
  }
  if (!tagService) {
    throw new Error('createIndexRouter requires a tagService dependency.');
  }

  const router = express.Router();

  router.get('/', (req, res, next) => {
    renderDashboardPage(req, res, next, {
      appName,
      workflowQueryService,
      pageDefaultsService,
      tagService,
    });
  });

  router.post('/dashboard/defaults', (req, res, next) => {
    const enhanced = isEnhancedRequest(req);
    const submission = parseDashboardDefaultsSubmission(req.body);

    if (!submission.valid) {
      if (enhanced) {
        res.status(422).json({
          status: 'error',
          message: DASHBOARD_DEFAULTS_VALIDATION_MESSAGE,
          errors: flattenDashboardDefaultsErrors(submission.errors),
          values: submission.values,
        });
        return;
      }

      renderDashboardPage(req, res, next, {
        appName,
        workflowQueryService,
        pageDefaultsService,
        tagService,
        status: 422,
        dashboardDefaultsDialogOpen: true,
        dashboardDefaultsFormState: {
          generalError: DASHBOARD_DEFAULTS_VALIDATION_MESSAGE,
          fieldErrors: submission.errors.sections,
          order: submission.validOrder,
          sections: submission.values.sections,
        },
      });
      return;
    }

    try {
      getDashboardDefaultsService(req).saveDefaults(submission.values);
      if (enhanced) {
        res.json({
          status: 'success',
          message: DASHBOARD_DEFAULTS_SAVED_MESSAGE,
          values: {},
        });
        return;
      }
      res.redirect(`/?notice=${DASHBOARD_DEFAULTS_SAVED_NOTICE}`);
    } catch (err) {
      if (enhanced) {
        res.status(500).json({
          status: 'error',
          message: 'Dashboard defaults could not be saved. No changes were made.',
        });
        return;
      }
      next(err);
    }
  });

  return router;
}
