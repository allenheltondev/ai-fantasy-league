import type { AuthConfig } from '@readysetcloud/ui/auth';
import type { RuntimeConfig } from '../config/runtimeConfig';

/**
 * The auth package's configuration for this app's client.
 *
 * `sharedCookieDomain: ''` switches off the package's parent-domain session
 * bridge. On any *.readysetcloud.io host it otherwise defaults on, mirroring
 * the raw ID and refresh tokens into a JavaScript-readable `.readysetcloud.io`
 * cookie shared with sibling apps whose tokens are minted for other clients
 * (which this API would reject anyway). Same choice as llm-eval-harness: the
 * session stays on this origin (localStorage) only.
 */
export function toAuthConfig(config: RuntimeConfig): AuthConfig {
  return { region: config.region, clientId: config.clientId, sharedCookieDomain: '' };
}
