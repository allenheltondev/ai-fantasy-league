import { createContext, useContext } from 'react';
import type { RuntimeConfig } from './runtimeConfig';

export interface AppConfig {
  /** Null when this environment published no sign-in configuration. */
  auth: RuntimeConfig | null;
}

export const ConfigContext = createContext<AppConfig>({ auth: null });

export function useAppConfig(): AppConfig {
  return useContext(ConfigContext);
}
