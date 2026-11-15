import { describe, expect, it, vi } from 'vitest';
import {
  enhanceProjectRelatedNotes,
  projectRelatedNoteExpansion,
  RELATED_NOTE_PIN_KEY_PREFIX,
  readRelatedNotePin,
  relatedNotePinKey,
} from '../src/static/client/project-related-notes.js';
import { enhanceProjectRelatedNotes as bundled } from '../src/static/creatorcrate.js';

// WP3B: Related Notes disclosure + browser-local Pin, on a minimal fake DOM
// shaped like the WP3A partial as corrected in WP6.1 (card, disclosure with its
// Show/Hide note label, preview, icon-only pin with a tooltip).

function element(attrs = {}, children = [], { text = '', classes = [] } = {}) {
  const attributes = new Map(Object.entries(attrs));
  const listeners = [];
  const node = {
    children,
    parent: null,
    ownerDocument: null,
    textContent: text,
    get hidden() { return attributes.has('hidden'); },
    set hidden(value) { if (value) attributes.set('hidden', ''); else attributes.delete('hidden'); },
    get id() { return attributes.get('id') || ''; },
    dataset: {},
    classList: {
      set: new Set(classes),
      contains(name) { return this.set.has(name); },
      toggle(name, force) { if (force) this.set.add(name); else this.set.delete(name); },
    },
    listeners,
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); },
    addEventListener(type, listener) { listeners.push({ type, listener }); },
    click() { listeners.filter((entry) => entry.type === 'click').forEach((entry) => entry.listener({ target: node })); },
    matches(selector) {
      if (selector.startsWith('[')) return attributes.has(selector.slice(1, -1));
      if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
      return false;
    },
    descendants() { return children.flatMap((child) => [child, ...child.descendants()]); },
    querySelectorAll(selector) { return node.descendants().filter((child) => child.matches(selector)); },
    querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
    contains(other) { return other === node || node.descendants().includes(other); },
  };
  children.forEach((child) => { child.parent = node; });
  return node;
}

function noteCard(id, title = `Note ${id}`) {
  const pin = element({
    type: 'button', 'aria-pressed': 'false', 'aria-label': `Pin ${title}`, 'data-tooltip': 'Pin note', 'data-project-related-note-pin': id,
  });
  const label = element({ 'data-project-related-note-disclosure-label': '' }, [], { text: 'Show note' });
  const disclosure = element({
    type: 'button', 'aria-expanded': 'false', 'aria-controls': `note-${id}-preview`, 'data-project-related-note-disclosure': id,
  }, [label]);
  const preview = element({ id: `note-${id}-preview`, 'data-project-related-note-preview': id, hidden: '' });
  const heading = element({}, [], { text: `  ${title}\n `, classes: ['project-related-note-title'] });
  const card = element({ 'data-project-related-note': id }, [heading, pin, disclosure, preview]);
  return { card, pin, label, disclosure, preview };
}

function page(ids) {
  const notes = ids.map((id) => noteCard(id));
  const feedbackText = element({ 'data-dialog-feedback-text': '' });
  const feedback = element({ 'data-dialog-feedback': '', role: 'status', hidden: '' }, [feedbackText], { classes: ['notice', 'notice--success'] });
  const region = element({ 'data-project-related-notes-region': '' }, notes.map((note) => note.card));
  const body = element({}, [feedback, region]);
  const document = {
    nodeType: 9,
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    getElementById: (id) => body.descendants().find((node) => node.id === id) || null,
  };
  [body, ...body.descendants()].forEach((node) => { node.ownerDocument = document; });
  return { document, region, notes, feedback, feedbackText, byId: Object.fromEntries(notes.map((note) => [note.card.getAttribute('data-project-related-note'), note])) };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    failGet: false,
    failSet: false,
    failRemove: false,
    getItem(key) { if (this.failGet) throw new Error('blocked'); return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { if (this.failSet) throw new Error('QuotaExceededError'); values.set(key, String(value)); },
    removeItem(key) { if (this.failRemove) throw new Error('blocked'); values.delete(key); },
  };
}

const key = (id) => `creatorcrate:related-notes:v1:note:${id}`;

function expectExpanded(note, expanded) {
  expect(note.disclosure.getAttribute('aria-expanded')).toBe(String(expanded));
  expect(note.preview.hidden).toBe(!expanded);
  // The visible disclosure text follows the actual expansion.
  expect(note.label.textContent).toBe(expanded ? 'Hide note' : 'Show note');
}

function expectPinned(note, pinned) {
  const verb = pinned ? 'Unpin' : 'Pin';
  expect(note.pin.getAttribute('aria-pressed')).toBe(String(pinned));
  expect(note.pin.getAttribute('aria-label')).toBe(`${verb} Note ${note.card.getAttribute('data-project-related-note')}`);
  // Icon-only: the established tooltip names the action; no native title.
  expect(note.pin.getAttribute('data-tooltip')).toBe(`${verb} note`);
  expect(note.pin.getAttribute('title')).toBeNull();
}

describe('Related Notes pin key', () => {
  it('uses the approved per-note key and rejects non-id values', () => {
    expect(RELATED_NOTE_PIN_KEY_PREFIX).toBe('creatorcrate:related-notes:v1:note:');
    expect(relatedNotePinKey('42')).toBe(key(42));
    expect(relatedNotePinKey(7)).toBe(key(7));
    for (const bad of ['', '0', '-1', '1.5', 'abc', '01', null, undefined]) expect(relatedNotePinKey(bad)).toBeNull();
  });

  it('reads only "1" as pinned and reports unreadable storage as null', () => {
    const storage = memoryStorage({ [key(1)]: '1', [key(2)]: 'true', [key(3)]: '' });
    expect(readRelatedNotePin('1', storage)).toBe(true);
    expect(readRelatedNotePin('2', storage)).toBe(false);
    expect(readRelatedNotePin('3', storage)).toBe(false);
    expect(readRelatedNotePin('4', storage)).toBe(false);
    storage.failGet = true;
    expect(readRelatedNotePin('1', storage)).toBeNull();
    expect(readRelatedNotePin('1', () => { throw new Error('SecurityError'); })).toBeNull();
    expect(readRelatedNotePin('1', () => null)).toBeNull();
  });
});

describe('enhanceProjectRelatedNotes', () => {
  it('is exported from the client bootstrap', () => {
    expect(bundled).toBe(enhanceProjectRelatedNotes);
  });

  it('starts unpinned notes collapsed and toggles each disclosure independently', () => {
    const { document, byId } = page(['1', '2']);
    const storage = memoryStorage();
    enhanceProjectRelatedNotes(document, { storage });
    expectExpanded(byId[1], false);
    expectExpanded(byId[2], false);
    expectPinned(byId[1], false);

    byId[1].disclosure.click();
    expectExpanded(byId[1], true);
    expectExpanded(byId[2], false);
    byId[2].disclosure.click();
    expectExpanded(byId[1], true);
    expectExpanded(byId[2], true);
    byId[1].disclosure.click();
    expectExpanded(byId[1], false);
    expectExpanded(byId[2], true);
    // Expanding never pins.
    expect(storage.values.size).toBe(0);
    expectPinned(byId[2], false);
  });

  it('pins (persist, pressed, expand) and unpins (remove, unpressed, expansion kept)', () => {
    const { document, byId } = page(['1', '2']);
    const storage = memoryStorage({ unrelated: 'keep' });
    enhanceProjectRelatedNotes(document, { storage });

    byId[1].pin.click();
    expect(storage.values.get(key(1))).toBe('1');
    expectPinned(byId[1], true);
    expectExpanded(byId[1], true);
    expectExpanded(byId[2], false);

    byId[1].pin.click();
    expect(storage.values.has(key(1))).toBe(false);
    expectPinned(byId[1], false);
    expectExpanded(byId[1], true);
    expect(storage.values.get('unrelated')).toBe('keep');
  });

  it('restores pinned notes expanded on reload; manual collapse keeps the pin', () => {
    const storage = memoryStorage();
    const first = page(['5', '6']);
    enhanceProjectRelatedNotes(first.document, { storage });
    first.byId[5].pin.click();
    first.byId[5].disclosure.click();
    expectExpanded(first.byId[5], false);
    expectPinned(first.byId[5], true);
    expect(storage.values.get(key(5))).toBe('1');

    const reload = page(['5', '6']);
    enhanceProjectRelatedNotes(reload.document, { storage });
    expectExpanded(reload.byId[5], true);
    expectPinned(reload.byId[5], true);
    expectExpanded(reload.byId[6], false);

    reload.byId[5].pin.click();
    const again = page(['5']);
    enhanceProjectRelatedNotes(again.document, { storage });
    expectExpanded(again.byId[5], false);
    expectPinned(again.byId[5], false);
  });

  it('treats invalid stored values as unpinned without rewriting them', () => {
    const storage = memoryStorage({ [key(1)]: 'yes', [key(2)]: '{"pinned":true}' });
    const { document, byId } = page(['1', '2']);
    enhanceProjectRelatedNotes(document, { storage });
    expectExpanded(byId[1], false);
    expectPinned(byId[1], false);
    expectExpanded(byId[2], false);
    expect(storage.values.get(key(1))).toBe('yes');
    byId[1].pin.click();
    expect(storage.values.get(key(1))).toBe('1');
    expectPinned(byId[1], true);
  });

  it('defaults to collapsed when storage cannot be read and keeps disclosure usable', () => {
    const storage = memoryStorage({ [key(1)]: '1' });
    storage.failGet = true;
    const { document, byId } = page(['1']);
    enhanceProjectRelatedNotes(document, { storage });
    expectExpanded(byId[1], false);
    expectPinned(byId[1], false);
    byId[1].disclosure.click();
    expectExpanded(byId[1], true);

    const unavailable = page(['1']);
    enhanceProjectRelatedNotes(unavailable.document, { storage: () => { throw new Error('SecurityError'); } });
    expectExpanded(unavailable.byId[1], false);
    unavailable.byId[1].disclosure.click();
    expectExpanded(unavailable.byId[1], true);
  });

  it('keeps the committed pin state and reports a failed write without retrying', () => {
    const storage = memoryStorage();
    storage.failSet = true;
    const setItem = vi.spyOn(storage, 'setItem');
    const { document, byId, feedback, feedbackText } = page(['1', '2']);
    enhanceProjectRelatedNotes(document, { storage });

    byId[1].pin.click();
    expect(setItem).toHaveBeenCalledTimes(1);
    expectPinned(byId[1], false);
    expectExpanded(byId[1], false);
    expect(feedback.hidden).toBe(false);
    expect(feedback.getAttribute('role')).toBe('status');
    expect(feedback.classList.contains('notice--error')).toBe(true);
    expect(feedback.classList.contains('notice--success')).toBe(false);
    expect(feedbackText.textContent).toMatch(/^Couldn't pin Note 1\./);
    // Disclosure still works.
    byId[1].disclosure.click();
    expectExpanded(byId[1], true);
    expect(setItem).toHaveBeenCalledTimes(1);

    // A later successful pin clears that failure.
    storage.failSet = false;
    byId[2].pin.click();
    expectPinned(byId[2], true);
    expect(feedback.hidden).toBe(true);
    expect(feedbackText.textContent).toBe('');
  });

  it('keeps a pin whose removal fails and reports it', () => {
    const storage = memoryStorage({ [key(3)]: '1' });
    const { document, byId, feedback, feedbackText } = page(['3']);
    enhanceProjectRelatedNotes(document, { storage });
    expectPinned(byId[3], true);
    storage.failRemove = true;
    byId[3].pin.click();
    expectPinned(byId[3], true);
    expect(storage.values.get(key(3))).toBe('1');
    expect(feedback.hidden).toBe(false);
    expect(feedbackText.textContent).toMatch(/^Couldn't unpin Note 3\./);
  });

  it('does not clear an unrelated feedback message on a later successful pin', () => {
    const storage = memoryStorage();
    const { document, byId, feedback, feedbackText } = page(['1']);
    enhanceProjectRelatedNotes(document, { storage });
    feedbackText.textContent = 'Project saved.';
    feedback.hidden = false;
    byId[1].pin.click();
    expect(feedback.hidden).toBe(false);
    expect(feedbackText.textContent).toBe('Project saved.');
  });

  it('binds each card once when called again and binds only new cards', () => {
    const storage = memoryStorage();
    const { document, region, byId } = page(['1']);
    enhanceProjectRelatedNotes(document, { storage });
    enhanceProjectRelatedNotes(document, { storage });
    enhanceProjectRelatedNotes(region, { storage });
    expect(byId[1].disclosure.listeners).toHaveLength(1);
    expect(byId[1].pin.listeners).toHaveLength(1);
    byId[1].disclosure.click();
    expectExpanded(byId[1], true);

    // A newly rendered card (WP5 replacement) binds on its own, and a kept
    // expansion overrides the pin default only for the notes it names.
    storage.values.set(key(9), '1');
    const replacement = page(['9', '10']);
    enhanceProjectRelatedNotes(replacement.region, { storage, expansion: new Map([['9', false], ['10', true]]) });
    expectExpanded(replacement.byId[9], false);
    expectPinned(replacement.byId[9], true);
    expectExpanded(replacement.byId[10], true);
    expect(projectRelatedNoteExpansion(replacement.region)).toEqual(new Map([['9', false], ['10', true]]));
    expect(replacement.byId[9].disclosure.listeners).toHaveLength(1);
  });

  it('isolates a failing card and ignores absent sections', () => {
    const storage = memoryStorage();
    const { document, byId } = page(['1', '2']);
    byId[1].card.querySelector = () => { throw new Error('broken card'); };
    const reportError = vi.fn();
    vi.stubGlobal('reportError', reportError);
    try {
      expect(() => enhanceProjectRelatedNotes(document, { storage })).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(reportError).toHaveBeenCalledTimes(1);
    byId[2].disclosure.click();
    expectExpanded(byId[2], true);

    expect(() => enhanceProjectRelatedNotes(element(), { storage })).not.toThrow();
    expect(() => enhanceProjectRelatedNotes(null, { storage })).not.toThrow();
  });
});
