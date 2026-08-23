import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';

const sharpSpy = vi.hoisted(() => vi.fn());
const sharpTestHook = vi.hoisted(() => ({ onInput: null }));

vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default(...args) {
      sharpSpy(...args);
      const replacement = sharpTestHook.onInput?.(...args);
      return replacement ?? actual.default(...args);
    },
  };
});

import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  openDatabase,
  runMigrations,
} from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { StorageError } from '../src/storage/path-manager.js';
import {
  createAssetWorkflowMetadataService,
} from '../src/services/asset-workflow-metadata-service.js';
import {
  PNG_SIGNATURE,
  PNG_TEXT_CHUNK_MAX_INPUT_BYTES,
  PNG_TOTAL_TEXT_MAX_BYTES,
  WorkflowPromptMetadataError,
  createPngChunk,
} from '../src/services/workflow-prompt-editor.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function makePng(chunks) {
  return Buffer.concat([
    PNG_SIGNATURE,
    createPngChunk('IHDR', Buffer.alloc(13)),
    ...chunks,
    createPngChunk('IEND'),
  ]);
}

function makeWebp(chunkType, payload, {
  chunkLength = payload.length,
  riffLength = 4 + 8 + payload.length + (payload.length % 2),
} = {}) {
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 'ascii');
  riffHeader.writeUInt32LE(riffLength, 4);
  riffHeader.write('WEBP', 8, 'ascii');

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write(chunkType, 0, 'ascii');
  chunkHeader.writeUInt32LE(chunkLength, 4);

  return Buffer.concat([
    riffHeader,
    chunkHeader,
    payload,
    Buffer.alloc(payload.length % 2),
  ]);
}

function addLargeApp1Segment(jpeg) {
  const payload = Buffer.alloc(65533);
  Buffer.from([
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // Exif\0\0
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]).copy(payload);

  const app1 = Buffer.alloc(payload.length + 4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);

  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

function textChunk(key, value) {
  return createPngChunk('tEXt', Buffer.concat([
    Buffer.from(key, 'latin1'),
    Buffer.from([0]),
    Buffer.from(value, 'latin1'),
  ]));
}

function itextChunk(key, value) {
  return createPngChunk('iTXt', Buffer.concat([
    Buffer.from(key, 'ascii'),
    Buffer.from([0, 0, 0, 0, 0]),
    Buffer.from(value, 'utf8'),
  ]));
}

function a1111ParametersFixture() {
  return [
    'cinematic portrait <lora:portrait-style:0.8>',
    'Negative prompt: lowres, blurry',
    'Steps: 30, Sampler: Euler a, CFG scale: 4.0, Seed: 944442803, Size: 832x1248, Model: portrait.safetensors',
  ].join('\n');
}

function a1111FallbackFixture() {
  return {
    format: 'creatorcrate.comfyui-a1111-import-metadata/v1',
    source: 'parameters',
    native_workflow: false,
    positive_prompt: 'cinematic portrait <lora:portrait-style:0.8>',
    negative_prompt: 'lowres, blurry',
    settings_suffix: 'Steps: 30, Sampler: Euler a, CFG scale: 4.0, Seed: 944442803, Size: 832x1248, Model: portrait.safetensors',
    settings: {
      steps: 30,
      sampler: 'Euler a',
      cfg_scale: 4,
      seed: 944442803,
      width: 832,
      height: 1248,
      model: 'portrait.safetensors',
    },
    loras: [{ name: 'portrait-style', weight: 0.8 }],
  };
}

function workflowFixture() {
  return {
    '1': {
      class_type: 'KSampler',
      inputs: {
        positive: ['2', 0],
        negative: ['3', 0],
        seed: 42,
      },
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'portrait subject', clip: ['4', 0] },
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'blurry', clip: ['4', 0] },
    },
    '4': {
      class_type: 'CheckpointLoaderSimple',
      inputs: {},
    },
  };
}

function databaseTimestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function makeHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-asset-workflow-metadata-'));
  const projectsRoot = path.join(tmpDir, 'projects');
  fs.mkdirSync(projectsRoot);

  const db = openDatabase(path.join(tmpDir, 'test.db'));
  runMigrations(db, MIGRATIONS_DIR);

  const projectRepository = createProjectRepository(db);
  const assetRepository = createAssetRepository(db);
  let project = projectRepository.create({
    title: 'Workflow metadata asset',
    slug: 'workflow-metadata-asset',
    description: '',
    notes: '',
    status: 'tbd',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
  });
  const projectDir = '000001-workflow-metadata-asset';
  const projectPath = path.join(projectsRoot, projectDir);
  fs.mkdirSync(projectPath);
  project = projectRepository.setProjectDir(project.id, projectDir);

  function indexAsset(relativePath, {
    contents,
    extension = path.extname(relativePath).slice(1),
    write = true,
  } = {}) {
    if (write) {
      const assetPath = path.join(projectPath, relativePath);
      fs.mkdirSync(path.dirname(assetPath), { recursive: true });
      fs.writeFileSync(assetPath, contents);
    }

    return assetRepository.upsert(project.id, relativePath, {
      filename: path.basename(relativePath),
      extension,
      mimeType: extension.toLowerCase() === 'png'
        ? 'image/png'
        : 'application/octet-stream',
      sizeBytes: contents?.length ?? 0,
      modifiedAt: databaseTimestamp(),
    });
  }

  return {
    indexAsset,
    projectPath,
    service: createAssetWorkflowMetadataService({ db, projectsRoot }),
    cleanup() {
      closeDatabase(db);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('asset workflow metadata service', () => {
  let harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    sharpSpy.mockClear();
    sharpTestHook.onInput = null;
    vi.restoreAllMocks();
    harness.cleanup();
  });

  it('returns embedded ComfyUI workflow metadata from a PNG and closes its handle', () => {
    const workflow = workflowFixture();
    const asset = harness.indexAsset('source/workflow.png', {
      contents: makePng([textChunk('prompt', JSON.stringify(workflow))]),
    });
    const closeSpy = vi.spyOn(fs, 'closeSync');

    expect(harness.service.getWorkflowMetadata(asset.id)).toEqual({
      metadataKey: 'prompt',
      workflow,
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('transports validated A1111 parameters metadata without reconstructing a native graph', () => {
    const fallback = a1111FallbackFixture();
    const asset = harness.indexAsset('source/a1111.png', {
      contents: makePng([itextChunk('parameters', a1111ParametersFixture())]),
    });

    const metadata = harness.service.getWorkflowMetadata(asset.id);

    expect(metadata).toEqual({
      metadataKey: 'parameters',
      workflow: fallback,
    });
    expect(metadata.workflow.native_workflow).toBe(false);
  });

  it('returns null for invalid parameters metadata after successful PNG inspection', () => {
    const asset = harness.indexAsset('source/invalid-parameters.png', {
      contents: makePng([itextChunk('parameters', 'an unrelated note')]),
    });

    expect(harness.service.getWorkflowMetadata(asset.id)).toBeNull();
  });

  it('detects workflow metadata in a PNG larger than the text limit without whole-file reads', () => {
    const workflow = workflowFixture();
    const asset = harness.indexAsset('source/large-image.png', {
      contents: makePng([
        textChunk('prompt', JSON.stringify(workflow)),
        createPngChunk('IDAT', Buffer.alloc(PNG_TOTAL_TEXT_MAX_BYTES + 1)),
      ]),
    });
    const readFileSpy = vi.spyOn(fs, 'readFileSync');
    const readSyncSpy = vi.spyOn(fs, 'readSync');
    const closeSpy = vi.spyOn(fs, 'closeSync');

    expect(harness.service.getWorkflowMetadata(asset.id)).toEqual({
      metadataKey: 'prompt',
      workflow,
    });
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(Math.max(...readSyncSpy.mock.calls.map(([, , , length]) => length)))
      .toBeLessThanOrEqual(64 * 1024);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('retries short positional descriptor reads until it reconstructs the requested range', () => {
    const workflow = workflowFixture();
    const asset = harness.indexAsset('source/short-read.png', {
      contents: makePng([textChunk('prompt', JSON.stringify(workflow))]),
    });
    const originalReadSync = fs.readSync;
    let shortReadPending = true;
    const readSyncSpy = vi.spyOn(fs, 'readSync').mockImplementation((
      handle,
      buffer,
      bufferOffset,
      length,
      position
    ) => {
      if (shortReadPending) {
        shortReadPending = false;
        return originalReadSync(handle, buffer, bufferOffset, Math.min(length, 4), position);
      }
      return originalReadSync(handle, buffer, bufferOffset, length, position);
    });

    expect(harness.service.getWorkflowMetadata(asset.id)).toEqual({
      metadataKey: 'prompt',
      workflow,
    });
    expect(readSyncSpy.mock.calls).toEqual(expect.arrayContaining([
      [expect.any(Number), expect.any(Buffer), 0, 8, 0],
      [expect.any(Number), expect.any(Buffer), 4, 4, 4],
    ]));
  });

  it('returns only the bytes read when a positional descriptor read reaches EOF early', () => {
    const asset = harness.indexAsset('source/eof-short-read.png', {
      contents: makePng([]),
    });
    const originalReadSync = fs.readSync;
    let calls = 0;
    const readSyncSpy = vi.spyOn(fs, 'readSync').mockImplementation((
      handle,
      buffer,
      bufferOffset,
      length,
      position
    ) => {
      calls += 1;
      if (calls === 1) {
        return originalReadSync(handle, buffer, bufferOffset, Math.min(length, 4), position);
      }
      if (calls === 2) return 0;
      return originalReadSync(handle, buffer, bufferOffset, length, position);
    });

    expect(() => harness.service.getWorkflowMetadata(asset.id)).toThrow(
      expect.objectContaining({ code: 'MALFORMED_PNG' })
    );
    expect(readSyncSpy.mock.calls).toEqual(expect.arrayContaining([
      [expect.any(Number), expect.any(Buffer), 0, 8, 0],
      [expect.any(Number), expect.any(Buffer), 4, 4, 4],
    ]));
  });

  it('keeps rejecting oversized textual metadata and closes its handle', () => {
    const asset = harness.indexAsset('source/oversized-text.png', {
      contents: makePng([
        textChunk('prompt', 'x'.repeat(PNG_TEXT_CHUNK_MAX_INPUT_BYTES)),
      ]),
    });
    const closeSpy = vi.spyOn(fs, 'closeSync');

    expect(() => harness.service.getWorkflowMetadata(asset.id)).toThrow(
      expect.objectContaining({ code: 'OVERSIZED_PNG_METADATA' })
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates truncated PNG chunk failures and closes its handle', () => {
    const truncated = Buffer.alloc(20);
    PNG_SIGNATURE.copy(truncated);
    truncated.writeUInt32BE(13, 8);
    truncated.write('IHDR', 12, 'ascii');
    const asset = harness.indexAsset('source/truncated.png', { contents: truncated });
    const closeSpy = vi.spyOn(fs, 'closeSync');

    expect(() => harness.service.getWorkflowMetadata(asset.id)).toThrow(
      expect.objectContaining({ code: 'MALFORMED_PNG' })
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when a successfully read PNG has no supported workflow', () => {
    const asset = harness.indexAsset('source/plain.png', {
      contents: makePng([]),
    });

    expect(harness.service.getWorkflowMetadata(asset.id)).toBeNull();
  });

  it('probes PNG dimensions from bounded validated descriptor reads and closes the handle', async () => {
    const imageBytes = await sharp({
      create: { width: 832, height: 1248, channels: 3, background: 'black' },
    }).png().toBuffer();
    const image = harness.indexAsset('source/dimensions.png', {
      contents: Buffer.concat([imageBytes, Buffer.alloc(64 * 1024)]),
    });
    const closeSpy = vi.spyOn(fs, 'closeSync');
    const readSyncSpy = vi.spyOn(fs, 'readSync');
    sharpSpy.mockClear();

    await expect(harness.service.getImageDimensions(image.id)).resolves.toEqual({
      width: 832,
      height: 1248,
    });

    expect(sharpSpy).not.toHaveBeenCalled();
    expect(Math.max(...readSyncSpy.mock.calls.map(([, , , length]) => length)))
      .toBeLessThanOrEqual(33);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null for a PNG whose IHDR has an invalid declared payload length', async () => {
    const png = Buffer.alloc(24);
    PNG_SIGNATURE.copy(png);
    png.writeUInt32BE(12, 8);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(832, 16);
    png.writeUInt32BE(1248, 20);
    const image = harness.indexAsset('source/invalid-ihdr-length.png', { contents: png });

    await expect(harness.service.getImageDimensions(image.id)).resolves.toBeNull();
  });

  it('returns null for a PNG truncated after its 24-byte IHDR prefix', async () => {
    const ihdrPayload = Buffer.alloc(13);
    ihdrPayload.writeUInt32BE(832, 0);
    ihdrPayload.writeUInt32BE(1248, 4);
    const png = Buffer.concat([PNG_SIGNATURE, createPngChunk('IHDR', ihdrPayload)]);
    const image = harness.indexAsset('source/truncated-ihdr-prefix.png', {
      contents: png.subarray(0, 24),
    });

    await expect(harness.service.getImageDimensions(image.id)).resolves.toBeNull();
  });

  it('returns null for a PNG with a truncated IHDR CRC', async () => {
    const ihdrPayload = Buffer.alloc(13);
    ihdrPayload.writeUInt32BE(832, 0);
    ihdrPayload.writeUInt32BE(1248, 4);
    const png = Buffer.concat([PNG_SIGNATURE, createPngChunk('IHDR', ihdrPayload)]);
    const image = harness.indexAsset('source/truncated-ihdr-crc.png', {
      contents: png.subarray(0, 32),
    });

    await expect(harness.service.getImageDimensions(image.id)).resolves.toBeNull();
  });

  it('returns null for a PNG with an invalid IHDR CRC', async () => {
    const ihdrPayload = Buffer.alloc(13);
    ihdrPayload.writeUInt32BE(832, 0);
    ihdrPayload.writeUInt32BE(1248, 4);
    const png = Buffer.from(Buffer.concat([PNG_SIGNATURE, createPngChunk('IHDR', ihdrPayload)]));
    png[32] ^= 0xff;
    const image = harness.indexAsset('source/invalid-ihdr-crc.png', { contents: png });

    await expect(harness.service.getImageDimensions(image.id)).resolves.toBeNull();
  });

  it.each([
    ['VP8X', (() => {
      const payload = Buffer.alloc(10);
      payload.writeUIntLE(831, 4, 3);
      payload.writeUIntLE(1247, 7, 3);
      return payload;
    })(), 9],
    ['VP8 ', (() => {
      const payload = Buffer.alloc(10);
      payload.set([0x9d, 0x01, 0x2a], 3);
      payload.writeUInt16LE(832, 6);
      payload.writeUInt16LE(1248, 8);
      return payload;
    })(), 9],
    ['VP8L', (() => {
      const payload = Buffer.alloc(5);
      payload[0] = 0x2f;
      payload.writeUInt32LE(831 | (1247 << 14), 1);
      return payload;
    })(), 4],
  ])('returns null for a WebP with an undersized declared %s chunk', async (
    chunkType,
    payload,
    chunkLength
  ) => {
    const image = harness.indexAsset(`source/undersized-${chunkType.trim()}.webp`, {
      contents: makeWebp(chunkType, payload, { chunkLength }),
    });

    await expect(harness.service.getImageDimensions(image.id)).resolves.toBeNull();
  });

  it('returns null for a WebP whose declared RIFF length excludes its dimension chunk', async () => {
    const payload = Buffer.alloc(10);
    payload.writeUIntLE(831, 4, 3);
    payload.writeUIntLE(1247, 7, 3);
    const image = harness.indexAsset('source/short-riff.webp', {
      contents: makeWebp('VP8X', payload, { riffLength: 21 }),
    });

    await expect(harness.service.getImageDimensions(image.id)).resolves.toBeNull();
  });

  it('uses validated descriptor bytes if the pathname changes after the header read', async () => {
    const original = await sharp({
      create: { width: 832, height: 1248, channels: 3, background: 'black' },
    }).png().toBuffer();
    const replacement = await sharp({
      create: { width: 7, height: 5, channels: 3, background: 'white' },
    }).png().toBuffer();
    const image = harness.indexAsset('source/replaced-dimensions.png', {
      contents: original,
    });
    const imagePath = path.join(harness.projectPath, 'source/replaced-dimensions.png');
    sharpSpy.mockClear();
    const originalReadSync = fs.readSync;
    let replaced = false;
    vi.spyOn(fs, 'readSync').mockImplementation((handle, buffer, bufferOffset, length, position) => {
      const bytesRead = originalReadSync(handle, buffer, bufferOffset, length, position);
      if (!replaced) {
        replaced = true;
        fs.writeFileSync(imagePath, replacement);
      }
      return bytesRead;
    });

    await expect(harness.service.getImageDimensions(image.id)).resolves.toEqual({
      width: 832,
      height: 1248,
    });
    expect(sharpSpy).not.toHaveBeenCalled();
  });

  it('isolates unavailable dimensions from workflow inspection and closes the handle', async () => {
    const workflow = workflowFixture();
    const image = harness.indexAsset('source/corrupt-dimensions.png', {
      contents: makePng([textChunk('prompt', JSON.stringify(workflow))]),
    });
    const closeSpy = vi.spyOn(fs, 'closeSync');
    sharpSpy.mockClear();

    await expect(harness.service.getImageDimensions(image.id)).resolves.toBeNull();
    expect(sharpSpy).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(harness.service.getWorkflowMetadata(image.id)).toEqual({
      metadataKey: 'prompt',
      workflow,
    });
  });

  it('returns null for non-image assets without opening or probing them', async () => {
    const document = harness.indexAsset('source/document.txt', {
      contents: Buffer.from('not an image'),
      extension: 'txt',
      write: false,
    });
    sharpSpy.mockClear();

    await expect(harness.service.getImageDimensions(document.id)).resolves.toBeNull();
    expect(sharpSpy).not.toHaveBeenCalled();
  });

  it('returns null for a GIF without its complete logical-screen descriptor', async () => {
    const gif = Buffer.alloc(10);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(832, 6);
    gif.writeUInt16LE(1248, 8);
    const image = harness.indexAsset('source/truncated.gif', { contents: gif });

    await expect(harness.service.getImageDimensions(image.id)).resolves.toBeNull();
  });

  it('returns null for a BMP whose declared DIB header extends beyond EOF', async () => {
    const bmp = Buffer.alloc(26);
    bmp.write('BM', 0, 'ascii');
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(832, 18);
    bmp.writeInt32LE(1248, 22);
    const image = harness.indexAsset('source/truncated.bmp', { contents: bmp });

    await expect(harness.service.getImageDimensions(image.id)).resolves.toBeNull();
  });

  it('returns null for a JPEG whose declared SOF segment extends beyond EOF', async () => {
    const image = harness.indexAsset('source/truncated.jpg', {
      contents: Buffer.from([
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11,
        0x08, 0x04, 0xe0, 0x03, 0x40,
      ]),
    });

    await expect(harness.service.getImageDimensions(image.id)).resolves.toBeNull();
  });

  it('returns null for a JPEG SOF with no component count or descriptors', async () => {
    const image = harness.indexAsset('source/short-sof.jpg', {
      contents: Buffer.from([
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07,
        0x08, 0x04, 0xe0, 0x03, 0x40,
      ]),
    });

    await expect(harness.service.getImageDimensions(image.id)).resolves.toBeNull();
  });

  it('returns null for a JPEG SOF with an inconsistent component section length', async () => {
    const image = harness.indexAsset('source/inconsistent-sof.jpg', {
      contents: Buffer.from([
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b,
        0x08, 0x04, 0xe0, 0x03, 0x40, 0x03,
        0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
      ]),
    });

    await expect(harness.service.getImageDimensions(image.id)).resolves.toBeNull();
  });

  it('finds a JPEG SOF after 64 KiB through bounded validated descriptor reads', async () => {
    const baseJpeg = await sharp({
      create: { width: 832, height: 1248, channels: 3, background: 'black' },
    }).jpeg().toBuffer();
    const jpeg = addLargeApp1Segment(baseJpeg);
    await expect(sharp(jpeg).metadata()).resolves.toMatchObject({ width: 832, height: 1248 });
    const image = harness.indexAsset('source/large-app1.jpg', { contents: jpeg });
    const closeSpy = vi.spyOn(fs, 'closeSync');
    const readSyncSpy = vi.spyOn(fs, 'readSync');
    sharpSpy.mockClear();

    await expect(harness.service.getImageDimensions(image.id)).resolves.toEqual({
      width: 832,
      height: 1248,
    });

    expect(sharpSpy).not.toHaveBeenCalled();
    expect(Math.max(...readSyncSpy.mock.calls.map(([, , , length]) => length)))
      .toBeLessThanOrEqual(24);
    expect(readSyncSpy.mock.calls.some(([, , , , position]) => position > 64 * 1024)).toBe(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null for a non-PNG asset without opening or parsing it', () => {
    const asset = harness.indexAsset('source/document.jpg', {
      contents: Buffer.from('not a PNG'),
      write: false,
    });

    expect(harness.service.getWorkflowMetadata(asset.id)).toBeNull();
  });

  it('propagates a missing storage file failure instead of returning no workflow', () => {
    const asset = harness.indexAsset('source/missing.png', {
      contents: Buffer.from('not present'),
      write: false,
    });

    expect(() => harness.service.getWorkflowMetadata(asset.id)).toThrow(StorageError);
  });

  it('propagates malformed PNG failures and closes the opened handle', () => {
    const asset = harness.indexAsset('source/malformed.png', {
      contents: Buffer.from('not a PNG'),
    });
    const closeSpy = vi.spyOn(fs, 'closeSync');

    expect(() => harness.service.getWorkflowMetadata(asset.id)).toThrow(
      expect.objectContaining({
        code: 'INVALID_PNG_SIGNATURE',
      })
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(() => harness.service.getWorkflowMetadata(asset.id)).toThrow(
      WorkflowPromptMetadataError
    );
  });
});
