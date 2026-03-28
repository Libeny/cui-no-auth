import { GeminiService } from './gemini-service.js';
import { GLMASRService } from './glm-asr-service.js';
import { ConfigService } from './config-service.js';
import { createLogger, type Logger } from './logger.js';
import type { ASRProvider } from '@/types/config.js';

/**
 * Common interface for all ASR services
 */
export interface ASRTranscribeResponse {
  text: string;
}

export interface ASRHealthResponse {
  status: 'healthy' | 'unhealthy';
  message: string;
  apiKeyValid: boolean;
  provider?: ASRProvider;
}

/**
 * ASR Service Manager
 * Manages ASR providers and routes requests to the appropriate service
 */
export class ASRService {
  private logger: Logger;
  private geminiService: GeminiService;
  private glmASRService: GLMASRService;
  private provider: ASRProvider;

  constructor(geminiService: GeminiService, glmASRService: GLMASRService) {
    this.logger = createLogger('ASRService');
    this.geminiService = geminiService;
    this.glmASRService = glmASRService;
    this.provider = 'gemini'; // default
  }

  async initialize(): Promise<void> {
    const config = ConfigService.getInstance().getConfig();

    // Determine which provider to use
    // Priority: asr.provider > gemini config (for backward compatibility) > default (gemini)
    if (config.asr?.provider) {
      this.provider = config.asr.provider;
    } else if (config.gemini?.apiKey || process.env.GOOGLE_API_KEY) {
      this.provider = 'gemini';
    }

    this.logger.info('Initializing ASR service', { provider: this.provider });

    // Initialize the selected provider
    if (this.provider === 'gemini') {
      await this.geminiService.initialize();
    } else if (this.provider === 'glm') {
      await this.glmASRService.initialize();
    }
  }

  async checkHealth(): Promise<ASRHealthResponse> {
    let health: ASRHealthResponse;

    if (this.provider === 'gemini') {
      const geminiHealth = await this.geminiService.checkHealth();
      health = {
        ...geminiHealth,
        provider: 'gemini'
      };
    } else if (this.provider === 'glm') {
      const glmHealth = await this.glmASRService.checkHealth();
      health = {
        ...glmHealth,
        provider: 'glm'
      };
    } else {
      health = {
        status: 'unhealthy',
        message: 'Unknown ASR provider',
        apiKeyValid: false,
        provider: this.provider
      };
    }

    return health;
  }

  async transcribe(audio: string, mimeType: string): Promise<ASRTranscribeResponse> {
    this.logger.debug('Transcribing audio', {
      provider: this.provider,
      mimeType,
      audioLength: audio.length
    });

    if (this.provider === 'gemini') {
      return await this.geminiService.transcribe(audio, mimeType);
    } else if (this.provider === 'glm') {
      return await this.glmASRService.transcribe(audio, mimeType);
    } else {
      throw new Error(`Unknown ASR provider: ${this.provider}`);
    }
  }

  getProvider(): ASRProvider {
    return this.provider;
  }
}

// Export singleton instance
import { geminiService } from './gemini-service.js';
import { glmASRService } from './glm-asr-service.js';
export const asrService = new ASRService(geminiService, glmASRService);
