import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import type { SessionInfo, ConversationListQuery } from '@/types/index.js';
import { createLogger } from './logger.js';
import { type Logger } from './logger.js';

type SessionRow = {
  session_id: string;
  custom_name: string;
  created_at: string;
  updated_at: string;
  version: number;
  pinned: number | boolean;
  archived: number | boolean;
  continuation_session_id: string;
  initial_commit_head: string;
  permission_mode: string;
  // Indexed fields
  summary: string | null;
  project_path: string | null;
  message_count: number | null;
  total_duration: number | null;
  model: string | null;
  last_scanned_at: number | null;
};

/**
 * SessionInfoService manages session information using SQLite backend
 * Stores session metadata including custom names in ~/.cui/session-info.db
 * Provides fast lookups and updates for session-specific data
 */
export class SessionInfoService {
  private static instance: SessionInfoService;
  private logger: Logger;
  private dbPath!: string;
  private configDir!: string;
  private isInitialized = false;
  private db!: Database.Database;

  private getSessionStmt!: Database.Statement;
  private insertSessionStmt!: Database.Statement;
  private updateSessionStmt!: Database.Statement;
  private deleteSessionStmt!: Database.Statement;
  private getAllStmt!: Database.Statement;
  private countStmt!: Database.Statement;
  private archiveAllStmt!: Database.Statement;
  private setMetadataStmt!: Database.Statement;
  private getMetadataStmt!: Database.Statement;
  private updateIndexedDataStmt!: Database.Statement;

  constructor(customConfigDir?: string) {
    this.logger = createLogger('SessionInfoService');
    this.initializePaths(customConfigDir);
  }

  static getInstance(): SessionInfoService {
    if (!SessionInfoService.instance) {
      SessionInfoService.instance = new SessionInfoService();
    }
    return SessionInfoService.instance;
  }

  static resetInstance(): void {
    if (SessionInfoService.instance) {
      SessionInfoService.instance.isInitialized = false;
    }
    SessionInfoService.instance = null as unknown as SessionInfoService;
  }

  private initializePaths(customConfigDir?: string): void {
    if (customConfigDir) {
      if (customConfigDir === ':memory:') {
        this.configDir = ':memory:';
        this.dbPath = ':memory:';
        return;
      }
      this.configDir = path.join(customConfigDir, '.cui');
    } else {
      this.configDir = path.join(os.homedir(), '.cui');
    }
    this.dbPath = path.join(this.configDir, 'session-info.db');

    this.logger.debug('Initializing paths', {
      homedir: os.homedir(),
      configDir: this.configDir,
      dbPath: this.dbPath
    });
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      if (this.dbPath !== ':memory:' && !fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
        this.logger.debug('Created config directory', { dir: this.configDir });
      }

      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');

      // Initialize tables
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          custom_name TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          version INTEGER NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          continuation_session_id TEXT NOT NULL DEFAULT '',
          initial_commit_head TEXT NOT NULL DEFAULT '',
          permission_mode TEXT NOT NULL DEFAULT 'default'
        );
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      // Migrate Schema: Add new indexed columns if they don't exist
      this.migrateSchema();

      this.prepareStatements();
      this.ensureMetadata();
      this.isInitialized = true;
    } catch (error) {
      this.logger.error('Failed to initialize session info database', error);
      throw new Error(`Session info database initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private migrateSchema(): void {
    const columnsToAdd = [
      { name: 'summary', type: 'TEXT', default: 'NULL' },
      { name: 'project_path', type: 'TEXT', default: 'NULL' },
      { name: 'message_count', type: 'INTEGER', default: 'NULL' },
      { name: 'total_duration', type: 'INTEGER', default: 'NULL' },
      { name: 'model', type: 'TEXT', default: 'NULL' },
      { name: 'last_scanned_at', type: 'INTEGER', default: 'NULL' }
    ];

    const tableInfo = this.db.pragma('table_info(sessions)') as { name: string }[];
    const existingColumns = new Set(tableInfo.map(c => c.name));

    for (const col of columnsToAdd) {
      if (!existingColumns.has(col.name)) {
        try {
          this.logger.info(`Migrating schema: adding column ${col.name}`);
          this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col.name} ${col.type} DEFAULT ${col.default}`);
        } catch (error) {
          this.logger.warn(`Failed to add column ${col.name} (might already exist)`, error);
        }
      }
    }
  }

  private prepareStatements(): void {
    this.getSessionStmt = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?');
    
    this.insertSessionStmt = this.db.prepare(`
      INSERT INTO sessions (
        session_id, custom_name, created_at, updated_at, version,
        pinned, archived, continuation_session_id, initial_commit_head, permission_mode,
        summary, project_path, message_count, total_duration, model, last_scanned_at
      ) VALUES (
        @session_id, @custom_name, @created_at, @updated_at, @version,
        @pinned, @archived, @continuation_session_id, @initial_commit_head, @permission_mode,
        @summary, @project_path, @message_count, @total_duration, @model, @last_scanned_at
      )
    `);

    this.updateSessionStmt = this.db.prepare(`
      UPDATE sessions SET
        custom_name=@custom_name,
        updated_at=@updated_at,
        pinned=@pinned,
        archived=@archived,
        continuation_session_id=@continuation_session_id,
        initial_commit_head=@initial_commit_head,
        permission_mode=@permission_mode,
        version=@version,
        summary=COALESCE(@summary, summary),
        project_path=COALESCE(@project_path, project_path),
        message_count=COALESCE(@message_count, message_count),
        total_duration=COALESCE(@total_duration, total_duration),
        model=COALESCE(@model, model),
        last_scanned_at=COALESCE(@last_scanned_at, last_scanned_at)
      WHERE session_id=@session_id
    `);

    // Specialized statement for the indexer to update indexed fields without touching user preferences
    this.updateIndexedDataStmt = this.db.prepare(`
      INSERT INTO sessions (
        session_id, created_at, updated_at, version, 
        summary, project_path, message_count, total_duration, model, last_scanned_at
      ) VALUES (
        @session_id, @created_at, @updated_at, 3,
        @summary, @project_path, @message_count, @total_duration, @model, @last_scanned_at
      )
      ON CONFLICT(session_id) DO UPDATE SET
        summary=excluded.summary,
        project_path=excluded.project_path,
        message_count=excluded.message_count,
        total_duration=excluded.total_duration,
        model=excluded.model,
        last_scanned_at=excluded.last_scanned_at,
        updated_at=excluded.updated_at
    `);

    this.deleteSessionStmt = this.db.prepare('DELETE FROM sessions WHERE session_id = ?');
    this.getAllStmt = this.db.prepare('SELECT * FROM sessions');
    this.countStmt = this.db.prepare('SELECT COUNT(*) as count FROM sessions');
    this.archiveAllStmt = this.db.prepare('UPDATE sessions SET archived=1, updated_at=@updated_at WHERE archived=0');
    this.setMetadataStmt = this.db.prepare('INSERT INTO metadata (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    this.getMetadataStmt = this.db.prepare('SELECT value FROM metadata WHERE key = ?');
  }

  private ensureMetadata(): void {
    const now = new Date().toISOString();
    const schema = this.getMetadataStmt.get('schema_version') as { value?: string } | undefined;
    if (!schema) {
      this.setMetadataStmt.run({ key: 'schema_version', value: '4' });
      this.setMetadataStmt.run({ key: 'created_at', value: now });
      this.setMetadataStmt.run({ key: 'last_updated', value: now });
    }
  }

  private mapRow(row: SessionRow): SessionInfo {
    return {
      custom_name: row.custom_name,
      created_at: row.created_at,
      updated_at: row.updated_at,
      version: row.version,
      pinned: !!row.pinned,
      archived: !!row.archived,
      continuation_session_id: row.continuation_session_id,
      initial_commit_head: row.initial_commit_head,
      permission_mode: row.permission_mode,
      // Map indexed fields
      summary: row.summary || undefined,
      project_path: row.project_path || undefined,
      message_count: row.message_count || undefined,
      total_duration: row.total_duration || undefined,
      model: row.model || undefined,
      last_scanned_at: row.last_scanned_at || undefined
    };
  }

  async getSessionInfo(sessionId: string): Promise<SessionInfo> {
    try {
      const row = this.getSessionStmt.get(sessionId) as SessionRow | undefined;
      if (row) {
        return this.mapRow(row);
      }

      const now = new Date().toISOString();
      const defaultSession: SessionInfo = {
        custom_name: '',
        created_at: now,
        updated_at: now,
        version: 3,
        pinned: false,
        archived: false,
        continuation_session_id: '',
        initial_commit_head: '',
        permission_mode: 'default'
      };
      
      this.insertSessionStmt.run({
        session_id: sessionId,
        custom_name: '',
        created_at: now,
        updated_at: now,
        version: 3,
        pinned: 0,
        archived: 0,
        continuation_session_id: '',
        initial_commit_head: '',
        permission_mode: 'default',
        summary: null,
        project_path: null,
        message_count: null,
        total_duration: null,
        model: null,
        last_scanned_at: null
      });
      
      this.setMetadataStmt.run({ key: 'last_updated', value: now });
      return defaultSession;
    } catch (error) {
      this.logger.error('Failed to get session info', { sessionId, error });
      const now = new Date().toISOString();
      return {
        custom_name: '',
        created_at: now,
        updated_at: now,
        version: 3,
        pinned: false,
        archived: false,
        continuation_session_id: '',
        initial_commit_head: '',
        permission_mode: 'default'
      };
    }
  }

  async updateSessionInfo(sessionId: string, updates: Partial<SessionInfo>): Promise<SessionInfo> {
    try {
      const existingRow = this.getSessionStmt.get(sessionId) as SessionRow | undefined;
      const now = new Date().toISOString();
      
      // Prepare parameters for INSERT or UPDATE
      // We use a merged object for parameters
      const merged = existingRow ? { ...this.mapRow(existingRow), ...updates } : {
        custom_name: '',
        created_at: now,
        updated_at: now,
        version: 3,
        pinned: false,
        archived: false,
        continuation_session_id: '',
        initial_commit_head: '',
        permission_mode: 'default',
        summary: undefined,
        project_path: undefined,
        message_count: undefined,
        total_duration: undefined,
        model: undefined,
        last_scanned_at: undefined,
        ...updates
      };

      const params = {
        session_id: sessionId,
        custom_name: merged.custom_name,
        created_at: merged.created_at,
        updated_at: now, // Always update updated_at
        version: merged.version,
        pinned: merged.pinned ? 1 : 0,
        archived: merged.archived ? 1 : 0,
        continuation_session_id: merged.continuation_session_id,
        initial_commit_head: merged.initial_commit_head,
        permission_mode: merged.permission_mode,
        summary: merged.summary || null,
        project_path: merged.project_path || null,
        message_count: merged.message_count || null,
        total_duration: merged.total_duration || null,
        model: merged.model || null,
        last_scanned_at: merged.last_scanned_at || null
      };

      if (existingRow) {
        this.updateSessionStmt.run(params);
      } else {
        this.insertSessionStmt.run(params);
      }
      
      this.setMetadataStmt.run({ key: 'last_updated', value: now });
      return { ...merged, updated_at: now };
      
    } catch (error) {
      this.logger.error('Failed to update session info', { sessionId, updates, error });
      throw new Error(`Failed to update session info: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Bulk upsert indexed metadata (used by Indexer)
   */
  async bulkUpsertIndexedMetadata(items: Array<{
    sessionId: string;
    summary?: string;
    projectPath?: string;
    messageCount?: number;
    totalDuration?: number;
    model?: string;
    lastScannedAt: number;
    createdAt?: string;
    updatedAt?: string;
  }>): Promise<void> {
    if (items.length === 0) return;

    try {
      const transaction = this.db.transaction((rows) => {
        let changes = 0;
        for (const row of rows) {
          const info = this.updateIndexedDataStmt.run({
            session_id: row.sessionId,
            created_at: row.createdAt || new Date().toISOString(),
            updated_at: row.updatedAt || new Date().toISOString(),
            summary: row.summary || null,
            project_path: row.projectPath || null,
            message_count: row.messageCount || null,
            total_duration: row.totalDuration || null,
            model: row.model || null,
            last_scanned_at: row.lastScannedAt
          });
          changes += info.changes;
        }
        return changes;
      });

      const changes = transaction(items);
      this.logger.debug('Bulk upserted indexed metadata', { count: items.length, changes });
      
      const now = new Date().toISOString();
      this.setMetadataStmt.run({ key: 'last_updated', value: now });
      
    } catch (error) {
      this.logger.error('Failed to bulk upsert indexed metadata', error);
      throw error;
    }
  }

  async updateCustomName(sessionId: string, customName: string): Promise<void> {
    await this.updateSessionInfo(sessionId, { custom_name: customName });
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.logger.info('Deleting session info', { sessionId });
    try {
      const result = this.deleteSessionStmt.run(sessionId);
      if (result.changes > 0) {
        const now = new Date().toISOString();
        this.setMetadataStmt.run({ key: 'last_updated', value: now });
        this.logger.info('Session info deleted successfully', { sessionId });
      } else {
        this.logger.debug('Session info not found for deletion', { sessionId });
      }
    } catch (error) {
      this.logger.error('Failed to delete session info', { sessionId, error });
      throw new Error(`Failed to delete session info: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getAllSessionInfo(): Promise<Record<string, SessionInfo>> {
    this.logger.debug('Getting all session info');
    try {
      const rows = this.getAllStmt.all() as Array<SessionRow & { session_id: string }>;
      const result: Record<string, SessionInfo> = {};
      for (const row of rows) {
        result[row.session_id] = this.mapRow(row);
      }
      return result;
    } catch (error) {
      this.logger.error('Failed to get all session info', error);
      return {};
    }
  }

  async getStats(): Promise<{ sessionCount: number; dbSize: number; lastUpdated: string }> {
    try {
      const countRow = this.countStmt.get() as { count: number };
      let dbSize = 0;
      if (this.dbPath !== ':memory:') {
        try {
          const stats = fs.statSync(this.dbPath);
          dbSize = stats.size;
        } catch {
          dbSize = 0;
        }
      }
      const lastUpdatedRow = this.getMetadataStmt.get('last_updated') as { value?: string } | undefined;
      return {
        sessionCount: countRow.count,
        dbSize,
        lastUpdated: lastUpdatedRow?.value || new Date().toISOString()
      };
    } catch (error) {
      this.logger.error('Failed to get database stats', error);
      return {
        sessionCount: 0,
        dbSize: 0,
        lastUpdated: new Date().toISOString()
      };
    }
  }

  /**
   * Get conversations with filtering, sorting and pagination
   */
  async getConversations(query: ConversationListQuery): Promise<{ conversations: SessionInfo[]; total: number }> {
    try {
      let sql = 'SELECT * FROM sessions WHERE 1=1';
      const params: any[] = [];
      
      // Filtering
      if (query.projectPath) {
        sql += ' AND project_path = ?';
        params.push(query.projectPath);
      }
      
      if (query.archived !== undefined) {
        sql += ' AND archived = ?';
        params.push(query.archived ? 1 : 0);
      }
      
      if (query.pinned !== undefined) {
        sql += ' AND pinned = ?';
        params.push(query.pinned ? 1 : 0);
      }
      
      if (query.hasContinuation !== undefined) {
        if (query.hasContinuation) {
          sql += " AND continuation_session_id != ''";
        } else {
          sql += " AND continuation_session_id = ''";
        }
      }

      // Count total before pagination
      const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as count');
      const total = (this.db.prepare(countSql).get(...params) as { count: number }).count;
      
      // Sorting
      const sortBy = query.sortBy === 'created' ? 'created_at' : 'updated_at';
      const order = query.order === 'desc' ? 'DESC' : 'ASC';
      sql += ` ORDER BY ${sortBy} ${order}`;
      
      // Pagination
      if (query.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(query.limit);
        
        if (query.offset !== undefined) {
          sql += ' OFFSET ?';
          params.push(query.offset);
        }
      }
      
      const rows = this.db.prepare(sql).all(...params) as Array<SessionRow>;
      const conversations = rows.map(row => ({
        ...this.mapRow(row),
        // Ensure session_id is mapped to sessionId if SessionInfo type requires it, 
        // but currently SessionInfo doesn't have sessionId field (it's usually wrapper)
        // We will handle this in the caller
        sessionId: row.session_id 
      }));
      
      return { conversations, total };
      
    } catch (error) {
      this.logger.error('Failed to get conversations', error);
      throw new Error(`Failed to get conversations: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  reinitializePaths(customConfigDir?: string): void {
    this.initializePaths(customConfigDir);
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getConfigDir(): string {
    return this.configDir;
  }

  async archiveAllSessions(): Promise<number> {
    this.logger.info('Archiving all sessions');
    try {
      const now = new Date().toISOString();
      const transaction = this.db.transaction(() => {
        const info = this.archiveAllStmt.run({ updated_at: now });
        if (info.changes > 0) {
          this.setMetadataStmt.run({ key: 'last_updated', value: now });
        }
        return info.changes;
      });
      const archivedCount = transaction();
      this.logger.info('Sessions archived successfully', { archivedCount });
      return archivedCount;
    } catch (error) {
      this.logger.error('Failed to archive all sessions', error);
      throw new Error(`Failed to archive all sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async syncMissingSessions(sessionIds: string[]): Promise<number> {
    // This is legacy sync, can keep it for now or deprecate
    // The new bulkUpsertIndexedMetadata is preferred
    try {
      const now = new Date().toISOString();
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO sessions (
          session_id, custom_name, created_at, updated_at, version,
          pinned, archived, continuation_session_id, initial_commit_head, permission_mode
        ) VALUES (
          @session_id, '', @now, @now, 3,
          0, 0, '', '', 'default'
        )
      `);
      const transaction = this.db.transaction((ids: string[]) => {
        let inserted = 0;
        for (const id of ids) {
          const info = insert.run({ session_id: id, now });
          if (info.changes > 0) inserted++;
        }
        if (inserted > 0) {
          this.setMetadataStmt.run({ key: 'last_updated', value: now });
        }
        return inserted;
      });
      return transaction(sessionIds);
    } catch (error) {
      this.logger.error('Failed to sync missing sessions', error);
      throw new Error(`Failed to sync missing sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}