import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as contracts from '../src/services/asset-processing-contracts.js';
import * as service from '../src/services/asset-processing-service.js';

const CONTRACT_EXPORTS = [
  'AssetProcessingError',
  'CONVERSION_FORMATS',
  'CONVERSION_QUALITY_DEFAULT',
  'CONVERSION_QUALITY_MAX',
  'CONVERSION_QUALITY_MIN',
  'deriveConversionOutputPlan',
  'isSupportedConversionSource',
  'normalizeConversionOptions',
  'normalizeRelativePath',
  'ORIGINAL_HANDLINGS',
  'pathKey',
  'WATERMARK_SOURCE_IMAGE_EXTENSIONS',
];

describe('asset processing contracts', () => {
  it('preserves executor export identity for every extracted contract', () => {
    for (const name of CONTRACT_EXPORTS) {
      expect(service[name]).toBe(contracts[name]);
    }
  });

  it('preserves error identity across direct and compatibility imports', () => {
    let error;
    try {
      contracts.normalizeConversionOptions({ format: 'png', originalHandling: 'invalid' });
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(contracts.AssetProcessingError);
    expect(error).toBeInstanceOf(service.AssetProcessingError);
    expect(error).toMatchObject({
      name: 'AssetProcessingError',
      message: 'Original handling must be one of: keep, move, delete.',
      code: 'INVALID_ORIGINAL_HANDLING',
    });
  });

  it('imports only dependency-light path and metadata modules', () => {
    const sourcePath = fileURLToPath(new URL('../src/services/asset-processing-contracts.js', import.meta.url));
    const source = fs.readFileSync(sourcePath, 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);

    expect(imports).toEqual(['node:path', './asset-metadata.js']);
  });
});
