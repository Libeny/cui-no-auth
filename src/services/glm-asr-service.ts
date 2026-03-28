import { CUIError } from '@/types/index.js';
import { createLogger, type Logger } from '@/services/logger.js';
import { ConfigService } from './config-service.js';

export interface GLMASRHealthResponse {
  status: 'healthy' | 'unhealthy';
  message: string;
  apiKeyValid: boolean;
}

export interface GLMASRTranscribeRequest {
  audio: string; // base64 encoded audio
  mimeType: string; // audio mime type
}

export interface GLMASRTranscribeResponse {
  text: string;
}

export class GLMASRService {
  private logger: Logger;
  private apiKey: string | null = null;
  private model: string;
  private endpoint: string;

  constructor() {
    this.logger = createLogger('GLMASRService');
    this.model = 'glm-asr-2512';
    this.endpoint = 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions';
  }

  async initialize(): Promise<void> {
    const config = ConfigService.getInstance().getConfig();

    // Try to get API key from ASR config first, then fall back to environment variable
    this.apiKey = config.asr?.apiKey || process.env.ZHIPUAI_API_KEY || null;

    if (!this.apiKey) {
      this.logger.warn('GLM ASR API key not configured');
      return;
    }

    // Override model if configured
    if (config.asr?.model) {
      this.model = config.asr.model;
    }

    this.logger.info('GLM ASR service initialized', { model: this.model });
  }

  async checkHealth(): Promise<GLMASRHealthResponse> {
    if (!this.apiKey) {
      return {
        status: 'unhealthy',
        message: 'GLM ASR API key not configured',
        apiKeyValid: false
      };
    }

    try {
      // Test with a minimal request (we don't have a simple health check endpoint)
      // For now, just check if API key exists
      return {
        status: 'healthy',
        message: 'GLM ASR API key is configured',
        apiKeyValid: true
      };
    } catch (error) {
      this.logger.error('Health check failed', { error });
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown error',
        apiKeyValid: false
      };
    }
  }

  async transcribe(audio: string, mimeType: string): Promise<GLMASRTranscribeResponse> {
    if (!this.apiKey) {
      throw new CUIError('GLM_ASR_API_KEY_MISSING', 'GLM ASR API key not configured', 400);
    }

    try {
      // Convert base64 to buffer
      const audioBuffer = Buffer.from(audio, 'base64');

      // Determine file extension from mimeType
      const extension = this.getFileExtension(mimeType);

      // Create a File object from the buffer (File extends Blob)
      const audioFile = new File([audioBuffer], `audio.${extension}`, { type: mimeType });

      // Create form data using native FormData
      const formData = new FormData();
      formData.append('model', this.model);
      formData.append('file', audioFile);
      formData.append('stream', 'false');

      // Make request
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('GLM ASR API error', {
          status: response.status,
          statusText: response.statusText,
          error: errorText
        });
        throw new CUIError(
          'GLM_ASR_API_ERROR',
          `GLM ASR API returned ${response.status}: ${errorText}`,
          response.status
        );
      }

      const result = await response.json() as any;

      // Extract text from response
      // Based on GLM ASR API documentation, the response should contain the transcribed text
      const text = result.text || result.transcription || '';

      if (!text) {
        throw new CUIError('GLM_ASR_TRANSCRIBE_ERROR', 'No transcription returned', 500);
      }

      this.logger.debug('Audio transcribed successfully', { textLength: text.length });
      return { text: text.trim() };
    } catch (error) {
      if (error instanceof CUIError) {
        throw error;
      }
      this.logger.error('Transcription failed', { error });
      throw new CUIError('GLM_ASR_TRANSCRIBE_ERROR', 'Failed to transcribe audio', 500);
    }
  }

  private getFileExtension(mimeType: string): string {
    const mimeToExt: Record<string, string> = {
      'audio/webm': 'webm',
      'audio/webm;codecs=opus': 'webm',
      'audio/wav': 'wav',
      'audio/mp3': 'mp3',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/m4a': 'm4a',
    };

    return mimeToExt[mimeType] || 'webm';
  }
}

// Export singleton instance
export const glmASRService = new GLMASRService();
