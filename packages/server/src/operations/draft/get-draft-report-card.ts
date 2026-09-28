import { REPORT_CARD_GRADES } from '@fantasy/core';
import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { requireDraft } from '../../league/draft.js';
import { actorTeam } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

const ReportTeamSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  yours: z.boolean().describe('True for your own team.'),
  grade: z.enum(REPORT_CARD_GRADES).describe('Draft grade, A+ (best) through F- (worst).'),
  headline: z.string(),
  strengths: z.array(z.string()).describe('What went well.'),
  weaknesses: z.array(z.string()).describe("What didn't."),
  analysis: z.string().describe('A paragraph on the draft and the season ahead.'),
  projectedWins: z.number().int(),
  projectedLosses: z.number().int(),
  projectedRank: z.number().int().describe('Projected final regular-season standing, 1 = first.'),
  projectedPoints: z
    .number()
    .describe("Projected regular-season points from the roster's best lineup each week."),
  expectedWins: z.number().describe('Schedule-based expected wins behind the projection.')
});

export const DraftReportCardSchema = z.object({
  status: z
    .enum(['draft_in_progress', 'grading', 'ready'])
    .describe(
      '`draft_in_progress` until the last pick; `grading` while the report card is written (usually under a minute); then `ready`.'
    ),
  source: z
    .enum(['model', 'computed'])
    .nullable()
    .describe('`model` when an AI graded the draft; `computed` when grades came from projections alone.'),
  summary: z.string().nullable().describe('The league-wide take.'),
  generatedAt: z.string().nullable(),
  teams: z
    .array(ReportTeamSchema)
    .describe(
      'Every team, in projected standings order. Records add up across the league: total wins equal total losses, and each record fits the schedule.'
    )
});
export type DraftReportCardView = z.infer<typeof DraftReportCardSchema>;

export const getDraftReportCard = defineOperation({
  name: 'get_draft_report_card',
  method: 'GET',
  path: '/leagues/{leagueId}/draft/report-card',
  summary: 'Draft grades and projected standings for every team',
  description: [
    'The post-draft report card: an AI-judged letter grade (A+ through F-) for every team, with what went well, what did not, and a short analysis, plus a projected regular-season record and final standing.',
    'Projections come from each roster’s best weekly lineup under league scoring against the real schedule, so the projected records add up: every matchup is one win and one loss.',
    'Returns status `draft_in_progress` before the last pick and `grading` while the report card is being written. Before the draft starts this returns DRAFT_NOT_STARTED. Any member of the league can read it.'
  ].join(' '),
  tags: ['draft'],
  mutation: false,
  input: z.object({ leagueId: LeagueIdSchema }),
  output: DraftReportCardSchema,
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const record = requireDraft(await ctx.repos.drafts.get(input.leagueId));
    const empty = { source: null, summary: null, generatedAt: null, teams: [] };
    if (record.status !== 'complete') return { status: 'draft_in_progress' as const, ...empty };
    const report = await ctx.repos.drafts.getReport(input.leagueId);
    if (report === null || report.status !== 'ready') return { status: 'grading' as const, ...empty };
    const yourTeamId = actorTeam(access.actor)?.id ?? null;
    const names = new Map(access.teams.map((t) => [t.id, t.name]));
    return {
      status: 'ready' as const,
      source: report.source,
      summary: report.summary,
      generatedAt: report.updatedAt,
      teams: [...report.teams]
        .sort((a, b) => a.projectedRank - b.projectedRank)
        .map((t) => ({ ...t, teamName: names.get(t.teamId) ?? t.teamId, yours: t.teamId === yourTeamId }))
    };
  }
});
