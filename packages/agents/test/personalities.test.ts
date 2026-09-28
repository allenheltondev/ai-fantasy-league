import { PERSONALITIES, PERSONALITY_IDS, resolveAgentConfig, yahooDefaultSettings } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { assembleSystemPrompt } from '../src/prompt.js';
import { league } from './support.js';

/**
 * Personalities (issue #75): every preset has its own voice, and that voice is in every prompt the
 * agent gets, chat and decisions alike, so chat lines and decision summaries sound like the same
 * character. The snapshots pin each persona's prompt so a catalog edit shows up in review.
 */

function prompt(
  personalityId: (typeof PERSONALITY_IDS)[number],
  task: { title: string; instructions: string }
) {
  return assembleSystemPrompt({
    config: resolveAgentConfig({ personalityId, difficulty: 'pro', archetype: 'balanced' }),
    league: league(),
    teamId: 'team-2',
    settings: yahooDefaultSettings(4),
    memory: [],
    task
  });
}

const CHAT = { title: 'React to a league moment', instructions: 'Say something.' };
const DECISION = { title: 'Set your lineup', instructions: 'Pick starters.' };

describe('personality prompts', () => {
  for (const p of PERSONALITIES) {
    it(`${p.id}: persona section`, () => {
      const persona = resolveAgentConfig({ personalityId: p.id, difficulty: 'pro', archetype: 'balanced' })
        .prompt.persona;
      expect(persona).toMatchSnapshot();
    });
  }

  it('gives every personality a distinct voice in chat and decision prompts', () => {
    const personas = PERSONALITIES.map((p) => {
      const chat = prompt(p.id, CHAT);
      const decision = prompt(p.id, DECISION);
      for (const text of [chat, decision]) {
        expect(text).toContain(`You play the part of "${p.displayName}"`);
        expect(text).toContain(`Voice: ${p.voice}`);
        expect(text).toContain(p.sampleLines[0]);
      }
      // Decision summaries are written in the same voice.
      expect(decision).toContain('`summary`, in your own voice');
      return chat.slice(0, chat.indexOf('# How you play'));
    });
    expect(new Set(personas).size).toBe(PERSONALITIES.length);
  });
});
