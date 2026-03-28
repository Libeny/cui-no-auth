/**
 * Configuration types for CUI
 */
import { RouterConfiguration } from './router-config.js';

export interface EnvPreset {
  id: string;           // uuid
  name: string;         // e.g. "Clash", "Corporate VPN"
  proxy?: string;       // e.g. http://127.0.0.1:7897
  noProxy?: string;     // e.g. localhost,127.0.0.1
  envVars?: Record<string, string>;  // e.g. { ANTHROPIC_BASE_URL: "..." }
}

export interface ServerConfig {
  host: string;
  port: number;
}

export interface GeminiConfig {
  /**
   * Google API key for Gemini
   * Can also be set via GOOGLE_API_KEY environment variable
   */
  apiKey?: string;

  /**
   * Gemini model to use
   * Default: 'gemini-2.5-flash'
   */
  model?: string;
}

/**
 * Supported ASR (Automatic Speech Recognition) providers
 */
export type ASRProvider = 'gemini' | 'glm';

/**
 * ASR configuration for voice input
 */
export interface ASRConfig {
  /**
   * ASR provider to use
   * Default: 'gemini'
   */
  provider?: ASRProvider;

  /**
   * API key for the selected provider
   * - For 'gemini': Can also be set via GOOGLE_API_KEY environment variable
   * - For 'glm': Can also be set via ZHIPUAI_API_KEY environment variable
   */
  apiKey?: string;

  /**
   * Model to use for transcription
   * - For 'gemini': Default 'gemini-2.5-flash'
   * - For 'glm': Default 'glm-asr-2512'
   */
  model?: string;
}

export interface InterfaceConfig {
  colorScheme: 'light' | 'dark' | 'system';
  language: string;
  notifications?: {
    enabled: boolean;
    ntfyUrl?: string;
    webPush?: {
      subject?: string; // e.g. mailto:you@example.com
      vapidPublicKey?: string;
      vapidPrivateKey?: string;
    };
  };
}

export interface CUIConfig {
  /**
   * Unique machine identifier
   * Format: {hostname}-{16char_hash}
   * Example: "wenbomacbook-a1b2c3d4e5f6g7h8"
   */
  machine_id: string;
  
  /**
   * Server configuration
   */
  server: ServerConfig;

  /**
   * Authentication token for API access
   * 32-character random string generated on first run
   */
  authToken: string;

  /**
   * Gemini API configuration (optional)
   * @deprecated Use 'asr' configuration instead
   */
  gemini?: GeminiConfig;

  /**
   * ASR (Automatic Speech Recognition) configuration (optional)
   * Configures voice input transcription service
   */
  asr?: ASRConfig;

  /**
   * Optional router configuration for Claude Code Router
   */
  router?: RouterConfiguration;

  /**
   * Interface preferences and settings
   */
  interface: InterfaceConfig;

  /**
   * Environment presets for proxy/env configuration
   */
  envPresets?: EnvPreset[];
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Omit<CUIConfig, 'machine_id' | 'authToken'> = {
  server: {
    host: 'localhost',
    port: 3001
  },
  interface: {
    colorScheme: 'system',
    language: 'en'
  }
};