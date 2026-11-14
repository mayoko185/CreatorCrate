import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entrypoint = fs.readFileSync(path.join(root, 'src/static/creatorcrate.js'), 'utf8');

function productionFiles(directory = path.join(root, 'src')) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(filename);
    return /\.(?:js|njk|css)$/.test(filename) ? [filename] : [];
  });
}

describe('image slideshow retirement', () => {
  it('has no legacy module or production imports', () => {
    expect(fs.existsSync(path.join(root, 'src/static/client/slideshow.js'))).toBe(false);
    for (const filename of productionFiles()) {
      expect(fs.readFileSync(filename, 'utf8'), filename).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?)['"][^'"]*\/slideshow\.js['"]/);
    }
  });

  it('exposes no retired enhancers or runtime ownership markers', () => {
    for (const filename of productionFiles()) {
      expect(fs.readFileSync(filename, 'utf8'), filename).not.toMatch(
        /enhanceSlideshow|enhanceProjectAssetsPreviewSlideshow|SLIDESHOW_SCAFFOLD_SELECTOR|SLIDESHOW_SEQUENCE_SELECTOR|__creatorCrateSlideshowState|projectAssetsPreviewSlideshowBound|slideshowBound|temporarySequenceActive|openSingleById/,
      );
    }
  });

  it('has no obsolete scaffold attributes', () => {
    for (const filename of productionFiles()) {
      expect(fs.readFileSync(filename, 'utf8'), filename).not.toMatch(/\bdata-slideshow-/);
    }
  });

  it('has no obsolete CSS selectors and retains the current trigger and viewer', () => {
    const css = fs.readFileSync(path.join(root, 'src/static/creatorcrate.css'), 'utf8');
    expect(css).not.toMatch(/\.slideshow-(?!trigger\b)[\w-]+|\[data-slideshow-/);
    expect(css).toContain('.slideshow-trigger');
    expect(css).toContain('.unified-viewer-dialog');
  });

  it('initializes each unified host and the shared viewer once', () => {
    for (const name of ['ProjectAssets', 'AssetLibrary', 'AssetDetails', 'ReleaseAssets', 'ReleaseDetail', 'ProjectDetail', 'Unified']) {
      expect(entrypoint.match(new RegExp(`enhance${name}Viewer\\(document\\)`, 'g')), name).toHaveLength(1);
    }
    for (const [filename, attribute] of [
      ['src/views/projects/assets.njk', 'data-project-assets-viewer-sequence'],
      ['src/views/assets/index.njk', 'data-asset-library-viewer-sequence'],
    ]) {
      const template = fs.readFileSync(path.join(root, filename), 'utf8');
      expect(template.match(new RegExp(attribute, 'g')), filename).toHaveLength(1);
      expect(template, filename).toContain('slideshowSequenceJson');
    }
  });
});
