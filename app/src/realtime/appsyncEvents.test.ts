import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVENTS_SUBPROTOCOL,
  authSubprotocol,
  base64Url,
  subscribeChannels,
  type SocketLike
} from './appsyncEvents';

/** A WebSocket stand-in: records what the client sends, and lets the test play the server. */
class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  closed: number | undefined | null = null;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  onclose: SocketLike['onclose'] = null;
  failSend = false;
  failClose = false;

  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {}

  send(data: string) {
    if (this.failSend) throw new Error('not open');
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number) {
    this.closed = code;
    if (this.failClose) throw new Error('already closed');
  }

  open() {
    this.onopen?.({});
  }

  receive(message: unknown) {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  sentOfType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

const target = {
  httpHost: 'abc.appsync-api.us-east-1.amazonaws.com',
  realtimeHost: 'abc.realtime',
  channels: ['/fantasy/league/L1', '/fantasy/global']
};

function connect(channels = target.channels, options: { timeoutMs?: number } = {}) {
  let socket: FakeSocket | null = null;
  let n = 0;
  const handlers = { onData: vi.fn(), onError: vi.fn() };
  const opened = subscribeChannels({ ...target, channels }, 'id.token.sig', handlers, {
    socket: (url, protocols) => (socket = new FakeSocket(url, protocols)),
    newId: () => `sub-${++n}`,
    ...options
  });
  return { opened, handlers, socket: socket as unknown as FakeSocket };
}

/** Opens, acks, and confirms every subscription. */
async function live(channels = target.channels) {
  const c = connect(channels);
  c.socket.open();
  c.socket.receive({ type: 'connection_ack', connectionTimeoutMs: 300_000 });
  for (const s of c.socket.sentOfType('subscribe')) c.socket.receive({ type: 'subscribe_success', id: s.id });
  return { ...c, close: await c.opened };
}

const decode = (protocol: string) =>
  JSON.parse(atob(protocol.slice('header-'.length).replace(/-/g, '+').replace(/_/g, '/'))) as unknown;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('base64Url', () => {
  it('encodes UTF-8 without padding or URL-unsafe characters', () => {
    expect(base64Url('a')).toBe('YQ');
    expect(base64Url('??>')).toBe('Pz8-');
    expect(base64Url('é')).toBe('w6k');
    expect(base64Url('ÿÿÿ?')).toBe('w7_Dv8O_Pw');
  });
});

describe('subscribeChannels', () => {
  it('connects with the event subprotocol and the ID token, then subscribes to every channel', async () => {
    const { socket, opened, handlers } = connect();
    expect(socket.url).toBe('wss://abc.realtime/event/realtime');
    expect(socket.protocols[0]).toBe(EVENTS_SUBPROTOCOL);
    expect(socket.protocols[1]).toBe(authSubprotocol(target.httpHost, 'id.token.sig'));
    expect(decode(socket.protocols[1] as string)).toEqual({
      host: target.httpHost,
      Authorization: 'id.token.sig'
    });
    socket.open();
    expect(socket.sent).toEqual([{ type: 'connection_init' }]);
    socket.receive({ type: 'connection_ack', connectionTimeoutMs: 300_000 });
    const authorization = { host: target.httpHost, Authorization: 'id.token.sig' };
    expect(socket.sentOfType('subscribe')).toEqual([
      { type: 'subscribe', id: 'sub-1', channel: '/fantasy/league/L1', authorization },
      { type: 'subscribe', id: 'sub-2', channel: '/fantasy/global', authorization }
    ]);
    // Live only once every subscription is confirmed.
    let resolved = false;
    void opened.then(() => (resolved = true));
    socket.receive({ type: 'subscribe_success', id: 'sub-1' });
    await Promise.resolve();
    expect(resolved).toBe(false);
    socket.receive({ type: 'subscribe_success', id: 'sub-2' });
    await opened;
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it('passes on published events for its subscriptions, and ignores everything else', async () => {
    const { socket, handlers } = await live();
    // AWS sends `event` as an array of the published event strings.
    socket.receive({
      type: 'data',
      id: 'sub-1',
      event: [
        '{"type":"event","detailType":"Draft Pick Made"}',
        '{"type":"event","detailType":"Draft Turn Started"}'
      ]
    });
    socket.receive({ type: 'data', id: 'sub-2', event: ['{"type":"chat"}'] });
    // A lone string or object is unwrapped the same way.
    socket.receive({ type: 'data', id: 'sub-2', event: '{"type":"chat","n":2}' });
    socket.receive({ type: 'data', id: 'sub-2', event: { type: 'chat', n: 3 } });
    socket.receive({ type: 'data', id: 'someone-else', event: '{}' });
    socket.receive({ type: 'data', event: '{}' });
    socket.receive({ type: 'ka' });
    socket.receive({ type: 'unsubscribe_success', id: 'sub-1' });
    socket.receive('not json');
    expect(handlers.onData.mock.calls).toEqual([
      ['{"type":"event","detailType":"Draft Pick Made"}'],
      ['{"type":"event","detailType":"Draft Turn Started"}'],
      ['{"type":"chat"}'],
      ['{"type":"chat","n":2}'],
      ['{"type":"chat","n":3}']
    ]);
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it('unsubscribes and closes the socket on close, once', async () => {
    const { socket, close } = await live();
    close();
    expect(socket.sentOfType('unsubscribe')).toEqual([
      { type: 'unsubscribe', id: 'sub-1' },
      { type: 'unsubscribe', id: 'sub-2' }
    ]);
    expect(socket.closed).toBe(1000);
    expect(socket.onmessage).toBeNull();
    close();
    expect(socket.sentOfType('unsubscribe')).toHaveLength(2);
  });

  it('closes quietly when the socket is already gone', async () => {
    const { socket, close } = await live();
    socket.failSend = true;
    socket.failClose = true;
    expect(() => close()).not.toThrow();
    expect(socket.closed).toBe(1000);
  });

  it('rejects, and closes the socket, when a subscribe or the connection is refused', async () => {
    const refused = connect();
    refused.socket.open();
    refused.socket.receive({ type: 'connection_ack' });
    refused.socket.receive({ type: 'subscribe_success', id: 'sub-1' });
    refused.socket.receive({
      type: 'subscribe_error',
      id: 'sub-2',
      errors: [{ errorType: 'UnauthorizedException' }]
    });
    await expect(refused.opened).rejects.toThrow(/Could not subscribe/);
    expect(refused.socket.closed).toBe(1000);

    const denied = connect();
    denied.socket.open();
    denied.socket.receive({ type: 'connection_error', errors: [{ errorType: 'UnauthorizedException' }] });
    await expect(denied.opened).rejects.toThrow(/Could not subscribe/);

    const dropped = connect();
    dropped.socket.onclose?.({});
    await expect(dropped.opened).rejects.toThrow(/Could not subscribe/);
    expect(dropped.handlers.onError).not.toHaveBeenCalled();
  });

  it('gives up when connecting takes too long', async () => {
    vi.useFakeTimers();
    const slow = connect(target.channels, { timeoutMs: 1000 });
    slow.socket.open();
    vi.advanceTimersByTime(1000);
    await expect(slow.opened).rejects.toThrow(/Could not subscribe/);
  });

  it('reports a dropped connection, an error, or a missed keep-alive once', async () => {
    const dropped = await live();
    dropped.socket.onerror?.({});
    dropped.socket.onclose?.({});
    expect(dropped.handlers.onError).toHaveBeenCalledOnce();
    expect(dropped.socket.closed).toBe(1000);

    const errored = await live();
    errored.socket.receive({ type: 'error', errors: [] });
    expect(errored.handlers.onError).toHaveBeenCalledOnce();

    vi.useFakeTimers();
    const quiet = connect();
    quiet.socket.open();
    quiet.socket.receive({ type: 'connection_ack', connectionTimeoutMs: 10_000 });
    for (const s of quiet.socket.sentOfType('subscribe'))
      quiet.socket.receive({ type: 'subscribe_success', id: s.id });
    await quiet.opened;
    vi.advanceTimersByTime(9_000);
    quiet.socket.receive({ type: 'ka' });
    vi.advanceTimersByTime(9_000);
    expect(quiet.handlers.onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(quiet.handlers.onError).toHaveBeenCalledOnce();
  });

  it('is live at once with no channels, and uses the browser WebSocket and random ids by default', async () => {
    const empty = connect([]);
    empty.socket.open();
    empty.socket.receive({ type: 'connection_ack', connectionTimeoutMs: 0 });
    await expect(empty.opened).resolves.toBeTypeOf('function');

    const sockets: FakeSocket[] = [];
    vi.stubGlobal(
      'WebSocket',
      class extends FakeSocket {
        constructor(url: string, protocols: string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      }
    );
    const opened = subscribeChannels({ ...target, channels: ['/fantasy/global'] }, 't', {
      onData: vi.fn(),
      onError: vi.fn()
    });
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ type: 'connection_ack' });
    const [subscribe] = socket.sentOfType('subscribe');
    expect(subscribe?.id).toMatch(/^[0-9a-f-]{36}$/);
    socket.receive({ type: 'subscribe_success', id: subscribe?.id });
    (await opened)();
    expect(socket.closed).toBe(1000);
  });
});
