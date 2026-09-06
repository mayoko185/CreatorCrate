// Keep route matching identical to the multipart adapters (Express defaults).
export const BOOK_CREATE_MULTIPART_PATH = /^\/notes\/books\/?$/i;
export const BOOK_EDIT_MULTIPART_PATH = /^\/notes\/books\/[0-9]+\/?$/i;

export function isBookMultipartRequest(req) {
  return req.method === 'POST' && /^multipart\//i.test(req.headers['content-type'] || '')
    && (BOOK_CREATE_MULTIPART_PATH.test(req.path) || BOOK_EDIT_MULTIPART_PATH.test(req.path));
}

// Terminal handling is not a transport event: parser, handler, compensation
// and template callbacks must all have relinquished their graph-work holds.
export function admitBookUpload(req, res, tracker) {
  const operation = tracker.begin();
  if (!operation) return null;
  let pending = 0;
  let terminal = false;
  let completed = false;
  let forwardVersion = 0;
  const settle = () => {
    if (!terminal || pending !== 0 || completed) return;
    completed = true;
    req.removeListener?.('aborted', cancel);
    res.removeListener?.('close', close);
    operation.complete();
  };
  const cancel = () => operation.cancel();
  // Router fallthrough can itself defer next(). A close between middleware
  // layers must not declare that still-dispatched request terminal.
  const close = () => { cancel(); };
  const lifetime = Object.freeze({
    operation,
    terminal() { terminal = true; settle(); },
    forward() { terminal = false; forwardVersion++; },
    get forwardVersion() { return forwardVersion; },
    hold() {
      if (completed) throw new Error('Book upload request already completed.');
      pending++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pending--;
        settle();
      };
    },
  });
  req.bookUploadLifetime = lifetime;
  req.once?.('aborted', cancel);
  res.once?.('close', close);
  const end = res.end;
  if (end) res.end = function (...args) {
    const release = lifetime.hold();
    try { return end.apply(this, args); }
    finally { lifetime.terminal(); release(); }
  };
  // Express render() is callback-based, even when a route itself is async.
  const render = res.render;
  const forward = (error) => { lifetime.forward(); return req.next(error); };
  if (render) res.render = function (view, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    const release = lifetime.hold();
    try {
      return render.call(this, view, options, (error, html) => {
        try {
          if (callback) return callback(error, html);
          if (error) return forward(error);
          return res.send(html);
        } catch (failure) {
          return forward(failure);
        } finally { release(); }
      });
    } catch (error) { release(); throw error; }
  };
  return lifetime;
}

// Apply only to the parser and New/Edit handlers, not unrelated processing jobs.
export function withBookUploadLifetime(handler) {
  return function (req, res, next) {
    if (!req.bookUploadLifetime) return handler(req, res, next);
    const release = req.bookUploadLifetime?.hold();
    const version = req.bookUploadLifetime.forwardVersion;
    let forwarded = false;
    const forward = (error) => {
      forwarded = true;
      req.bookUploadLifetime?.forward();
      return next(error);
    };
    const finish = () => {
      // A synchronous template callback can forward independently of the
      // handler's next argument. Do not overwrite that continuation's state.
      if (!forwarded && req.bookUploadLifetime.forwardVersion === version) req.bookUploadLifetime.terminal();
      release?.();
    };
    try {
      const result = handler(req, res, forward);
      return Promise.resolve(result).catch(forward).finally(finish);
    } catch (error) {
      try { return forward(error); } finally { finish(); }
    }
  };
}
