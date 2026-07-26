import fs from 'node:fs';
import path from 'node:path';

export class FilesystemError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FilesystemError';
  }
}

function checkDirectory(dirPath, label) {
  let stats;
  try {
    stats = fs.statSync(dirPath);
  } catch (err) {
    throw new FilesystemError(
      `${label} "${dirPath}" does not exist or cannot be accessed. Create the directory and ensure it is readable and writable.`
    );
  }

  if (!stats.isDirectory()) {
    throw new FilesystemError(`${label} "${dirPath}" exists but is not a directory.`);
  }

  try {
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (err) {
    throw new FilesystemError(
      `${label} "${dirPath}" is not readable and writable by the current process.`
    );
  }
}

export function validateMounts(config) {
  checkDirectory(config.appDataRoot, 'APP_DATA_ROOT');
  checkDirectory(config.projectsRoot, 'PROJECTS_ROOT');

  const dbParent = path.dirname(config.databasePath);
  let parentStats;
  try {
    parentStats = fs.statSync(dbParent);
  } catch (err) {
    throw new FilesystemError(
      `The parent directory of DATABASE_PATH "${dbParent}" does not exist or cannot be accessed. Ensure APP_DATA_ROOT is mounted and writable.`
    );
  }

  if (!parentStats.isDirectory()) {
    throw new FilesystemError(
      `The parent directory of DATABASE_PATH "${dbParent}" exists but is not a directory.`
    );
  }

  try {
    fs.accessSync(dbParent, fs.constants.W_OK);
  } catch (err) {
    throw new FilesystemError(
      `The parent directory of DATABASE_PATH "${dbParent}" is not writable by the current process.`
    );
  }
}
