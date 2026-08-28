import {
  isEnhancementBound,
  markEnhancementBound,
} from './dom.js';

const CATEGORY_SLUG_AUTOFILL_FORM_SELECTOR = '[data-category-slug-autofill-form]';
const CATEGORY_SLUG_AUTOFILL_DISPLAY_NAME_SELECTOR = '[data-category-slug-autofill-display-name]';
const CATEGORY_SLUG_AUTOFILL_DIRECTORY_SLUG_SELECTOR = '[data-category-slug-autofill-directory-slug]';
const RESERVED_DIRECTORY_SLUGS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function directorySlugFromDisplayName(value) {
  const slug = String(value ?? '')
    .trim()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return RESERVED_DIRECTORY_SLUGS.has(slug) ? '' : slug;
}

export function enhanceCategorySlugAutofill(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const forms = scope.querySelectorAll(CATEGORY_SLUG_AUTOFILL_FORM_SELECTOR);
  forms.forEach((form) => {
    if (isEnhancementBound(form, 'categorySlugAutofillBound')) return;
    const displayName = form.querySelector?.(CATEGORY_SLUG_AUTOFILL_DISPLAY_NAME_SELECTOR);
    const directorySlug = form.querySelector?.(CATEGORY_SLUG_AUTOFILL_DIRECTORY_SLUG_SELECTOR);
    if (!displayName || !directorySlug) return;

    markEnhancementBound(form, 'categorySlugAutofillBound');
    displayName.addEventListener?.('keydown', (event) => {
      if (event.key !== 'Tab' || event.shiftKey || directorySlug.value !== '') return;
      const slug = directorySlugFromDisplayName(displayName.value);
      if (slug) directorySlug.value = slug;
    });
  });
  return forms.length;
}
