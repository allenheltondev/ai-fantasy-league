/**
 * A small AWS AppSync Events WebSocket client, written to the documented protocol, for the channels
 * get_realtime_config hands out. Loaded on demand (only when realtime is on), so local dev and e2e
 * never fetch it.
 *
 * - Connect to `wss://<realtimeHost>/event/realtime` with the subprotocols `aws-appsync-event-ws`
 *   and `header-<base64url({ host, Authorization })>`, the caller's Cognito ID token.
 * - Send `connection_init`; the server answers `connection_ack` with `connectionTimeoutMs`, then
 *   keeps the connection alive with `ka` messages.
 * - Subscribe to each channel (`subscribe` with an `id`, the `channel`, and the same
 *   `authorization`); each answers `subscribe_success` or `subscribe_error`. The server checks every
 *   subscribe against current league membership, so a refusal is final for this socket.
 * - `data` messages carry the published events for a subscription `id`: `event` is an array of
 *   JSON strings, one per published event (a lone string or object is accepted too).
 * - Closing sends `unsubscribe` for each subscription, then closes the socket.
 *
 * Any failure before every subscription is in place rejects; any failure after (a dropped
 * connection, a missed keep-alive, an error message) calls `onError` once, and callers fall back
 * to polling.
 */

export interface EventsTarget {
  /** The Event API HTTP domain: the `host` in every authorization. */
  httpHost: string;
  /** The Event API WebSocket domain. */
  realtimeHost: string;
  channels: string[];
}

export interface EventsHandlers {
  /** One published event, as the JSON text the server published. */
  onData(raw: string): void;
  onError(): void;
}

/** The parts of a WebSocket the client uses, so tests can pass a fake. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

export interface EventsOptions {
  socket?: SocketFactory;
  /** How long connecting and subscribing may take. */
  timeoutMs?: number;
  newId?: () => string;
}

export const EVENTS_SUBPROTOCOL = 'aws-appsync-event-ws';
const CONNECT_TIMEOUT_MS = 15_000;
/** Used until `connection_ack` says otherwise. */
const DEFAULT_KEEPALIVE_MS = 300_000;

/** UTF-8 text as unpadded base64url. */
export function base64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The authorization AppSync Events reads: the API's HTTP domain and the Cognito ID token. */
export function authorization(httpHost: string, token: string): { host: string; Authorization: string } {
  return { host: httpHost, Authorization: token };
}

/** The subprotocol that carries the authorization when the socket opens. */
export function authSubprotocol(httpHost: string, token: string): string {
  return `header-${base64Url(JSON.stringify(authorization(httpHost, token)))}`;
}

// A browser WebSocket has these members (its handlers take narrower events than the fakes pass).
const browserSocket: SocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as SocketLike;

interface Message {
  type?: unknown;
  id?: unknown;
  event?: unknown;
  connectionTimeoutMs?: unknown;
}

/** Opens one connection, subscribes to every channel, and resolves to a function that closes it. */
export function subscribeChannels(
  target: EventsTarget,
  token: string,
  handlers: EventsHandlers,
  options: EventsOptions = {}
): Promise<() => void> {
  const auth = authorization(target.httpHost, token);
  const newId = options.newId ?? (() => crypto.randomUUID());
  const socket = (options.socket ?? browserSocket)(`wss://${target.realtimeHost}/event/realtime`, [
    EVENTS_SUBPROTOCOL,
    authSubprotocol(target.httpHost, token)
  ]);
  const ids = new Map(target.channels.map((channel) => [newId(), channel]));
  const pending = new Set(ids.keys());

  return new Promise((resolve, reject) => {
    let state: 'connecting' | 'live' | 'done' = 'connecting';
    let keepalive: ReturnType<typeof setTimeout> | null = null;
    let keepaliveMs = DEFAULT_KEEPALIVE_MS;
    const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
    const stopTimers = () => {
      clearTimeout(connectTimer);
      if (keepalive !== null) clearTimeout(keepalive);
    };
    const shut = () => {
      state = 'done';
      stopTimers();
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close(1000);
      } catch {
        // Already closed.
      }
    };
    const fail = () => {
      if (state === 'done') return;
      const wasLive = state === 'live';
      shut();
      if (wasLive) handlers.onError();
      else reject(new Error('Could not subscribe to live updates.'));
    };
    const alive = () => {
      if (keepalive !== null) clearTimeout(keepalive);
      keepalive = setTimeout(fail, keepaliveMs);
    };
    const connectTimer = setTimeout(fail, options.timeoutMs ?? CONNECT_TIMEOUT_MS);

    socket.onopen = () => send({ type: 'connection_init' });
    socket.onerror = fail;
    socket.onclose = fail;
    socket.onmessage = ({ data }) => {
      let message: Message;
      try {
        message = JSON.parse(String(data)) as Message;
      } catch {
        return;
      }
      switch (message.type) {
        case 'connection_ack':
          if (typeof message.connectionTimeoutMs === 'number' && message.connectionTimeoutMs > 0) {
            keepaliveMs = message.connectionTimeoutMs;
          }
          alive();
          for (const [id, channel] of ids) send({ type: 'subscribe', id, channel, authorization: auth });
          if (ids.size === 0) live();
          return;
        case 'ka':
          alive();
          return;
        case 'subscribe_success':
          if (typeof message.id === 'string') pending.delete(message.id);
          if (pending.size === 0 && state === 'connecting') live();
          return;
        case 'data':
          if (state === 'live' && typeof message.id === 'string' && ids.has(message.id)) {
            const events = Array.isArray(message.event) ? message.event : [message.event];
            for (const event of events)
              handlers.onData(typeof event === 'string' ? event : JSON.stringify(event));
          }
          return;
        // A refused connection or subscribe, an event AppSync could not deliver (polling catches up
        // on what was missed), or any other server error.
        case 'connection_error':
        case 'subscribe_error':
        case 'broadcast_error':
        case 'error':
          fail();
          return;
        default:
          // unsubscribe_success, and anything newer than this client.
          return;
      }
    };

    function live() {
      state = 'live';
      clearTimeout(connectTimer);
      resolve(() => {
        if (state === 'done') return;
        for (const id of ids.keys()) {
          try {
            send({ type: 'unsubscribe', id });
          } catch {
            // The socket is going away anyway.
          }
        }
        shut();
      });
    }
  });
}
