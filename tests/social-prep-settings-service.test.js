import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import {
  createSocialPrepSettingsService,
  SocialPrepSettingsValidationError,
  SOCIAL_PREP_ENABLED_KEY,
  SOCIAL_PREP_PLATFORMS_KEY,
} from '../src/services/social-prep-settings-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Social Preparation settings service', () => {
  let tmpDir;
  let db;
  let repository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-prep-settings-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createAppMetaRepository(db);
    service = createSocialPrepSettingsService({ appMetaRepository: repository });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to disabled with no configured platforms', () => {
    expect(service.getSettings()).toEqual({ enabled: false, platforms: [] });
  });

  it('stores enabled state using the app_meta boolean convention', () => {
    expect(service.setEnabled(true)).toBe('1');
    expect(repository.getValue(SOCIAL_PREP_ENABLED_KEY)).toBe('1');
    expect(service.isEnabled()).toBe(true);

    expect(service.setEnabled(false)).toBe('0');
    expect(repository.getValue(SOCIAL_PREP_ENABLED_KEY)).toBe('0');
    expect(service.isEnabled()).toBe(false);
  });

  it('stores selected platforms in canonical order as a comma-separated value', () => {
    expect(service.setPlatforms(['bluesky', 'patreon'])).toBe('patreon,bluesky');
    expect(repository.getValue(SOCIAL_PREP_PLATFORMS_KEY)).toBe('patreon,bluesky');
    expect(service.getPlatforms()).toEqual(['patreon', 'bluesky']);
  });

  it('allows an empty platform selection', () => {
    expect(service.setPlatforms([])).toBe('');
    expect(service.getPlatforms()).toEqual([]);
  });

  it('reports whether an enabled or platform value changed', () => {
    expect(service.setEnabledWithOutcome(false)).toEqual({ value: '0', changed: false });
    expect(service.setEnabledWithOutcome(true)).toEqual({ value: '1', changed: true });
    expect(service.setPlatformsWithOutcome([])).toEqual({ value: '', changed: false });
    expect(service.setPlatformsWithOutcome(['x'])).toEqual({ value: 'x', changed: true });
  });

  it('rejects unknown and duplicate platforms', () => {
    expect(() => service.setPlatforms(['mastodon']))
      .toThrow(SocialPrepSettingsValidationError);
    expect(() => service.setPlatforms(['x', 'x']))
      .toThrow(SocialPrepSettingsValidationError);
  });

  it('returns no platforms for malformed stored values', () => {
    for (const value of [
      'mastodon',
      'patreon,patreon',
      'x,patreon',
      ',patreon',
      'patreon,',
      'patreon, bluesky',
    ]) {
      repository.setValue(SOCIAL_PREP_PLATFORMS_KEY, value);
      expect(service.getPlatforms()).toEqual([]);
    }
  });

  it('requires valid dependencies and enabled state', () => {
    expect(() => createSocialPrepSettingsService({})).toThrow(
      'createSocialPrepSettingsService requires an appMetaRepository dependency.'
    );
    expect(() => service.setEnabled('true')).toThrow(
      'Social Preparation enabled state must be a boolean.'
    );
  });
});
