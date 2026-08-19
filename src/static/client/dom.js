export function hideElement(element) {
  if (!element) return;
  element.hidden = true;
  if (typeof element.setAttribute === 'function') {
    element.setAttribute('hidden', '');
  }
}

export function showElement(element) {
  if (!element) return;
  element.hidden = false;
  if (typeof element.removeAttribute === 'function') {
    element.removeAttribute('hidden');
  }
}

export function isEnhancementBound(element, key) {
  return element?.dataset?.[key] === 'true' || element?.[key] === true;
}

export function markEnhancementBound(element, key) {
  if (!element) return;
  if (element.dataset) element.dataset[key] = 'true';
  else element[key] = true;
}

export function setHidden(element, hidden) {
  if (!element) return;
  if (hidden) element.setAttribute?.('hidden', '');
  else element.removeAttribute?.('hidden');
}

export function liveRegionDocument(scope) {
  if (!scope) return null;
  if (scope.nodeType === 9) return scope;
  return scope.ownerDocument || globalThis.document || null;
}

export function liveRegionWindow(document) {
  return document?.defaultView || globalThis;
}
