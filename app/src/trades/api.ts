import type { ApiFetch } from '../api/client';

/** Shapes from the trade operations (preview_trade, propose_trade, list_trades, ...) in openapi.json. */

export interface PlayerRef {
  id: string;
  name: string;
  team: string | null;
  position: string;
}

export interface TeamRef {
  id: string;
  name: string;
}

export type TradeAction = 'accept' | 'reject' | 'counter' | 'withdraw' | 'vote' | 'approve';

export interface TradeView {
  id: string;
  status: string;
  fromTeam: TeamRef;
  toTeam: TeamRef;
  fromSends: PlayerRef[];
  toSends: PlayerRef[];
  fromDrops: PlayerRef[];
  toDrops: PlayerRef[];
  message: string | null;
  proposedAt: string;
  expiresAt: string;
  reviewEndsAt: string | null;
  counterOf: string | null;
  counterChain: string[];
  round: number;
  vetoVotes: number;
  vetoVotesRequired: number;
  youVotedToVeto: boolean;
  voidReason: { code: string; message: string; fix: string } | null;
  direction: 'incoming' | 'outgoing' | 'league';
  yourActions: TradeAction[];
}

export interface Issue {
  code: string;
  message: string;
  fix: string;
}

export interface SideImpact {
  team: TeamRef;
  sends: PlayerRef[];
  receives: PlayerRef[];
  drops: PlayerRef[];
  activeBefore: number;
  activeAfter: number;
  activeLimit: number;
  dropsNeeded: number;
  dropCandidates: PlayerRef[];
  lineupDelta: number;
  valueDelta: number;
}

export interface TradePreview {
  valid: boolean;
  issues: Issue[];
  warnings: Issue[];
  sides: [SideImpact, SideImpact];
  fairness: { favors: string | null; lineupGap: number; valueGap: number; lopsided: boolean };
}

export interface TradeSetup {
  yourTeam: TeamRef | null;
  teams: TeamRef[];
  allowedActions: string[];
}

export interface Selection {
  withTeamId: string;
  send: string[];
  receive: string[];
  drops: string[];
  message?: string;
}

export interface TradesApi {
  setup(leagueId: string): Promise<TradeSetup>;
  roster(leagueId: string, teamId: string): Promise<PlayerRef[]>;
  list(leagueId: string): Promise<TradeView[]>;
  preview(leagueId: string, selection: Selection): Promise<TradePreview>;
  propose(leagueId: string, selection: Selection): Promise<TradeView>;
  counter(leagueId: string, tradeId: string, selection: Selection): Promise<TradeView>;
  respond(
    leagueId: string,
    tradeId: string,
    response: 'accept' | 'reject',
    drops?: string[]
  ): Promise<TradeView>;
  withdraw(leagueId: string, tradeId: string): Promise<TradeView>;
  vote(leagueId: string, tradeId: string, decision: 'veto' | 'approve'): Promise<TradeView>;
}

const league = (leagueId: string) => `/leagues/${encodeURIComponent(leagueId)}`;
const body = (s: Selection) => ({
  send: s.send,
  receive: s.receive,
  drops: s.drops,
  ...(s.message ? { message: s.message } : {})
});

export function createTradesApi(apiFetch: ApiFetch): TradesApi {
  const trade = async (path: string, payload: unknown) =>
    (await apiFetch<{ trade: TradeView }>(path, { method: 'POST', body: payload })).data.trade;
  return {
    async setup(leagueId) {
      const res = await apiFetch<TradeSetup>(`${league(leagueId)}/state`);
      return {
        yourTeam: res.data.yourTeam,
        teams: res.data.teams.map((t) => ({ id: t.id, name: t.name })),
        allowedActions: res.data.allowedActions
      };
    },
    async roster(leagueId, teamId) {
      const res = await apiFetch<{ players: { player: PlayerRef }[] }>(
        `${league(leagueId)}/teams/${encodeURIComponent(teamId)}/roster`
      );
      return res.data.players.map((p) => p.player);
    },
    async list(leagueId) {
      return (await apiFetch<{ trades: TradeView[] }>(`${league(leagueId)}/trades`)).data.trades;
    },
    async preview(leagueId, s) {
      const res = await apiFetch<TradePreview>(`${league(leagueId)}/trades/preview`, {
        query: { withTeamId: s.withTeamId, send: s.send, receive: s.receive, drops: s.drops }
      });
      return res.data;
    },
    propose: (leagueId, s) => trade(`${league(leagueId)}/trades`, { withTeamId: s.withTeamId, ...body(s) }),
    counter: (leagueId, tradeId, s) => trade(`${league(leagueId)}/trades/${tradeId}/counter`, body(s)),
    respond: (leagueId, tradeId, response, drops = []) =>
      trade(`${league(leagueId)}/trades/${tradeId}/respond`, { response, drops }),
    withdraw: (leagueId, tradeId) => trade(`${league(leagueId)}/trades/${tradeId}/withdraw`, {}),
    vote: (leagueId, tradeId, decision) => trade(`${league(leagueId)}/trades/${tradeId}/votes`, { decision })
  };
}
