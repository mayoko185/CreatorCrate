import { EventEmitter } from 'node:events';
import { admitBookUpload, withBookUploadLifetime } from '../../src/middleware/book-upload-lifetime.js';
import { managedUploadTracker } from '../../src/services/managed-upload-tracker.js';

// Direct orchestration tests model the caller's early admission and terminal
// handler boundary. Production helpers must never silently acquire a late lease.
export function admittedUpload(handler) {
  return (req, res, deps, ...args) => {
    for (const target of [req, res]) {
      if (!target.once) Object.setPrototypeOf(target, EventEmitter.prototype);
    }
    admitBookUpload(req, res, deps.managedUploadTracker || managedUploadTracker);
    return withBookUploadLifetime(() => handler(req, res, deps, ...args))(
      req, res, (error) => { throw error; },
    ).finally(() => req.bookUploadLifetime.terminal());
  };
}
