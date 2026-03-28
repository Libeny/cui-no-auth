import type { EnvPreset } from '../types/config.js';

/**
 * Expand an EnvPreset into a flat Record of environment variables.
 * Proxy URL is mapped to all common proxy env vars (both lower and upper case).
 */
export function expandPreset(preset: EnvPreset): Record<string, string> {
  const env: Record<string, string> = {};

  if (preset.proxy) {
    env.http_proxy = preset.proxy;
    env.https_proxy = preset.proxy;
    env.all_proxy = preset.proxy;
    env.HTTP_PROXY = preset.proxy;
    env.HTTPS_PROXY = preset.proxy;
  }

  if (preset.noProxy) {
    env.no_proxy = preset.noProxy;
    env.NO_PROXY = preset.noProxy;
  }

  if (preset.envVars) {
    Object.assign(env, preset.envVars);
  }

  return env;
}

/**
 * Sensitive key patterns that should be masked in logs
 */
const SENSITIVE_PATTERNS = [/KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /CREDENTIAL/i];

/**
 * Return a safe-to-log version of env overrides, masking sensitive values.
 */
export function safeLogEnvOverrides(env: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_PATTERNS.some(pattern => pattern.test(key))) {
      safe[key] = value ? `${value.substring(0, 4)}****` : '';
    } else {
      safe[key] = value;
    }
  }
  return safe;
}
