import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto';
import type { Realtime, RealtimeEndpoint, RealtimeMessage } from './realtime.js';

/**
 * AWS AppSync Events (docs/adr, ADR 010). The relay publishes over the Event
 * API's HTTP endpoint (`POST https://<http domain>/event`), signed with the function's IAM role
 * (SigV4, service `appsync`); browsers subscribe over the WebSocket endpoint with their Cognito ID
 * token. Signing and the HTTP call sit behind small seams so the publisher is testable offline.
 */

/** Signs one request and returns the headers to send with it. */
export type RequestSigner = (request: {
  hostname: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<Record<string, string>>;

export type HttpPost = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class AppSyncEventsRealtime implements Realtime {
  constructor(
    private readonly options: { endpoint: RealtimeEndpoint; sign: RequestSigner; post?: HttpPost }
  ) {}

  endpoint(): RealtimeEndpoint {
    return this.options.endpoint;
  }

  async publish(channel: string, message: RealtimeMessage): Promise<void> {
    const hostname = this.options.endpoint.httpHost;
    // Each event is a JSON string; subscribers receive it as published.
    const body = JSON.stringify({ channel, events: [JSON.stringify(message)] });
    const signed = await this.options.sign({
      hostname,
      path: '/event',
      headers: { 'content-type': 'application/json', host: hostname },
      body
    });
    // `host` is signed, and fetch sends the same value from the URL.
    const { host: _host, ...headers } = signed;
    const post = this.options.post ?? (fetch as HttpPost);
    const response = await post(`https://${hostname}/event`, { method: 'POST', headers, body });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `AppSync Events publish to ${channel} failed: HTTP ${response.status} ${text.slice(0, 200)}`
      );
    }
    // A 200 can still report the event as failed.
    const failed = parseFailed(text);
    if (failed.length > 0) {
      throw new Error(
        `AppSync Events refused the publish to ${channel}: ${JSON.stringify(failed).slice(0, 200)}`
      );
    }
  }
}

function parseFailed(text: string): unknown[] {
  try {
    const value = JSON.parse(text) as { failed?: unknown } | null;
    return Array.isArray(value?.failed) ? value.failed : [];
  } catch {
    return [];
  }
}

/** What the signer hashes: text or bytes. */
type SourceData = string | ArrayBuffer | ArrayBufferView;

const bytes = (data: SourceData): string | Uint8Array =>
  typeof data === 'string'
    ? data
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);

/** SHA-256 (or its HMAC, given a secret) for the SigV4 signer, on node:crypto. */
export class NodeSha256 {
  #hash: Hash | Hmac;

  constructor(secret?: SourceData) {
    this.#hash = secret === undefined ? createHash('sha256') : createHmac('sha256', bytes(secret));
  }

  update(data: SourceData): void {
    this.#hash.update(bytes(data));
  }

  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.#hash.digest());
  }
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Signs with the Lambda role's credentials (the default provider chain). The signer is built on
 * first use, so the API (which never publishes) does not load it.
 */
export function sigV4Signer(options: {
  region: string;
  /** Test seams: fixed credentials and signing time. */
  credentials?: () => Promise<AwsCredentials>;
  now?: () => Date;
}): RequestSigner {
  let signer: Promise<import('@smithy/signature-v4').SignatureV4> | null = null;
  const load = async () => {
    const { SignatureV4 } = await import('@smithy/signature-v4');
    const credentials =
      options.credentials ?? (await import('@aws-sdk/credential-provider-node')).defaultProvider();
    return new SignatureV4({ service: 'appsync', region: options.region, credentials, sha256: NodeSha256 });
  };
  return async ({ hostname, path, headers, body }) => {
    signer ??= load();
    const signed = await (
      await signer
    ).sign(
      { method: 'POST', protocol: 'https:', hostname, path, headers, body, query: {} },
      options.now === undefined ? {} : { signingDate: options.now() }
    );
    return signed.headers;
  };
}
