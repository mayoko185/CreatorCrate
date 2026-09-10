import { createAppMetaRepository } from '../../src/data/app-meta-repository.js';
import { createProjectPageDefaultRepository } from '../../src/data/project-page-default-repository.js';
import { createProjectRepository } from '../../src/data/project-repository.js';
import { createProjectOptionCatalogueService } from '../../src/services/project-option-catalogue-service.js';

export function createTestProjectOptionCatalogueService(db) {
  return createProjectOptionCatalogueService({
    db,
    appMetaRepository: createAppMetaRepository(db),
    projectRepository: createProjectRepository(db),
    projectPageDefaultRepository: createProjectPageDefaultRepository(db),
  });
}
