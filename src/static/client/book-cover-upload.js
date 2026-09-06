import { requestAppConfirmation } from './confirm-dialog.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';

export function enhanceBookCoverUploads(scope = globalThis.document) {
  let count = 0;
  scope?.querySelectorAll?.('form[enctype="multipart/form-data"]').forEach((form) => {
    const cover = form.querySelector('input[type="file"][name="cover"]');
    const kind = form.querySelector('input[name="expectedCoverKind"]');
    const id = form.querySelector('input[name="expectedCoverId"]');
    const confirmed = form.querySelector('input[name="coverReplacementConfirmed"]');
    if (!cover || !kind || !id || !confirmed || isEnhancementBound(form, 'bookCoverUploadBound')) return;
    markEnhancementBound(form, 'bookCoverUploadBound');
    count += 1;
    let pending = false;
    let replaying = false;
    let replayEvent = null;
    let submitted = false;
    const replacing = () => cover.files?.length > 0 && kind.value !== 'none';
    const reset = () => { confirmed.value = 'false'; };
    reset();
    cover.addEventListener('change', reset);
    cover.addEventListener('input', reset);
    kind.addEventListener('change', reset);
    id.addEventListener('change', reset);
    form.addEventListener('reset', reset);
    form.ownerDocument.defaultView?.addEventListener('pageshow', () => {
      submitted = false;
      reset();
    });
    form.addEventListener('submit', (event) => {
      if (replaying) {
        replayEvent = event;
        return;
      }
      if (pending || submitted) {
        event.preventDefault();
        return;
      }
      reset();
      if (event.defaultPrevented) return;
      if (!replacing()) {
        // Native submit events run after constraint validation, unlike clicks.
        submitted = true;
        setTimeout(() => {
          if (event.defaultPrevented) submitted = false;
        }, 0);
        return;
      }
      event.preventDefault();
      pending = true;
      const submitter = event.submitter;
      try {
        requestAppConfirmation(form.ownerDocument, {
          title: 'Replace cover image?',
          message: 'This Book already has a cover image. Continuing will replace its current cover image. The previous image or Asset will not be deleted.',
          confirmLabel: 'Replace cover',
          opener: submitter || form.ownerDocument.activeElement || cover,
        }).then((approved) => {
          if (!approved || form.isConnected === false || submitter?.disabled
            || (submitter && submitter.form !== form)) return;
          // requestSubmit preserves validation, submitter overrides and native multipart encoding.
          // Authorization exists only while the browser constructs this submission's form data.
          confirmed.value = replacing() ? 'true' : 'false';
          replaying = true;
          try {
            if (submitter) form.requestSubmit(submitter);
            else form.requestSubmit();
            submitted = Boolean(replayEvent && !replayEvent.defaultPrevented);
          } finally {
            replaying = false;
            replayEvent = null;
            reset();
          }
        }).finally(() => {
          pending = false;
          reset();
        });
      } catch (error) {
        pending = false;
        reset();
        throw error;
      }
    });
  });
  return count;
}
