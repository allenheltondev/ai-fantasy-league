import { FixedClock } from '@fantasy/core';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../log.js';
import {
  OFF_SWITCH,
  ParameterKillSwitch,
  isEngagedValue,
  killSwitchFromParameter,
  ssmParameterReader
} from './kill-switch.js';

describe('killSwitchFromParameter', () => {
  const clock = new FixedClock('2026-10-04T15:00:00.000Z');

  it('is absent when the deployment names no parameter', () => {
    expect(killSwitchFromParameter(undefined, { clock, log: silentLogger })).toBeUndefined();
    expect(killSwitchFromParameter('  ', { clock, log: silentLogger })).toBeUndefined();
  });

  it('reads the named parameter', async () => {
    const reads: string[] = [];
    const reader = {
      read: async (name: string) => {
        reads.push(name);
        return 'on';
      }
    };
    const kill = killSwitchFromParameter('/stack/agents/kill-switch', { clock, log: silentLogger, reader });
    expect(kill).toBeInstanceOf(ParameterKillSwitch);
    expect(await kill?.engaged()).toBe(true);
    expect(reads).toEqual(['/stack/agents/kill-switch']);
    expect(killSwitchFromParameter('/x', { clock, log: silentLogger })).toBeInstanceOf(ParameterKillSwitch);
  });
});

describe('kill switch', () => {
  it('parses values', () => {
    for (const v of ['on', 'TRUE', ' 1 ', 'engaged']) expect(isEngagedValue(v)).toBe(true);
    for (const v of ['off', '', 'no', undefined]) expect(isEngagedValue(v)).toBe(false);
  });

  it('caches reads and fails closed', async () => {
    const clock = new FixedClock('2026-10-04T00:00:00Z');
    const read = vi
      .fn()
      .mockResolvedValueOnce('off')
      .mockResolvedValueOnce('on')
      .mockRejectedValueOnce(new Error('ssm down'));
    const ks = new ParameterKillSwitch({
      name: '/x',
      reader: { read },
      clock,
      log: silentLogger,
      ttlMs: 1000
    });
    expect(await ks.engaged()).toBe(false);
    expect(await ks.engaged()).toBe(false);
    clock.advance(1000);
    expect(await ks.engaged()).toBe(true);
    clock.advance(1000);
    expect(await ks.engaged()).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(await OFF_SWITCH.engaged()).toBe(false);
  });

  it('reads the SSM parameter', async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: 'on' } });
    const reader = ssmParameterReader({ send } as never);
    expect(await reader.read('/agents/kill-switch')).toBe('on');
    expect(send.mock.calls[0]?.[0].input).toEqual({ Name: '/agents/kill-switch' });
  });
});
