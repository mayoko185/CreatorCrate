import { describe, expect, it } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  applyPromptRules,
  createPngChunk,
  crc32,
  editWorkflowPromptsInPng,
  extractWorkflowMetadataFromPng,
  parsePngChunks,
  PNG_SIGNATURE,
  PNG_TEXT_CHUNK_MAX_INPUT_BYTES,
  PNG_TEXT_CHUNK_MAX_DECOMPRESSED_BYTES,
  PNG_TOTAL_TEXT_MAX_BYTES,
  WorkflowPromptMetadataError,
} from '../src/services/workflow-prompt-editor.js';

function makePng(chunks, {
  includeIhdr = true,
  ihdrData = Buffer.alloc(13),
  includeIend = true,
} = {}) {
  return Buffer.concat([
    PNG_SIGNATURE,
    ...(includeIhdr ? [createPngChunk('IHDR', ihdrData)] : []),
    ...chunks,
    ...(includeIend ? [createPngChunk('IEND')] : []),
  ]);
}

function textChunk(key, value) {
  return createPngChunk('tEXt', Buffer.concat([
    Buffer.from(key, 'latin1'),
    Buffer.from([0]),
    Buffer.from(value, 'latin1'),
  ]));
}

function ztextChunk(key, value) {
  return createPngChunk('zTXt', Buffer.concat([
    Buffer.from(key, 'latin1'),
    Buffer.from([0, 0]),
    deflateSync(Buffer.from(value, 'latin1')),
  ]));
}

function itextChunk(key, value, compressed = false) {
  return itextChunkWithFields(key, value, {
    compressionFlag: compressed ? 1 : 0,
    compressionMethod: 0,
  });
}

function itextChunkWithFields(key, value, { compressionFlag, compressionMethod }) {
  const text = Buffer.from(value, 'utf8');
  return createPngChunk('iTXt', Buffer.concat([
    Buffer.from(key, 'ascii'),
    Buffer.from([0, compressionFlag, compressionMethod, 0, 0]),
    compressionFlag === 1 ? deflateSync(text) : text,
  ]));
}

function textValues(buffer) {
  return parsePngChunks(buffer)
    .filter((chunk) => chunk.type === 'tEXt')
    .map((chunk) => {
      const separator = chunk.data.indexOf(0);
      return [
        chunk.data.toString('latin1', 0, separator),
        chunk.data.toString('latin1', separator + 1),
      ];
    });
}

function ztextValues(buffer) {
  return parsePngChunks(buffer)
    .filter((chunk) => chunk.type === 'zTXt')
    .map((chunk) => {
      const separator = chunk.data.indexOf(0);
      return [
        chunk.data.toString('latin1', 0, separator),
        inflateSync(chunk.data.subarray(separator + 2)).toString('latin1'),
      ];
    });
}

function graphMetadata() {
  return JSON.stringify({
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
      class_type: 'CLIPTextEncode',
      inputs: { text: 'unrelated text node' },
    },
  });
}

function graphWithPositivePrompt(value) {
  const graph = JSON.parse(graphMetadata());
  graph['2'].inputs.text = value;
  return JSON.stringify(graph);
}

function a1111ParametersFixture() {
  return [
    'cinematic portrait <lora:portrait-style:0.8>, <lora:studio-light:0.5>, <lora:detailer:1.0>',
    'Negative prompt: lowres, blurry',
    'Steps: 30, Sampler: Direct 1024px - Euler a / normal, CFG scale: 4.0, Seed: 944442803, Size: 832x1248, Model: models/checkpoints/realistic/portrait.safetensors, Version: v1.10.1',
  ].join('\n');
}

function a1111FallbackFixture() {
  return {
    format: 'creatorcrate.comfyui-a1111-import-metadata/v1',
    source: 'parameters',
    native_workflow: false,
    positive_prompt: 'cinematic portrait <lora:portrait-style:0.8>, <lora:studio-light:0.5>, <lora:detailer:1.0>',
    negative_prompt: 'lowres, blurry',
    settings_suffix: 'Steps: 30, Sampler: Direct 1024px - Euler a / normal, CFG scale: 4.0, Seed: 944442803, Size: 832x1248, Model: models/checkpoints/realistic/portrait.safetensors, Version: v1.10.1',
    settings: {
      steps: 30,
      sampler: 'Direct 1024px - Euler a / normal',
      cfg_scale: 4,
      seed: 944442803,
      width: 832,
      height: 1248,
      model: 'models/checkpoints/realistic/portrait.safetensors',
    },
    loras: [
      { name: 'portrait-style', weight: 0.8 },
      { name: 'studio-light', weight: 0.5 },
      { name: 'detailer', weight: 1 },
    ],
  };
}

describe('workflow metadata extraction', () => {
  it('extracts a ComfyUI execution graph from native prompt metadata', () => {
    const workflow = JSON.parse(graphMetadata());

    expect(extractWorkflowMetadataFromPng(makePng([
      textChunk('prompt', JSON.stringify(workflow)),
    ]))).toEqual({ metadataKey: 'prompt', workflow });
  });

  it('extracts a native ComfyUI UI workflow from compressed zTXt metadata', () => {
    const workflow = JSON.parse(graphMetadata());

    expect(extractWorkflowMetadataFromPng(makePng([
      ztextChunk('workflow', JSON.stringify(workflow)),
    ]))).toEqual({ metadataKey: 'workflow', workflow });
  });

  it('detects a UI workflow without prompt-editable text nodes', () => {
    const workflow = {
      nodes: [
        { id: 1, type: 'KSampler', inputs: [{ name: 'positive', link: 10 }] },
        { id: 2, type: 'EmptyLatentImage', widgets_values: [512, 512] },
      ],
      links: [[10, 2, 0, 1, 0]],
    };

    expect(extractWorkflowMetadataFromPng(makePng([
      textChunk('workflow', JSON.stringify(workflow)),
    ]))).toEqual({ metadataKey: 'workflow', workflow });
  });

  it('rejects a UI-shaped workflow whose nodes lack ComfyUI node structure', () => {
    expect(extractWorkflowMetadataFromPng(makePng([
      textChunk('workflow', JSON.stringify({ nodes: [{}] })),
    ]))).toBeNull();
  });

  it('falls through an invalid workflow source to validated A1111 parameters', () => {
    expect(extractWorkflowMetadataFromPng(makePng([
      textChunk('workflow', JSON.stringify({ nodes: [{}] })),
      itextChunk('parameters', a1111ParametersFixture()),
    ]))).toEqual({
      metadataKey: 'parameters',
      workflow: a1111FallbackFixture(),
    });
  });

  it('extracts validated A1111 parameters from uncompressed iTXt metadata', () => {
    expect(extractWorkflowMetadataFromPng(makePng([
      itextChunk('parameters', a1111ParametersFixture()),
    ]))).toEqual({
      metadataKey: 'parameters',
      workflow: a1111FallbackFixture(),
    });
  });

  it('extracts a ComfyUI wrapper graph for viewer display', () => {
    const workflow = JSON.parse(graphMetadata());

    expect(extractWorkflowMetadataFromPng(makePng([
      textChunk('comfyui', JSON.stringify({ prompt: workflow })),
    ]))).toEqual({ metadataKey: 'comfyui', workflow });
  });

  it('skips an invalid ComfyUI wrapper before a later valid source', () => {
    expect(extractWorkflowMetadataFromPng(makePng([
      textChunk('comfyui', JSON.stringify({ prompt: {} })),
      itextChunk('parameters', a1111ParametersFixture()),
    ]))).toEqual({
      metadataKey: 'parameters',
      workflow: a1111FallbackFixture(),
    });
  });

  it('extracts Windows drive-letter LoRA paths from A1111 parameters', () => {
    const parameters = a1111ParametersFixture()
      .replace('<lora:portrait-style:0.8>', '<lora:C:\\models\\style.safetensors:0.8>');

    expect(extractWorkflowMetadataFromPng(makePng([
      itextChunk('parameters', parameters),
    ]))).toMatchObject({
      metadataKey: 'parameters',
      workflow: {
        loras: [
          { name: 'C:\\models\\style.safetensors', weight: 0.8 },
          { name: 'studio-light', weight: 0.5 },
          { name: 'detailer', weight: 1 },
        ],
      },
    });
  });

  it('preserves literal A1111 prompt and settings text while deriving LoRAs', () => {
    const positivePrompt = '  masterpiece,, <lora:C:\\models\\style.safetensors:0.8>,, subject  ';
    const negativePrompt = ' lowres,, <lora:negative\\style.safetensors:0.25>,, ';
    const settingsSuffix = 'Steps: 30, Sampler: Euler a, CFG scale: 4.0, Seed: 42, Size: 832x1248, Model: C:\\models\\base.safetensors, Version: v1.10.1  ';
    const parameters = `${positivePrompt}\r\nNegative prompt: ${negativePrompt}\r\n${settingsSuffix}`;

    const workflow = extractWorkflowMetadataFromPng(makePng([
      itextChunk('parameters', parameters),
    ])).workflow;

    expect(workflow).toMatchObject({
      positive_prompt: positivePrompt,
      negative_prompt: negativePrompt,
      settings_suffix: settingsSuffix,
      settings: { model: 'C:\\models\\base.safetensors' },
      loras: [
        { name: 'C:\\models\\style.safetensors', weight: 0.8 },
        { name: 'negative\\style.safetensors', weight: 0.25 },
      ],
    });
  });

  it.each([
    '<lora:portrait-style>',
    '<lora:portrait-style:strong>',
  ])('ignores malformed A1111 LoRA tags: %s', (malformedTag) => {
    const parameters = a1111ParametersFixture()
      .replace('<lora:portrait-style:0.8>', malformedTag);

    expect(extractWorkflowMetadataFromPng(makePng([
      itextChunk('parameters', parameters),
    ]))).toMatchObject({
      metadataKey: 'parameters',
      workflow: {
        loras: [
          { name: 'studio-light', weight: 0.5 },
          { name: 'detailer', weight: 1 },
        ],
      },
    });
  });

  it.each([
    ['workflow first', ['workflow', 'prompt', 'parameters']],
    ['workflow last', ['parameters', 'prompt', 'workflow']],
  ])('prioritizes native workflow over prompt and parameters when %s', (_description, order) => {
    const workflow = {
      nodes: [{ id: 1, type: 'EmptyLatentImage', widgets_values: [512, 512] }],
    };
    const chunks = order.map((source) => ({
      workflow: textChunk('workflow', JSON.stringify(workflow)),
      prompt: textChunk('prompt', graphMetadata()),
      parameters: itextChunk('parameters', a1111ParametersFixture()),
    }[source]));

    expect(extractWorkflowMetadataFromPng(makePng(chunks))).toEqual({
      metadataKey: 'workflow',
      workflow,
    });
  });

  it.each([
    ['prompt first', ['prompt', 'parameters']],
    ['prompt last', ['parameters', 'prompt']],
  ])('prioritizes native prompt over parameters when %s', (_description, order) => {
    const workflow = JSON.parse(graphMetadata());
    const chunks = order.map((source) => ({
      prompt: textChunk('prompt', JSON.stringify(workflow)),
      parameters: itextChunk('parameters', a1111ParametersFixture()),
    }[source]));

    expect(extractWorkflowMetadataFromPng(makePng(chunks))).toEqual({
      metadataKey: 'prompt',
      workflow,
    });
  });

  it.each([
    ['arbitrary text', 'an unrelated note'],
    ['incomplete settings', 'Positive prompt: a cat\nNegative prompt: blurry\nSteps: 30'],
    ['malformed size', 'Positive prompt: a cat\nNegative prompt: blurry\nSteps: 30, Sampler: Euler, CFG scale: 4, Seed: 42, Size: wide'],
  ])('rejects %s parameters metadata', (_description, value) => {
    expect(extractWorkflowMetadataFromPng(makePng([
      itextChunk('parameters', value),
    ]))).toBeNull();
  });

  it.each([
    ['no textual metadata', []],
    ['non-JSON prompt metadata', [textChunk('prompt', 'not JSON')]],
  ])('returns null for %s', (_description, chunks) => {
    expect(extractWorkflowMetadataFromPng(makePng(chunks))).toBeNull();
  });

  it('preserves malformed-PNG error behavior', () => {
    expect(() => extractWorkflowMetadataFromPng(Buffer.from('not png'))).toThrow(
      expect.objectContaining({ code: 'INVALID_PNG_SIGNATURE' }),
    );
  });
});

describe('workflow prompt PNG editor', () => {
  it('validates the PNG signature and safely parses ordered chunks', () => {
    const ancillary = createPngChunk('pHYs', Buffer.from([1, 2, 3, 4]));
    const png = makePng([ancillary]);
    const chunks = parsePngChunks(png);

    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'pHYs', 'IEND']);
    expect(chunks[1].raw).toEqual(ancillary);
    expect(() => parsePngChunks(Buffer.from('not png'))).toThrow(
      expect.objectContaining({ code: 'INVALID_PNG_SIGNATURE' }),
    );
  });


  it('keeps Edit Workflow Prompts selecting a usable prompt graph over display-only workflow metadata', () => {
    const displayOnlyWorkflow = {
      nodes: [{ id: 1, type: 'EmptyLatentImage', widgets_values: [512, 512] }],
    };
    const edited = editWorkflowPromptsInPng(makePng([
      textChunk('workflow', JSON.stringify(displayOnlyWorkflow)),
      textChunk('prompt', graphWithPositivePrompt('editable prompt')),
    ]), {
      positive: { rules: [{ type: 'append', text: ' edited' }] },
    });
    const values = textValues(edited.buffer);

    expect(JSON.parse(values[0][1])).toEqual(displayOnlyWorkflow);
    expect(JSON.parse(values[1][1])['2'].inputs.text).toBe('editable prompt edited');
    expect(edited.metadataKey).toBe('prompt');
  });

  it.each([
    ['no IHDR', makePng([], { includeIhdr: false, includeIend: false })],
    ['first chunk is not IHDR', makePng([createPngChunk('pHYs', Buffer.from([1]))], { includeIhdr: false })],
    ['duplicate IHDR', makePng([createPngChunk('IHDR', Buffer.alloc(13))])],
    ['wrong-length IHDR', makePng([], { ihdrData: Buffer.alloc(12) })],
    ['missing IEND', makePng([], { includeIend: false })],
  ])('rejects structurally malformed PNG: %s', (_description, png) => {
    expect(() => parsePngChunks(png)).toThrow(expect.objectContaining({
      name: 'WorkflowPromptMetadataError',
    }));
  });

  it('rejects truncated chunks and bad CRCs', () => {
    const png = makePng([textChunk('prompt', 'hello')]);
    expect(() => parsePngChunks(png.subarray(0, png.length - 2))).toThrow(
      expect.objectContaining({ code: 'MALFORMED_PNG' }),
    );

    const corrupted = Buffer.from(png);
    const target = parsePngChunks(corrupted).find((chunk) => chunk.type === 'tEXt');
    corrupted[target.offset + target.raw.length - 1] ^= 0xff;
    expect(() => parsePngChunks(corrupted)).toThrow(
      expect.objectContaining({ code: 'INVALID_PNG_CRC' }),
    );
  });

  it('preserves unrelated chunks and recalculates only the rewritten CRC', () => {
    const before = createPngChunk('pHYs', Buffer.from([9, 8, 7, 6]));
    const png = makePng([before, textChunk('parameters', 'old prompt')]);
    const edited = editWorkflowPromptsInPng(png, {
      positive: { rules: [{ type: 'replace', search: 'old', replacement: 'new' }] },
    });
    const chunks = parsePngChunks(edited.buffer);
    const rewritten = chunks.find((chunk) => chunk.type === 'tEXt');

    expect(chunks.find((chunk) => chunk.type === 'pHYs').raw).toEqual(before);
    expect(rewritten.data.toString('latin1')).toContain('new prompt');
    expect(rewritten.raw.readUInt32BE(rewritten.raw.length - 4)).toBe(
      crc32(rewritten.raw.subarray(4, rewritten.raw.length - 4)),
    );
    expect(edited.metadataKey).toBe('parameters');
  });

  it('edits compressed zTXt metadata without changing its chunk type', () => {
    const edited = editWorkflowPromptsInPng(makePng([ztextChunk('parameters', 'sunset')]), {
      positive: { rules: [{ type: 'prepend', text: 'cinematic ' }] },
    });
    const chunk = parsePngChunks(edited.buffer).find((candidate) => candidate.type === 'zTXt');

    expect(chunk).toBeTruthy();
    expect(edited.buffer.includes(Buffer.from('sunset'))).toBe(false);
    expect(edited.changed).toBe(true);
  });

  it('edits a realistic compressed workflow without rejecting its metadata size', () => {
    const edited = editWorkflowPromptsInPng(makePng([ztextChunk('prompt', graphMetadata())]), {
      positive: { rules: [{ type: 'append', text: ', detailed' }] },
    });

    const graph = JSON.parse(ztextValues(edited.buffer).find(([key]) => key === 'prompt')[1]);
    expect(graph['2'].inputs.text).toBe('portrait subject, detailed');
    expect(edited.changed).toBe(true);
  });

  it.each([false, true])('edits %scompressed iTXt metadata', (compressed) => {
    const edited = editWorkflowPromptsInPng(
      makePng([itextChunk('parameters', 'hello', compressed)]),
      { positive: { rules: [{ type: 'append', text: ' world' }] } },
    );

    expect(edited.changed).toBe(true);
    expect(parsePngChunks(edited.buffer).some((chunk) => chunk.type === 'iTXt')).toBe(true);
  });

  it.each([
    ['uncompressed method', 0, 1],
    ['compressed method', 1, 1],
    ['unsupported flag', 2, 0],
  ])('rejects malformed iTXt compression fields: %s', (_description, compressionFlag, compressionMethod) => {
    const png = makePng([itextChunkWithFields('parameters', 'hello', {
      compressionFlag,
      compressionMethod,
    })]);

    expect(() => editWorkflowPromptsInPng(png, {
      positive: { rules: [{ type: 'append', text: '!' }] },
    })).toThrow(expect.objectContaining({ name: 'WorkflowPromptMetadataError' }));
  });

  it.each([
    ['zTXt', () => ztextChunk('parameters', Buffer.alloc(
      PNG_TEXT_CHUNK_MAX_DECOMPRESSED_BYTES + 1,
      0x61,
    ).toString('latin1'))],
    ['compressed iTXt', () => itextChunk('parameters', Buffer.alloc(
      PNG_TEXT_CHUNK_MAX_DECOMPRESSED_BYTES + 1,
      0x61,
    ).toString('utf8'), true)],
  ])('rejects oversized decompressed %s metadata without rewriting the source', (_description, makeChunk) => {
    const png = makePng([makeChunk()]);
    const original = Buffer.from(png);

    expect(() => editWorkflowPromptsInPng(png, {
      positive: { rules: [{ type: 'append', text: '!' }] },
    })).toThrow(expect.objectContaining({ code: 'OVERSIZED_PNG_METADATA' }));
    expect(png).toEqual(original);
  });

  it('rejects an oversized textual chunk before processing it', () => {
    const value = Buffer.alloc(PNG_TEXT_CHUNK_MAX_INPUT_BYTES, 0x61).toString('latin1');
    const png = makePng([textChunk('parameters', value + 'a')]);

    expect(() => editWorkflowPromptsInPng(png, {
      positive: { rules: [{ type: 'append', text: '!' }] },
    })).toThrow(expect.objectContaining({ code: 'OVERSIZED_PNG_METADATA' }));
  });

  it('rejects textual metadata whose aggregate decoded size is too large', () => {
    const value = 'a'.repeat(Math.floor(PNG_TOTAL_TEXT_MAX_BYTES / 3) + 1);
    const png = makePng([
      textChunk('one', value),
      textChunk('two', value),
      textChunk('three', value),
    ]);

    expect(() => editWorkflowPromptsInPng(png, {
      positive: { rules: [{ type: 'append', text: '!' }] },
    })).toThrow(expect.objectContaining({ code: 'OVERSIZED_PNG_METADATA' }));
  });

  it('traverses ComfyUI sampler links for positive and negative prompts only', () => {
    const edited = editWorkflowPromptsInPng(makePng([textChunk('prompt', graphMetadata())]), {
      positive: { rules: [{ type: 'append', text: ', detailed' }] },
      negative: { rules: [{ type: 'replace', search: 'blurry', replacement: 'low quality' }] },
    });
    const values = textValues(edited.buffer);
    const graph = JSON.parse(values.find(([key]) => key === 'prompt')[1]);

    expect(graph['2'].inputs.text).toBe('portrait subject, detailed');
    expect(graph['3'].inputs.text).toBe('low quality');
    expect(graph['4'].inputs.text).toBe('unrelated text node');
    expect(edited.positiveChanged).toBe(true);
    expect(edited.negativeChanged).toBe(true);
  });

  it('applies mixed rules in fixed Python phases and preserves phase order', () => {
    expect(applyPromptRules('AC', [
      { type: 'replace', search: 'A', replacement: 'C' },
      { type: 'remove', text: 'C' },
      { type: 'append', text: 'S' },
      { type: 'remove', text: 'missing' },
      { type: 'prepend', text: 'P' },
      { type: 'replace', search: 'C', replacement: 'D' },
    ])).toBe('PDS');

    expect(applyPromptRules('x x x', [
      { type: 'remove', text: 'x' },
    ])).toBe('  ');
    expect(applyPromptRules('ABC', [
      { type: 'replace', search: 'A', replacement: 'B' },
      { type: 'replace', search: 'B', replacement: 'C' },
    ])).toBe('CCC');
  });

  it('matches Python empty-search replacement insertion points', () => {
    expect(applyPromptRules('ab', [
      { type: 'replace', search: '', replacement: 'X' },
    ])).toBe('XaXbX');
    expect(applyPromptRules('', [
      { type: 'replace', search: '', replacement: 'X' },
    ])).toBe('X');
    expect(applyPromptRules('ab', [
      { type: 'replace', search: '', replacement: '' },
    ])).toBe('ab');

    const edited = editWorkflowPromptsInPng(makePng([textChunk('parameters', 'ab')]), {
      positive: { rules: [{ type: 'replace', search: '', replacement: 'X' }] },
    });
    expect(textValues(edited.buffer)[0][1]).toBe('XaXbX');
  });

  it('guards exact prepend and append boundaries on repeated application', () => {
    const prepend = [{ type: 'prepend', text: 'prefix ' }];
    const append = [{ type: 'append', text: ' suffix' }];
    const prepended = applyPromptRules('prompt', prepend);
    const appended = applyPromptRules('prompt', append);

    expect(applyPromptRules(prepended, prepend)).toBe(prepended);
    expect(applyPromptRules(appended, append)).toBe(appended);
    expect(applyPromptRules('prefix prompt', [{ type: 'prepend', text: 'fix' }]))
      .toBe('fixprefix prompt');
  });

  it('rejects unknown rule types before processing', () => {
    expect(() => applyPromptRules('prompt', [{ type: 'unknown', text: 'x' }]))
      .toThrow(expect.objectContaining({
        name: 'WorkflowPromptMetadataError',
        code: 'INVALID_PROMPT_RULE',
      }));
  });

  it('does not duplicate guarded additions for shared ComfyUI prompt nodes', () => {
    const graph = JSON.stringify({
      '1': { class_type: 'KSampler', inputs: { positive: ['2', 0], negative: ['3', 0] } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'prompt' } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 'bad' } },
      '4': { class_type: 'KSampler', inputs: { positive: ['2', 0], negative: ['3', 0] } },
    });
    const edited = editWorkflowPromptsInPng(makePng([textChunk('prompt', graph)]), {
      positive: { rules: [{ type: 'prepend', text: 'positive ' }] },
      negative: { rules: [{ type: 'append', text: ' negative' }] },
    });
    const result = JSON.parse(textValues(edited.buffer)[0][1]);

    expect(result['2'].inputs.text).toBe('positive prompt');
    expect(result['3'].inputs.text).toBe('bad negative');
  });

  it('supports the comfyui metadata wrapper key', () => {
    const comfyui = JSON.stringify({ prompt: JSON.parse(graphMetadata()) });
    const edited = editWorkflowPromptsInPng(makePng([textChunk('comfyui', comfyui)]), {
      positive: { rules: [{ type: 'prepend', text: 'wrapped ' }] },
    });
    const wrapper = JSON.parse(textValues(edited.buffer).find(([key]) => key === 'comfyui')[1]);

    expect(wrapper.prompt['2'].inputs.text).toBe('wrapped portrait subject');
    expect(edited.metadataKey).toBe('comfyui');
  });

  it('selects an earlier workflow chunk before a later prompt chunk', () => {
    const edited = editWorkflowPromptsInPng(makePng([
      textChunk('workflow', graphWithPositivePrompt('workflow first')),
      textChunk('prompt', graphWithPositivePrompt('prompt later')),
    ]), {
      positive: { rules: [{ type: 'append', text: ' edited' }] },
    });
    const values = textValues(edited.buffer);

    expect(JSON.parse(values[0][1])['2'].inputs.text).toBe('workflow first edited');
    expect(JSON.parse(values[1][1])['2'].inputs.text).toBe('prompt later');
    expect(edited.metadataKey).toBe('workflow');
  });

  it('selects an earlier comfyui chunk before a later workflow chunk', () => {
    const comfyui = JSON.stringify({ prompt: JSON.parse(graphWithPositivePrompt('comfyui first')) });
    const edited = editWorkflowPromptsInPng(makePng([
      textChunk('comfyui', comfyui),
      textChunk('workflow', graphWithPositivePrompt('workflow later')),
    ]), {
      positive: { rules: [{ type: 'prepend', text: 'edited ' }] },
    });
    const values = textValues(edited.buffer);

    expect(JSON.parse(values[0][1]).prompt['2'].inputs.text).toBe('edited comfyui first');
    expect(JSON.parse(values[1][1])['2'].inputs.text).toBe('workflow later');
    expect(edited.metadataKey).toBe('comfyui');
  });

  it('selects an earlier prompt chunk before a later workflow chunk', () => {
    const edited = editWorkflowPromptsInPng(makePng([
      textChunk('prompt', graphWithPositivePrompt('prompt first')),
      textChunk('workflow', graphWithPositivePrompt('workflow later')),
    ]), {
      positive: { rules: [{ type: 'append', text: ' edited' }] },
    });
    const values = textValues(edited.buffer);

    expect(JSON.parse(values[0][1])['2'].inputs.text).toBe('prompt first edited');
    expect(JSON.parse(values[1][1])['2'].inputs.text).toBe('workflow later');
    expect(edited.metadataKey).toBe('prompt');
  });

  it('skips invalid recognized JSON in favor of a later valid workflow', () => {
    const edited = editWorkflowPromptsInPng(makePng([
      textChunk('prompt', '{broken'),
      textChunk('workflow', graphWithPositivePrompt('valid workflow')),
    ]), {
      positive: { rules: [{ type: 'append', text: ' edited' }] },
    });
    const values = textValues(edited.buffer);

    expect(values[0][1]).toBe('{broken');
    expect(JSON.parse(values[1][1])['2'].inputs.text).toBe('valid workflow edited');
    expect(edited.metadataKey).toBe('workflow');
  });

  it.each([
    ['an empty object', '{}'],
    ['an unrelated object', '{"foo":"bar"}'],
    ['empty workflow nodes', '{"nodes":[]}'],
  ])('falls back to A1111/Krita parameters after recognized non-workflow JSON: %s', (_description, prompt) => {
    const parameters = 'Positive prompt: a cat\nNegative prompt: blurry\nSteps: 20, Sampler: Euler';
    const edited = editWorkflowPromptsInPng(makePng([
      textChunk('prompt', prompt),
      textChunk('parameters', parameters),
    ]), {
      positive: { rules: [{ type: 'append', text: ', studio light' }] },
    });
    const values = textValues(edited.buffer);

    expect(values[0][1]).toBe(prompt);
    expect(values[1][1]).toBe(
      'Positive prompt: a cat, studio light\nNegative prompt: blurry\nSteps: 20, Sampler: Euler',
    );
    expect(edited.metadataKey).toBe('parameters');
  });

  it('skips empty workflow nodes before a later usable workflow', () => {
    const edited = editWorkflowPromptsInPng(makePng([
      textChunk('workflow', '{"nodes":[]}'),
      textChunk('workflow', graphWithPositivePrompt('later workflow')),
    ]), {
      positive: { rules: [{ type: 'append', text: ' edited' }] },
    });
    const values = textValues(edited.buffer);

    expect(values[0][1]).toBe('{"nodes":[]}');
    expect(JSON.parse(values[1][1])['2'].inputs.text).toBe('later workflow edited');
    expect(edited.metadataKey).toBe('workflow');
  });

  it('skips graph-shaped JSON without a linked sampler prompt graph', () => {
    const unusable = JSON.stringify({
      nodes: [{ id: 1, type: 'KSampler', inputs: [{ name: 'positive', link: 10 }] }],
      links: [],
    });
    const parameters = 'Positive prompt: a cat\nNegative prompt: blurry\nSteps: 20';
    const edited = editWorkflowPromptsInPng(makePng([
      textChunk('workflow', unusable),
      textChunk('parameters', parameters),
    ]), {
      positive: { rules: [{ type: 'append', text: ', studio light' }] },
    });
    const values = textValues(edited.buffer);

    expect(values[0][1]).toBe(unusable);
    expect(values[1][1]).toBe('Positive prompt: a cat, studio light\nNegative prompt: blurry\nSteps: 20');
    expect(edited.metadataKey).toBe('parameters');
  });

  it('continues past recognized non-workflow JSON to a later workflow', () => {
    const edited = editWorkflowPromptsInPng(makePng([
      textChunk('prompt', '{}'),
      textChunk('workflow', graphWithPositivePrompt('valid workflow')),
    ]), {
      positive: { rules: [{ type: 'append', text: ' edited' }] },
    });
    const values = textValues(edited.buffer);

    expect(values[0][1]).toBe('{}');
    expect(JSON.parse(values[1][1])['2'].inputs.text).toBe('valid workflow edited');
    expect(edited.metadataKey).toBe('workflow');
  });

  it('selects workflow-shaped JSON under an unrelated keyword by chunk order', () => {
    const edited = editWorkflowPromptsInPng(makePng([
      textChunk('custom', graphWithPositivePrompt('custom first')),
      textChunk('workflow', graphWithPositivePrompt('workflow later')),
    ]), {
      positive: { rules: [{ type: 'append', text: ' edited' }] },
    });
    const values = textValues(edited.buffer);

    expect(JSON.parse(values[0][1])['2'].inputs.text).toBe('custom first edited');
    expect(JSON.parse(values[1][1])['2'].inputs.text).toBe('workflow later');
    expect(edited.metadataKey).toBe('custom');
  });

  it('continues past non-JSON parameters to find a later workflow', () => {
    const edited = editWorkflowPromptsInPng(makePng([
      textChunk('parameters', 'not workflow JSON'),
      textChunk('workflow', graphWithPositivePrompt('valid workflow')),
    ]), {
      positive: { rules: [{ type: 'append', text: ' edited' }] },
    });
    const values = textValues(edited.buffer);

    expect(values[0][1]).toBe('not workflow JSON');
    expect(JSON.parse(values[1][1])['2'].inputs.text).toBe('valid workflow edited');
    expect(edited.metadataKey).toBe('workflow');
  });

  it('uses workflow node links when only UI workflow metadata is available', () => {
    const workflow = {
      nodes: [
        { id: 1, type: 'KSampler', inputs: [{ name: 'positive', link: 10 }, { name: 'negative', link: 11 }] },
        { id: 2, type: 'CLIPTextEncode', widgets_values: ['positive ui'] },
        { id: 3, type: 'CLIPTextEncode', widgets_values: ['negative ui'] },
      ],
      links: [[10, 2, 0, 1, 0], [11, 3, 0, 1, 1]],
    };
    const edited = editWorkflowPromptsInPng(makePng([textChunk('workflow', JSON.stringify(workflow))]), {
      positive: { rules: [{ type: 'prepend', text: 'ui ' }] },
      negative: { rules: [{ type: 'append', text: ' safe' }] },
    });
    const graph = JSON.parse(textValues(edited.buffer).find(([key]) => key === 'workflow')[1]);

    expect(graph.nodes[1].widgets_values[0]).toBe('ui positive ui');
    expect(graph.nodes[2].widgets_values[0]).toBe('negative ui safe');
  });

  it('edits A1111/Krita parameters while retaining parameter fields', () => {
    const value = 'Positive prompt: a cat\nNegative prompt: blurry, old\nSteps: 20, Sampler: Euler';
    const edited = editWorkflowPromptsInPng(makePng([textChunk('parameters', value)]), {
      positive: { rules: [{ type: 'append', text: ', studio light' }] },
      negative: { rules: [{ type: 'remove', text: 'old' }] },
    });
    const parameter = textValues(edited.buffer).find(([key]) => key === 'parameters')[1];

    expect(parameter).toBe('Positive prompt: a cat, studio light\nNegative prompt: blurry, \nSteps: 20, Sampler: Euler');
  });

  it('applies phased rules independently to A1111/Krita positive and negative text', () => {
    const value = 'Positive prompt: A C\nNegative prompt: C\nSteps: 20';
    const edited = editWorkflowPromptsInPng(makePng([textChunk('parameters', value)]), {
      positive: {
        rules: [
          { type: 'replace', search: 'A', replacement: 'C' },
          { type: 'remove', text: 'C' },
          { type: 'prepend', text: 'P' },
          { type: 'append', text: 'S' },
        ],
      },
      negative: {
        rules: [
          { type: 'append', text: 'M' },
          { type: 'remove', text: 'D' },
          { type: 'prepend', text: 'N' },
          { type: 'replace', search: 'C', replacement: 'D' },
        ],
      },
    });

    expect(textValues(edited.buffer)[0][1])
      .toBe('Positive prompt: PC S\nNegative prompt: NDM\nSteps: 20');
  });

  it('keeps A1111 parameter fields out of a positive-only fallback prompt', () => {
    const edited = editWorkflowPromptsInPng(makePng([textChunk('parameters', 'a cat\nSteps: 20')]), {
      positive: { rules: [{ type: 'append', text: ', warm light' }] },
    });
    const parameter = textValues(edited.buffer)[0][1];

    expect(parameter).toBe('a cat, warm light\nSteps: 20');
  });

  it('applies ordered mixed rules, repeated removals, and replacements', () => {
    const edited = editWorkflowPromptsInPng(makePng([textChunk('parameters', 'base old old')]), {
      positive: {
        rules: [
          { type: 'prepend', text: 'start ' },
          { type: 'append', text: ' end' },
          { type: 'remove', text: 'old' },
          { type: 'remove', text: 'old' },
          { type: 'replace', search: 'base', replacement: 'new' },
          { type: 'replace', search: 'new', replacement: 'final' },
          { type: 'replace', search: 'missing', replacement: 'ignored' },
        ],
      },
    });
    const parameter = textValues(edited.buffer)[0][1];

    expect(parameter).toBe('start final   end');
  });

  it('treats empty rules and missing targets as no-ops', () => {
    const png = makePng([textChunk('parameters', 'unchanged')]);
    const edited = editWorkflowPromptsInPng(png, {
      positive: {
        rules: [
          { type: 'prepend', text: '' },
          { type: 'append', text: '' },
          { type: 'remove', text: '' },
          { type: 'remove', text: 'missing' },
          { type: 'replace', search: 'missing', replacement: '' },
        ],
      },
    });

    expect(edited.changed).toBe(false);
    expect(edited.buffer).toBe(png);
    expect(edited.metadataKey).toBe('parameters');
  });

  it('uses the first non-empty parameters chunk when no workflow JSON exists', () => {
    const edited = editWorkflowPromptsInPng(makePng([
      textChunk('parameters', ''),
      textChunk('parameters', 'first prompt'),
      textChunk('parameters', 'second prompt'),
    ]), {
      positive: { rules: [{ type: 'append', text: 'x' }] },
    });
    const values = textValues(edited.buffer);

    expect(values).toEqual([
      ['parameters', ''],
      ['parameters', 'first promptx'],
      ['parameters', 'second prompt'],
    ]);
    expect(edited.metadataKey).toBe('parameters');
  });

  it('rejects invalid rule objects', () => {
    expect(() => editWorkflowPromptsInPng(makePng([textChunk('parameters', 'prompt')]), {
      positive: { rules: [{ type: 'replace', search: 'x' }] },
    })).toThrow(expect.objectContaining({
      name: 'WorkflowPromptMetadataError',
      code: 'INVALID_PROMPT_RULE',
    }));
    expect(WorkflowPromptMetadataError).toBeTypeOf('function');
  });
});
