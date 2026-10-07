import { createProcessingRecoveryEvidenceRepository } from '../../src/data/processing-recovery-evidence-repository.js';
import { createProcessingRecoveryEvidenceRecorder } from '../../src/services/processing-recovery-evidence-recorder.js';

// The recovery evidence dependencies the app wires into the processing service: the recorder
// and the repository it writes through, both on the test's shared connection. `repository`
// lets a test inject a failing or recording wrapper around the real repository.
export function processingRecoveryEvidenceDependencies(db, { repository } = {}) {
  const processingRecoveryEvidenceRepository = repository ?? createProcessingRecoveryEvidenceRepository(db);
  return {
    processingRecoveryEvidenceRepository,
    processingRecoveryEvidenceRecorder: createProcessingRecoveryEvidenceRecorder({
      db, repository: processingRecoveryEvidenceRepository,
    }),
  };
}
