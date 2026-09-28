import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSeatConfig } from '../../api/types';
import { catalog, seatConfigs } from '../../test/fakeApi';
import { AgentCard } from './AgentCard';
import { difficultyTone, shufflePersonality, withAdvanced } from './agentConfig';
import { AgentGrid } from './AgentGrid';

const CATALOG = catalog();
const CONFIG: AgentSeatConfig = { personalityId: 'p1', difficulty: 'pro', archetype: 'zero_rb' };

describe('agent config helpers', () => {
  it('shuffles to an unused personality, or any other once all are used', () => {
    const configs = seatConfigs(3);
    const next = shufflePersonality(configs, 1, CATALOG, () => 0);
    expect(next).toEqual({ ...configs[1], personalityId: 'p3' });
    const full = seatConfigs(12);
    expect(shufflePersonality(full, 0, CATALOG, () => 0.999).personalityId).toBe('p11');
  });

  it('colors difficulties from cool to hot', () => {
    expect(difficultyTone(CATALOG, 'rookie')).toBe('neutral');
    expect(difficultyTone(CATALOG, 'hall_of_famer')).toBe('error');
    expect(difficultyTone(CATALOG, 'unknown')).toBe('neutral');
  });

  it('keeps only the Advanced values that were set', () => {
    expect(withAdvanced({ ...CONFIG, advanced: { customFlavor: 'x' } }, {})).toEqual(CONFIG);
    expect(
      withAdvanced(CONFIG, {
        modelOverride: 'nova-micro',
        customFlavor: '  loves kickers ',
        levers: { maxToolSteps: 3, chatModelTier: undefined, research: {} }
      })
    ).toEqual({
      ...CONFIG,
      advanced: { modelOverride: 'nova-micro', customFlavor: 'loves kickers', levers: { maxToolSteps: 3 } }
    });
    expect(withAdvanced(CONFIG, { levers: { research: { news: false } } })).toEqual({
      ...CONFIG,
      advanced: { levers: { research: { news: false } } }
    });
  });
});

describe('AgentCard', () => {
  it('shows the persona, blurb, difficulty pill, and strategy', () => {
    render(<AgentCard seatLabel="Seat 2" config={CONFIG} catalog={CATALOG} />);
    const card = screen.getByRole('generic', { name: 'Seat 2: Persona 1' });
    expect(within(card).getByRole('img', { name: 'Persona 1 avatar' })).toBeInTheDocument();
    expect(within(card).getByText('Bio of persona 1.')).toBeInTheDocument();
    expect(within(card).getByTestId('difficulty-pill')).toHaveTextContent('Pro');
    expect(within(card).getByText('Zero RB')).toBeInTheDocument();
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });

  it('falls back to ids for entries missing from the catalog', () => {
    render(
      <AgentCard
        seatLabel="Seat 3"
        config={{ personalityId: 'ghost', difficulty: 'legend', archetype: '' }}
        catalog={CATALOG}
      />
    );
    expect(screen.getByRole('heading', { name: 'ghost' })).toBeInTheDocument();
    expect(screen.getByTestId('difficulty-pill')).toHaveTextContent('legend');
    expect(screen.queryByText('Strategy:')).not.toBeInTheDocument();
  });

  it('changes difficulty, shuffles, and edits the Advanced drawer', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onShuffle = vi.fn();
    render(
      <AgentCard
        seatLabel="Seat 2"
        config={{ ...CONFIG, advanced: { levers: { research: { news: true } } } }}
        catalog={CATALOG}
        onChange={onChange}
        onShuffle={onShuffle}
      />
    );
    await user.selectOptions(screen.getByLabelText('Difficulty'), 'rookie');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ difficulty: 'rookie' }));
    await user.click(screen.getByRole('button', { name: 'Shuffle' }));
    expect(onShuffle).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Strategy')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.selectOptions(screen.getByLabelText('Strategy'), 'balanced');
    await user.selectOptions(screen.getByLabelText('Decision model tier'), 'frontier');
    await user.selectOptions(screen.getByLabelText('Chat model tier'), 'lite');
    await user.selectOptions(screen.getByLabelText('Chat model tier'), '');
    await user.selectOptions(screen.getByLabelText('Preferred model'), 'claude-opus-5');
    await user.selectOptions(screen.getByLabelText('Reasoning effort'), 'high');
    expect(screen.getByLabelText('News')).toHaveValue('on');
    await user.selectOptions(screen.getByLabelText('News'), '');
    await user.selectOptions(screen.getByLabelText('Trending players'), 'off');
    await user.selectOptions(screen.getByLabelText('Projections'), 'on');
    await user.type(screen.getByLabelText('Actions per trigger'), '3');
    await user.type(screen.getByLabelText('Cooldown (minutes)'), '5');
    await user.clear(screen.getByLabelText('Cooldown (minutes)'));
    await user.type(screen.getByLabelText('Extra personality flavor'), 'Hates kickers.');
    onChange.mockClear();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith({
      personalityId: 'p1',
      difficulty: 'pro',
      archetype: 'balanced',
      advanced: {
        modelOverride: 'claude-opus-5',
        customFlavor: 'Hates kickers.',
        levers: {
          decisionModelTier: 'frontier',
          reasoningEffort: 'high',
          research: { trending: false, projections: true },
          actionsPerTrigger: 3
        }
      }
    });
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('closes the drawer with Escape', async () => {
    const user = userEvent.setup();
    render(<AgentCard seatLabel="Seat 2" config={CONFIG} catalog={CATALOG} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });
});

describe('AgentGrid', () => {
  const seats = seatConfigs(2).map((config, i) => ({ key: String(i), label: `Seat ${i + 2}`, config }));

  it('is read-only without an editor', () => {
    render(<AgentGrid seats={seats} catalog={CATALOG} />);
    expect(screen.getAllByTestId('agent-card')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Randomize all' })).not.toBeInTheDocument();
  });

  it('routes card and bulk controls to the editor', async () => {
    const user = userEvent.setup();
    const editor = {
      onChange: vi.fn(),
      onShuffle: vi.fn(),
      onRandomizeAll: vi.fn(),
      onDifficultyAll: vi.fn()
    };
    render(<AgentGrid seats={seats} catalog={CATALOG} editor={editor} />);
    await user.click(screen.getByRole('button', { name: 'Randomize all' }));
    expect(editor.onRandomizeAll).toHaveBeenCalledOnce();
    await user.selectOptions(screen.getByLabelText('Difficulty for all'), 'all_pro');
    expect(editor.onDifficultyAll).toHaveBeenCalledWith('all_pro');
    const second = screen.getAllByTestId('agent-card')[1] as HTMLElement;
    await user.click(within(second).getByRole('button', { name: 'Shuffle' }));
    expect(editor.onShuffle).toHaveBeenCalledWith(1);
    await user.selectOptions(within(second).getByLabelText('Difficulty'), 'rookie');
    expect(editor.onChange).toHaveBeenCalledWith(1, expect.objectContaining({ difficulty: 'rookie' }));
  });
});
