import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createGeneratedArtifactRepository } from '../src/data/generated-artifact-repository.js';
import { deriveDisabledModeCsrfToken } from '../src/middleware/csrf.js';
import { buildAssetPreviewModel } from '../src/services/asset-presentation.js';
import { buildAssetRevisionToken } from '../src/services/preview-service.js';
import { makeZip } from './helpers/zip-fixture.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const PEPPER = 'a'.repeat(64);

describe('generated comic discovery through the manual HTTP scan', () => {
  let tmpDir;
  let db;
  let app;
  let agent;
  let project;
  let projectDir;
  let assetRepository;
  let artifactRepository;
  let cbz;
  let csrf;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-generated-comic-scan-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot);
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      appDataRoot: tmpDir, authState: { csrfPepper: PEPPER }, startGeneratedImageRebuild: false,
    });
    project = app.locals.projectService.create({ title: 'Generated Comics', status: 'tbd', projectType: 'images' });
    projectDir = path.join(projectsRoot, project.project_dir);
    assetRepository = createAssetRepository(db);
    artifactRepository = createGeneratedArtifactRepository(db);
    agent = request.agent(app);
    const response = await agent.get(`/projects/${project.id}/assets`).expect(200);
    const cookie = response.headers['set-cookie'].find((value) => value.startsWith('cc_csrf_anon='));
    csrf = deriveDisabledModeCsrfToken(PEPPER, decodeURIComponent(cookie.split(';')[0].split('=')[1]));
    const page = await sharp({ create: { width: 8, height: 12, channels: 3, background: '#ffffff' } })
      .webp().toBuffer();
    cbz = makeZip([{ name: '01.webp', data: page }, { name: '02.webp', data: page }]);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function generated(relativePath, bytes = cbz) {
    fs.writeFileSync(path.join(projectDir, relativePath), bytes);
    return assetRepository.applyAssetWatermarks(project.id, { artifactOutputs: [{
      relativePath, kind: 'archive-cbz', generatedBy: 'archives', generatedMode: 'standalone',
      sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length,
      outputProvenance: 'v1:1:2:3',
    }] }).artifactOutputs[0];
  }

  const scan = () => agent.post(`/projects/${project.id}/scan/manual`)
    .set('Accept', 'application/json').set('X-CSRF-Token', csrf).send({}).expect(200);

  it('discovers published comics and keeps atomic regeneration and replacement authority intact', async () => {
    const bytes = await sharp({ create: { width: 8, height: 12, channels: 3, background: '#ffffff' } })
      .png().toBuffer();
    fs.writeFileSync(path.join(projectDir, 'source.png'), bytes);
    await scan();
    const source = assetRepository.findByProjectIdAndPath(project.id, 'source.png');
    const options = { archives: [{ archiveFormat: 'cbz', imageFormat: 'webp', baseName: 'generated' }] };
    const processing = app.locals.assetProcessingService;
    const first = await processing.createArchives(project.id, [source.id], options);
    const relativePath = first.generatedPaths[0];
    const artifact = artifactRepository.findByProjectIdAndPath(project.id, relativePath);
    expect(artifact).toBeTruthy();
    expect(assetRepository.findByProjectIdAndPath(project.id, relativePath)).toBeUndefined();
    expect((await scan()).body.scan).toEqual({ added: 1, updated: 0, missing: 0, total: 2 });
    const comic = assetRepository.findByProjectIdAndPath(project.id, relativePath);
    expect(comic).toMatchObject({ extension: 'cbz', source_generation: 0 });
    expect((await scan()).body.scan).toEqual({ added: 0, updated: 0, missing: 0, total: 2 });
    await expect(processing.createArchives(project.id, [source.id], options))
      .rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });
    await processing.createArchives(project.id, [source.id], { ...options, replaceExistingArchives: true });
    const updated = assetRepository.findById(comic.id);
    const stats = fs.statSync(path.join(projectDir, relativePath));
    expect(updated).toMatchObject({ id: comic.id, size_bytes: stats.size,
      modified_at: stats.mtime.toISOString(), source_generation: 1 });
    expect(buildAssetRevisionToken(updated)).not.toBe(buildAssetRevisionToken(comic));
    expect(artifactRepository.findByProjectIdAndPath(project.id, relativePath))
      .toMatchObject({ id: artifact.id, generated_by: artifact.generated_by, size_bytes: stats.size });
    expect((await scan()).body.scan).toEqual({ added: 0, updated: 0, missing: 0, total: 2 });
    expect(assetRepository.findById(comic.id)).toEqual(updated);
  });

  it('indexes an artifact-owned WebP CBZ and exposes it in both asset browsers without disturbing provenance', async () => {
    const artifact = generated('generated_webp.CbZ');
    generated('generated.png', Buffer.from('noncomic output'));
    const artifactsBefore = artifactRepository.listByProjectId(project.id);
    expect(assetRepository.findByProjectId(project.id)).toEqual([]);
    // The real route keeps its CSRF protection before any reconciliation.
    await agent.post(`/projects/${project.id}/scan/manual`).set('Accept', 'application/json').send({}).expect(403);
    expect(assetRepository.findByProjectId(project.id)).toEqual([]);
    const response = await scan();
    expect(response.body).toMatchObject({ ok: true, scan: { added: 1, updated: 0, missing: 0, total: 1 } });
    const row = assetRepository.findByProjectIdAndPath(project.id, artifact.relative_path);
    expect(row).toMatchObject({ relative_path: 'generated_webp.CbZ', extension: 'cbz',
      mime_type: 'application/vnd.comicbook+zip', is_present: 1, source_generation: 0 });
    expect(artifactRepository.listByProjectId(project.id)).toEqual(artifactsBefore);
    expect(assetRepository.findByProjectIdAndPath(project.id, 'generated.png')).toBeUndefined();
    const revision = buildAssetRevisionToken(row);
    expect(revision).toEqual(expect.any(String));
    expect(revision.length).toBeGreaterThan(0);
    expect(buildAssetPreviewModel(row, null)).toMatchObject({
      comic: { format: 'cbz', sourceRevision: revision }, previewable: false,
    });
    for (const [url, trigger] of [
      [`/projects/${project.id}/assets?view=grid&pageSize=all`, 'data-project-assets-comic-trigger'],
      ['/asset-viewer?view=grid&pageSize=all', 'data-asset-library-comic-trigger'],
    ]) {
      const rendered = await agent.get(url).redirects(3).expect(200);
      expect(rendered.text).toContain('value="cbz"');
      const link = [...rendered.text.matchAll(/<a\s[^>]*>/g)]
        .map((match) => match[0]).find((tag) => tag.includes(trigger) && tag.includes(`data-comic-asset="${row.id}"`));
      expect(link).toBeTruthy();
      expect(link).toContain(`data-comic-project="${project.id}"`);
      expect(link).toContain(`data-comic-source-revision="${revision}"`);
      expect(link).toContain('aria-label="Read comic ');
      expect(link).toContain(`/projects/${project.id}/assets/${row.id}`);
    }
    expect((await scan()).body.scan).toEqual({ added: 0, updated: 0, missing: 0, total: 1 });
    expect(assetRepository.findById(row.id)).toEqual(row);
    expect(artifactRepository.listByProjectId(project.id)).toEqual(artifactsBefore);
    generated('later.cbz');
    const laterArtifacts = artifactRepository.listByProjectId(project.id);
    expect((await scan()).body.scan).toEqual({ added: 1, updated: 0, missing: 0, total: 2 });
    expect((await scan()).body.scan).toEqual({ added: 0, updated: 0, missing: 0, total: 2 });
    expect(assetRepository.findById(row.id)).toEqual(row);
    expect(assetRepository.findByProjectIdAndPath(project.id, 'later.cbz'))
      .toMatchObject({ extension: 'cbz', is_present: 1, source_generation: 0 });
    expect(artifactRepository.listByProjectId(project.id)).toEqual(laterArtifacts);
  });
});
