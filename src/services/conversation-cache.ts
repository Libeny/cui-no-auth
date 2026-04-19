import { createLogger, type Logger } from './logger.js';

export interface ConversationChain {
  sessionId: string;
  messages: unknown[];
  projectPath: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  totalDuration: number;
  model: string;
}

interface CachedFileEntries<TEntry> {
  entries: TEntry[];
  mtime: number;
  projectPath: string;
}

interface CacheStats {
  isLoaded: boolean;
  cachedFileCount: number;
  totalCachedEntries: number;
  isCurrentlyParsing: boolean;
  fileCacheDetails: Array<{
    filePath: string;
    entryCount: number;
    mtime: number;
    projectPath: string;
  }>;
}

export class ConversationCache<TEntry = unknown> {
  private logger: Logger;
  private fileCache = new Map<string, CachedFileEntries<TEntry>>();
  private activeParsePromise: Promise<ConversationChain[]> | null = null;
  private isLoaded = false;

  constructor() {
    this.logger = createLogger('ConversationCache');
  }

  async getOrParseConversations(
    fileModTimes: Map<string, number>,
    parseFile: (filePath: string) => Promise<TEntry[]>,
    getSourceProject: (filePath: string) => string,
    processAllEntries: (entries: TEntry[]) => ConversationChain[],
  ): Promise<ConversationChain[]> {
    if (this.activeParsePromise) {
      return this.activeParsePromise;
    }

    this.activeParsePromise = this.rebuildCache(fileModTimes, parseFile, getSourceProject, processAllEntries);

    try {
      const result = await this.activeParsePromise;
      this.isLoaded = true;
      return result;
    } finally {
      this.activeParsePromise = null;
    }
  }

  clear(): void {
    this.fileCache.clear();
    this.activeParsePromise = null;
    this.isLoaded = false;
  }

  isFileCacheValid(filePath: string, mtime: number): boolean {
    return this.fileCache.get(filePath)?.mtime === mtime;
  }

  updateFileCache(filePath: string, entries: TEntry[], mtime: number, projectPath: string): void {
    this.fileCache.set(filePath, {
      entries,
      mtime,
      projectPath,
    });
  }

  getStats(): CacheStats {
    const fileCacheDetails = [...this.fileCache.entries()].map(([filePath, cached]) => ({
      filePath,
      entryCount: cached.entries.length,
      mtime: cached.mtime,
      projectPath: cached.projectPath,
    }));

    return {
      isLoaded: this.isLoaded,
      cachedFileCount: this.fileCache.size,
      totalCachedEntries: fileCacheDetails.reduce((sum, item) => sum + item.entryCount, 0),
      isCurrentlyParsing: this.activeParsePromise !== null,
      fileCacheDetails,
    };
  }

  private async rebuildCache(
    fileModTimes: Map<string, number>,
    parseFile: (filePath: string) => Promise<TEntry[]>,
    getSourceProject: (filePath: string) => string,
    processAllEntries: (entries: TEntry[]) => ConversationChain[],
  ): Promise<ConversationChain[]> {
    for (const cachedPath of [...this.fileCache.keys()]) {
      if (!fileModTimes.has(cachedPath)) {
        this.fileCache.delete(cachedPath);
      }
    }

    for (const [filePath, mtime] of fileModTimes.entries()) {
      if (this.isFileCacheValid(filePath, mtime)) {
        continue;
      }

      try {
        const entries = await parseFile(filePath);
        this.updateFileCache(filePath, entries, mtime, getSourceProject(filePath));
      } catch (error) {
        this.logger.warn('Failed to parse conversation file for cache', { filePath, error });
        this.fileCache.delete(filePath);
      }
    }

    const allEntries = [...this.fileCache.values()].flatMap((cached) => cached.entries);
    return processAllEntries(allEntries);
  }
}
