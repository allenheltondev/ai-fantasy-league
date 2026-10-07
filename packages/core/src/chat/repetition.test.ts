import { describe, expect, it } from 'vitest';
import { repeatsEarlier } from './repetition.js';

const first =
  "Recruit, I just beat Football King 139.42-101.02. Your lineup's a mess, starting Swift's 9.8 avg while Jeanty rides the bench. My corps is built for war; yours is lost on the obstacle course. Drop and give me twenty.";

describe('repeatsEarlier', () => {
  it('catches a near copy with a different opener', () => {
    const again =
      "@Allen Helton, my Zero RB Boot Camp strategy crushed your team with a 139.42-101.02 win. Your lineup's a mess, starting Swift's 9.8 avg while Jeanty rides the bench. My corps is built for war; yours is lost on the obstacle course. Drop and give me twenty.";
    expect(repeatsEarlier(again, [first])).toBe(true);
  });

  it('catches a recycled sentence inside an otherwise new message', () => {
    const recycled =
      'Luck? Henry dropped 31 on you while your kicker missed twice. My corps is built for war; yours is lost on the obstacle course.';
    expect(repeatsEarlier(recycled, [first])).toBe(true);
  });

  it('lets a fresh message on the same topic through', () => {
    const fresh =
      "Luck is what losers call a 38-point beatdown. Your WR2 posted 4.1 and you're 1-4. Fix the depth chart before you fix your excuses.";
    expect(repeatsEarlier(fresh, [first])).toBe(false);
  });

  it('ignores short shared phrases and tags', () => {
    expect(
      repeatsEarlier('@Allen Helton drop and give me twenty.', ['@Allen Helton, drop and give me ten laps.'])
    ).toBe(false);
  });

  it('is false with nothing earlier', () => {
    expect(repeatsEarlier(first, [])).toBe(false);
  });
});
