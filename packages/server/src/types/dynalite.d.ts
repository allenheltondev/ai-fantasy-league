declare module 'dynalite' {
  import type { Server } from 'node:http';

  interface DynaliteOptions {
    createTableMs?: number;
    deleteTableMs?: number;
    updateTableMs?: number;
    maxItemSizeKb?: number;
    path?: string;
  }

  export default function dynalite(options?: DynaliteOptions): Server;
}
