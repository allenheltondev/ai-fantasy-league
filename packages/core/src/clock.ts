/** Source of time for all domain and server code. Never read the wall clock directly. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date()
};

/** A clock pinned to a moment that tests and the simulator can advance. */
export class FixedClock implements Clock {
  #current: Date;

  constructor(start: Date | string) {
    this.#current = new Date(start);
  }

  now(): Date {
    return new Date(this.#current);
  }

  set(to: Date | string): void {
    this.#current = new Date(to);
  }

  advance(ms: number): void {
    this.#current = new Date(this.#current.getTime() + ms);
  }
}
