import { ProjectNotFoundError } from './project-service.js';
import { TagNotFoundError } from './tag-service.js';

export { ProjectNotFoundError, TagNotFoundError };

export class ProjectTagValidationError extends Error {
  constructor(errors) {
    super('Project tag validation failed');
    this.name = 'ProjectTagValidationError';
    this.errors = errors;
  }
}

function assertPositiveIntegerId(value, fieldLabel) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProjectTagValidationError({
      [fieldLabel]: `${fieldLabel} must be a positive integer.`,
    });
  }
}

function assertTagIdArray(tagIds) {
  if (!Array.isArray(tagIds)) {
    throw new ProjectTagValidationError({ tagIds: 'tagIds must be an array.' });
  }

  for (const tagId of tagIds) {
    assertPositiveIntegerId(tagId, 'tagId');
  }
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../data/tag-repository.js').createTagRepository>} deps.tagRepository
 * @param {ReturnType<import('../data/project-repository.js').createProjectRepository>} deps.projectRepository
 */
export function createProjectTagService({ tagRepository, projectRepository } = {}) {
  if (!tagRepository) {
    throw new Error('createProjectTagService requires a tagRepository dependency.');
  }
  if (!projectRepository) {
    throw new Error('createProjectTagService requires a projectRepository dependency.');
  }

  function requireProject(projectId) {
    const project = projectRepository.findById(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    return project;
  }

  function requireTag(tagId) {
    const tag = tagRepository.findById(tagId);
    if (!tag) {
      throw new TagNotFoundError(tagId);
    }
    return tag;
  }

  return {
    listProjectTags(projectId) {
      assertPositiveIntegerId(projectId, 'projectId');
      requireProject(projectId);
      return tagRepository.listForProject(projectId);
    },

    assignTagToProject(projectId, tagId) {
      assertPositiveIntegerId(projectId, 'projectId');
      assertPositiveIntegerId(tagId, 'tagId');
      requireProject(projectId);
      requireTag(tagId);
      return tagRepository.assignToProject(projectId, tagId);
    },

    removeTagFromProject(projectId, tagId) {
      assertPositiveIntegerId(projectId, 'projectId');
      assertPositiveIntegerId(tagId, 'tagId');
      requireProject(projectId);
      requireTag(tagId);
      return tagRepository.removeFromProject(projectId, tagId);
    },

    replaceProjectTags(projectId, tagIds) {
      assertPositiveIntegerId(projectId, 'projectId');
      assertTagIdArray(tagIds);

      const uniqueTagIds = [...new Set(tagIds)];
      requireProject(projectId);
      for (const tagId of uniqueTagIds) {
        requireTag(tagId);
      }

      return tagRepository.replaceForProject(projectId, uniqueTagIds);
    },
  };
}
