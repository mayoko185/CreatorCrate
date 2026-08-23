import { describe, expect, it } from 'vitest';
import {
  presentWorkflowJson,
  WORKFLOW_JSON_TOKEN_KINDS,
} from '../src/services/workflow-json-presenter.js';

function rejoin(tokens) {
  return tokens.map((token) => token.text).join('');
}

describe('workflow JSON presenter', () => {
  it('classifies object keys separately from string values', () => {
    const tokens = presentWorkflowJson({ node: 'KSampler' });

    expect(tokens).toContainEqual({
      kind: WORKFLOW_JSON_TOKEN_KINDS.KEY,
      text: '"node"',
    });
    expect(tokens).toContainEqual({
      kind: WORKFLOW_JSON_TOKEN_KINDS.STRING,
      text: '"KSampler"',
    });
    expect(rejoin(tokens)).toBe(JSON.stringify({ node: 'KSampler' }, null, 2));
  });

  it('presents source backslashes literally without mutating string values', () => {
    const value = 'masterpiece,, <lora:C:\\models\\style.safetensors:0.8>, quote " slash \\ newline\nnext line';
    const workflow = { value };
    const tokens = presentWorkflowJson({ value });

    expect(tokens).toContainEqual({
      kind: WORKFLOW_JSON_TOKEN_KINDS.STRING,
      text: '"masterpiece,, <lora:C:\\models\\style.safetensors:0.8>, quote \\" slash \\ newline\\\\nnext line"',
    });
    expect(rejoin(tokens)).toContain('C:\\models\\style.safetensors');
    expect(rejoin(tokens)).not.toContain('C:\\\\models\\\\style.safetensors');
    expect(workflow).toEqual({ value });
  });

  it('distinguishes actual controls from literal escape-like sequences without mutating inputs', () => {
    const workflow = {
      literalNewline: 'foo\\nbar',
      actualNewline: 'foo\nbar',
      literalCarriageReturn: 'foo\\rbar',
      actualCarriageReturn: 'foo\rbar',
      literalTab: 'foo\\tbar',
      actualTab: 'foo\tbar',
      literalBackspace: 'foo\\bbar',
      actualBackspace: 'foo\bbar',
      literalFormFeed: 'foo\\fbar',
      actualFormFeed: 'foo\fbar',
    };
    const before = structuredClone(workflow);
    const stringTexts = presentWorkflowJson(workflow)
      .filter((token) => token.kind === WORKFLOW_JSON_TOKEN_KINDS.STRING)
      .map((token) => token.text);

    expect(stringTexts).toEqual([
      '"foo\\nbar"',
      '"foo\\\\nbar"',
      '"foo\\rbar"',
      '"foo\\\\rbar"',
      '"foo\\tbar"',
      '"foo\\\\tbar"',
      '"foo\\bbar"',
      '"foo\\\\bbar"',
      '"foo\\fbar"',
      '"foo\\\\fbar"',
    ]);
    expect(workflow).toEqual(before);
  });

  it('retains the exact source backslash count in string token display', () => {
    const singleBackslashes = 'C:\\models\\style.safetensors';
    const doubledBackslashes = 'C:\\\\models\\\\style.safetensors';
    const lora = '<lora:Mayoko\\max\\model.safetensors:0.8>';
    const workflow = { singleBackslashes, doubledBackslashes, lora };
    const tokens = presentWorkflowJson(workflow);
    const strings = tokens.filter((token) => token.kind === WORKFLOW_JSON_TOKEN_KINDS.STRING)
      .map((token) => token.text);

    expect(strings).toContain('"C:\\models\\style.safetensors"');
    expect(strings).toContain('"C:\\\\models\\\\style.safetensors"');
    expect(strings).toContain('"<lora:Mayoko\\max\\model.safetensors:0.8>"');
    expect(workflow).toEqual({ singleBackslashes, doubledBackslashes, lora });
  });

  it('classifies negative, decimal, and exponent numbers', () => {
    const workflow = {
      negative: -12,
      decimal: 3.14,
      exponent: 1e21,
    };
    const tokens = presentWorkflowJson(workflow);

    expect(tokens.filter((token) => token.kind === WORKFLOW_JSON_TOKEN_KINDS.NUMBER)
      .map((token) => token.text)).toEqual(['-12', '3.14', '1e+21']);
    expect(rejoin(tokens)).toBe(JSON.stringify(workflow, null, 2));
  });

  it('classifies booleans and null values', () => {
    const tokens = presentWorkflowJson({ enabled: true, disabled: false, missing: null });

    expect(tokens.filter((token) => token.kind === WORKFLOW_JSON_TOKEN_KINDS.BOOLEAN)
      .map((token) => token.text)).toEqual(['true', 'false']);
    expect(tokens).toContainEqual({
      kind: WORKFLOW_JSON_TOKEN_KINDS.NULL,
      text: 'null',
    });
  });

  it('preserves arrays, nested objects, and structural punctuation', () => {
    const workflow = {
      nodes: [{ id: 1, inputs: { seed: 42 } }, { id: 2, inputs: [] }],
    };
    const tokens = presentWorkflowJson(workflow);

    expect(tokens.some((token) => (
      token.kind === WORKFLOW_JSON_TOKEN_KINDS.PUNCTUATION && token.text.includes('[')
    ))).toBe(true);
    expect(rejoin(tokens)).toBe(JSON.stringify(workflow, null, 2));
  });

  it('returns hostile HTML-like values as literal text tokens without HTML output', () => {
    const hostile = '<script>alert("x")</script>';
    const tokens = presentWorkflowJson({ prompt: hostile });

    expect(tokens).toContainEqual({
      kind: WORKFLOW_JSON_TOKEN_KINDS.STRING,
      text: JSON.stringify(hostile),
    });
    expect(tokens.every((token) => (
      Object.keys(token).every((key) => key === 'kind' || key === 'text')
      && typeof token.kind === 'string'
      && typeof token.text === 'string'
    ))).toBe(true);
    expect(rejoin(tokens)).not.toContain('<span');
  });

  it('rejoins exactly to the pretty serialized workflow', () => {
    const workflow = {
      nodes: [{ id: 7, values: ['alpha', false, null, -0.5e2] }],
      metadata: { title: 'Nested workflow' },
    };

    expect(rejoin(presentWorkflowJson(workflow))).toBe(JSON.stringify(workflow, null, 2));
  });

  it('does not truncate a reasonably large workflow', () => {
    const workflow = {
      nodes: Array.from({ length: 320 }, (_, id) => ({
        id,
        class_type: 'KSampler',
        inputs: { prompt: `node-${id}`, seed: id },
      })),
    };
    const serialized = JSON.stringify(workflow, null, 2);
    const tokens = presentWorkflowJson(workflow);

    expect(rejoin(tokens)).toBe(serialized);
    expect(rejoin(tokens)).toContain('"node-319"');
    expect(rejoin(tokens).length).toBe(serialized.length);
  });

  it('uses only the fixed public token kinds', () => {
    const allowedKinds = new Set(Object.values(WORKFLOW_JSON_TOKEN_KINDS));

    expect(presentWorkflowJson({ value: [1, true, null, 'text'] })
      .every((token) => allowedKinds.has(token.kind))).toBe(true);
  });
});
