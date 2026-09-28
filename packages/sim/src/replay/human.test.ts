import { FixedClock, yahooDefaultSettings } from '@fantasy/core';
import { InMemoryEventPublisher, createInMemoryRepos, createServices, silentLogger } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { archiveDir } from '../cli/archive-dir.js';
import { FIXTURE_ARCHIVE_DIR } from '../archive/io.js';
import { HUMAN } from './league-replay.js';
import { HumanStandIn, dataOf, operationRunner } from './human.js';

function standIn() {
  const services = createServices({
    clock: new FixedClock('2025-09-01T00:00:00.000Z'),
    repos: createInMemoryRepos(),
    events: new InMemoryEventPublisher(),
    log: silentLogger
  });
  const run = operationRunner(services);
  return { run, human: new HumanStandIn(HUMAN, 'team-1', run, services) };
}

const event = (detailType: string, detail: Record<string, unknown>) => ({
  id: 'e1',
  'detail-type': detailType,
  source: 'fantasy',
  detail
});

describe('the human stand-in', () => {
  it('ignores events before it has a league and events from other leagues', async () => {
    const { human } = standIn();
    const sub = human.subscriber();
    await sub.handle(event('Draft Turn Started', { leagueId: 'lg', teamId: 'team-1', pick: 1 }));
    human.join({ id: 'lg', settings: yahooDefaultSettings() });
    await sub.handle(event('Lineup Lock Approaching', { leagueId: 'other', week: 1 }));
    await sub.handle(event('Draft Turn Started', { leagueId: 'lg', teamId: 'team-2', pick: 1 }));
    expect(human.actions).toEqual({});
  });

  it('records refusals and surfaces them with their fix', async () => {
    const { human } = standIn();
    human.join({ id: 'missing', settings: yahooDefaultSettings() });
    await expect(
      human.subscriber().handle(event('Lineup Lock Approaching', { leagueId: 'missing', week: 1 }))
    ).rejects.toThrow(/get_roster failed: LEAGUE_NOT_FOUND/);
    expect(human.actions).toEqual({ get_roster: 1 });
    expect(human.refused).toEqual([{ operation: 'get_roster', code: 'LEAGUE_NOT_FOUND' }]);
  });

  it('runs operations by name only', async () => {
    const { run } = standIn();
    await expect(run('no_such_operation', {}, HUMAN)).rejects.toThrow(/No operation named/);
    expect(() => dataOf({ error: { code: 'CONFLICT', message: 'm', fix: 'f' } }, 'op')).toThrow(
      'op failed: CONFLICT m (f)'
    );
  });
});

describe('--archive', () => {
  it('names the fixture, a built season, or a directory', () => {
    expect(archiveDir('fixtures')).toBe(FIXTURE_ARCHIVE_DIR);
    expect(archiveDir('2025')).toMatch(/archives[/\\]2025$/);
    expect(archiveDir('/tmp/a')).toBe('/tmp/a');
    expect(archiveDir('a', '/base')).toBe('/base/a');
  });
});
