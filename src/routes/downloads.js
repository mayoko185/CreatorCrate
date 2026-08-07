import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The Open locally Windows installer is a fixed, application-controlled
// artifact shipped in the repository's downloads/ directory (built from
// helper/windows, see helper/windows/installer/CreatorCrate.OpenLocally.iss)
// and copied into the runtime image by the Dockerfile. Only this one
// constant filename is ever served — the route never resolves user input,
// so no arbitrary file path can be exposed through it.
const OPEN_LOCALLY_INSTALLER_FILENAME = 'CreatorCrate.OpenLocally-Setup.exe';

const DEFAULT_DOWNLOADS_ROOT = path.join(__dirname, '..', '..', 'downloads');

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

export function createDownloadsRouter({ downloadsRoot = DEFAULT_DOWNLOADS_ROOT } = {}) {
  const router = express.Router();

  router.get('/creatorcrate-open-locally-setup.exe', (req, res, next) => {
    const filePath = path.join(downloadsRoot, OPEN_LOCALLY_INSTALLER_FILENAME);
    if (!fs.existsSync(filePath)) {
      return next(createNotFound());
    }
    res.download(filePath, OPEN_LOCALLY_INSTALLER_FILENAME);
  });

  return router;
}

/**
 * Whether the Open locally installer artifact is present in the downloads
 * root. The artifact is built from helper/windows and placed there before the
 * Docker image is built; while it is absent the download route returns 404,
 * so the Settings page must not present a dead download action.
 */
export function isOpenLocallyInstallerAvailable({ downloadsRoot = DEFAULT_DOWNLOADS_ROOT } = {}) {
  return fs.existsSync(path.join(downloadsRoot, OPEN_LOCALLY_INSTALLER_FILENAME));
}
