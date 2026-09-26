export function presentGeneratedImageRebuild(status) {
  const phase = status?.phase || 'idle';
  const checked = (status?.succeeded || 0) + (status?.failed || 0) + (status?.skipped || 0);
  const total = status?.total || 0;
  const counts = `${status?.succeeded || 0} rebuilt · ${status?.skipped || 0} skipped · ${status?.failed || 0} failed`;
  const progress = `${checked.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} checked`;
  const details = phase === 'running' || phase === 'completed' || phase === 'completed_with_failures' || phase === 'failed'
    ? `${progress} · ${counts}` : '';
  const message = {
    idle: 'Generated images are up to date.',
    queued: 'Rebuild queued. It will run in the background; you can keep browsing.',
    running: 'Rebuilding generated images in the background. You can keep browsing.',
    completed: 'Rebuild complete.',
    completed_with_failures: 'Rebuild finished, but some images could not be rebuilt. You can keep browsing.',
    failed: 'Rebuild stopped before finishing. You can keep browsing and start a manual rebuild.',
  }[phase] || 'Generated-image rebuild status is unavailable.';
  return { phase, runId: status?.runId || '', message, details };
}
