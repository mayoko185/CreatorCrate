import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { RELEASE_SIGNATURES_KEY } from '../src/services/release-signature-settings-service.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const SIGNATURES_URL = '/settings/release-signatures';

describe('settings — release signatures HTTP', () => {
  let dir;
  let db;
  let app;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-signatures-http-'));
    db = openDatabase(path.join(dir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function send(method, url, body) {
    return agent[method](url).set('X-CSRF-Token', csrfToken).send(body);
  }

  it('reads and mutates the persisted catalogue through authenticated JSON endpoints', async () => {
    expect((await agent.get(SIGNATURES_URL).expect(200)).body)
      .toEqual({ version: 1, entries: [], defaultId: null });
    const first = await send('post', SIGNATURES_URL, { name: 'First', body: '  hello  ' }).expect(200);
    const firstId = first.body.entries[0].id;
    const second = await send('post', SIGNATURES_URL, { name: 'Second', body: 'world' }).expect(200);
    const secondId = second.body.entries[1].id;
    expect((await send('patch', `${SIGNATURES_URL}/${firstId}`, { name: 'Edited', body: 'updated' }).expect(200))
      .body.entries[0].id).toBe(firstId);
    expect((await send('put', `${SIGNATURES_URL}/order`, { orderedIds: [secondId, firstId] }).expect(200))
      .body.entries.map(({ id }) => id)).toEqual([secondId, firstId]);
    expect((await send('put', `${SIGNATURES_URL}/default`, { id: firstId }).expect(200)).body.defaultId)
      .toBe(firstId);
    expect((await send('put', `${SIGNATURES_URL}/default`, { id: null }).expect(200)).body.defaultId)
      .toBeNull();
    await send('put', `${SIGNATURES_URL}/default`, { id: firstId }).expect(200);
    expect((await send('delete', `${SIGNATURES_URL}/${secondId}`).expect(200)).body.defaultId).toBe(firstId);
    expect((await send('delete', `${SIGNATURES_URL}/${firstId}`).expect(200)).body.defaultId).toBeNull();
    expect((await send('put', `${SIGNATURES_URL}/default`, { id: null }).expect(200)).body.defaultId).toBeNull();
    expect(JSON.parse(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck()
      .get(RELEASE_SIGNATURES_KEY))).toEqual({ version: 1, entries: [], defaultId: null });
  });

  it('rejects malformed writes and preserves the stored value', async () => {
    const added = await send('post', SIGNATURES_URL, { name: 'First', body: 'text' }).expect(200);
    const id = added.body.entries[0].id;
    const raw = () => db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck()
      .get(RELEASE_SIGNATURES_KEY);
    const before = raw();
    await send('put', `${SIGNATURES_URL}/order`, { orderedIds: [id, id] }).expect(422);
    await send('put', `${SIGNATURES_URL}/default`, { id: '00000000-0000-4000-8000-000000000000' }).expect(422);
    await send('patch', `${SIGNATURES_URL}/${id}`, { name: '', body: 'changed' }).expect(422);
    await send('post', SIGNATURES_URL, { name: 'Forged', body: '', id: 'forged' }).expect(422);
    expect(raw()).toBe(before);
  });

  it('uses the application authentication and CSRF middleware', async () => {
    await request(app).get(SIGNATURES_URL).expect(302);
    await request(app).post(SIGNATURES_URL).send({ name: 'No session', body: '' }).expect(401);
    await agent.post(SIGNATURES_URL).send({ name: 'No token', body: '' }).expect(403);
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(RELEASE_SIGNATURES_KEY))
      .toBeUndefined();
  });
});
