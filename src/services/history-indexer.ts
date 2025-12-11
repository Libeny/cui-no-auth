import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { createLogger, type Logger } from './logger.js';
import { SessionInfoService } from './session-info-service.js';
import { StreamManager } from './stream-manager.js';
import { StreamEvent } from '../types/index.js';

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
  filePath?: string;
}

export class HistoryIndexer {
  private logger: Logger;
  private claudeHomePath: string;
  private sessionInfoService: SessionInfoService;
  private streamManager?: StreamManager;
  private isRunning: boolean = false;
  private shouldStop: boolean = false;

  constructor(sessionInfoService?: SessionInfoService) {
    this.logger = createLogger('HistoryIndexer');
    this.claudeHomePath = path.join(os.homedir(), '.claude');
    this.sessionInfoService = sessionInfoService || SessionInfoService.getInstance();
  }

  setStreamManager(streamManager: StreamManager): void {
    this.streamManager = streamManager;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Indexer is already running');
      return;
    }
    
    this.isRunning = true;
    this.shouldStop = false;
    
    // Initial scan to sync DB
    this.logger.info('Starting initial history scan...');
    try {
      await this.scanAndIndex();
      this.logger.info('Initial scan completed');
    } catch (error) {
      this.logger.error('Initial scan failed', error);
    }
    
    // Start watcher for real-time updates
    this.startWatcher();
  }

  stop(): void {
    this.shouldStop = true;
    this.isRunning = false;
    // fs.watch returns a FSWatcher which has a close() method.
    // We'll need to store it to close it.
    if (this.watcher) {
        this.watcher.close();
        this.watcher = undefined;
    }
  }

  private watcher?: fs.FSWatcher;
  private pendingUpdates = new Map<string, NodeJS.Timeout>();

  private startWatcher(): void {
    const projectsDir = path.join(this.claudeHomePath, 'projects');
    
    if (!fs.existsSync(projectsDir)) {
      this.logger.warn(`Projects directory not found for watching: ${projectsDir}`);
      return;
    }

    try {
      this.logger.info(`Starting file watcher on ${projectsDir}`);
      
      this.watcher = fs.watch(projectsDir, { recursive: true }, (eventType, filename) => {
        if (!filename || this.shouldStop) return;

        // Filter valid files
        const isJsonl = filename.toString().endsWith('.jsonl');
        const isAgent = filename.toString().includes('agent-') || filename.toString().startsWith('agent-'); // simple check
        
        if (!isJsonl || isAgent) return;

        // Construct full path
        // filename from fs.watch is relative to projectsDir
        const fullPath = path.join(projectsDir, filename.toString());
        
        // Debounce updates for this file
        const existingTimer = this.pendingUpdates.get(fullPath);
        if (existingTimer) clearTimeout(existingTimer);

        this.pendingUpdates.set(fullPath, setTimeout(() => {
          this.pendingUpdates.delete(fullPath);
          this.indexSingleFile(fullPath).catch(err => {
             this.logger.error(`Error indexing file from watcher: ${filename}`, err);
          });
        }, 200)); // 200ms debounce for snappier updates
      });
      
      this.watcher.on('error', (error) => {
        this.logger.error('File watcher error', error);
      });

    } catch (error) {
      this.logger.error('Failed to start file watcher', error);
    }
  }

  private async indexSingleFile(filePath: string): Promise<void> {
    try {
        // Check if file still exists
        if (!fs.existsSync(filePath)) return;

        const stats = await fsPromises.stat(filePath);
        const filename = path.basename(filePath);
        const sessionId = filename.replace('.jsonl', '');
        
        // Extract metadata
        const metadata = await this.extractMetadata(filePath, sessionId, stats.mtimeMs);
        
        if (metadata) {
            // Upsert single entry
            await this.sessionInfoService.bulkUpsertIndexedMetadata([{ ...metadata, filePath }]);
            this.logger.debug(`Updated index for session: ${sessionId}`);

            // Broadcast update event
            if (this.streamManager) {
                this.streamManager.broadcast('global', {
                    type: 'index_update',
                    sessionId,
                    timestamp: new Date().toISOString()
                });
            }
        }
    } catch (error) {
        this.logger.debug(`Failed to index single file ${filePath}`, error);
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
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
        
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
              currentBatch.push({ ...metadata, filePath });
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
      let firstUserMessage = '';

      rl.on('line', (line) => {
        try {
          if (!line.trim()) return;
          
          // Fast JSON parse - we only need top level keys usually
          const entry = JSON.parse(line);
          
          // Ignore sidechain messages (internal sub-agents)
          if (entry.isSidechain) {
            return;
          }

          // Capture timestamps
          if (entry.timestamp) {
            if (!firstTimestamp) firstTimestamp = entry.timestamp;
            lastTimestamp = entry.timestamp;
          }

          // Capture cwd/projectPath from ANY entry that has it
          if (!projectPath && entry.cwd) {
            projectPath = entry.cwd;
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

            // Capture first user message for fallback summary
            if (entry.type === 'user' && !firstUserMessage) {
              if (typeof entry.message === 'string') {
                firstUserMessage = entry.message;
              } else if (typeof entry.message === 'object') {
                 if (typeof entry.message.content === 'string') {
                   firstUserMessage = entry.message.content;
                 } else if (Array.isArray(entry.message.content)) {
                   // Extract text from content blocks
                   firstUserMessage = entry.message.content
                     .filter((b: any) => b.type === 'text')
                     .map((b: any) => b.text)
                     .join(' ');
                 }
              }
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

        // Fallback summary
        if (!summary && firstUserMessage) {
          summary = firstUserMessage.slice(0, 100).replace(/\n/g, ' ');
          if (firstUserMessage.length > 100) summary += '...';
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
