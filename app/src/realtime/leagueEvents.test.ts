import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeInfo } from '../chat/api';
import {
  connectMomentoEvents,
  eventTarget,
  parseEventItem,
  useLiveEvents,
  type EventConnect,
  type LeagueEvent
} from './leagueEvents';

vi.mock('@gomomento/sdk-web', () => {
  class Subscription {
    unsubscribe = vi.fn();
  }
  const state: {
    failTopic: string | null;
    options: Record<string, { onItem(item: { valueString(): string }): void; onError(): void }>;
    subs: Subscription[];
  } = { failTopic: null, options: {}, subs: [] };
  return {
    __state: state,
    TopicConfigurations: { Browser: { latest: () => 'browser' } },
    CredentialProvider: { fromDisposableToken: (p: unknown) => ({ disposable: p }) },
    TopicSubscribe: { Subscription },
    TopicClient: class {
      async subscribe(_cache: string, topic: string, options: (typeof state.options)[string]) {
        state.options[topic] = options;
        if (topic === state.failTopic) return { error: true };
        const sub = new Subscription();
        state.subs.push(sub);
        return sub;
      }
    }
  };
});

const INFO: RealtimeInfo = {
  enabled: true,
  token: 't',
  endpoint: null,
  cacheName: 'c',
  topics: { league: 'fantasy.league.L1', global: 'fantasy.global' },
  expiresAt: null,
  pollIntervalSeconds: 5
};

afterEach(() => {
  vi.useRealTimers();
});

describe('league event helpers', () => {
  it('builds a target only from a complete token', () => {
    expect(eventTarget(INFO, false)).toEqual({ token: 't', cacheName: 'c', topics: ['fantasy.league.L1'] });
    expect(eventTarget(INFO, true)?.topics).toEqual(['fantasy.league.L1', 'fantasy.global']);
    const withTeam = { ...INFO, topics: { ...INFO.topics!, team: 'fantasy.team.L1.team-1' } };
    expect(eventTarget(withTeam, true)?.topics).toEqual([
      'fantasy.league.L1',
      'fantasy.team.L1.team-1',
      'fantasy.global'
    ]);
    expect(eventTarget({ ...INFO, topics: { ...INFO.topics!, team: null } }, false)?.topics).toEqual([
      'fantasy.league.L1'
    ]);
    expect(eventTarget({ ...INFO, enabled: false }, false)).toBeNull();
    expect(eventTarget({ ...INFO, token: null }, false)).toBeNull();
    expect(eventTarget({ ...INFO, cacheName: null }, false)).toBeNull();
    expect(eventTarget({ ...INFO, topics: null }, false)).toBeNull();
  });

  it('reads league events and ignores chat and junk', () => {
    expect(
      parseEventItem(JSON.stringify({ type: 'event', detailType: 'Draft Pick Made', leagueId: 'L1' }))
    ).toEqual({ detailType: 'Draft Pick Made', leagueId: 'L1' });
    expect(
      parseEventItem(JSON.stringify({ type: 'event', detailType: 'Scores Updated', leagueId: null }))
    ).toEqual({
      detailType: 'Scores Updated',
      leagueId: null
    });
    expect(parseEventItem(JSON.stringify({ type: 'chat', message: {} }))).toBeNull();
    expect(parseEventItem(JSON.stringify({ type: 'event' }))).toBeNull();
    expect(parseEventItem('nope')).toBeNull();
  });

  it('subscribes to every topic and closes them together', async () => {
    const sdk = (await import('@gomomento/sdk-web')) as unknown as {
      __state: {
        failTopic: string | null;
        options: Record<string, { onItem(item: { valueString(): string }): void; onError(): void }>;
        subs: { unsubscribe: () => void }[];
      };
    };
    const onEvent = vi.fn();
    const onError = vi.fn();
    const close = await connectMomentoEvents(
      { token: 't', cacheName: 'c', topics: ['a', 'b'] },
      { onEvent, onError }
    );
    sdk.__state.options.b!.onItem({
      valueString: () => JSON.stringify({ type: 'event', detailType: 'Scores Updated' })
    });
    sdk.__state.options.a!.onItem({ valueString: () => JSON.stringify({ type: 'chat' }) });
    sdk.__state.options.a!.onError();
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ detailType: 'Scores Updated', leagueId: null });
    expect(onError).toHaveBeenCalledOnce();
    close();
    expect(sdk.__state.subs.every((s) => vi.mocked(s.unsubscribe).mock.calls.length === 1)).toBe(true);

    sdk.__state.subs = [];
    sdk.__state.failTopic = 'b';
    await expect(
      connectMomentoEvents({ token: 't', cacheName: 'c', topics: ['a', 'b'] }, { onEvent, onError })
    ).rejects.toThrow(/Could not subscribe/);
    // The first topic's subscription is closed when the second fails.
    expect(sdk.__state.subs[0]?.unsubscribe).toHaveBeenCalled();
  });
});

function fakeConnect() {
  const handlers: { onEvent?: (e: LeagueEvent) => void; onError?: () => void } = {};
  const close = vi.fn();
  const connect = vi.fn<EventConnect>(async (_target, h) => {
    handlers.onEvent = h.onEvent;
    handlers.onError = h.onError;
    return close;
  });
  return { connect, handlers, close };
}

const TYPES = ['Draft Pick Made'];

describe('useLiveEvents', () => {
  it('polls when realtime is off or the token call fails', async () => {
    const { connect } = fakeConnect();
    const off = renderHook(() =>
      useLiveEvents({
        leagueId: 'L1',
        types: TYPES,
        realtime: async () => ({ ...INFO, enabled: false }),
        connect,
        onEvent: vi.fn()
      })
    );
    expect(off.result.current).toBe('loading');
    await waitFor(() => expect(off.result.current).toBe('polling'));
    const failed = renderHook(() =>
      useLiveEvents({
        leagueId: 'L1',
        types: TYPES,
        realtime: () => Promise.reject(new Error('offline')),
        connect,
        onEvent: vi.fn()
      })
    );
    await waitFor(() => expect(failed.result.current).toBe('polling'));
    expect(connect).not.toHaveBeenCalled();
  });

  it('goes live and passes on only the wanted events for this league', async () => {
    const { connect, handlers, close } = fakeConnect();
    const onEvent = vi.fn();
    const hook = renderHook(() =>
      useLiveEvents({
        leagueId: 'L1',
        types: TYPES,
        global: true,
        realtime: async () => INFO,
        connect,
        onEvent
      })
    );
    await waitFor(() => expect(hook.result.current).toBe('live'));
    expect(connect.mock.calls[0]?.[0].topics).toEqual(['fantasy.league.L1', 'fantasy.global']);
    handlers.onEvent!({ detailType: 'Draft Pick Made', leagueId: 'L1' });
    handlers.onEvent!({ detailType: 'Draft Pick Made', leagueId: null });
    handlers.onEvent!({ detailType: 'Draft Pick Made', leagueId: 'L2' });
    handlers.onEvent!({ detailType: 'Waivers Processed', leagueId: 'L1' });
    expect(onEvent).toHaveBeenCalledTimes(2);
    act(() => handlers.onError!());
    expect(hook.result.current).toBe('polling');
    expect(close).toHaveBeenCalledOnce();
    hook.unmount();
    // A late error from a closed subscription is harmless.
    handlers.onError!();
    expect(close).toHaveBeenCalledOnce();
  });

  it('falls back to polling when the subscription fails', async () => {
    const connect = vi.fn<EventConnect>(() => Promise.reject(new Error('no')));
    const hook = renderHook(() =>
      useLiveEvents({ leagueId: 'L1', types: TYPES, realtime: async () => INFO, connect, onEvent: vi.fn() })
    );
    await waitFor(() => expect(hook.result.current).toBe('polling'));
  });

  it('closes a subscription that opens after unmount, and ignores a late token', async () => {
    const { connect, close } = fakeConnect();
    let resolveInfo: (info: RealtimeInfo) => void = () => undefined;
    const late = renderHook(() =>
      useLiveEvents({
        leagueId: 'L1',
        types: TYPES,
        realtime: () => new Promise((resolve) => (resolveInfo = resolve)),
        connect,
        onEvent: vi.fn()
      })
    );
    late.unmount();
    resolveInfo(INFO);
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();

    let openConnection: () => void = () => undefined;
    const slow = vi.fn<EventConnect>(() => new Promise((resolve) => (openConnection = () => resolve(close))));
    const hook = renderHook(() =>
      useLiveEvents({
        leagueId: 'L1',
        types: TYPES,
        realtime: async () => INFO,
        connect: slow,
        onEvent: vi.fn()
      })
    );
    await waitFor(() => expect(slow).toHaveBeenCalled());
    hook.unmount();
    openConnection();
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it('renews the token before it expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { connect, close } = fakeConnect();
    const realtime = vi.fn(async () => ({
      ...INFO,
      expiresAt: new Date(Date.now() + 120_000).toISOString()
    }));
    const hook = renderHook(() =>
      useLiveEvents({ leagueId: 'L1', types: TYPES, realtime, connect, onEvent: vi.fn() })
    );
    await waitFor(() => expect(hook.result.current).toBe('live'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(close).toHaveBeenCalledOnce();
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    hook.unmount();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
