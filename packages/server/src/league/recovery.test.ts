import { describe, expect, it, vi } from 'vitest';
import { league } from '../../test/support/harness.js';
import { ApiError } from '../errors.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { updateRecovery } from './recovery.js';

describe('recovery checkpoints', () => {
  it('leaves deleted leagues and already completed checkpoints alone', async () => {
    const repos = createInMemoryRepos();
    expect(await updateRecovery(repos, 'missing', (value) => value)).toBeNull();
    await repos.leagues.create(league());
    expect(await updateRecovery(repos, 'lg-1', () => null)).toEqual(league());
  });
  it.each([new ApiError('CONFLICT', 'busy', { fix: 'Retry.' }), new Error('storage unavailable')])(
    'propagates persistent storage failures instead of claiming completion',
    async (error) => {
      const repos = createInMemoryRepos();
      await repos.leagues.create(league());
      const update = vi.spyOn(repos.leagues, 'update').mockRejectedValue(error);
      await expect(updateRecovery(repos, 'lg-1', (value) => ({ ...value, draftStartup: null }))).rejects.toBe(
        error
      );
      expect(update).toHaveBeenCalledTimes(error instanceof ApiError ? 4 : 1);
    }
  );
});
