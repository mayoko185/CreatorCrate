/**
 * Intentional rendered parity: /releases/:id/assets vs /projects/:id/assets.
 *
 * Single-surface HTTP/template suites own their complete markup and behavior.
 * This suite keeps only the smaller contract that would catch one asset browser
 * drifting from the other while both remain independently valid.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function extractElement(html, tag, className) {
  return html.match(new RegExp(`<${tag} class="[^"]*${className}[^"]*"[\\s\\S]*?<\\/${tag}>`))?.[0] || '';
}

function extractElements(html, tag, className) {
  return [...html.matchAll(new RegExp(`<${tag} class="[^"]*${className}[^"]*"[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g'))]
    .map((match) => match[0]);
}

function extractDialog(html, id) {
  return html.match(new RegExp(`<dialog id="${id}"[^>]*>[\\s\\S]*?<\\/dialog>`))?.[0] || '';
}

function extractInputTag(html, id) {
  return html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] || '';
}

function optionValues(html, selectId) {
  const select = html.match(new RegExp(`<select id="${selectId}"[^>]*>[\\s\\S]*?<\\/select>`))?.[0] || '';
  return [...select.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
}

function extractRegionBefore(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  return start === -1 || end === -1 ? '' : html.slice(start, end);
}

function sizeOptionLabels(control) {
  return [...control.matchAll(/data-grid-size-option-label="([^"]+)"/g)].map((match) => match[1]);
}

function renderedSelectionFilenames(html, cardClass) {
  return extractElements(html, 'article', cardClass).map((card) => {
    const selectionInput = card.match(/<input\b[^>]*class="asset-select-checkbox"[^>]*>/)?.[0] || '';
    return selectionInput.match(/data-asset-filename="([^"]+)"/)?.[1]
      || selectionInput.match(/aria-label="(?:Select|Deselect) ([^"]+)"/)?.[1]
      || '';
  });
}

function markerOrder(html, markers) {
  return markers.map((marker) => html.indexOf(marker));
}

describe('intentional asset-browser parity: releases vs projects', () => {
  let db;
  let tmpDir;
  let projectId;
  let releaseLocation;
  let category;
  let disabledCategory;
  let pages;
  const fixtureFilenames = Object.freeze({
    insertionOrder: ['asset2.png', 'asset10.png', 'Asset1.png'],
    canonicalOrder: ['Asset1.png', 'asset10.png', 'asset2.png'],
  });

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-parity-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });

    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper } },
    );
    const { agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot);

    const projectResponse = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Parity+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    projectId = Number(projectResponse.headers.location.replace('/projects/', ''));

    const projectDirName = fs.readdirSync(projectsRoot).find((entry) => entry.endsWith('-parity-test-project'));
    const projectDir = path.join(projectsRoot, projectDirName);
    const categoryRepository = createAssetCategoryRepository(db);
    [category] = categoryRepository.listProjectCategories(projectId);
    fs.writeFileSync(path.join(projectDir, fixtureFilenames.insertionOrder[0]), 'png');
    fs.writeFileSync(path.join(projectDir, fixtureFilenames.insertionOrder[1]), 'png');
    fs.mkdirSync(path.join(projectDir, category.directory_slug), { recursive: true });
    fs.writeFileSync(path.join(projectDir, category.directory_slug, fixtureFilenames.insertionOrder[2]), 'png');
    await agent
      .post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    disabledCategory = categoryRepository.addProjectCategory({
      projectId,
      displayName: 'Disabled parity category',
      directorySlug: 'disabled-parity-category',
      displayOrder: categoryRepository.listProjectCategories(projectId).length,
      enabled: false,
    });

    const releaseResponse = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Parity+Test+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    releaseLocation = releaseResponse.headers.location;

    const [firstAsset] = createAssetRepository(db).findByProjectId(projectId);
    await agent
      .post(`${releaseLocation}/assets`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${firstAsset.id}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const [projectGrid, releaseGrid, projectList, releaseList, projectCategory, projectPaged, releasePaged] = await Promise.all([
      agent.get(`/projects/${projectId}/assets`).expect(200),
      agent.get(`${releaseLocation}/assets`).expect(200),
      agent.get(`/projects/${projectId}/assets?view=list`).expect(200),
      agent.get(`${releaseLocation}/assets?view=list`).expect(200),
      agent.get(`/projects/${projectId}/assets?category=${category.id}`).expect(200),
      agent.get(`/projects/${projectId}/assets?pageSize=1`).expect(200),
      agent.get(`${releaseLocation}/assets?pageSize=1`).expect(200),
    ]);
    pages = {
      projectGrid: projectGrid.text,
      releaseGrid: releaseGrid.text,
      projectList: projectList.text,
      releaseList: releaseList.text,
      projectCategory: projectCategory.text,
      projectPaged: projectPaged.text,
      releasePaged: releasePaged.text,
    };
  });

  afterAll(() => {
    if (db) closeDatabase(db);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps the shared browser shell and display controls on both surfaces', () => {
    for (const [html, dialogId] of [
      [pages.projectGrid, 'project-assets-filter-dialog'],
      [pages.releaseGrid, 'release-assets-filter-dialog'],
    ]) {
      const positions = markerOrder(html, [
        'class="asset-browser-layout"',
        'class="asset-browser-content"',
        'class="asset-viewer-display-controls"',
        'class="view-switcher"',
        'data-asset-grid-size-controls',
      ]);
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(html).toContain(`href="#${dialogId}" aria-label="Filter assets"`);
      expect(extractDialog(html, dialogId)).toContain('class="app-dialog" data-app-dialog');
    }
  });

  it('keeps the intentional shared Grid card contract and surface-specific extensions', () => {
    const projectCard = extractElement(pages.projectGrid, 'article', 'asset-card');
    const releaseCard = extractElement(pages.releaseGrid, 'article', 'asset-card');
    const sharedMarkers = [
      'asset-card--project',
      'role="option"',
      'aria-selected=',
      'data-asset-selectable-card',
      'class="asset-select-checkbox"',
      'class="asset-card-top"',
      'class="asset-card-media',
      'data-asset-viewer-preview',
      'data-asset-info-card',
      'class="asset-details-link',
      fixtureFilenames.canonicalOrder[0],
      category.display_name,
    ];

    for (const card of [projectCard, releaseCard]) {
      for (const marker of sharedMarkers) expect(card).toContain(marker);
      expect(card).not.toContain('class="asset-card-body"');
      expect(extractRegionBefore(card, 'class="asset-card-top"', 'class="asset-card-media')).toContain('class="asset-select-checkbox"');
    }
    expect(projectCard).toContain('data-project-assets-preview-id');
    expect(projectCard).not.toContain('release-asset-grid-role');
    expect(releaseCard).not.toContain('data-project-assets-preview-id');
    expect(releaseCard).toContain('release-asset-grid-role');
    expect(projectCard).toContain('Effective tags');
    expect(projectCard).toContain('Release usage');
    expect(releaseCard).not.toContain('Effective tags');
    expect(releaseCard).not.toContain('Release usage');
  });

  it('keeps the intentional shared List card contract and different actions', () => {
    const projectCard = extractElement(pages.projectList, 'article', 'asset-list-card');
    const releaseCard = extractElement(pages.releaseList, 'article', 'asset-list-card');
    const sharedMarkers = [
      'asset-list-card--project',
      'data-asset-selectable-card',
      'class="asset-select-checkbox"',
      'class="asset-list-card-top"',
      'class="asset-list-card-media',
      'class="asset-list-card-body"',
      'asset-list-card-identity',
      'asset-list-card-primary-metadata',
      'asset-list-card-associations-region',
      'data-asset-title-row',
      'class="asset-details-link',
      fixtureFilenames.canonicalOrder[0],
      category.display_name,
    ];

    for (const card of [projectCard, releaseCard]) {
      for (const marker of sharedMarkers) expect(card).toContain(marker);
      const positions = markerOrder(card, [
        'class="asset-list-card-top"',
        'class="asset-list-card-media',
        'class="asset-list-card-body"',
      ]);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(extractRegionBefore(card, 'class="asset-list-card-top"', 'class="asset-list-card-media')).toContain('class="asset-select-checkbox"');
    }
    expect(projectCard).toContain('data-asset-rename-trigger');
    expect(projectCard).toContain('data-project-assets-preview-id');
    expect(projectCard).not.toContain('release-asset-role-form');
    expect(releaseCard).not.toContain('data-asset-rename-trigger');
    expect(releaseCard).not.toContain('data-project-assets-preview-id');
    expect(releaseCard).toContain('release-asset-role-form');
  });

  it('keeps category presentation aligned and the Project category dropdown correct', () => {
    for (const html of [pages.projectGrid, pages.releaseGrid, pages.projectList, pages.releaseList]) {
      expect(html).toMatch(new RegExp(`<dt>Category<\\/dt>[\\s\\S]*?${category.display_name}`));
    }

    const dialog = extractDialog(pages.projectCategory, 'project-assets-filter-dialog');
    expect(pages.projectCategory).toContain(`Category: ${category.display_name}`);
    expect(dialog).toContain(`aria-label="Category filter: ${category.display_name} (1)"`);
    const activeCategoryInput = extractInputTag(dialog, `asset-category-option-${category.id}`);
    expect(activeCategoryInput).toContain(`value="${category.id}"`);
    expect(activeCategoryInput).toMatch(/\schecked(?:\s|=|>)/);
    expect(dialog).toContain('id="asset-category-option-all"');
    expect(dialog).toContain('id="asset-category-option-uncategorized"');
    expect(dialog).toContain('id="asset-category-option-missing"');
    expect(dialog).toMatch(new RegExp(`id="asset-category-option-${disabledCategory.id}"[\\s\\S]*?Disabled parity category \\(0\\)[\\s\\S]*?\\(disabled\\)`));
  });

  it('keeps shared view-size modes and page-size choices without testing live requests', () => {
    for (const html of [pages.projectGrid, pages.releaseGrid]) {
      const controlStart = html.indexOf('data-asset-grid-size-controls');
      const gridStart = html.indexOf('<ul class="asset-grid', controlStart);
      const control = html.slice(controlStart, gridStart);
      expect(sizeOptionLabels(control).sort()).toEqual(['compact', 'default', 'large']);
      expect(control).toContain('data-grid-size-slider');
    }
    for (const html of [pages.projectList, pages.releaseList]) {
      const controlStart = html.indexOf('data-asset-list-size-controls');
      const listStart = html.indexOf('<ul class="asset-list', controlStart);
      const control = html.slice(controlStart, listStart);
      expect(sizeOptionLabels(control).sort()).toEqual(['compact', 'large']);
      expect(control).toContain('data-grid-size-slider');
    }

    const supportedPageSizes = ['10', '25', '50', '100', '150', '200', 'all'];
    expect(optionValues(pages.projectPaged, 'pageSize')).toEqual(supportedPageSizes);
    expect(optionValues(pages.releasePaged, 'pageSize')).toEqual(supportedPageSizes);
  });

  it('keeps canonical filename order and link-based pagination aligned', () => {
    for (const [html, cardClass] of [
      [pages.projectGrid, 'asset-card'],
      [pages.releaseGrid, 'asset-card'],
      [pages.projectList, 'asset-list-card'],
      [pages.releaseList, 'asset-list-card'],
    ]) {
      expect(renderedSelectionFilenames(html, cardClass)).toEqual(fixtureFilenames.canonicalOrder);
    }
    for (const html of [pages.projectPaged, pages.releasePaged]) {
      expect(html).toMatch(/<a [^>]*class="pagination-next"/);
      expect(html).not.toMatch(/<button [^>]*class="pagination-next"/);
    }
  });
});
