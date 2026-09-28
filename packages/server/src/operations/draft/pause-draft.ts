import { currentPick } from '@fantasy/core';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireCommissioner } from '../../league/access.js';
import { announceTurn, requireDraft, secondsLeft } from '../../league/draft.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { DRAFT_STATUSES } from '../../repos/types.js';

const ClockSchema = z.object({
  status: z.enum(DRAFT_STATUSES),
  deadline: z.string().nullable().describe('When the team on the clock must pick; null while paused.'),
  secondsLeft: z.number().int().nullable()
});

export const pauseDraft = defineOperation({
  name: 'pause_draft',
  method: 'POST',
  path: '/leagues/{leagueId}/draft/pause',
  summary: 'Pause the draft clock (commissioner only)',
  description:
    'Freezes the pick clock: nobody can pick and autopick waits until resume_draft, which gives the team on the clock the seconds it had left. Pausing a paused draft changes nothing. Only the commissioner, while the league is drafting.',
  tags: ['draft'],
  mutation: true,
  auth: 'user',
  input: z.object({ leagueId: LeagueIdSchema }),
  output: ClockSchema,
  handler: async (ctx, input) => {
    const access = await requireCommissioner(ctx, input.leagueId);
    const now = ctx.clock.now();
    assertAction('pause_draft', access.league, access.actor, now);
    let record = requireDraft(await ctx.repos.drafts.get(input.leagueId));
    if (record.status === 'in_progress') {
      record = await ctx.repos.drafts.update({
        ...record,
        status: 'paused',
        pausedRemainingSeconds: secondsLeft(record, now),
        deadline: null,
        updatedAt: now.toISOString()
      });
      // Pushed to open boards (the realtime relay), so their countdowns stop now.
      await ctx.events.publish('Draft Paused', {
        leagueId: record.leagueId,
        pick: currentPick(record.state)?.overall ?? null,
        secondsLeft: record.pausedRemainingSeconds,
        pausedAt: now.toISOString()
      });
    }
    return { status: record.status, deadline: record.deadline, secondsLeft: secondsLeft(record, now) };
  }
});

export const resumeDraft = defineOperation({
  name: 'resume_draft',
  method: 'POST',
  path: '/leagues/{leagueId}/draft/resume',
  summary: 'Restart a paused draft clock (commissioner only)',
  description:
    'Restarts the pick clock with the seconds the team on the clock had left when you paused (at least 30), and announces the turn again so agents pick. Only the commissioner, while the league is drafting; a draft that is not paused returns CONFLICT.',
  tags: ['draft'],
  mutation: true,
  auth: 'user',
  input: z.object({ leagueId: LeagueIdSchema }),
  output: ClockSchema,
  handler: async (ctx, input) => {
    const access = await requireCommissioner(ctx, input.leagueId);
    const now = ctx.clock.now();
    assertAction('resume_draft', access.league, access.actor, now);
    const record = requireDraft(await ctx.repos.drafts.get(input.leagueId));
    if (record.status !== 'paused') {
      throw new ApiError('CONFLICT', 'The draft is not paused.', {
        fix: 'Only a paused draft can resume. get_draft_board shows its status.'
      });
    }
    const seconds = Math.max(30, record.pausedRemainingSeconds ?? record.state.pickSeconds);
    const resumed = await ctx.repos.drafts.update({
      ...record,
      status: 'in_progress',
      pausedRemainingSeconds: null,
      deadline: new Date(now.getTime() + seconds * 1000).toISOString(),
      updatedAt: now.toISOString()
    });
    await ctx.events.publish('Draft Resumed', {
      leagueId: resumed.leagueId,
      pick: currentPick(resumed.state)?.overall ?? null,
      deadline: resumed.deadline as string,
      secondsLeft: seconds,
      resumedAt: now.toISOString()
    });
    await announceTurn(ctx, resumed);
    return { status: resumed.status, deadline: resumed.deadline, secondsLeft: secondsLeft(resumed, now) };
  }
});
