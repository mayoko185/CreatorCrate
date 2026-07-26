import path from 'node:path';
import process from 'node:process';

const DEFAULTS = {
  NODE_ENV: 'development',
  PORT: '3000',
  APP_NAME: 'CreatorCrate',
  APP_DATA_ROOT: './data/app',
  PROJECTS_ROOT: './data/projects',
  DATABASE_PATH: './data/app/creatorcrate.db',
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function getEnv(rawEnv, key) {
  const value = rawEnv[key];
  return value === undefined || value === '' ? DEFAULTS[key] : value;
}

export function createConfig(rawEnv = process.env) {
  const nodeEnv = getEnv(rawEnv, 'NODE_ENV');
  const appName = getEnv(rawEnv, 'APP_NAME');

  const portRaw = getEnv(rawEnv, 'PORT');
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Invalid PORT "${portRaw}". Expected an integer between 1 and 65535.`);
  }

  const appDataRoot = path.resolve(getEnv(rawEnv, 'APP_DATA_ROOT'));
  const projectsRoot = path.resolve(getEnv(rawEnv, 'PROJECTS_ROOT'));
  const databasePath = path.resolve(getEnv(rawEnv, 'DATABASE_PATH'));

  const relativeDb = path.relative(appDataRoot, databasePath);
  if (
    relativeDb === '' ||
    relativeDb.startsWith('..') ||
    path.isAbsolute(relativeDb)
  ) {
    throw new ConfigError(
      `DATABASE_PATH "${databasePath}" must be located within APP_DATA_ROOT "${appDataRoot}".`
    );
  }

  return Object.freeze({
    nodeEnv,
    port,
    appName,
    appDataRoot,
    projectsRoot,
    databasePath,
  });
}
