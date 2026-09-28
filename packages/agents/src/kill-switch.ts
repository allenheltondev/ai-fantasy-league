import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { Clock } from '@fantasy/core';
import type { Logger } from '@fantasy/server';

/**
 * The global kill switch (issue #93): an SSM parameter that puts every agent into deterministic
 * mode. Values `on`, `true`, `1`, or `engaged` (any case) turn it on; anything else is off.
 * If the parameter can't be read the switch fails closed (on): spend is the thing it guards.
 */
export interface KillSwitch {
  engaged(): Promise<boolean>;
}

export const OFF_SWITCH: KillSwitch = { engaged: async () => false };

export function isEngagedValue(value: string | undefined): boolean {
  return value !== undefined && ['on', 'true', '1', 'engaged'].includes(value.trim().toLowerCase());
}

export interface ParameterReader {
  read(name: string): Promise<string | undefined>;
}

export function ssmParameterReader(client: SSMClient = new SSMClient({})): ParameterReader {
  return {
    async read(name) {
      const result = await client.send(new GetParameterCommand({ Name: name }));
      return result.Parameter?.Value;
    }
  };
}

/** Reads the parameter at most once per `ttlMs` per container. */
export class ParameterKillSwitch implements KillSwitch {
  #cached: { value: boolean; at: number } | null = null;

  constructor(
    private readonly options: {
      name: string;
      reader: ParameterReader;
      clock: Clock;
      log: Logger;
      ttlMs?: number;
    }
  ) {}

  async engaged(): Promise<boolean> {
    const now = this.options.clock.now().getTime();
    const ttl = this.options.ttlMs ?? 60_000;
    if (this.#cached !== null && now - this.#cached.at < ttl) return this.#cached.value;
    let value: boolean;
    try {
      value = isEngagedValue(await this.options.reader.read(this.options.name));
    } catch (error) {
      this.options.log.warn('kill switch unreadable; failing closed', {
        parameter: this.options.name,
        error
      });
      value = true;
    }
    this.#cached = { value, at: now };
    return value;
  }
}
