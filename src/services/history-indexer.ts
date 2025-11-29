import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { createLogger, type Logger } from './logger.js';
import { SessionInfoService } from './session-info-service.js';

interface IndexedMetadata {
  sessionId: string;
  summary?: string;
  projectPath?: string;
  messageCount: number;
  totalDuration: number;
  model: string;
  createdAt?: string;
  updatedAt?: string;
  lastScannedAt: number;
}

export class HistoryIndexer {
  private logger: Logger;
  private claudeHomePath: string;
  private sessionInfoService: SessionInfoService;
  private isRunning: boolean = false;
  private shouldStop: boolean = false;

  constructor(sessionInfoService?: SessionInfoService) {
    this.logger = createLogger('HistoryIndexer');
    this.claudeHomePath = path.join(os.homedir(), '.claude');
    this.sessionInfoService = sessionInfoService || SessionInfoService.getInstance();
  }

  /**
   * Start the indexing process in the background
   */
  start(): void {
    if (this.isRunning) {
      this.logger.warn('Indexer is already running');
      return;
    }
    
    this.isRunning = true;
    this.shouldStop = false;
    
    // Run asynchronously without awaiting
    this.runIndexLoop().catch(error => {
      this.logger.error('Indexer loop failed', error);
      this.isRunning = false;
    });
  }

  stop(): void {
    this.shouldStop = true;
  }

  private async runIndexLoop(): Promise<void> {
    this.logger.info('Starting history indexing...');
    const startTime = Date.now();
    
    try {
      await this.scanAndIndex();
      
      const duration = Date.now() - startTime;
      this.logger.info(`History indexing completed in ${duration}ms`);
    } catch (error) {
      this.logger.error('Error during indexing', error);
    } finally {
      this.isRunning = false;
    }
  }

  private async scanAndIndex(): Promise<void> {
    const projectsDir = path.join(this.claudeHomePath, 'projects');
    
    if (!fs.existsSync(projectsDir)) {
      this.logger.warn(`Projects directory not found: ${projectsDir}`);
      return;
    }

    // Get all known sessions from DB to check last_scanned_at
    const knownSessions = await this.sessionInfoService.getAllSessionInfo();
    
    const batchSize = 50;
    let currentBatch: IndexedMetadata[] = [];
    
    try {
      const projectDirs = await fsPromises.readdir(projectsDir);
      
      for (const projectDirName of projectDirs) {
        if (this.shouldStop) break;
        
        const fullProjectDir = path.join(projectsDir, projectDirName);
        const stats = await fsPromises.stat(fullProjectDir);
        
        if (!stats.isDirectory()) continue;
        
        // Scan files in project directory
        const files = await fsPromises.readdir(fullProjectDir);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
        
        for (const file of jsonlFiles) {
          if (this.shouldStop) break;
          
          const filePath = path.join(fullProjectDir, file);
          
          try {
            const fileStats = await fsPromises.stat(filePath);
            const sessionId = file.replace('.jsonl', '');
            const existingInfo = knownSessions[sessionId];
            
            // Skip if file hasn't changed since last scan
            // Allow 1s buffer for mtime differences
            if (existingInfo && existingInfo.last_scanned_at && 
                existingInfo.last_scanned_at >= fileStats.mtimeMs - 1000) {
              continue;
            }
            
            // Parse and extract metadata
            const metadata = await this.extractMetadata(filePath, sessionId, fileStats.mtimeMs);
            if (metadata) {
              // If projectPath wasn't found in file, use directory name logic (legacy)
              if (!metadata.projectPath) {
                 metadata.projectPath = projectDirName.replace(/-/g, '/');
              }
              
              currentBatch.push(metadata);
            }
            
            // Flush batch if full
            if (currentBatch.length >= batchSize) {
              await this.sessionInfoService.bulkUpsertIndexedMetadata(currentBatch);
              currentBatch = [];
            }
            
          } catch (error) {
            this.logger.warn(`Failed to index file ${file}`, error);
          }
        }
      }
      
      // Flush remaining
      if (currentBatch.length > 0) {
        await this.sessionInfoService.bulkUpsertIndexedMetadata(currentBatch);
      }
      
    } catch (error) {
      this.logger.error('Error scanning projects', error);
      throw error;
    }
  }

  private async extractMetadata(filePath: string, sessionId: string, mtime: number): Promise<IndexedMetadata | null> {
    return new Promise((resolve, reject) => {
      const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      let messageCount = 0;
      let totalDuration = 0;
      let model = 'Unknown';
      let summary = '';
      let projectPath = '';
      let firstTimestamp = '';
      let lastTimestamp = '';
      let foundModel = false;

      rl.on('line', (line) => {
        try {
          if (!line.trim()) return;
          
          // Fast JSON parse - we only need top level keys usually
          const entry = JSON.parse(line);
          
          // Capture timestamps
          if (entry.timestamp) {
            if (!firstTimestamp) firstTimestamp = entry.timestamp;
            lastTimestamp = entry.timestamp;
          }
          
          // 1. Count user/assistant messages
          if (entry.type === 'user' || entry.type === 'assistant') {
            messageCount++;
            
            if (entry.durationMs) {
              totalDuration += entry.durationMs;
            }
            
            // Extract model from first message that has it
            if (!foundModel && entry.message && entry.message.model) {
              model = entry.message.model;
              foundModel = true;
            }
            
            // Extract cwd/projectPath from first message
            if (!projectPath && entry.cwd) {
              projectPath = entry.cwd;
            }
          }
          
          // 2. Capture summary
          if (entry.type === 'summary' && entry.summary) {
            summary = entry.summary;
          }
          
        } catch (e) {
          // Ignore parse errors
        }
      });

      rl.on('close', () => {
        if (messageCount === 0 && !summary) {
            resolve(null); // Empty or invalid file
            return;
        }

        resolve({
          sessionId,
          summary: summary || undefined,
          projectPath: projectPath || undefined,
          messageCount,
          totalDuration,
          model,
          createdAt: firstTimestamp || new Date(mtime).toISOString(),
          updatedAt: lastTimestamp || new Date(mtime).toISOString(),
          lastScannedAt: mtime
        });
      });

      rl.on('error', (err) => {
        fileStream.destroy();
        reject(err);
      });
    });
  }
}
