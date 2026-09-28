import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PERSONALITIES } from '../agents/personalities.js';
import { banterRoll, banterVerdict, BANTER_LIMITS, isDmRoomId, replyToAgentDepth } from './banter.js';

const base = { depth: 0, roomId: 'trash-talk', banterRemaining: 3, propensity: 1, seed: 'e1:team-2' };

describe('agent-to-agent banter', () => {
  it('counts depth only for an agent answering an agent', () => {
    expect(replyToAgentDepth('agent', null)).toBe(0);
    expect(replyToAgentDepth('agent', { kind: 'user' })).toBe(0);
    expect(replyToAgentDepth('user', { kind: 'agent' })).toBe(0);
    expect(replyToAgentDepth('agent', { kind: 'agent' })).toBe(1);
    expect(replyToAgentDepth('agent', { kind: 'agent', replyToAgentDepth: 1 })).toBe(2);
    expect(replyToAgentDepth('agent', { kind: 'system' })).toBe(0);
  });

  it('never lets a retort draw another retort (property: every thread stops at depth 1)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('agent', 'user'), { minLength: 1, maxLength: 12 }),
        fc.string(),
        (authors, seed) => {
          // A thread where each message answers the one before it. Agents only answer a message
          // that may trigger them, so an agent message at depth d exists only if depth d-1 triggered.
          let previous: { kind: string; replyToAgentDepth: number } | null = null;
          for (const [i, kind] of authors.entries()) {
            if (kind === 'agent' && previous?.kind === 'agent') {
              const allowed = banterVerdict({
                ...base,
                depth: previous.replyToAgentDepth,
                seed: `${seed}${i}`
              });
              if (allowed !== 'ok') break;
            }
            const depth = replyToAgentDepth(kind, previous);
            expect(depth).toBeLessThanOrEqual(BANTER_LIMITS.maxTriggerDepth);
            if (depth >= BANTER_LIMITS.maxTriggerDepth)
              expect(banterVerdict({ ...base, depth, seed: `${seed}${i}` })).toBe('depth');
            previous = { kind, replyToAgentDepth: depth };
          }
        }
      )
    );
  });

  it('refuses in a DM, without budget, or when the roll misses', () => {
    expect(banterVerdict(base)).toBe('ok');
    expect(banterVerdict({ ...base, depth: 1 })).toBe('depth');
    expect(banterVerdict({ ...base, roomId: 'dm-team-1-team-2' })).toBe('dm');
    expect(banterVerdict({ ...base, banterRemaining: 0 })).toBe('budget');
    expect(banterVerdict({ ...base, propensity: 0 })).toBe('declined');
    expect(banterVerdict({ ...base, propensity: -1 })).toBe('declined');
    expect(isDmRoomId('m-2026-W05-W05-1')).toBe(false);
    expect(isDmRoomId('dm-a-b')).toBe(true);
  });

  it('rolls deterministically, and a propensity is roughly the chance to bite (property)', () => {
    fc.assert(fc.property(fc.string(), (seed) => banterRoll(seed) === banterRoll(seed)));
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const r = banterRoll(seed);
        return r >= 0 && r < 1;
      })
    );
    const bites = (p: number) =>
      Array.from({ length: 2000 }, (_, i) => banterVerdict({ ...base, propensity: p, seed: `e${i}` })).filter(
        (v) => v === 'ok'
      ).length / 2000;
    expect(bites(0.5)).toBeGreaterThan(0.4);
    expect(bites(0.5)).toBeLessThan(0.6);
    expect(bites(0.05)).toBeLessThan(0.1);
  });

  it('gives every personality a propensity, and quiet ones rarely bite', () => {
    for (const p of PERSONALITIES) {
      expect(p.banter).toBeGreaterThanOrEqual(0);
      expect(p.banter).toBeLessThanOrEqual(1);
    }
    const zen = PERSONALITIES.find((p) => p.id === 'zen-master');
    const chaos = PERSONALITIES.find((p) => p.id === 'chaos-agent');
    expect(zen?.banter).toBeLessThan(0.1);
    expect(chaos?.banter).toBeGreaterThan(0.8);
  });
});
