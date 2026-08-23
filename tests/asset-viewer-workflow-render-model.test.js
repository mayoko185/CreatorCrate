import { describe, expect, it } from 'vitest';
import {
  buildAssetViewerRenderModel,
  buildAssetViewerTagFailureRenderModel,
} from '../src/routes/assets.js';
import { StorageError } from '../src/storage/path-manager.js';
import { WorkflowPromptMetadataError } from '../src/services/workflow-prompt-editor.js';

function viewerData() {
  return {
    project: { id: 1, project_dir: 'project-1', archived_at: null, status: 'active' },
    asset: {
      id: 2,
      project_id: 1,
      relative_path: 'image.png',
      filename: 'image.png',
      category_id: null,
      is_present: 1,
    },
    context: {},
    filters: {},
    enabledCategories: [],
    canMutate: true,
  };
}

function request() {
  return {
    query: {},
    app: {
      locals: {
        openLocallySettingsService: { getWindowsProjectsPath: () => null },
        assetTagService: { listAssetTags: () => [] },
        tagService: { listTags: () => [] },
      },
    },
  };
}

const workflowQueryService = {
  getProjectAssetBrowserContext: () => ({ context: {} }),
};

function a1111FallbackFixture() {
  return {
    format: 'creatorcrate.comfyui-a1111-import-metadata/v1',
    source: 'parameters',
    native_workflow: false,
    positive_prompt: 'cinematic portrait',
    negative_prompt: 'lowres',
    settings_suffix: 'Steps: 30, Sampler: Euler a, CFG scale: 4.0, Seed: 42, Size: 832x1248',
    settings: {
      steps: 30,
      sampler: 'Euler a',
      cfg_scale: 4,
      seed: 42,
      width: 832,
      height: 1248,
    },
    loras: [],
  };
}

describe('asset viewer workflow render model', () => {
  it('presents detected workflow metadata as syntax-highlight tokens only', async () => {
    const model = await buildAssetViewerRenderModel(
      viewerData(),
      {},
      request(),
      workflowQueryService,
      {
        getWorkflowMetadata: () => ({
          metadataKey: 'workflow',
          workflow: { node: 'KSampler', enabled: true },
        }),
      },
    );

    expect(model.workflowInspection).toMatchObject({
      status: 'detected',
      metadataKey: 'workflow',
    });
    expect(model.workflowInspection.tokens).toContainEqual({ kind: 'key', text: '"node"' });
    expect(model.workflowInspection.tokens).toContainEqual({ kind: 'boolean', text: 'true' });
    expect(model.workflowInspection).not.toHaveProperty('workflow');
  });

  it('presents a validated A1111 fallback as detected non-native JSON', async () => {
    const fallback = a1111FallbackFixture();
    const model = await buildAssetViewerRenderModel(
      viewerData(),
      {},
      request(),
      workflowQueryService,
      {
        getWorkflowMetadata: () => ({
          metadataKey: 'parameters',
          workflow: fallback,
        }),
      },
    );

    expect(model.workflowInspection).toMatchObject({
      status: 'detected',
      metadataKey: 'parameters',
    });
    expect(model.workflowInspection.tokens.map((token) => token.text).join(''))
      .toBe(JSON.stringify(fallback, null, 2));
    expect(model.workflowInspection.tokens).toContainEqual({ kind: 'key', text: '"source"' });
    expect(model.workflowInspection.tokens).toContainEqual({ kind: 'string', text: '"parameters"' });
    expect(model.workflowInspection.tokens).toContainEqual({ kind: 'key', text: '"native_workflow"' });
    expect(model.workflowInspection.tokens).toContainEqual({ kind: 'boolean', text: 'false' });
  });

  it('adds known image dimensions to the File details render model', async () => {
    const model = await buildAssetViewerRenderModel(
      viewerData(),
      {},
      request(),
      workflowQueryService,
      {
        getWorkflowMetadata: () => null,
        getImageDimensions: () => ({ width: 832, height: 1248 }),
      },
    );

    expect(model.asset.imageDimensions).toEqual({ width: 832, height: 1248 });
  });

  it('does not supply misleading dimensions when they are unavailable', async () => {
    const model = await buildAssetViewerRenderModel(
      viewerData(),
      {},
      request(),
      workflowQueryService,
      {
        getWorkflowMetadata: () => null,
        getImageDimensions: () => null,
      },
    );

    expect(model.asset.imageDimensions).toBeNull();
  });

  it('keeps a successful no-workflow inspection distinct from a failed inspection', async () => {
    const none = await buildAssetViewerRenderModel(
      viewerData(), {}, request(), workflowQueryService,
      { getWorkflowMetadata: () => null },
    );
    const failures = await Promise.all([
      new StorageError('Asset file cannot be read.'),
      new WorkflowPromptMetadataError('PNG workflow metadata is malformed.'),
    ].map((error) => buildAssetViewerRenderModel(
      viewerData(), {}, request(), workflowQueryService,
      { getWorkflowMetadata: () => { throw error; } },
    )));

    expect(none.workflowInspection).toEqual({ status: 'none' });
    expect(failures.map((model) => model.workflowInspection)).toEqual([
      { status: 'inspection-failure' },
      { status: 'inspection-failure' },
    ]);
  });

  it('uses the same workflow inspection model for controlled tag re-renders', async () => {
    const model = await buildAssetViewerTagFailureRenderModel({
      req: request(),
      data: viewerData(),
      workflowQueryService,
      assetWorkflowMetadataService: {
        getWorkflowMetadata: () => ({ metadataKey: 'prompt', workflow: { seed: 42 } }),
      },
      projectPrimaryImageService: { getPrimaryImage: () => null },
      errors: { tagIds: 'Choose valid tags.' },
    });

    expect(model.workflowInspection).toMatchObject({
      status: 'detected',
      metadataKey: 'prompt',
    });
    expect(model.formError.message).toContain('Choose valid tags.');
  });
});
