import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeInfo } from '../chat/api';
import {
  connectLiveEvents,
  eventTarget,
  parseEventItem,
  useLiveEvents,
  type EventConnect,
  type LeagueEvent
} from './leagueEvents';

vi.mock('@readysetcloud/ui/auth', () => ({ getFreshIdToken: async () => 'id-token' }));

const events = vi.hoisted(() => ({
  calls: [] as { target: unknown; token: string; handlers: { onData(raw: string): void; onError(): void } }[],
  close: vi.fn()
}));
vi.mock('./appsyncEvents', () => ({
  subscribeChannels: async (
    target: unknown,
    token: string,
    handlers: { onData(raw: string): void; onError(): void }
  ) => {
    events.calls.push({ target, token, handlers });
    return events.close;
  }
}));

const INFO: RealtimeInfo = {
  enabled: true,
  httpHost: 'api.example',
  realtimeHost: 'realtime.example',
  channels: { league: '/fantasy/league/L1', global: '/fantasy/global' },
  refreshAt: null,
  pollIntervalSeconds: 5
};

afterEach(() => {
  vi.useRealTimers();
});

describe('league event helpers', () => {
  it('builds a target only from a complete config', () => {
    const endpoint = { httpHost: 'api.example', realtimeHost: 'realtime.example' };
    expect(eventTarget(INFO, false)).toEqual({ ...endpoint, channels: ['/fantasy/league/L1'] });
    expect(eventTarget(INFO, true)?.channels).toEqual(['/fantasy/league/L1', '/fantasy/global']);
    const withTeam = { ...INFO, channels: { ...INFO.channels!, team: '/fantasy/team/L1/team-1/k1' } };
    expect(eventTarget(withTeam, true)?.channels).toEqual([
      '/fantasy/league/L1',
      '/fantasy/team/L1/team-1/k1',
      '/fantasy/global'
    ]);
    expect(eventTarget({ ...INFO, channels: { ...INFO.channels!, team: null } }, false)?.channels).toEqual([
      '/fantasy/league/L1'
    ]);
    expect(eventTarget({ ...INFO, enabled: false }, false)).toBeNull();
    expect(eventTarget({ ...INFO, httpHost: null }, false)).toBeNull();
    expect(eventTarget({ ...INFO, realtimeHost: null }, false)).toBeNull();
    expect(eventTarget({ ...INFO, channels: null }, false)).toBeNull();
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

  it('subscribes to every channel on one connection, with the ID token, and closes it', async () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    const target = { httpHost: 'h', realtimeHost: 'r', channels: ['a', 'b'] };
    const close = await connectLiveEvents(target, { onEvent, onError });
    expect(events.calls[0]).toMatchObject({ target, token: 'id-token' });
    const { handlers } = events.calls[0]!;
    handlers.onData(JSON.stringify({ type: 'event', detailType: 'Scores Updated' }));
    handlers.onData('junk');
    handlers.onError();
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ detailType: 'Scores Updated', leagueId: null });
    expect(onError).toHaveBeenCalledOnce();
    close();
    expect(events.close).toHaveBeenCalledOnce();
  });

  it('lets a dev-build page script stand in for AppSync Events (the e2e suite pushes events this way)', async () => {
    const close = vi.fn();
    const standIn = vi.fn<EventConnect>(async () => close);
    window.__fantasyEvents = standIn;
    try {
      const target = { httpHost: 'h', realtimeHost: 'r', channels: ['a'] };
      const handlers = { onEvent: vi.fn(), onError: vi.fn() };
      expect(await connectLiveEvents(target, handlers)).toBe(close);
      expect(standIn).toHaveBeenCalledWith(target, handlers);
    } finally {
      delete window.__fantasyEvents;
    }
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
  it('polls when realtime is off or the config call fails', async () => {
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
    expect(connect.mock.calls[0]?.[0].channels).toEqual(['/fantasy/league/L1', '/fantasy/global']);
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

  it('closes a subscription that opens after unmount, and ignores a late config', async () => {
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

  it('asks for the config again before refreshAt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { connect, close } = fakeConnect();
    const realtime = vi.fn(async () => ({
      ...INFO,
      refreshAt: new Date(Date.now() + 120_000).toISOString()
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
