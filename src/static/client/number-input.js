import {
  isEnhancementBound,
  markEnhancementBound,
} from './dom.js';

export const NUMBER_INPUT_SELECTOR = 'input[type="number"]';

function numberStepperFieldName(input) {
  const labels = Array.from(input?.labels || []);
  const document = input?.ownerDocument;
  const inputId = input?.id || input?.getAttribute?.('id');
  if (labels.length === 0 && inputId && typeof document?.querySelectorAll === 'function') {
    labels.push(...Array.from(document.querySelectorAll('label')).filter((label) => (
      label.getAttribute?.('for') === inputId
    )));
  }
  if (labels.length === 0) {
    const field = input?.closest?.('.field');
    const label = field?.querySelector?.('label');
    if (label) labels.push(label);
  }
  const name = String(labels[0]?.textContent || input?.getAttribute?.('aria-label') || '').trim();
  return name || 'value';
}

function syncNumberStepperState(input) {
  const wrapper = input?.parentElement;
  if (!wrapper?.classList?.contains('cc-number-stepper')) return;
  const locked = Boolean(input.disabled || input.readOnly
    || input.hasAttribute?.('disabled') || input.hasAttribute?.('readonly'));
  if (wrapper.classList.contains('is-disabled') !== locked) {
    wrapper.classList.toggle('is-disabled', locked);
  }
  wrapper.querySelectorAll?.('[data-number-stepper-direction]').forEach((button) => {
    const direction = button.dataset?.numberStepperDirection || button.getAttribute?.('data-number-stepper-direction');
    const label = `${direction === 'decrement' ? 'Decrease' : 'Increase'} ${numberStepperFieldName(input)}`;
    if (button.disabled !== locked) button.disabled = locked;
    if (button.getAttribute?.('aria-disabled') !== String(locked)) {
      button.setAttribute?.('aria-disabled', String(locked));
    }
    if (button.getAttribute?.('aria-label') !== label) button.setAttribute?.('aria-label', label);
  });
}

function dispatchNumberStepperEvents(input) {
  const EventConstructor = input?.ownerDocument?.defaultView?.Event || globalThis.Event;
  ['input', 'change'].forEach((type) => {
    if (typeof EventConstructor === 'function') {
      input.dispatchEvent?.(new EventConstructor(type, { bubbles: true }));
    } else {
      input.dispatchEvent?.({ type, bubbles: true });
    }
  });
}

function createNumberStepperButton(document, direction) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('class', `cc-number-stepper-button cc-number-stepper-button--${direction}`);
  button.setAttribute('data-number-stepper-direction', direction);
  button.textContent = direction === 'decrement' ? '−' : '+';
  return button;
}

function enhanceNumberInput(input) {
  if (!input?.matches?.(NUMBER_INPUT_SELECTOR)) return false;
  if (isEnhancementBound(input, 'numberStepperBound')) {
    syncNumberStepperState(input);
    return false;
  }

  const document = input.ownerDocument;
  const parent = input.parentElement;
  if (!document?.createElement || !parent?.insertBefore) return false;

  const wrapper = document.createElement('span');
  wrapper.setAttribute('class', 'cc-number-stepper');
  wrapper.setAttribute('data-number-stepper', '');
  const decrement = createNumberStepperButton(document, 'decrement');
  const increment = createNumberStepperButton(document, 'increment');

  parent.insertBefore(wrapper, input);
  wrapper.append(input, decrement, increment);
  markEnhancementBound(input, 'numberStepperBound');

  [decrement, increment].forEach((button) => {
    button.addEventListener?.('click', () => {
      if (input.disabled || input.readOnly || input.hasAttribute?.('readonly')) return;
      const previousValue = input.value;
      try {
        if (button.dataset?.numberStepperDirection === 'decrement') input.stepDown();
        else input.stepUp();
      } catch {
        return;
      }
      if (input.value !== previousValue) dispatchNumberStepperEvents(input);
      syncNumberStepperState(input);
    });
  });

  syncNumberStepperState(input);
  return true;
}

export function enhanceNumberInputs(scope = globalThis.document) {
  if (!scope) return 0;
  const inputs = [];
  if (scope.matches?.(NUMBER_INPUT_SELECTOR)) inputs.push(scope);
  if (typeof scope.querySelectorAll === 'function') inputs.push(...scope.querySelectorAll(NUMBER_INPUT_SELECTOR));
  return inputs.reduce((count, input) => count + Number(enhanceNumberInput(input)), 0);
}
