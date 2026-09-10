export function isProjectArchived(project) {
  return project?.archived_at != null || project?.status === 'archived';
}
