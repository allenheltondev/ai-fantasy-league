import {
  optimizeLineup,
  type LeagueSettings,
  type LineupContext,
  type Position,
  type RosterPlayer,
  type RosterSlot
} from '@fantasy/core';
import {
  createContext,
  executeOperation,
  registry,
  type BusEvent,
  type Envelope,
  type EventSubscriber,
  type Principal,
  type Services
} from '@fantasy/server';

/** Runs one operation through the real pipeline (validation, auth, phase checks, idempotency, audit). */
export type RunOperation = (
  name: string,
  input: Record<string, unknown>,
  principal: Principal
) => Promise<Envelope>;

export function operationRunner(services: Services): RunOperation {
  let n = 0;
  return async (name, input, principal) => {
    const operation = registry.get(name);
    if (operation === undefined) throw new Error(`No operation named ${name}.`);
    const result = await executeOperation({
      registry,
      operation,
      ctx: createContext(services, principal),
      input,
      idempotencyKey: operation.mutation ? `sim-op-${String(++n).padStart(6, '0')}` : null
    });
    return result.body;
  };
}

/** The data of a successful envelope; throws with the error's code and fix otherwise. */
export function dataOf<T>(envelope: Envelope, what: string): T {
  if ('error' in envelope) {
    throw new Error(
      `${what} failed: ${envelope.error.code} ${envelope.error.message} (${envelope.error.fix})`
    );
  }
  return envelope.data as T;
}

interface Board {
  onTheClock: { overall: number; teamId: string } | null;
  yourNeeds: string[];
  bestAvailable: { player: { id: string } }[];
}

interface RosterView {
  week: number;
  players: {
    player: { id: string; name: string; team: string | null; position: Position };
    slot: RosterSlot;
    status: RosterPlayer['status'];
    kickoff: string | null;
    projectedPoints: number | null;
  }[];
}

/**
 * The scripted human in seat 1, playing through the same operations a person's browser calls:
 * - on its draft turn it takes the best available player, or the best one for its first empty
 *   starting slot when that pick would leave the roster unable to fill its starters;
 * - before each lineup lock it starts the lineup optimizer's picks from `get_roster` projections;
 * - each week before the trade deadline, when the league rolls over, it offers one agent team (in
 *   turn) a bench-for-bench swap at a position both benches hold; the agent answers through its
 *   `trade_response` task, and an accepted trade processes after the review period.
 * It makes no waiver claims. Every call it makes is counted in `actions`; refusals (a lopsided or
 * locked trade, say) are recorded in `refused`.
 */
export class HumanStandIn {
  readonly actions: Record<string, number> = {};
  readonly refused: { operation: string; code: string }[] = [];
  #league: { id: string; settings: LeagueSettings } | null = null;

  constructor(
    readonly principal: Principal,
    readonly teamId: string,
    private readonly run: RunOperation,
    private readonly services: Services
  ) {}

  subscriber(): EventSubscriber {
    return {
      name: 'human-stand-in',
      detailTypes: ['Draft Turn Started', 'Lineup Lock Approaching', 'Week Rolled Over'],
      handle: (event) => this.#handle(event)
    };
  }

  async #handle(event: BusEvent): Promise<void> {
    const detail = event.detail as Record<string, unknown>;
    if (this.#league === null || detail.leagueId !== this.#league.id) return;
    if (event['detail-type'] === 'Draft Turn Started') {
      if (detail.teamId === this.teamId) await this.#draft(Number(detail.pick));
      return;
    }
    if (event['detail-type'] === 'Week Rolled Over') {
      await this.#offerTrade(Number(detail.week));
      return;
    }
    await this.#lineup(Number(detail.week));
  }

  async #call(name: string, input: Record<string, unknown>): Promise<Envelope> {
    this.actions[name] = (this.actions[name] ?? 0) + 1;
    const result = await this.run(name, { leagueId: this.#league?.id, ...input }, this.principal);
    if ('error' in result) this.refused.push({ operation: name, code: result.error.code });
    return result;
  }

  async #draft(pick: number): Promise<void> {
    const board = dataOf<Board>(await this.#call('get_draft_board', {}), 'get_draft_board');
    let made = await this.#call('make_draft_pick', { playerId: board.bestAvailable[0]?.player.id, pick });
    if ('error' in made && made.error.code === 'ROSTER_WOULD_BE_INVALID') {
      const need = board.yourNeeds[0] === 'W/R/T' ? 'WR' : board.yourNeeds[0];
      const forNeed = dataOf<Board>(
        await this.#call('get_draft_board', { position: need }),
        'get_draft_board'
      );
      made = await this.#call('make_draft_pick', { playerId: forNeed.bestAvailable[0]?.player.id, pick });
    }
    dataOf(made, 'make_draft_pick');
  }

  async #lineup(week: number): Promise<void> {
    const view = dataOf<RosterView>(
      await this.#call('get_roster', { teamId: this.teamId, week }),
      'get_roster'
    );
    const roster: RosterPlayer[] = view.players.map((p) => ({
      playerId: p.player.id,
      name: p.player.name,
      positions: [p.player.position],
      status: p.status,
      nflTeam: p.player.team
    }));
    const projections: Record<string, number> = {};
    const games: Record<string, { kickoff: string }> = {};
    for (const p of view.players) {
      if (p.projectedPoints !== null) projections[p.player.id] = p.projectedPoints;
      if (p.kickoff !== null && p.player.team !== null) games[p.player.team] = { kickoff: p.kickoff };
    }
    const current = view.players.map((p) => ({ playerId: p.player.id, slot: p.slot }));
    const context: LineupContext = { games, now: this.services.clock.now(), previousLineup: current };
    const best = optimizeLineup(
      (this.#league as { settings: LeagueSettings }).settings,
      roster,
      projections,
      context
    );
    const before = new Map(current.map((e) => [e.playerId, e.slot]));
    const moves = best.lineup.filter((e) => before.get(e.playerId) !== e.slot);
    if (moves.length === 0) return;
    dataOf(await this.#call('set_lineup', { teamId: this.teamId, week: view.week, moves }), 'set_lineup');
  }

  async #offerTrade(week: number): Promise<void> {
    const settings = (this.#league as { settings: LeagueSettings }).settings;
    if (week > settings.trades.deadlineWeek) return;
    const partner = `team-${2 + (week % (settings.teamCount - 1))}`;
    const bench = async (teamId: string) =>
      dataOf<RosterView>(await this.#call('get_roster', { teamId, week }), 'get_roster').players.filter(
        (p) => p.slot === 'BN'
      );
    const mine = await bench(this.teamId);
    const theirs = await bench(partner);
    const points = (p: RosterView['players'][number]) => p.projectedPoints ?? 0;
    const give = [...mine].sort((a, b) => points(a) - points(b));
    for (const offer of give) {
      const want = theirs
        .filter((p) => p.player.position === offer.player.position)
        .sort((a, b) => points(b) - points(a))[0];
      if (want === undefined) continue;
      await this.#call('propose_trade', {
        teamId: this.teamId,
        withTeamId: partner,
        send: [offer.player.id],
        receive: [want.player.id],
        message: 'Bench depth swap?'
      });
      return;
    }
  }

  /** The league it plays in, once created. */
  join(league: { id: string; settings: LeagueSettings }): void {
    this.#league = league;
  }
}
