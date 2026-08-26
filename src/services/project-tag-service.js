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
export function createProjectTagService({ tagRepository, projectRepository, applicationLogger = null } = {}) {
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

  function logActivity(event, projectId, tagId, assignmentCount) {
    try {
      applicationLogger?.info?.({
        event,
        kind: 'activity',
        subsystem: 'tags',
        message: 'Project tag activity completed.',
        projectId,
        context: { tagId, assignmentCount },
      });
    } catch {
      // Activity logging must never alter a completed project-tag mutation.
    }
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
      const assigned = tagRepository.assignToProject(projectId, tagId);
      if (assigned) logActivity('project.tags.assigned', projectId, tagId, 1);
      return assigned;
    },

    removeTagFromProject(projectId, tagId) {
      assertPositiveIntegerId(projectId, 'projectId');
      assertPositiveIntegerId(tagId, 'tagId');
      requireProject(projectId);
      requireTag(tagId);
      const removed = tagRepository.removeFromProject(projectId, tagId);
      if (removed) logActivity('project.tags.removed', projectId, tagId, 1);
      return removed;
    },

    replaceProjectTags(projectId, tagIds) {
      assertPositiveIntegerId(projectId, 'projectId');
      assertTagIdArray(tagIds);

      const uniqueTagIds = [...new Set(tagIds)];
      requireProject(projectId);
      for (const tagId of uniqueTagIds) {
        requireTag(tagId);
      }

      const currentTagIds = tagRepository.listForProject(projectId).map((tag) => tag.id);
      const currentTagIdSet = new Set(currentTagIds);
      const desiredTagIdSet = new Set(uniqueTagIds);
      const assignedCount = uniqueTagIds.filter((tagId) => !currentTagIdSet.has(tagId)).length;
      const removedCount = currentTagIds.filter((tagId) => !desiredTagIdSet.has(tagId)).length;
      const resultingTags = tagRepository.replaceForProject(projectId, uniqueTagIds);
      if (assignedCount > 0) logActivity('project.tags.assigned', projectId, null, assignedCount);
      if (removedCount > 0) logActivity('project.tags.removed', projectId, null, removedCount);
      return resultingTags;
    },
  };
}
