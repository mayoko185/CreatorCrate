import { isEnhancementBound, markEnhancementBound } from './dom.js';

const NOTE_EDITOR_FORM_SELECTOR = '[data-notes-editor-form]';
const NOTE_EDITOR_HOST_SELECTOR = '[data-notes-editor-host]';
const NOTE_EDITOR_SOURCE_SELECTOR = '[data-notes-editor-source]';
const NOTES_CODE_BLOCK_SELECTOR = '.notes-content pre > code';
const NOTES_CODE_COPY_BUTTON_SELECTOR = '.notes-code-copy';
const NOTES_CODE_COPY_FEEDBACK_MS = 1200;
const NOTE_EDITOR_TOOLBAR_ITEMS = [
  ['heading', 'bold', 'italic', 'strike'],
  ['quote'],
  ['ul', 'ol', 'task'],
  ['link', 'table'],
  ['code', 'codeblock'],
];

let toastUiEditorLoad;
const pendingNotesEditorForms = new WeakSet();

function loadToastUiEditor() {
  if (!toastUiEditorLoad) {
    toastUiEditorLoad = Promise.all([
      import('@toast-ui/editor'),
      import('@toast-ui/editor/dist/toastui-editor.css'),
      import('@toast-ui/editor/dist/theme/toastui-editor-dark.css'),
    ]).then(([editorModule]) => {
      const Editor = editorModule.default;
      if (typeof Editor !== 'function') {
        throw new TypeError('The Notes editor module did not expose its default Editor constructor.');
      }
      return Editor;
    });
  }
  return toastUiEditorLoad;
}

function initializeNotesEditor({ form, host, textarea }, Editor) {
  let editor = null;
  try {
    editor = new Editor({
      el: host,
      initialValue: textarea.value,
      initialEditType: 'wysiwyg',
      hideModeSwitch: false,
      usageStatistics: false,
      autofocus: false,
      height: 'auto',
      theme: 'dark',
      toolbarItems: NOTE_EDITOR_TOOLBAR_ITEMS,
    });

    if (typeof editor.getMarkdown !== 'function' || typeof editor.removeHook !== 'function') {
      editor.destroy?.();
      return;
    }

    editor.removeHook('addImageBlobHook');
  } catch {
    editor?.destroy?.();
    return;
  }

  form.addEventListener('submit', () => {
    textarea.value = editor.getMarkdown();
  });
  textarea.hidden = true;
  textarea.setAttribute?.('hidden', '');
  markEnhancementBound(form, 'notesEditorBound');
}

export function enhanceNotesEditor(scope = globalThis.document, { loadEditor = loadToastUiEditor } = {}) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const forms = scope.querySelectorAll(NOTE_EDITOR_FORM_SELECTOR);
  const targets = [];
  forms.forEach((form) => {
    if (isEnhancementBound(form, 'notesEditorBound') || pendingNotesEditorForms.has(form)) return;

    const host = form.querySelector?.(NOTE_EDITOR_HOST_SELECTOR);
    const textarea = form.querySelector?.(NOTE_EDITOR_SOURCE_SELECTOR);
    if (!host || !textarea || typeof form.addEventListener !== 'function') return;

    pendingNotesEditorForms.add(form);
    targets.push({ form, host, textarea });
  });

  if (targets.length === 0) return forms.length;

  let editorLoad;
  try {
    editorLoad = Promise.resolve(loadEditor());
  } catch (error) {
    editorLoad = Promise.reject(error);
  }

  editorLoad.then((Editor) => {
    if (typeof Editor !== 'function') {
      throw new TypeError('The Notes editor loader did not return an Editor constructor.');
    }
    targets.forEach((target) => {
      pendingNotesEditorForms.delete(target.form);
      initializeNotesEditor(target, Editor);
    });
  }).catch((error) => {
    targets.forEach((target) => pendingNotesEditorForms.delete(target.form));
    globalThis.console?.warn?.(
      '[CreatorCrate] Notes editor enhancement failed; the Markdown textarea remains available.',
      error,
    );
  });

  return forms.length;
}

function notesCodeCopyFeedback(button, label, ariaLabel) {
  button.textContent = label;
  button.setAttribute?.('aria-label', ariaLabel);
}

function bindNotesCodeCopyButton(button, code) {
  if (!button || isEnhancementBound(button, 'notesCodeCopyBound')) return;

  button.type = 'button';
  button.className = 'button button-small notes-code-copy';
  notesCodeCopyFeedback(button, 'Copy', 'Copy code');
  button.setAttribute?.('title', 'Copy code');

  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== 'function') {
    button.disabled = true;
    button.setAttribute?.('aria-disabled', 'true');
    button.setAttribute?.('title', 'Copying is unavailable in this browser.');
    markEnhancementBound(button, 'notesCodeCopyBound');
    return;
  }

  let copying = false;
  let feedbackTimer = null;
  const restoreCopyLabel = () => {
    feedbackTimer = null;
    notesCodeCopyFeedback(button, 'Copy', 'Copy code');
  };

  button.addEventListener('click', async () => {
    if (copying) return;
    copying = true;
    button.disabled = true;
    if (feedbackTimer !== null) globalThis.clearTimeout?.(feedbackTimer);

    try {
      await clipboard.writeText(code.textContent);
      notesCodeCopyFeedback(button, 'Copied', 'Code copied');
    } catch {
      notesCodeCopyFeedback(button, 'Copy failed', 'Copy code failed');
    } finally {
      copying = false;
      button.disabled = false;
      feedbackTimer = globalThis.setTimeout?.(restoreCopyLabel, NOTES_CODE_COPY_FEEDBACK_MS) ?? null;
    }
  });

  markEnhancementBound(button, 'notesCodeCopyBound');
}

export function enhanceNotesCodeBlocks(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const blocks = scope.querySelectorAll(NOTES_CODE_BLOCK_SELECTOR);
  blocks.forEach((code) => {
    const pre = code?.parentElement || code?.parentNode;
    const document = code?.ownerDocument || globalThis.document;
    if (!pre || !document || typeof document.createElement !== 'function') return;

    let button = pre.querySelector?.(NOTES_CODE_COPY_BUTTON_SELECTOR);
    if (!button) {
      button = document.createElement('button');
      pre.insertBefore?.(button, pre.firstChild || null);
    }
    pre.classList?.add('notes-code-block-enhanced');
    bindNotesCodeCopyButton(button, code);
  });

  return blocks.length;
}
