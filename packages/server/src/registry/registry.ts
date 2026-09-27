import type { AnyOperation } from './operation.js';

export interface Registry {
  readonly operations: readonly AnyOperation[];
  get(name: string): AnyOperation | undefined;
}

/** Collects operations and rejects duplicate names or routes. */
export function createRegistry(operations: readonly AnyOperation[]): Registry {
  const byName = new Map<string, AnyOperation>();
  const routes = new Set<string>();
  for (const op of operations) {
    if (byName.has(op.name)) throw new Error(`Duplicate operation name "${op.name}"`);
    const route = `${op.method} ${op.path.replace(/\{[^}]+\}/g, '{}')}`;
    if (routes.has(route)) throw new Error(`Duplicate route ${op.method} ${op.path} (${op.name})`);
    byName.set(op.name, op);
    routes.add(route);
  }
  return {
    operations: [...operations].sort((a, b) => a.name.localeCompare(b.name)),
    get: (name) => byName.get(name)
  };
}
