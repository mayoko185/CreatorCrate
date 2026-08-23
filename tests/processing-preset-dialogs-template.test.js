/**
 * Server-rendered markup for the preset-management controls added to the
 * Convert / Workflow Prompt / Watermark processing dialogs
 * (src/views/partials/processing-dialogs.njk, presetSection macro).
 *
 * Verifies the same compact management area (Save/Update/Rename/Delete +
 * a name-input form) renders identically for all three dialogs, that the
 * management controls are real buttons with correct default disabled
 * state, and that the name input carries a visible/associated label —
 * accessibility requirements from the preset-management assignment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const CSS_PATH = fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url));
const PROCESSING_JS_PATH = fileURLToPath(new URL('../src/static/processing.js', import.meta.url));

function dialogBody(html, dialogId) {
  const re = new RegExp(`<dialog id="${dialogId}"[\\s\\S]*?data-app-dialog[\\s\\S]*?<\\/dialog>`);
  const match = html.match(re);
  return match ? match[0] : '';
}

function elementByClass(source, tag, className) {
  const opening = new RegExp(`<${tag}\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`).exec(source);
  if (!opening) return '';
  const tags = new RegExp(`</?${tag}\\b[^>]*>`, 'g');
  tags.lastIndex = opening.index;
  let depth = 0;
  let match;
  while ((match = tags.exec(source))) {
    if (match[0].startsWith(`</${tag}`)) depth -= 1;
    else depth += 1;
    if (depth === 0) return source.slice(opening.index, tags.lastIndex);
  }
  return '';
}

function scopeSection(dialogBody) {
  return dialogBody.match(/<section class="settings-section processing-dialog-section" data-processing-scope[\s\S]*?<\/section>/)?.[0] || '';
}

function sectionByData(source, attribute) {
  return source.match(new RegExp(`<section\\b[^>]*${attribute}[^>]*>[\\s\\S]*?<\\/section>`))?.[0] || '';
}

function sectionByHeading(source, heading) {
  return source.match(new RegExp(`<section class="settings-section processing-dialog-section"[^>]*>\\s*<h3[^>]*>${heading}<\\/h3>[\\s\\S]*?<\\/section>`))?.[0] || '';
}

function fieldPairInCompactGrid(source, firstField, secondField) {
  return new RegExp(
    `<div class="processing-watermark-compact-grid[^\"]*">(?:(?!<div class="processing-watermark-compact-grid)[\\s\\S])*?data-processing-field="${firstField}"(?:(?!<div class="processing-watermark-compact-grid)[\\s\\S])*?data-processing-field="${secondField}"`,
  ).test(source);
}

describe('Processing dialog preset-management markup', () => {
  let db;
  let app;
  let tmpDir;
  let agent;
  let csrfToken;
  let projectId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-preset-dialogs-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
    const res = await agent
      .post('/projects')
      .send('title=Preset+Dialog+Project')
      .send('status=tbd')
      .send('priority=normal')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded');
    projectId = Number(res.headers.location.replace('/projects/', ''));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders the same preset-management controls for Convert, Workflow Prompt, and Watermark', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const html = res.text;

    for (const dialogId of ['processing-convert-dialog', 'processing-workflow-dialog', 'processing-watermark-dialog']) {
      const body = dialogBody(html, dialogId);
      expect(body, `expected ${dialogId} to render`).not.toBe('');

      // Preset selector with an explicit Custom option (selected by default).
      expect(body).toContain('data-processing-preset-select');
      expect(body).toMatch(/<option value=""[^>]*>Custom<\/option>/);

      // Real buttons, not links or divs, for every management action.
      expect(body).toMatch(/<button[^>]*data-processing-preset-save[^>]*>Save as preset<\/button>/);
      expect(body).toMatch(/<button[^>]*type="button"[^>]*data-processing-preset-update[^>]*disabled[^>]*aria-disabled="true"[^>]*>Update preset<\/button>/);
      expect(body).toMatch(/<button[^>]*type="button"[^>]*data-processing-preset-rename[^>]*disabled[^>]*aria-disabled="true"[^>]*>Rename preset<\/button>/);
      expect(body).toMatch(/<button[^>]*type="button"[^>]*data-processing-preset-delete[^>]*disabled[^>]*aria-disabled="true"[^>]*>Delete preset<\/button>/);
      expect(body).toMatch(/<button[^>]*type="button"[^>]*data-processing-preset-export[^>]*disabled[^>]*aria-disabled="true"[^>]*>Export presets<\/button>/);
      expect(body).toMatch(/<button[^>]*type="button"[^>]*data-processing-preset-import[^>]*>Import presets<\/button>/);
      expect(body).toMatch(/<input[^>]*type="file"[^>]*accept="application\/json,\.json"[^>]*data-processing-preset-import-input[^>]*hidden/);

      // Save as preset itself is not disabled by default (available from Custom).
      const saveButtonMarkup = body.match(/<button[^>]*data-processing-preset-save[^>]*>/)[0];
      expect(saveButtonMarkup).not.toContain('disabled');

      // Name input has a visible, associated label (not just a placeholder).
      const nameFormMatch = body.match(/<form class="processing-preset-name-form"[\s\S]*?<\/form>/);
      expect(nameFormMatch, `expected a preset name form in ${dialogId}`).toBeTruthy();
      const nameForm = nameFormMatch[0];
      const inputIdMatch = nameForm.match(/data-processing-preset-name-input[^>]*id="([^"]+)"/) || nameForm.match(/id="([^"]+)"[^>]*data-processing-preset-name-input/);
      expect(inputIdMatch, 'name input must have an id').toBeTruthy();
      expect(nameForm).toContain(`for="${inputIdMatch[1]}"`);

      const presetCard = body.match(/<section class="settings-section processing-dialog-section">\s*<h3>Preset<\/h3>[\s\S]*?<\/section>/)?.[0] || '';
      expect(presetCard).not.toBe('');
      expect(presetCard).toContain('<legend class="sr-only">Preset</legend>');
      expect(presetCard).toContain('class="form-actions" data-processing-preset-actions');
      expect(presetCard).toContain('<details class="notes-workspace-disclosure">');
      expect(presetCard).toContain('<summary>Preset settings</summary>');
      expect(presetCard).toMatch(/<p class="help-text processing-preset-modified" data-processing-preset-modified hidden>Modified from preset\.<\/p>/);

      const currentActions = presetCard.match(/<div class="form-actions" data-processing-preset-actions>[\s\S]*?<\/div>/)?.[0] || '';
      const library = presetCard.match(/<details class="notes-workspace-disclosure">[\s\S]*?<\/details>/)?.[0] || '';
      expect(currentActions).toContain('data-processing-preset-save');
      expect(currentActions).toContain('data-processing-preset-update');
      expect(currentActions).not.toContain('data-processing-preset-rename');
      expect(currentActions).not.toContain('data-processing-preset-import');
      expect(currentActions).not.toContain('data-processing-preset-export');
      expect(currentActions).not.toContain('data-processing-preset-delete');
      expect(library).toContain('data-processing-preset-rename');
      expect(library).toContain('data-processing-preset-import');
      expect(library).toContain('data-processing-preset-export');
      expect(library).toContain('data-processing-preset-delete');
    }
  });

  it('renders global Watermark controls without legacy registry UI', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const watermarkBody = dialogBody(res.text, 'processing-watermark-dialog');
    const manageBody = dialogBody(res.text, 'processing-manage-watermarks-dialog');

    expect(watermarkBody).toContain('data-processing-field="watermarkId"');
    expect(watermarkBody).not.toContain('data-processing-field="watermarkAssetId"');
    expect(watermarkBody).toContain('Select a global Watermark');
    expect(watermarkBody).toContain('data-cc-dropdown-dispatch-native-change');

    expect(manageBody).toContain('data-processing-manage-watermarks');
    expect(manageBody).not.toContain('data-project-id');
    expect(manageBody).not.toContain('data-project-archived');
    expect(manageBody).toContain('data-processing-watermark-list');
    expect(manageBody).toContain('data-processing-scan-watermarks');
    expect(manageBody).toContain('<code>watermarks/</code>');
    expect(manageBody).toContain('automatic scanning');

    [
      'data-processing-add-watermark-form', 'processing-add-watermark-file',
      'data-processing-rename-watermark', 'data-processing-replace-watermark',
      'data-processing-delete-watermark', 'Add watermark', 'Rename', 'Replace image', 'Delete',
    ].forEach((legacyMarker) => expect(manageBody).not.toContain(legacyMarker));
  });

  it('renders the standalone Archives dialog without preset CRUD or Watermark-only fields', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const body = dialogBody(res.text, 'processing-archive-dialog');
    const watermarkBody = dialogBody(res.text, 'processing-watermark-dialog');
    expect(body).not.toBe('');
    expect(watermarkBody).not.toBe('');
    [
      'makeArchives', 'archiveIncludeResized', 'replaceExistingArchives', 'archiveFormat',
      'zipJpgQuality', 'zipWebpQuality', 'setName', 'archivePrefix', 'zipBaseName',
      'makeCbz', 'cbzJpgQuality', 'cbzPrefix', 'cbzFrom',
    ].forEach((field) => expect(watermarkBody).not.toContain(`data-processing-field="${field}"`));
    expect(body).toContain('data-processing-operation="archive"');
    expect(body).not.toContain('data-processing-preset-select');
    expect(body).toContain('Create JPEG/WebP archive pair');
    expect(body).toContain('data-processing-field="makeArchives"');
    expect(body).toContain('data-processing-field="archiveFormat"');
    expect(body).toContain('>ZIP<');
    expect(body).toContain('>7z<');
    expect(body).toContain('Set name');
    expect(body).toContain('Archive prefix');
    expect(body).toContain('Base name');
    expect(body).toContain('data-processing-field="replaceExistingArchives"');
    expect(body).toContain('Create CBZ');
    expect(body).toContain('data-processing-field="cbzJpgQuality"');
    expect(body).toContain('data-processing-field="cbzPrefix"');
    expect(body).not.toContain('watermark-resource-select');
    expect(body).not.toContain('watermark-scale-map-select');
    expect(body).not.toContain('data-processing-field="scale"');
    expect(body).not.toContain('data-processing-field="deleteSource"');
  });

  it('does not persist scope, project, or asset-selection fields inside the preset management area', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const body = dialogBody(res.text, 'processing-convert-dialog');
    const presetSectionMatch = body.match(/<section class="settings-section processing-dialog-section">\s*<h3>Preset<\/h3>[\s\S]*?<\/section>/);
    expect(presetSectionMatch, 'expected to isolate the preset management block').toBeTruthy();
    const presetSection = presetSectionMatch[0];
    expect(presetSection).not.toContain('data-processing-scope');
    expect(presetSection).not.toContain('data-processing-category-select');
  });

  it('renders workflow prompt rules with the shared operation dropdown and settings-card sections', async () => {
    const res = await agent.get('/projects/' + projectId + '/assets').expect(200);
    const body = dialogBody(res.text, 'processing-workflow-dialog');
    const ruleTemplate = body.match(/<template data-processing-rule-row-template>[\s\S]*?<\/template>/)?.[0] || '';

    expect(body).toMatch(/class="[^"]*\bapp-dialog--processing-workflow\b[^"]*"/);
    expect(ruleTemplate).toMatch(/<details[^>]*data-cc-dropdown[^>]*data-cc-dropdown-mode="single"/);
    expect((ruleTemplate.match(/data-cc-dropdown-mode="single"/g) || [])).toHaveLength(1);

    const operationSelect = ruleTemplate.match(/<select[^>]*data-cc-dropdown-native-select[^>]*data-processing-rule-operation[^>]*>[\s\S]*?<\/select>/)?.[0] || '';
    expect(operationSelect).not.toBe('');
    expect(operationSelect).toMatch(/<option value="remove" selected>Remove<\/option>/);
    expect(operationSelect).toMatch(/<option value="replace">Replace<\/option>/);
    expect(operationSelect).toMatch(/<option value="prepend">Prepend<\/option>/);
    expect(operationSelect).toMatch(/<option value="append">Append<\/option>/);
    expect(operationSelect.indexOf('>Remove<')).toBeLessThan(operationSelect.indexOf('>Replace<'));
    expect(operationSelect.indexOf('>Replace<')).toBeLessThan(operationSelect.indexOf('>Prepend<'));
    expect(operationSelect.indexOf('>Prepend<')).toBeLessThan(operationSelect.indexOf('>Append<'));
    expect(ruleTemplate).not.toContain('name="rule-type"');
    expect(ruleTemplate).not.toMatch(/<label><input type="radio"[^>]*> (?:Remove|Replace|Prepend|Append)<\/label>/);
    expect(ruleTemplate).toMatch(/<button[^>]*data-processing-remove-rule[^>]*aria-label="Remove rule"[^>]*>X<\/button>/);
    expect(ruleTemplate).toMatch(/<input[^>]*data-processing-rule-text[^>]*aria-label="Rule text"/);
    expect(ruleTemplate).toMatch(/<input[^>]*data-processing-rule-search[^>]*aria-label="Search text"/);
    expect(ruleTemplate).toMatch(/<input[^>]*data-processing-rule-replacement[^>]*aria-label="Replacement text"/);

    for (const [side, heading] of [['positive', 'Positive prompt rules'], ['negative', 'Negative prompt rules']]) {
      const section = sectionByData(body, 'data-processing-rules="' + side + '"');
      expect(section).toMatch(/class="settings-section processing-dialog-section processing-rule-section"/);
      expect(section).toContain('<h3>' + heading + '</h3>');
      expect(section).toContain('class="processing-dialog-section-body"');
      expect(section).toContain('data-processing-rule-list');
    }
  });

  it('keeps stacked workflow rule controls content-height at narrow widths', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const stackedControls = css.match(
      /@media \(max-width: 40rem\) \{[\s\S]*?\.app-dialog--processing-workflow \.processing-rule-row \{[\s\S]*?flex-direction:\s*column;[\s\S]*?\}[\s\S]*?(\.app-dialog--processing-workflow \.processing-rule-type,[\s\S]*?\.app-dialog--processing-workflow \.processing-rule-row input\[type="text"\] \{[\s\S]*?\})/,
    )?.[1] || '';

    expect(stackedControls).toMatch(/flex:\s*0 0 auto;/);
    expect(stackedControls).toMatch(/width:\s*100%;/);
    expect(stackedControls).toMatch(/max-width:\s*none;/);
  });

  it('keeps workflow rule action buttons content-width in flexible section bodies', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const addRuleAction = css.match(
      /\.app-dialog--processing-workflow \[data-processing-add-rule\]\s*\{([\s\S]*?)\}/,
    )?.[1] || '';

    expect(addRuleAction).toMatch(/align-self:\s*flex-start;/);
  });

  it('widens all four main processing dialogs with a scoped class', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const html = res.text;
    const css = fs.readFileSync(CSS_PATH, 'utf8');

    for (const dialogId of ['processing-convert-dialog', 'processing-workflow-dialog', 'processing-watermark-dialog', 'processing-archive-dialog']) {
      const body = dialogBody(html, dialogId);
      expect(body).toMatch(/class="[^"]*\bapp-dialog--processing\b[^"]*"/);
    }
    expect(dialogBody(html, 'processing-workflow-dialog')).toMatch(/class="[^"]*\bapp-dialog--processing-workflow\b[^"]*"/);

    const manageWatermarks = dialogBody(html, 'processing-manage-watermarks-dialog');
    const manageScaleMap = dialogBody(html, 'processing-manage-scale-map-dialog');
    expect(manageWatermarks).not.toContain('app-dialog--processing');
    expect(manageScaleMap).not.toContain('app-dialog--processing');

    expect(css).toMatch(/\.app-dialog--processing\s*\{[\s\S]*?width:\s*min\(\s*51rem\s*,\s*calc\(\s*100vw\s*-\s*2rem\s*\)\s*\)/);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*540px\s*\)\s*\{[\s\S]*?\.app-dialog--processing\s*\{[\s\S]*?width:\s*calc\(\s*100vw\s+-\s*1rem\s*\)/);
  });

  it('uses the Edit Project shell hierarchy and pinned Preview/Apply footer for all four processing dialogs', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);

    for (const dialogId of ['processing-convert-dialog', 'processing-workflow-dialog', 'processing-watermark-dialog', 'processing-archive-dialog']) {
      const dialog = dialogBody(res.text, dialogId);
      const card = elementByClass(dialog, 'div', 'app-dialog-card');
      const scrollBody = elementByClass(card, 'div', 'app-dialog-body');
      const footer = elementByClass(card, 'footer', 'app-dialog-footer');
      expect(card, `expected card in ${dialogId}`).not.toBe('');
      expect(scrollBody, `expected scroll body in ${dialogId}`).not.toBe('');
      expect(footer, `expected footer in ${dialogId}`).not.toBe('');
      expect(scrollBody).not.toContain('data-processing-error');
      expect(scrollBody).not.toContain('data-processing-status');
      expect(scrollBody).not.toContain('app-dialog-footer');
      expect(card.indexOf('app-dialog-description')).toBeLessThan(card.indexOf('app-dialog-body'));
      expect(card).toMatch(/<\/div>\s*<div class="app-dialog-error processing-error"[\s\S]*?<\/div>\s*<div class="app-dialog-status"[\s\S]*?<\/div>\s*<footer class="app-dialog-footer">/);

      const buttons = footer.match(/<button\b/g) || [];
      expect(buttons).toHaveLength(2);
      expect(footer.indexOf('data-processing-preview')).toBeLessThan(footer.indexOf('data-processing-apply'));
      expect(footer).not.toContain('data-dialog-close');
    }
  });

  it('renders Plan and Result as hidden shared settings cards with the required refresh action', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);

    for (const dialogId of ['processing-convert-dialog', 'processing-workflow-dialog', 'processing-watermark-dialog', 'processing-archive-dialog']) {
      const dialog = dialogBody(res.text, dialogId);
      const plan = sectionByData(dialog, 'data-processing-plan');
      const result = sectionByData(dialog, 'data-processing-result');
      expect(plan).toMatch(/class="settings-section processing-dialog-section"/);
      expect(plan).toMatch(/data-processing-plan hidden/);
      expect(plan).toContain('processing-plan-counts');
      expect(plan).toContain('processing-plan-items');
      expect(result).toMatch(/class="settings-section processing-dialog-section"/);
      expect(result).toMatch(/data-processing-result hidden/);
      expect(result).toContain('data-processing-result-body');
      expect(result).toMatch(/<button type="button" class="button button-small button-secondary" data-processing-refresh>Refresh assets<\/button>/);
    }
  });

  it('keeps Manage Watermarks and Manage Scale Map actions at card-level footers', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const watermarks = dialogBody(res.text, 'processing-manage-watermarks-dialog');
    const scaleMap = dialogBody(res.text, 'processing-manage-scale-map-dialog');
    const watermarkCard = elementByClass(watermarks, 'div', 'app-dialog-card');
    const scaleMapCard = elementByClass(scaleMap, 'div', 'app-dialog-card');
    const watermarkBody = elementByClass(watermarkCard, 'div', 'app-dialog-body');
    const scaleMapBody = elementByClass(scaleMapCard, 'div', 'app-dialog-body');
    const watermarkFooter = elementByClass(watermarkCard, 'footer', 'app-dialog-footer');
    const scaleMapFooter = elementByClass(scaleMapCard, 'footer', 'app-dialog-footer');

    expect(watermarkBody).not.toContain('data-processing-scan-watermarks');
    expect(watermarkFooter).toContain('data-processing-scan-watermarks');
    expect(watermarkFooter).toContain('button-primary');
    expect(scaleMapBody).not.toContain('data-processing-scale-map-save');
    expect(scaleMapBody).not.toContain('data-dialog-close');
    expect(scaleMapFooter).toMatch(/<button type="button" class="button button-primary" data-processing-scale-map-save>Save<\/button>/);
  });

  it('uses the settings-card scope contract and keeps category dropdown radios out of scope resolution', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const processingJs = fs.readFileSync(PROCESSING_JS_PATH, 'utf8');
    for (const dialogId of ['processing-convert-dialog', 'processing-workflow-dialog', 'processing-watermark-dialog', 'processing-archive-dialog']) {
      const dialog = dialogBody(res.text, dialogId);
      const scope = scopeSection(dialog);
      expect(scope).toMatch(/class="settings-section processing-dialog-section"[^>]*data-processing-scope[^>]*role="radiogroup"/);
      expect((scope.match(/data-processing-scope-option="(?:selected|category|project)"/g) || [])).toHaveLength(3);
      expect(scope).toContain('processing-dialog-section-body processing-scope-body');
      expect(scope).toMatch(/class="field field--checkbox processing-scope-option(?:\s[^"]*)?"/);
      expect(scope).toContain('data-processing-category-select');
      expect(processingJs).toContain("root.querySelector('[data-processing-scope-option]:checked')");
      expect(scope).not.toContain('[data-processing-scope] input[type="radio"]:checked');
      if (['processing-workflow-dialog', 'processing-watermark-dialog'].includes(dialogId)) {
        expect(scope).toContain('processing-watermark-scope-row');
        expect(scope).toContain('processing-watermark-scope-body');
        expect(scope).toContain('processing-watermark-choice-control');
      }
      if (['processing-workflow-dialog', 'processing-watermark-dialog'].includes(dialogId)) {
        expect(scope).toContain('Selected (<span data-processing-selected-count>0</span> selected)');
        expect(scope).toContain('All categories');
        expect(scope).not.toContain('>Category</span>');
        expect(scope).toMatch(/class="sr-only" type="radio"[^>]*value="category"/);
      }
      if (dialogId === 'processing-workflow-dialog') {
        expect((scope.match(/processing-watermark-choice-control/g) || [])).toHaveLength(2);
        expect((scope.match(/data-processing-scope-option="project"/g) || [])).toHaveLength(1);
        expect(scope).not.toContain('Entire project');
      }
    }
  });

  it('restores intrinsic processing dropdown sizing without widening resource controls', async () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');

    expect(css).toMatch(/\.app-dialog--processing\s+\.asset-filter-multiselect-field\s*\{[\s\S]*?flex:\s*0 1 auto;[\s\S]*?width:\s*max-content;[\s\S]*?max-width:\s*min\(\s*100%,\s*26rem\s*\)/);
    expect(css).toMatch(/\.app-dialog--processing\s+\.asset-filter-multiselect-field\s+\.asset-filter-multiselect--sized,[\s\S]*?\.app-dialog--processing\s+\.asset-filter-multiselect-field\s+\.asset-filter-multiselect--sized\s+summary\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?max-width:\s*100%/);
    expect(css).toMatch(/\.app-dialog--processing\s+\.asset-filter-multiselect-field\s+\.asset-filter-multiselect-panel\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?max-width:\s*min\(\s*26rem,\s*calc\(\s*100vw\s*-\s*1rem\s*\)\s*\)/);
    expect(css).toContain('.processing-resource-field .processing-select-field { flex: 0 1 auto; min-width: 0; }');
    expect(css).not.toContain('.processing-resource-field .processing-select-field { flex: 1 1 12rem; min-width: 0; }');
  });

  it('renders one singleton Scale Map action without a picker', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const body = dialogBody(res.text, 'processing-watermark-dialog');
    const manageBody = dialogBody(res.text, 'processing-manage-scale-map-dialog');

    expect((body.match(/<label for="watermark-resource-select">Watermark<\/label>/g) || [])).toHaveLength(1);
    expect((body.match(/>Manage Scale Map<\/button>/g) || [])).toHaveLength(1);
    expect(body).not.toContain('watermark-scale-map-select');
    expect(body).not.toContain('data-processing-field="scaleMapId"');
    expect(body).not.toContain('Manage scale maps');
    expect(body).toContain('<legend class="sr-only">Watermark</legend>');
    expect(manageBody).toContain('data-processing-manage-scale-map');
    [
      'data-processing-scale-map-list', 'data-processing-scale-map-name',
      'data-processing-scale-map-new', 'data-processing-scale-map-edit="',
      'data-processing-scale-map-delete', 'Display name', 'Create scale map',
    ].forEach((marker) => expect(manageBody).not.toContain(marker));
    expect(manageBody).toContain('data-processing-scale-map-rows');
    expect(manageBody).toContain('data-processing-scale-map-save');
  });

  it('keeps the Watermark source card and resource dropdown at intrinsic width', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const html = res.text;
    const css = fs.readFileSync(CSS_PATH, 'utf8');

    const body = dialogBody(html, 'processing-watermark-dialog');
    const source = sectionByHeading(body, 'Watermark source');
    expect(source).not.toBe('');
    expect(source).toContain('class="processing-resource-field"');
    const resourceField = elementByClass(source, 'div', 'processing-resource-field');
    expect(resourceField).not.toContain('data-dialog-open');
    const actions = source.match(/<div class="form-actions">[\s\S]*?<\/div>/)?.[0] || '';
    expect(actions).toContain('data-dialog-open="processing-manage-watermarks-dialog"');
    expect(actions).toContain('data-dialog-open="processing-manage-scale-map-dialog"');
    expect(css).toContain('.processing-resource-field .button { width: auto; flex: 0 0 auto; }');
  });

  it('renders the Watermark configuration as ordered visible settings cards', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const body = dialogBody(res.text, 'processing-watermark-dialog');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const headings = Array.from(
      body.matchAll(/<section class="settings-section processing-dialog-section"[^>]*>\s*<h3[^>]*>([^<]+)<\/h3>/g),
      (match) => match[1],
    );

    expect(headings).toEqual([
      'Preset', 'Watermark source', 'Scope', 'Placement', 'Size &amp; scale',
      'Offsets', 'Resize', 'Output format', 'Output naming', 'Plan', 'Preview', 'Result',
    ]);

    const source = sectionByHeading(body, 'Watermark source');
    expect(source).not.toBe('');
    expect(source).toContain('data-processing-watermark-thumb');
    expect(source).toContain('Place PNG files in the global <code>watermarks/</code> folder.');
    expect(source).not.toMatch(/<label[^>]*>Scale Map<\/label>/);
    expect(source).not.toContain('watermark-scale-map-select');
    const sourceActions = source.match(/<div class="form-actions">[\s\S]*?<\/div>/)?.[0] || '';
    expect(sourceActions).toMatch(/<button type="button" class="button button-small button-secondary" data-dialog-open="processing-manage-watermarks-dialog">Manage watermarks<\/button>/);
    expect(sourceActions).toMatch(/<button type="button" class="button button-small button-secondary" data-dialog-open="processing-manage-scale-map-dialog">Manage Scale Map<\/button>/);

    const placement = sectionByHeading(body, 'Placement');
    expect(fieldPairInCompactGrid(placement, 'position', 'containment')).toBe(true);
    expect(placement).toMatch(/<div class="processing-watermark-compact-grid processing-watermark-compact-row">[\s\S]*processing-watermark-choice-control[\s\S]*data-processing-field="allowOffCanvas"[\s\S]*>\s*<span>Allow off-canvas<\/span>/);
    expect(placement).not.toContain('processing-checkbox-label');

    const size = sectionByHeading(body, 'Size &amp; scale');
    expect(fieldPairInCompactGrid(size, 'scaleBasis', 'scale')).toBe(true);
    expect(size).toContain('processing-watermark-compact-row--size-primary');
    expect(size).toContain('processing-watermark-compact-row--size-secondary');
    expect(size).toContain('data-processing-field="opacity"');
    expect(size).toContain('processing-watermark-field--numeric');
    expect(size).not.toContain('0.25 (used unless');
    expect(size).not.toContain('0 (off — uses');
    expect(size).toContain('Used unless overridden by the scale map or fixed width.');

    const offsets = sectionByHeading(body, 'Offsets');
    expect(offsets).toContain('processing-watermark-compact-grid--offsets');
    expect(offsets.indexOf('data-processing-field="marginRatio"')).toBeLessThan(offsets.indexOf('data-processing-field="nudgeXRatio"'));
    expect(offsets.indexOf('data-processing-field="nudgeXRatio"')).toBeLessThan(offsets.indexOf('data-processing-field="nudgeYRatio"'));
    expect(offsets.indexOf('data-processing-field="nudgeYRatio"')).toBeLessThan(offsets.indexOf('data-processing-field="marginPx"'));

    const resize = sectionByHeading(body, 'Resize');
    expect(resize).toContain('data-processing-field="maxDimension"');
    expect(resize).toMatch(/<label class="field field--checkbox processing-watermark-choice-control">[\s\S]*data-processing-field="watermarkBeforeResize"/);
    expect(resize).toMatch(/<label class="field field--checkbox processing-watermark-choice-control">[\s\S]*data-processing-field="trimWatermark"/);

    const outputFormat = sectionByHeading(body, 'Output format');
    expect(fieldPairInCompactGrid(outputFormat, 'primaryFormat', 'secondaryFormat')).toBe(true);
    expect(fieldPairInCompactGrid(outputFormat, 'secondaryFormat', 'resizedFormat')).toBe(true);
    expect(outputFormat).toContain('data-processing-field="webpLossless"');
    expect(outputFormat).toContain('data-processing-field="jpegBackground"');
    expect(outputFormat).not.toContain('Unresized formats');
    expect(outputFormat).not.toContain('Resized formats');
    expect(outputFormat).not.toContain('data-processing-type="list"');

    const outputNaming = sectionByHeading(body, 'Output naming');
    const outputCategoryIndex = outputNaming.indexOf('data-processing-field="outputCategorySlug"');
    const suffixRowIndex = outputNaming.indexOf('data-processing-field="unresizedSuffix"');
    expect(outputCategoryIndex).toBeGreaterThan(-1);
    expect(outputCategoryIndex).toBeLessThan(suffixRowIndex);
    expect(outputNaming).toContain('data-cc-dropdown');
    expect(outputNaming).toContain('Output category');
    expect(outputNaming).not.toContain('Output directory');
    expect(outputNaming).not.toContain('data-processing-field="outputDirectory"');
    expect(fieldPairInCompactGrid(outputNaming, 'outputCategorySlug', 'unresizedSuffix')).toBe(true);
    expect(fieldPairInCompactGrid(outputNaming, 'unresizedSuffix', 'resizedSuffix')).toBe(true);
    expect(outputNaming).not.toContain('Single suffix');
    expect(outputNaming).not.toContain('data-processing-field="singleSuffix"');
    expect(outputNaming).toContain('data-processing-field="overwrite"');
    expect(outputNaming).not.toContain('data-processing-field="alsoUnresized"');
    expect(outputNaming).toContain('processing-watermark-compact-row--output-naming-fields');
    expect(outputNaming).toContain('processing-watermark-compact-row--output-naming-options');
    expect(outputNaming).toContain('processing-watermark-field--output-category');
    expect(outputNaming).toContain('processing-watermark-field--text');
    expect(outputNaming).toMatch(/<div data-processing-delete-source-toggle>[\s\S]*?<label class="field field--checkbox processing-watermark-choice-control">[\s\S]*?data-processing-field="deleteSource"[\s\S]*?<\/label>\s*<p class="notice notice--warning processing-delete-source-warning" data-processing-delete-source-warning hidden>/);
    [
      'allowOffCanvas', 'watermarkBeforeResize', 'trimWatermark', 'webpLossless', 'overwrite', 'deleteSource',
    ].forEach((field) => expect(body).toMatch(new RegExp(
      `processing-watermark-choice-control[\\s\\S]*?data-processing-field="${field}"`,
    )));

    const processingFields = [
      'mode', 'watermarkId', 'position', 'containment', 'allowOffCanvas', 'scaleBasis', 'scale',
      'fixedWatermarkWidthPx', 'windowAspect', 'opacity', 'marginRatio', 'marginPx', 'nudgeXRatio',
      'nudgeX', 'nudgeYRatio', 'nudgeY', 'maxDimension', 'watermarkBeforeResize', 'trimWatermark',
      'primaryFormat', 'secondaryFormat', 'resizedFormat', 'quality', 'webpLossless', 'jpegBackground',
      'outputCategorySlug', 'unresizedSuffix', 'resizedSuffix', 'overwrite', 'deleteSource',
    ];
    for (const field of processingFields) {
      expect((body.match(new RegExp(`data-processing-field="${field}"`, 'g')) || [])).toHaveLength(1);
    }
    [
      'Selected', 'All categories', 'Position', 'Containment', 'Allow off-canvas',
      'Scale basis', 'Scale', 'Fixed watermark width (px)', 'Window aspect', 'Opacity',
      'Margin (%/ratio)', 'Margin (px)', 'Nudge X (%/ratio)', 'Nudge X (px)', 'Nudge Y (%/ratio)', 'Nudge Y (px)',
      'Max dimension', 'Watermark before resize', 'Trim transparent watermark border',
      'Primary format', 'Secondary format', 'Resized', 'Quality', 'Lossless WebP', 'JPEG background',
      'Output category', 'Unresized suffix', 'Resized suffix', 'Replace existing generated outputs',
      'Delete source',
    ].forEach((label) => expect(body).toContain(label));
    expect(body).not.toContain('<details class="processing-section"');
    expect(body).not.toContain('processing-checkbox-label');
    expect(css).toMatch(/\.app-dialog--processing \.processing-watermark-compact-grid\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.app-dialog--processing \.processing-watermark-compact-row\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?align-items:\s*start;/);
    expect(css).toContain('.app-dialog--processing .processing-watermark-scope-row {');
    expect(css).toContain('.app-dialog--processing .processing-watermark-choice-control {');
    expect(css).toMatch(/\.app-dialog--processing \.processing-watermark-compact-grid--offsets\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*10rem\)\)/);
    expect(css).toMatch(/\.app-dialog--processing \.processing-dialog-section-body:has\(\.processing-watermark-compact-grid\)[\s\S]*?gap:\s*var\(--space-sm\)[\s\S]*?padding:\s*var\(--space-sm\) var\(--space-md\) var\(--space-md\)/);
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*?\.app-dialog--processing \.processing-watermark-compact-grid--offsets\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.processing-watermark-thumb\s*\{[\s\S]*?width:\s*8\.25rem;[\s\S]*?height:\s*4\.125rem;/);
    expect(css).toMatch(/\.processing-watermark-option-thumbnail\s*\{[\s\S]*?width:\s*5\.5rem;[\s\S]*?height:\s*2\.75rem;/);
  });

  it('renders Output category as a slug-valued single-select dropdown', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const outputNaming = sectionByHeading(dialogBody(res.text, 'processing-watermark-dialog'), 'Output naming');
    const nativeSelect = outputNaming.match(/<select id="watermark-output-category"[\s\S]*?<\/select>/)?.[0] || '';
    const nativeOptions = Array.from(nativeSelect.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g), (match) => ({
      value: match[1], selected: /\bselected\b/.test(match[2]), label: match[3],
    }));
    const enhancedRadios = Array.from(outputNaming.matchAll(/<input[^>]*type="radio"[^>]*value="([^"]*)"([^>]*)>/g), (match) => ({
      value: match[1], checked: /\bchecked\b/.test(match[2]),
    }));

    expect(nativeOptions).toEqual([
      { value: '', selected: true, label: 'Choose an output category…' },
      { value: 'final', selected: false, label: 'Final' },
      { value: 'wip', selected: false, label: 'WIP' },
      { value: 'krz', selected: false, label: 'KRZ' },
      { value: 'wm', selected: false, label: 'WM' },
      { value: 'wm-lq', selected: false, label: 'WM-LQ' },
    ]);
    expect(enhancedRadios).toEqual([
      { value: '', checked: true },
      { value: 'final', checked: false },
      { value: 'wip', checked: false },
      { value: 'krz', checked: false },
      { value: 'wm', checked: false },
      { value: 'wm-lq', checked: false },
    ]);
  });

  it('renders the shared scope UI (selected / category / project) in all four processing dialogs', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const html = res.text;

    for (const dialogId of ['processing-convert-dialog', 'processing-workflow-dialog', 'processing-watermark-dialog', 'processing-archive-dialog']) {
      const body = dialogBody(html, dialogId);
      const scope = scopeSection(body);
      expect(scope, `expected scope section in ${dialogId}`).not.toBe('');

      expect(scope).toContain('data-processing-scope-option="selected"');
      expect(scope).toContain('data-processing-scope-option="category"');
      expect(scope).toContain('data-processing-scope-option="project"');
      expect(scope).toContain('data-processing-category-select');
      if (['processing-workflow-dialog', 'processing-watermark-dialog'].includes(dialogId)) {
        expect(scope).toContain('Selected (<span data-processing-selected-count>0</span> selected)');
        expect(scope).toContain('All categories');
        expect(scope).not.toMatch(/class="field field--checkbox processing-scope-option">\s*<input[^>]*value="category"/);
        expect(scope).toContain('class="sr-only" type="radio"');
        expect(scope).not.toContain('Entire project');
      } else {
        expect(scope).toContain('>Category<');
        expect(scope).toContain('Entire project');
      }

      expect(scope).not.toContain('data-processing-scope-option="directory"');
      expect(scope).not.toContain('data-processing-directory');
      expect(scope).not.toContain('data-processing-recursive');
      expect(scope).not.toContain('Project-relative directory');
      expect(scope).not.toContain('>Recursive<');
    }
  });

  it('renders all processing selects through the shared cc-dropdown component', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const html = res.text;

    for (const dialogId of ['processing-convert-dialog', 'processing-workflow-dialog', 'processing-watermark-dialog', 'processing-archive-dialog']) {
      const body = dialogBody(html, dialogId);
      const selects = body.match(/<select[^>]*data-cc-dropdown-native-select[^>]*data-processing-(?:field|preset-select|category-select)[^>]*>/g) || [];
      for (const select of selects) {
        expect(select).toContain('cc-dropdown-native-select');
        expect(select).toContain('data-cc-dropdown-native-select');
      }
      // Static and async selects alike are wrapped in the shared cc-dropdown details.
      expect((body.match(/class="asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown/g) || []).length).toBeGreaterThanOrEqual(selects.length);
    }
  });

  it('does not render plain standalone processing selects outside the shared dropdown shell', async () => {
    const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
    const html = res.text;

    for (const dialogId of ['processing-convert-dialog', 'processing-workflow-dialog', 'processing-watermark-dialog', 'processing-archive-dialog']) {
      const body = dialogBody(html, dialogId);
      const standalone = body.match(/<select[^>]*data-processing-(?:field|preset-select|category-select)[^>]*>/g) || [];
      for (const select of standalone) {
        expect(select).toContain('data-cc-dropdown-native-select');
        expect(select).toContain('cc-dropdown-native-select');
      }
    }
  });
});
