import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createReleaseService } from '../src/services/release-service.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { digestToken, generateIntentToken } from '../src/services/social-prep-tokens.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function failureReport(platform = 'x') {
  return {
    subsystem: 'social_preparation', timestamp: '2026-09-04T12:00:00.0000000+00:00', platform, adapter: `${platform}_social_preparation`,
    phase: 'media_readiness', stable_code: 'x_media_not_ready', outcome: 'failed', error_class: 'cdp_command',
    cdp_operation: 'get_box_model', cdp_code: -32000,
    cdp_message: 'Could not find node with given id',
    checkpoints: { home_ready: true, media_assigned: true },
    target_state: { owned_target_created: true, cleanup_attempted: true, cleanup_succeeded: false },
    cleanup: { error_class: 'cdp_transport' },
  };
}

function failureReportMessageAtUtf8ByteLength(byteLength, platform) {
  const report = { ...failureReport(platform), diagnostic_padding: '' };
  const paddingByteLength = byteLength - Buffer.byteLength(JSON.stringify(report), 'utf8');
  report.diagnostic_padding = `${'✦'.repeat(Math.floor(paddingByteLength / 3))}${'x'.repeat(paddingByteLength % 3)}`;
  return JSON.stringify(report);
}

describe('Social Preparation redemption HTTP', () => {
  let app;
  let db;
  let repository;
  let projectId;
  let releaseId;
  let releaseService;
  let intent;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-prep-redeem-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectId = Number(db.prepare(
      "INSERT INTO projects (title, slug, project_dir, description, notes, status, planned_date, published_date, patreon_url) VALUES ('Project', 'project', 'project-dir', '', '', 'tbd', NULL, NULL, NULL)"
    ).run().lastInsertRowid);
    releaseId = Number(db.prepare(
      "INSERT INTO releases (project_id, title, description, notes, published_date) VALUES (?, 'Snapshot title', 'Snapshot body', 'Private Notes', '2026-08-01')"
    ).run(projectId).lastInsertRowid);
    releaseService = createReleaseService({ db });
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { releaseService });
    repository = app.locals.socialPrepRepository;
    app.locals.openLocallySettingsService.setWindowsProjectsPath('D:\\Projects');
    intent = generateIntentToken();
    repository.insertSession({
      id: 'session-1', releaseId, kind: 'initial', intentHash: digestToken(intent),
      expiresAt: new Date('2030-01-01T00:00:00.000Z'), now: new Date('2029-12-31T23:59:00.000Z'),
    });
    repository.ensurePlatforms(releaseId, ['patreon', 'x', 'bluesky']);
    repository.reassignPlatformsToSession('session-1', ['patreon', 'x', 'bluesky']);
    repository.insertSessionAsset({
      sessionId: 'session-1', assetId: 2, projectId, role: 'attachment', sortOrder: 0,
      relativePath: 'final/second.png', filename: 'second.png', extension: '.png', mimeType: 'image/png', sizeBytes: 2, isPresent: true,
    });
    repository.insertSessionAsset({
      sessionId: 'session-1', assetId: 1, projectId, role: 'primary', sortOrder: 1,
      relativePath: 'final/first.png', filename: 'first.png', extension: '.png', mimeType: 'image/png', sizeBytes: 1, isPresent: true,
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bypasses browser session and CSRF, redeems once, and returns only snapshot-derived helper data', async () => {
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    expect(redeemed.headers['set-cookie']).toBeUndefined();
    expect(redeemed.body).toMatchObject({ ok: true, sessionId: 'session-1', releaseId });
    expect(redeemed.body.mediaToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(redeemed.body)).not.toContain('Private Notes');
    expect(redeemed.body.platforms.find((entry) => entry.platform === 'patreon')).toMatchObject({
      platform: 'patreon', title: 'Snapshot title', body: 'Snapshot body',
      assets: [
        { assetId: 2, filename: 'second.png', windowsPath: 'D:\\Projects\\project-dir\\final/second.png' },
        { assetId: 1, filename: 'first.png', windowsPath: 'D:\\Projects\\project-dir\\final/first.png' },
      ],
    });
    for (const platform of ['x', 'bluesky']) {
      expect(redeemed.body.platforms.find((entry) => entry.platform === platform)).toMatchObject({
        assets: [
          { assetId: 2, role: 'attachment', filename: 'second.png' },
          { assetId: 1, role: 'primary', filename: 'first.png' },
        ],
      });
    }
    const stored = db.prepare('SELECT media_token_hash FROM social_prep_sessions WHERE id = ?').get('session-1');
    expect(stored.media_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.media_token_hash).not.toBe(redeemed.body.mediaToken);

    const replay = await request(app).post('/social-prep/redeem').send({ intent }).expect(401);
    const malformed = await request(app).post('/social-prep/redeem').send({ intent: 'invalid' }).expect(401);
    expect(replay.body).toEqual(malformed.body);
  });

  it('treats an expired or query-supplied intent as the same private failure', async () => {
    const expiredIntent = generateIntentToken();
    const expiredReleaseId = Number(db.prepare(
      "INSERT INTO releases (project_id, title, description, notes, published_date) VALUES (?, 'Expired', '', '', '2026-08-01')"
    ).run(projectId).lastInsertRowid);
    repository.insertSession({
      id: 'expired-session', releaseId: expiredReleaseId, kind: 'initial', intentHash: digestToken(expiredIntent),
      expiresAt: new Date('2000-01-01T00:00:00.000Z'), now: new Date('1999-12-31T23:59:00.000Z'),
    });
    const expired = await request(app).post('/social-prep/redeem').send({ intent: expiredIntent }).expect(401);
    const query = await request(app).post(`/social-prep/redeem?intent=${intent}`).send({}).expect(401);
    expect(expired.body).toEqual(query.body);
  });

  it('persists a bounded helper failure report in application diagnostics without exposing it in status payloads', async () => {
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    const report = {
      ...failureReport(),
      title: 'orchid lantern meridian',
      body: 'cerulean fjord mosaic',
      private_note: 'obsidian harbor',
      arbitrary_nested_value: { marker: 'vermilion crescent' },
    };
    const response = await request(app)
      .patch('/social-prep/session-1/platforms/x')
      .set('Authorization', `Bearer ${redeemed.body.mediaToken}`)
      .send({ status: 'failed', detailCode: 'platform_preparation_failed', message: JSON.stringify(report) })
      .expect(200);

    expect(response.body.platform).toMatchObject({ platform: 'x', status: 'failed', detailCode: 'platform_preparation_failed' });
    expect(JSON.stringify(response.body)).not.toContain('Could not find node with given id');
    const [stored] = app.locals.applicationLogRepository.findPage({ subsystem: 'social_preparation' });
    expect(stored).toMatchObject({ level: 'error', kind: 'diagnostic', event: 'social_preparation.adapter_failed', project_id: projectId });
    const context = JSON.parse(stored.context_json);
    expect(context).toMatchObject({ release_id: releaseId, platform: 'x', attempt: 1 });
    expect(context.diagnostic).toMatchObject({ platform: 'x', adapter: 'x_social_preparation', cdp_code: -32000, cdp_message: 'Could not find node with given id' });
    for (const key of ['timestamp', 'title', 'body', 'private_note', 'arbitrary_nested_value']) expect(context.diagnostic).not.toHaveProperty(key);
    for (const privateFragment of ['orchid', 'lantern', 'meridian', 'cerulean', 'fjord', 'mosaic', 'obsidian', 'harbor', 'vermilion', 'crescent']) {
      expect(JSON.stringify(context)).not.toContain(privateFragment);
    }
    const settingsLogs = await request(app).get('/settings/logs?subsystem=social_preparation').expect(200);
    expect(settingsLogs.text).toContain('release_id');
    expect(settingsLogs.text).toContain(String(releaseId));
    for (const privateFragment of ['orchid', 'lantern', 'meridian', 'cerulean', 'fjord', 'mosaic', 'obsidian', 'harbor', 'vermilion', 'crescent']) {
      expect(settingsLogs.text).not.toContain(privateFragment);
    }
  });

  it('bounds helper failure diagnostics by UTF-8 bytes before parsing or persistence', async () => {
    const acceptedMessage = failureReportMessageAtUtf8ByteLength(6_144, 'x');
    const oversizedMessage = failureReportMessageAtUtf8ByteLength(6_145, 'bluesky');
    expect(acceptedMessage.length).toBeLessThanOrEqual(6_144);
    expect(oversizedMessage.length).toBeLessThanOrEqual(6_144);
    expect(Buffer.byteLength(acceptedMessage, 'utf8')).toBe(6_144);
    expect(Buffer.byteLength(oversizedMessage, 'utf8')).toBe(6_145);

    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    const accepted = await request(app)
      .patch('/social-prep/session-1/platforms/x')
      .set('Authorization', `Bearer ${redeemed.body.mediaToken}`)
      .send({ status: 'failed', detailCode: 'platform_preparation_failed', message: acceptedMessage })
      .expect(200);
    const oversized = await request(app)
      .patch('/social-prep/session-1/platforms/bluesky')
      .set('Authorization', `Bearer ${redeemed.body.mediaToken}`)
      .send({ status: 'failed', detailCode: 'platform_preparation_failed', message: oversizedMessage })
      .expect(200);

    expect(accepted.body.platform).toMatchObject({ platform: 'x', status: 'failed', detailCode: 'platform_preparation_failed' });
    expect(oversized.body.platform).toMatchObject({ platform: 'bluesky', status: 'failed', detailCode: 'platform_preparation_failed' });
    const logs = app.locals.applicationLogRepository.findPage({ subsystem: 'social_preparation' });
    expect(logs).toEqual([expect.objectContaining({ event: 'social_preparation.adapter_failed' })]);
    expect(JSON.parse(logs[0].context_json)).toMatchObject({ platform: 'x', diagnostic: { platform: 'x' } });
    expect(logs.map(({ context_json }) => context_json).join('\n')).not.toContain('✦');
  });

  const resolution = {
    stage: 'create_resolution', outcome: 'no_usable_candidate', candidate_limit: 16,
    limit_exceeded: false, complete: true, candidate_count: 2, inspected_count: 2,
    usable_count: 0, layout_rejected_count: 2,
  };

  const manual = {
    composition: { state: 'completed' },
    consent: { state: 'completed', parent_requested: true, parent_response_accepted: true, decision: 'continue', local_presentation: 'failed' },
    discovery: { state: 'completed', result: null },
    connection_setup: { state: 'completed' }, connection: { state: 'completed', result: null },
    browser_setup: { state: 'completed' }, adapter_invocation: { state: 'failed' }, runtime_disposal: { state: 'failed' },
    failure: { kind: 'caught_exception', exception_class: 'invalid_operation', disposal_exception_class: 'io' },
  };

  async function retainManual(manualPreparation, paddingBytes = 0) {
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    const report = { ...failureReport('patreon'), manual_preparation: manualPreparation, create_resolution: resolution,
      private_sibling: 'private-token private-vanity private-title private-file.png C:\\private\\media.png https://private.test/raw arbitrary-message' };
    let message = JSON.stringify(report);
    if (paddingBytes) {
      report.padding = '';
      const remaining = paddingBytes - Buffer.byteLength(JSON.stringify(report), 'utf8');
      report.padding = '✦'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
      message = JSON.stringify(report);
      expect(Buffer.byteLength(message, 'utf8')).toBe(paddingBytes);
    }
    const response = await request(app).patch('/social-prep/session-1/platforms/patreon')
      .set('Authorization', `Bearer ${redeemed.body.mediaToken}`)
      .send({ status: 'failed', detailCode: 'platform_preparation_failed', message }).expect(200);
    expect(response.body.platform.status).toBe('failed');
    return app.locals.applicationLogRepository.findPage({ subsystem: 'social_preparation' });
  }

  it('retains the complete fixed manual evidence with primary adapter diagnostic and no private siblings', async () => {
    const [stored] = await retainManual(manual);
    const diagnostic = JSON.parse(stored.context_json).diagnostic;
    expect(diagnostic.manual_preparation).toEqual(manual);
    expect(diagnostic.create_resolution).toEqual(resolution);
    expect(diagnostic.cdp_code).toBe(-32000);
    expect(diagnostic.checkpoints).toEqual(failureReport().checkpoints);
    for (const fragment of ['private-', 'private.test', 'arbitrary-message', 'C:\\private']) expect(stored.context_json).not.toContain(fragment);
  });

  it.each(['caught_exception', 'failure_outcome', 'disposal_failure'])('retains fixed failure kind %s without inventing an exception', async (kind) => {
    const evidence = { ...manual, failure: { kind, exception_class: null, disposal_exception_class: null } };
    const [stored] = await retainManual(evidence);
    expect(JSON.parse(stored.context_json).diagnostic.manual_preparation).toEqual(evidence);
  });

  it.each(['not_started', 'entered', 'completed', 'failed'])('retains each boundary state %s', async (state) => {
    const evidence = { ...manual, composition: { state } };
    const [stored] = await retainManual(evidence);
    expect(JSON.parse(stored.context_json).diagnostic.manual_preparation.composition.state).toBe(state);
  });

  it.each(['invalid_operation', 'io', 'unauthorized_access', 'argument', 'operation_canceled', 'object_disposed',
    'timeout', 'websocket_connection', 'social_preparation_runtime', 'browser_preparation', 'cdp_command', 'cdp_transport', 'unexpected'])
  ('retains only the allowlisted manual exception category %s', async (exception_class) => {
    const [stored] = await retainManual({ ...manual, failure: { ...manual.failure, exception_class } });
    expect(JSON.parse(stored.context_json).diagnostic.manual_preparation.failure.exception_class).toBe(exception_class);
  });

  it.each(['continue', 'cancel', 'display_failed', 'unknown'])('retains consent decision %s and unknown bridge facts without coercion', async (decision) => {
    const consent = { ...manual.consent, decision, parent_requested: null, parent_response_accepted: null, local_presentation: 'unknown' };
    const [stored] = await retainManual({ ...manual, consent });
    expect(JSON.parse(stored.context_json).diagnostic.manual_preparation.consent).toEqual(consent);
  });

  it.each([6144, 6145])('enforces the existing %i-byte transport boundary with manual evidence present', async (bytes) => {
    const logs = await retainManual(manual, bytes);
    expect(logs).toHaveLength(bytes === 6144 ? 1 : 0);
    if (logs.length) expect(JSON.parse(logs[0].context_json).diagnostic.manual_preparation).toEqual(manual);
  });

  it.each([
    null, [], 'private-string', {},
    { ...manual, private_field: 'private-token' },
    ...Object.keys(manual).map((missing) => Object.fromEntries(Object.entries(manual).filter(([key]) => key !== missing))),
    ...['composition', 'consent', 'discovery', 'connection_setup', 'connection', 'browser_setup', 'adapter_invocation', 'runtime_disposal']
      .flatMap((boundary) => [
        { ...manual, [boundary]: { ...manual[boundary], state: 'private-state' } },
        { ...manual, [boundary]: { ...manual[boundary], token: 'private-token' } },
        { ...manual, [boundary]: { ...manual[boundary], state: null } },
      ]),
    { ...manual, consent: { ...manual.consent, parent_requested: 'yes' } },
    { ...manual, consent: { ...manual.consent, parent_response_accepted: 1 } },
    { ...manual, consent: { ...manual.consent, decision: 'Continue' } },
    { ...manual, consent: { ...manual.consent, local_presentation: 'private-desktop' } },
    { ...manual, failure: { ...manual.failure, kind: 'private-kind' } },
    { ...manual, failure: { ...manual.failure, exception_class: 'System.InvalidOperationException' } },
    { ...manual, failure: { ...manual.failure, disposal_exception_class: 'private-exception' } },
    { ...manual, failure: { ...manual.failure, message: 'C:\\private\\media.png https://private.test/raw' } },
    { ...manual, discovery: { ...manual.discovery, result: 'private-result' } },
    { ...manual, connection: { ...manual.connection, result: 'ws://private.test/' } },
  ])('rejects malformed/private manual evidence without changing the status outcome (%#)', async (evidence) => {
    expect(await retainManual(evidence)).toEqual([]);
  });

  async function retainResolution(createResolution) {
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    await request(app).patch('/social-prep/session-1/platforms/patreon')
      .set('Authorization', `Bearer ${redeemed.body.mediaToken}`)
      .send({ status: 'failed', detailCode: 'platform_preparation_failed', message: JSON.stringify({
        ...failureReport('patreon'), create_resolution: createResolution,
        private_sibling: { nodeId: 'private-dom-marker', url: 'https://private.example/token' },
      }) }).expect(200);
    return app.locals.applicationLogRepository.findPage({ subsystem: 'social_preparation' });
  }

  it.each([
    'root_unavailable', 'zero_matches', 'no_usable_candidate', 'ambiguous', 'candidate_limit_exceeded',
    'malformed_query', 'invalid_candidate_identity', 'malformed_description', 'stale_description',
    'malformed_geometry', 'unique_candidate',
  ])('retains only the typed Create-resolution schema for %s', async (outcome) => {
    const evidence = { ...resolution, outcome };
    if (['root_unavailable', 'candidate_limit_exceeded', 'malformed_query'].includes(outcome)) {
      for (const key of ['candidate_count', 'inspected_count', 'usable_count', 'layout_rejected_count']) delete evidence[key];
      evidence.complete = false;
      evidence.limit_exceeded = outcome === 'candidate_limit_exceeded';
    } else if (outcome === 'zero_matches') {
      Object.assign(evidence, { candidate_count: 0, inspected_count: 0, usable_count: 0, layout_rejected_count: 0 });
    } else if (outcome === 'ambiguous') {
      Object.assign(evidence, { usable_count: 2, layout_rejected_count: 0 });
    } else if (outcome === 'unique_candidate') {
      Object.assign(evidence, { usable_count: 1, layout_rejected_count: 1 });
    } else if (outcome !== 'no_usable_candidate') {
      Object.assign(evidence, { inspected_count: 0, usable_count: 0, layout_rejected_count: 0, complete: false });
    }
    const [stored] = await retainResolution(evidence);
    expect(stored.event).toBe('social_preparation.adapter_failed');
    const diagnostic = JSON.parse(stored.context_json).diagnostic;
    expect(diagnostic.create_resolution).toEqual(evidence);
    expect(diagnostic).not.toHaveProperty('private_sibling');
    expect(stored.context_json).not.toContain('private-dom-marker');
    expect(stored.context_json).not.toContain('private.example');
  });

  it('retains unknown counts and outcome as absent, not fabricated zero or a final result', async () => {
    const evidence = { stage: 'create_resolution', candidate_limit: 16, limit_exceeded: false, complete: false };
    const [stored] = await retainResolution(evidence);
    expect(JSON.parse(stored.context_json).diagnostic.create_resolution).toEqual(evidence);
  });

  it.each([0, 16])('accepts the bounded count boundary %i', async (count) => {
    const evidence = { ...resolution, candidate_count: count, inspected_count: count, usable_count: 0, layout_rejected_count: count };
    const [stored] = await retainResolution(evidence);
    expect(JSON.parse(stored.context_json).diagnostic.create_resolution).toEqual(evidence);
  });

  it.each([
    null, [], 'private-string',
    { ...resolution, stage: 'private-stage' }, { ...resolution, outcome: 'private-outcome' },
    { ...resolution, outcome: null }, { ...resolution, candidate_limit: 17 },
    { ...resolution, candidate_limit: '16' }, { ...resolution, complete: 'yes' },
    { ...resolution, complete: null }, { ...resolution, limit_exceeded: 1 },
    { ...resolution, nodeId: 12345 }, { ...resolution, backendNodeId: 'private-node' },
    { ...resolution, session: { html: '<div>private-dom-marker</div>', token: 'private-secret' } },
    ...['stage', 'candidate_limit', 'limit_exceeded', 'complete'].map((missing) =>
      Object.fromEntries(Object.entries(resolution).filter(([key]) => key !== missing))),
    ...['candidate_count', 'inspected_count', 'usable_count', 'layout_rejected_count'].flatMap((key) =>
      [-1, 17, 0.5, '2', null, true, {}, [], Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ ...resolution, [key]: value }))),
  ])('rejects malformed or private resolver evidence without changing status transitions (%#)', async (evidence) => {
    expect(await retainResolution(evidence)).toEqual([]);
  });

  it('keeps a committed failed status successful when post-commit release enrichment throws', async () => {
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    let releaseLookupCalls = 0;
    releaseService.repository.findById = () => {
      releaseLookupCalls += 1;
      throw new Error('diagnostic release lookup failed');
    };

    const response = await request(app)
      .patch('/social-prep/session-1/platforms/x')
      .set('Authorization', `Bearer ${redeemed.body.mediaToken}`)
      .send({ status: 'failed', detailCode: 'platform_preparation_failed', message: JSON.stringify(failureReport()) })
      .expect(200);

    expect(response.body.platform).toMatchObject({ platform: 'x', status: 'failed', detailCode: 'platform_preparation_failed' });
    expect(releaseLookupCalls).toBe(1);
    const platform = repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x');
    expect(platform).toMatchObject({ status: 'failed', attempts: 1 });
    expect(app.locals.applicationLogRepository.findPage({ subsystem: 'social_preparation' })
      .filter((row) => row.event === 'social_preparation.adapter_failed')).toHaveLength(0);
  });

  it('correlates same-platform same-attempt failures to their safe release IDs', async () => {
    const firstRedeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    await request(app)
      .patch('/social-prep/session-1/platforms/x')
      .set('Authorization', `Bearer ${firstRedeemed.body.mediaToken}`)
      .send({ status: 'failed', detailCode: 'platform_preparation_failed', message: JSON.stringify(failureReport()) })
      .expect(200);

    const secondReleaseId = Number(db.prepare(
      "INSERT INTO releases (project_id, title, description, notes, published_date) VALUES (?, 'Second snapshot', '', '', '2026-08-01')"
    ).run(projectId).lastInsertRowid);
    const secondIntent = generateIntentToken();
    repository.insertSession({
      id: 'session-2', releaseId: secondReleaseId, kind: 'initial', intentHash: digestToken(secondIntent),
      expiresAt: new Date('2030-01-01T00:00:00.000Z'), now: new Date('2029-12-31T23:59:00.000Z'),
    });
    repository.ensurePlatforms(secondReleaseId, ['x']);
    repository.reassignPlatformsToSession('session-2', ['x']);
    const secondRedeemed = await request(app).post('/social-prep/redeem').send({ intent: secondIntent }).expect(200);
    await request(app)
      .patch('/social-prep/session-2/platforms/x')
      .set('Authorization', `Bearer ${secondRedeemed.body.mediaToken}`)
      .send({ status: 'failed', detailCode: 'platform_preparation_failed', message: JSON.stringify(failureReport()) })
      .expect(200);

    const contexts = app.locals.applicationLogRepository.findPage({ subsystem: 'social_preparation' })
      .filter((row) => row.event === 'social_preparation.adapter_failed')
      .map((row) => JSON.parse(row.context_json));
    expect(contexts).toHaveLength(2);
    expect(contexts.map((context) => context.release_id).sort((left, right) => left - right)).toEqual([releaseId, secondReleaseId]);
    for (const context of contexts) expect(context).toMatchObject({ platform: 'x', attempt: 1 });
    const serializedContexts = JSON.stringify(contexts);
    expect(serializedContexts).not.toContain(firstRedeemed.body.mediaToken);
    expect(serializedContexts).not.toContain(secondRedeemed.body.mediaToken);
    expect(serializedContexts).not.toContain('session-1');
    expect(serializedContexts).not.toContain('session-2');

    const settingsLogs = await request(app).get('/settings/logs?subsystem=social_preparation').expect(200);
    expect(settingsLogs.text).toContain('release_id');
    expect(settingsLogs.text).toContain(String(releaseId));
    expect(settingsLogs.text).toContain(String(secondReleaseId));
  });
});
