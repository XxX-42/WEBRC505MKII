const PROJECT_ARCHIVE_MUTATION_LOCK = 'webrc505-project-archive-mutation-v1';

/** Cross-tab serialization for project archive replacement and recovery. */
export async function withProjectArchiveMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    throw new Error('Project archive mutation requires cross-page Web Locks support; the operation was not submitted.');
  }
  return navigator.locks.request(PROJECT_ARCHIVE_MUTATION_LOCK, { mode: 'exclusive' }, operation);
}
