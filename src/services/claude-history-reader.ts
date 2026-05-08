import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import {
  ConversationSummary,
  ConversationMessage,
  ConversationListQuery,
  CUIError,
  SubagentSummary,
  SubagentDetailsResponse,
  BackgroundTaskSummary,
  BackgroundTaskDetailsResponse,
  BackgroundTaskStatus,
  SessionInfo,
} from '@/types/index.js';
import { createLogger, type Logger } from './logger.js';
import { SessionInfoService } from './session-info-service.js';
import { ToolMetricsService } from './ToolMetricsService.js';
import { MessageFilter } from './message-filter.js';
import { normalizeTokenUsage } from '@/utils/token-usage.js';
import Anthropic from '@anthropic-ai/sdk';

// Import RawJsonEntry locally
type RawJsonEntry = {
  type: string;
  uuid?: string;
  sessionId?: string;
  parentUuid?: string;
  timestamp?: string;
  message?: Anthropic.Message | Anthropic.MessageParam;
  cwd?: string;
  durationMs?: number;
  isSidechain?: boolean;
  userType?: string;
  version?: string;
  content?: string;
  operation?: string;
  attachment?: {
    type?: string;
    prompt?: string;
    commandMode?: string;
  };
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: string;
  summary?: string;
  leafUuid?: string;
};

type IndexedSessionInfo = SessionInfo & { sessionId: string };
type OutputFileStats = {
  path: string;
  size: number;
  updatedAt: string;
};

type BackgroundOutputRead = {
  output: string;
  truncated: boolean;
};

type MutableBackgroundTask = Omit<BackgroundTaskSummary, 'taskOutputToolUseIds'> & {
  taskOutputToolUseIds: Set<string>;
  outputFileCandidates: Set<string>;
  outputSnapshot?: string;
  lastRetrievalStatus?: string;
};

const MAX_BACKGROUND_OUTPUT_BYTES = 256 * 1024;
const BACKGROUND_OUTPUT_PREVIEW_CHARS = 1200;

/**
 * Reads conversation history from Claude's local storage
 * optimized to use SQLite index for listing and stream processing for fetching details.
 */
export class ClaudeHistoryReader {
  private claudeHomePath: string;
  private logger: Logger;
  private sessionInfoService: SessionInfoService;
  private toolMetricsService: ToolMetricsService;
  private messageFilter: MessageFilter;
  
  constructor(sessionInfoService?: SessionInfoService) {
    this.claudeHomePath = path.join(os.homedir(), '.claude');
    this.logger = createLogger('ClaudeHistoryReader');
    this.sessionInfoService = sessionInfoService || SessionInfoService.getInstance();
    this.toolMetricsService = new ToolMetricsService();
    this.messageFilter = new MessageFilter();
  }

  get homePath(): string {
    return this.claudeHomePath;
  }

  /**
   * Clear the conversation cache 
   * (No-op in new architecture as we rely on DB index)
   */
  clearCache(): void {
    // Legacy method kept for compatibility
    this.logger.debug('clearCache called - operating in DB-backed mode');
  }

  /**
   * List all conversations using SQLite index
   */
  async listConversations(filter?: ConversationListQuery): Promise<{
    conversations: ConversationSummary[];
    total: number;
  }> {
    try {
      if (typeof this.sessionInfoService.getConversations === 'function') {
        const { conversations: sessionInfos, total } = await this.sessionInfoService.getConversations(filter || {});

        const conversations: ConversationSummary[] = sessionInfos.map((info) => {
          const sessionInfo = info as IndexedSessionInfo;

          return {
            sessionId: sessionInfo.sessionId,
            projectPath: sessionInfo.project_path || '',
            summary: sessionInfo.summary || 'No summary available',
            sessionInfo,
            createdAt: sessionInfo.created_at,
            updatedAt: sessionInfo.updated_at,
            messageCount: sessionInfo.message_count || 0,
            totalDuration: sessionInfo.total_duration || 0,
            model: sessionInfo.model || 'Unknown',
            status: 'completed' as const,
            toolMetrics: undefined,
          };
        });

        return {
          conversations,
          total
        };
      }

      return await this.listConversationsFromFilesystem(filter);
    } catch (error) {
      try {
        return await this.listConversationsFromFilesystem(filter);
      } catch {
        throw new CUIError('HISTORY_READ_FAILED', `Failed to read conversation history: ${error}`, 500);
      }
    }
  }

  /**
   * Fetch full conversation details by reading the JSONL file directly
   */
  async fetchConversation(sessionId: string): Promise<ConversationMessage[]> {
    try {
      const projectsDir = path.join(this.claudeHomePath, 'projects');
      const filePath = await this.locateSessionFile(projectsDir, sessionId);
      
      if (!filePath) {
        throw new CUIError('CONVERSATION_NOT_FOUND', `Conversation ${sessionId} not found`, 404);
      }

      // 2. Parse file
      const entries = await this.parseJsonlFile(filePath);
      
      // 3. Build chain
      const messages = this.buildConversationChain(sessionId, entries);
      
      if (!messages) {
         return [];
      }
      
      // 4. Apply filter
      return this.messageFilter.filterMessages(messages);
      
    } catch (error) {
      if (error instanceof CUIError) throw error;
      throw new CUIError('CONVERSATION_READ_FAILED', `Failed to read conversation: ${error}`, 500);
    }
  }

  async listSubagents(sessionId: string): Promise<SubagentSummary[]> {
    const sessionFilePath = await this.locateMainSessionFile(sessionId);
    if (!sessionFilePath) {
      throw new CUIError('CONVERSATION_NOT_FOUND', `Conversation ${sessionId} not found`, 404);
    }

    const files = await this.findSubagentFiles(sessionFilePath, sessionId);
    if (files.length === 0) {
      return [];
    }

    const subagents = await Promise.all(
      files.map(async (filePath) => {
        const rawEntries = await this.parseJsonlFile(filePath);
        const messages = this.buildConversationChain(sessionId, rawEntries) || [];
        const userMessages = messages.filter((message) => message.type === 'user');
        const assistantMessages = messages.filter((message) => message.type === 'assistant');
        const fileName = path.basename(filePath);
        const summary =
          this.extractFirstText(userMessages[0]?.message) ||
          this.extractFirstText(assistantMessages[0]?.message) ||
          fileName.replace(/\.jsonl$/, '');
        const firstTimestamp = messages[0]?.timestamp;
        const lastTimestamp = messages[messages.length - 1]?.timestamp;
        const model =
          assistantMessages.find((message) => message.model)?.model ||
          assistantMessages[0]?.model ||
          '';

        return {
          subagentId: fileName.replace(/\.jsonl$/, ''),
          sessionId,
          messageCount: messages.length,
          firstTimestamp,
          lastTimestamp,
          model,
          summary,
        } satisfies SubagentSummary;
      }),
    );

    return subagents.sort((a, b) => {
      const aTime = new Date(a.firstTimestamp || 0).getTime();
      const bTime = new Date(b.firstTimestamp || 0).getTime();
      return aTime - bTime;
    });
  }

  async fetchSubagentConversation(sessionId: string, subagentId: string): Promise<SubagentDetailsResponse> {
    const sessionFilePath = await this.locateMainSessionFile(sessionId);
    if (!sessionFilePath) {
      throw new CUIError('CONVERSATION_NOT_FOUND', `Conversation ${sessionId} not found`, 404);
    }

    const subagentFilePath = await this.findSubagentFile(sessionFilePath, sessionId, subagentId);
    if (!subagentFilePath) {
      throw new CUIError('SUBAGENT_NOT_FOUND', `Sub-agent ${subagentId} not found`, 404);
    }

    const entries = await this.parseJsonlFile(subagentFilePath);
    const messages = this.buildConversationChain(sessionId, entries) || [];
    const assistantMessages = messages.filter((message) => message.type === 'assistant');
    const model =
      assistantMessages.find((message) => message.model)?.model ||
      assistantMessages[0]?.model ||
      'Unknown';
    const totalDuration = messages.reduce((sum, message) => sum + (message.durationMs || 0), 0);
    const subagents = await this.listSubagents(sessionId);
    const subagent = subagents.find((item) => item.subagentId === subagentId) || {
      subagentId,
      sessionId,
      messageCount: messages.length,
      firstTimestamp: messages[0]?.timestamp,
      lastTimestamp: messages[messages.length - 1]?.timestamp,
      model,
      summary: this.extractFirstText(messages[0]?.message) || subagentId,
    };

    return {
      subagent,
      messages: this.messageFilter.filterMessages(messages),
      metadata: {
        totalDuration,
        model,
      },
    };
  }

  async listBackgroundTasks(sessionId: string): Promise<BackgroundTaskSummary[]> {
    const { tasks } = await this.collectBackgroundTasks(sessionId);
    return tasks
      .map((task) => this.toBackgroundTaskSummary(task))
      .sort((a, b) => {
        const aTime = new Date(a.createdAt || a.updatedAt || 0).getTime();
        const bTime = new Date(b.createdAt || b.updatedAt || 0).getTime();
        return aTime - bTime;
      });
  }

  async fetchBackgroundTask(sessionId: string, taskId: string): Promise<BackgroundTaskDetailsResponse> {
    const { taskMap } = await this.collectBackgroundTasks(sessionId);
    const task = taskMap.get(taskId);

    if (!task) {
      throw new CUIError('BACKGROUND_TASK_NOT_FOUND', `Background task ${taskId} not found`, 404);
    }

    let output: string | undefined;
    let outputTruncated = false;
    let outputSource: BackgroundTaskDetailsResponse['outputSource'] = 'none';

    if (task.outputFile && task.outputFileExists) {
      const read = await this.readBackgroundOutputFile(task.outputFile);
      if (read) {
        output = read.output;
        outputTruncated = read.truncated;
        outputSource = 'file';
      }
    }

    if (outputSource === 'none' && task.outputSnapshot !== undefined) {
      output = task.outputSnapshot;
      outputSource = 'snapshot';
    }

    return {
      task: this.toBackgroundTaskSummary(task),
      output,
      outputSource,
      outputTruncated,
    };
  }

  /**
   * Get conversation metadata
   */
  async getConversationMetadata(sessionId: string): Promise<{
    summary: string;
    projectPath: string;
    model: string;
    totalDuration: number;
  } | null> {
    try {
      const info = await this.sessionInfoService.getSessionInfo(sessionId);
      const hasIndexedMetadata =
        Boolean(info.summary) ||
        Boolean(info.project_path) ||
        Boolean(info.model) ||
        Boolean(info.total_duration);

      if (!hasIndexedMetadata) {
        const fallback = await this.getConversationMetadataFromFile(sessionId);
        return fallback;
      }

      return {
        summary: info.summary || 'No summary',
        projectPath: info.project_path || '',
        model: info.model || 'Unknown',
        totalDuration: info.total_duration || 0
      };
    } catch (error) {
      this.logger.error('Error getting metadata for conversation', error, { sessionId });
      return null;
    }
  }

  /**
   * Get the working directory for a specific conversation session
   */
  async getConversationWorkingDirectory(sessionId: string): Promise<string | null> {
    try {
      const info = await this.sessionInfoService.getSessionInfo(sessionId);
      return info.project_path || null;
    } catch {
      return null;
    }
  }

  private async findProjectPathForSession(sessionId: string): Promise<string | null> {
    const info = await this.sessionInfoService.getSessionInfo(sessionId);
    return info.project_path || null;
  }

  private async locateMainSessionFile(sessionId: string): Promise<string | null> {
    const projectsDir = path.join(this.claudeHomePath, 'projects');
    return this.locateSessionFile(projectsDir, sessionId);
  }

  private async findSubagentFiles(sessionFilePath: string, sessionId: string): Promise<string[]> {
    const sessionDir = path.dirname(sessionFilePath);
    const candidates = new Set<string>();

    const candidateDirs = [
      path.join(sessionDir, path.basename(sessionId), 'subagents'),
      path.join(sessionDir, 'subagents'),
    ];

    for (const candidateDir of candidateDirs) {
      try {
        const nestedEntries = await fs.readdir(candidateDir);
        nestedEntries
          .filter((entry) => entry.startsWith('agent-') && entry.endsWith('.jsonl'))
          .forEach((entry) => candidates.add(path.join(candidateDir, entry)));
      } catch {
        // ignore
      }
    }

    const siblingDirs = [
      path.join(sessionDir, path.basename(sessionId)),
      sessionDir,
    ];

    for (const siblingDir of siblingDirs) {
      try {
        const siblingEntries = await fs.readdir(siblingDir);
        siblingEntries
          .filter((entry) => entry.startsWith('agent-') && entry.endsWith('.jsonl'))
          .forEach((entry) => candidates.add(path.join(siblingDir, entry)));
      } catch {
        // ignore
      }
    }

    const matches: string[] = [];
    for (const candidate of candidates) {
      if (await this.subagentFileBelongsToSession(candidate, sessionId)) {
        matches.push(candidate);
      }
    }

    return matches.sort();
  }

  private async findSubagentFile(sessionFilePath: string, sessionId: string, subagentId: string): Promise<string | null> {
    const files = await this.findSubagentFiles(sessionFilePath, sessionId);
    return files.find((filePath) => path.basename(filePath, '.jsonl') === subagentId) || null;
  }

  private async subagentFileBelongsToSession(filePath: string, sessionId: string): Promise<boolean> {
    const entries = await this.parseJsonlFile(filePath);
    return entries.some((entry) => entry.sessionId === sessionId);
  }

  private async collectBackgroundTasks(sessionId: string): Promise<{
    tasks: MutableBackgroundTask[];
    taskMap: Map<string, MutableBackgroundTask>;
  }> {
    const sessionFilePath = await this.locateMainSessionFile(sessionId);
    if (!sessionFilePath) {
      throw new CUIError('CONVERSATION_NOT_FOUND', `Conversation ${sessionId} not found`, 404);
    }

    const entries = await this.parseJsonlFile(sessionFilePath);
    const taskMap = new Map<string, MutableBackgroundTask>();
    const descriptionByToolUseId = new Map<string, string>();

    for (const entry of entries) {
      if (entry.sessionId && entry.sessionId !== sessionId) continue;

      for (const toolUse of this.extractToolUseBlocks(entry)) {
        const toolUseId = this.getString(toolUse.id);
        const toolName = this.getString(toolUse.name);
        const input = this.asRecord(toolUse.input);
        const description = this.getString(input?.description);

        if (toolUseId && description) {
          descriptionByToolUseId.set(toolUseId, description);
          for (const task of taskMap.values()) {
            if (task.launchToolUseId === toolUseId && !task.description) {
              task.description = description;
            }
          }
        }

        if (toolName === 'TaskOutput') {
          const taskId = this.getString(input?.task_id) || this.getString(input?.taskId);
          if (taskId && toolUseId) {
            const task = this.ensureBackgroundTask(taskMap, sessionId, taskId);
            task.taskOutputToolUseIds.add(toolUseId);
            this.updateBackgroundTaskTimestamp(task, entry.timestamp);
          }
        }
      }

      for (const payload of this.extractEntryTextPayloads(entry)) {
        this.applyBackgroundLaunchPayload(taskMap, sessionId, payload.text, payload.toolUseId, entry.timestamp, descriptionByToolUseId);
        this.applyTaskOutputPayload(taskMap, sessionId, payload.text, entry.timestamp);
        this.applyTaskNotificationPayload(taskMap, sessionId, payload.text, entry.timestamp, descriptionByToolUseId);
      }

      this.applyStructuredToolUseResult(taskMap, sessionId, entry, descriptionByToolUseId);
    }

    for (const task of taskMap.values()) {
      const resolvedOutputFile = await this.resolveBackgroundOutputFile(task.taskId, [...task.outputFileCandidates]);
      if (resolvedOutputFile) {
        task.outputFile = resolvedOutputFile.path;
        task.outputFileExists = true;
        task.outputFileSize = resolvedOutputFile.size;
        task.outputFileUpdatedAt = resolvedOutputFile.updatedAt;
        if (task.status === 'unknown') {
          task.status = 'running';
        }
      } else {
        task.outputFileExists = false;
      }

      if (!task.outputPreview && task.outputSnapshot) {
        task.outputPreview = this.truncatePreview(task.outputSnapshot);
      }
    }

    return {
      tasks: [...taskMap.values()],
      taskMap,
    };
  }

  private ensureBackgroundTask(
    taskMap: Map<string, MutableBackgroundTask>,
    sessionId: string,
    taskId: string,
  ): MutableBackgroundTask {
    const existing = taskMap.get(taskId);
    if (existing) {
      return existing;
    }

    const task: MutableBackgroundTask = {
      taskId,
      sessionId,
      status: 'unknown',
      outputFileExists: false,
      taskOutputToolUseIds: new Set<string>(),
      outputFileCandidates: new Set<string>(),
    };
    taskMap.set(taskId, task);
    return task;
  }

  private applyBackgroundLaunchPayload(
    taskMap: Map<string, MutableBackgroundTask>,
    sessionId: string,
    text: string,
    toolUseId: string | undefined,
    timestamp: string | undefined,
    descriptionByToolUseId: Map<string, string>,
  ): void {
    const match = text.match(/Command running in background with ID:\s*([A-Za-z0-9_-]+)\.\s*Output is being written to:\s*([^\r\n]+?\.output)/);
    if (!match) return;

    const [, taskId, outputFile] = match;
    const task = this.ensureBackgroundTask(taskMap, sessionId, taskId);
    task.status = 'running';
    task.outputFile = outputFile.trim();
    task.outputFileCandidates.add(outputFile.trim());
    if (toolUseId) {
      task.launchToolUseId = toolUseId;
      task.description = task.description || descriptionByToolUseId.get(toolUseId);
    }
    this.updateBackgroundTaskTimestamp(task, timestamp);
  }

  private applyTaskOutputPayload(
    taskMap: Map<string, MutableBackgroundTask>,
    sessionId: string,
    text: string,
    timestamp: string | undefined,
  ): void {
    const taskId = this.extractXmlTag(text, 'task_id') || this.extractXmlTag(text, 'task-id');
    if (!taskId) return;

    const task = this.ensureBackgroundTask(taskMap, sessionId, taskId);
    const taskType = this.extractXmlTag(text, 'task_type') || this.extractXmlTag(text, 'task-type');
    const rawStatus = this.extractXmlTag(text, 'status');
    const retrievalStatus = this.extractXmlTag(text, 'retrieval_status') || this.extractXmlTag(text, 'retrieval-status');
    const exitCode = this.parseExitCode(this.extractXmlTag(text, 'exit_code') || this.extractXmlTag(text, 'exit-code'));
    const output = this.extractXmlTag(text, 'output');

    if (taskType) {
      task.taskType = taskType;
    }
    if (retrievalStatus) {
      task.lastRetrievalStatus = retrievalStatus;
    }
    if (exitCode !== undefined) {
      task.exitCode = exitCode;
    }
    if (rawStatus) {
      task.status = this.normalizeBackgroundTaskStatus(rawStatus, task.exitCode);
      if (task.status === 'completed' || task.status === 'failed') {
        task.completedAt = timestamp;
      }
    }
    if (output !== undefined) {
      task.outputSnapshot = this.trimOuterNewline(output);
      task.outputPreview = this.truncatePreview(task.outputSnapshot);
    }

    this.updateBackgroundTaskTimestamp(task, timestamp);
  }

  private applyTaskNotificationPayload(
    taskMap: Map<string, MutableBackgroundTask>,
    sessionId: string,
    text: string,
    timestamp: string | undefined,
    descriptionByToolUseId: Map<string, string>,
  ): void {
    const taskId = this.extractXmlTag(text, 'task-id');
    if (!taskId) return;

    const task = this.ensureBackgroundTask(taskMap, sessionId, taskId);
    const toolUseId = this.extractXmlTag(text, 'tool-use-id');
    const outputFile = this.extractXmlTag(text, 'output-file');
    const rawStatus = this.extractXmlTag(text, 'status');
    const summary = this.extractXmlTag(text, 'summary');
    const exitCode = this.extractExitCodeFromSummary(summary);

    if (toolUseId) {
      task.launchToolUseId = toolUseId;
      task.description = task.description || descriptionByToolUseId.get(toolUseId);
    }
    if (outputFile) {
      task.outputFile = outputFile;
      task.outputFileCandidates.add(outputFile);
    }
    if (summary) {
      task.summary = summary;
      task.description = task.description || this.extractDescriptionFromSummary(summary);
    }
    if (exitCode !== undefined) {
      task.exitCode = exitCode;
    }
    if (rawStatus) {
      task.status = this.normalizeBackgroundTaskStatus(rawStatus, task.exitCode);
      if (task.status === 'completed' || task.status === 'failed') {
        task.completedAt = timestamp;
      }
    }

    this.updateBackgroundTaskTimestamp(task, timestamp);
  }

  private applyStructuredToolUseResult(
    taskMap: Map<string, MutableBackgroundTask>,
    sessionId: string,
    entry: RawJsonEntry,
    descriptionByToolUseId: Map<string, string>,
  ): void {
    const result = this.asRecord(entry.toolUseResult);
    if (!result) return;

    const backgroundTaskId = this.getString(result.backgroundTaskId);
    if (backgroundTaskId) {
      const task = this.ensureBackgroundTask(taskMap, sessionId, backgroundTaskId);
      task.status = task.status === 'unknown' ? 'running' : task.status;
      this.updateBackgroundTaskTimestamp(task, entry.timestamp);
    }

    const taskResult = this.asRecord(result.task);
    const taskId = this.getString(taskResult?.task_id) || this.getString(taskResult?.taskId);
    if (!taskId) return;

    const task = this.ensureBackgroundTask(taskMap, sessionId, taskId);
    const taskType = this.getString(taskResult?.task_type) || this.getString(taskResult?.taskType);
    const description = this.getString(taskResult?.description);
    const rawStatus = this.getString(taskResult?.status);
    const exitCode = this.parseExitCode(taskResult?.exitCode ?? taskResult?.exit_code);
    const output = this.getString(taskResult?.output);

    if (taskType) {
      task.taskType = taskType;
    }
    if (description) {
      task.description = description;
      if (task.launchToolUseId) {
        descriptionByToolUseId.set(task.launchToolUseId, description);
      }
    }
    if (exitCode !== undefined) {
      task.exitCode = exitCode;
    }
    if (rawStatus) {
      task.status = this.normalizeBackgroundTaskStatus(rawStatus, task.exitCode);
      if (task.status === 'completed' || task.status === 'failed') {
        task.completedAt = entry.timestamp;
      }
    }
    if (output !== undefined) {
      task.outputSnapshot = output;
      task.outputPreview = this.truncatePreview(output);
    }

    this.updateBackgroundTaskTimestamp(task, entry.timestamp);
  }

  private extractToolUseBlocks(entry: RawJsonEntry): any[] {
    const content = this.getMessageContent(entry);
    if (!Array.isArray(content)) return [];
    return content.filter((block: any) => block?.type === 'tool_use');
  }

  private extractEntryTextPayloads(entry: RawJsonEntry): Array<{ text: string; toolUseId?: string }> {
    const payloads: Array<{ text: string; toolUseId?: string }> = [];
    const content = this.getMessageContent(entry);

    if (typeof content === 'string') {
      payloads.push({ text: content });
    } else if (Array.isArray(content)) {
      for (const block of content as any[]) {
        const toolUseId = this.getString(block?.tool_use_id);
        if (typeof block?.content === 'string') {
          payloads.push({ text: block.content, toolUseId });
        } else if (Array.isArray(block?.content)) {
          for (const child of block.content) {
            const text = this.getString(child?.text) || this.getString(child?.content);
            if (text) {
              payloads.push({ text, toolUseId });
            }
          }
        }

        const blockText = this.getString(block?.text);
        if (blockText) {
          payloads.push({ text: blockText, toolUseId });
        }
      }
    }

    if (entry.content) {
      payloads.push({ text: entry.content });
    }
    if (entry.attachment?.prompt) {
      payloads.push({ text: entry.attachment.prompt });
    }

    return payloads;
  }

  private getMessageContent(entry: RawJsonEntry): unknown {
    const message = entry.message;
    if (!message || typeof message !== 'object' || !('content' in message)) {
      return undefined;
    }
    return message.content;
  }

  private toBackgroundTaskSummary(task: MutableBackgroundTask): BackgroundTaskSummary {
    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      status: task.status,
      outputFile: task.outputFile,
      outputFileExists: task.outputFileExists,
      outputFileSize: task.outputFileSize,
      outputFileUpdatedAt: task.outputFileUpdatedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      taskType: task.taskType,
      exitCode: task.exitCode,
      description: task.description,
      summary: task.summary,
      launchToolUseId: task.launchToolUseId,
      taskOutputToolUseIds: [...task.taskOutputToolUseIds],
      outputPreview: task.outputPreview,
    };
  }

  private updateBackgroundTaskTimestamp(task: MutableBackgroundTask, timestamp: string | undefined): void {
    if (!timestamp) return;
    if (!task.createdAt || new Date(timestamp).getTime() < new Date(task.createdAt).getTime()) {
      task.createdAt = timestamp;
    }
    if (!task.updatedAt || new Date(timestamp).getTime() > new Date(task.updatedAt).getTime()) {
      task.updatedAt = timestamp;
    }
  }

  private normalizeBackgroundTaskStatus(status: string | undefined, exitCode?: number): BackgroundTaskStatus {
    const normalized = status?.trim().toLowerCase();
    if (!normalized) return 'unknown';
    if (normalized === 'running' || normalized === 'not_ready' || normalized === 'pending') {
      return 'running';
    }
    if (normalized === 'completed' || normalized === 'success') {
      return exitCode !== undefined && exitCode !== 0 ? 'failed' : 'completed';
    }
    if (normalized === 'failed' || normalized === 'error' || normalized === 'cancelled' || normalized === 'canceled') {
      return 'failed';
    }
    return 'unknown';
  }

  private async resolveBackgroundOutputFile(taskId: string, candidates: string[]): Promise<OutputFileStats | null> {
    const fileName = `${taskId}.output`;

    for (const candidate of candidates) {
      if (path.basename(candidate) !== fileName) continue;
      const stats = await this.statOutputFile(candidate);
      if (stats) {
        return stats;
      }
    }

    const roots = [...new Set([os.tmpdir(), '/private/tmp', '/tmp'].map((root) => path.resolve(root)))];
    for (const root of roots) {
      const found = await this.findClaudeOutputFile(root, fileName);
      if (found) {
        const stats = await this.statOutputFile(found);
        if (stats) {
          return stats;
        }
      }
    }

    return null;
  }

  private async findClaudeOutputFile(root: string, fileName: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('claude-')) continue;
        const found = await this.findFileByName(path.join(root, entry.name), fileName, 5);
        if (found) {
          return found;
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private async findFileByName(directory: string, fileName: string, depthRemaining: number): Promise<string | null> {
    if (depthRemaining < 0) return null;

    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name === fileName) {
          return path.join(directory, entry.name);
        }
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = await this.findFileByName(path.join(directory, entry.name), fileName, depthRemaining - 1);
        if (found) {
          return found;
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private async statOutputFile(filePath: string): Promise<OutputFileStats | null> {
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        return null;
      }

      return {
        path: filePath,
        size: stats.size,
        updatedAt: stats.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async readBackgroundOutputFile(filePath: string): Promise<BackgroundOutputRead | null> {
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        return null;
      }

      if (stats.size <= MAX_BACKGROUND_OUTPUT_BYTES) {
        return {
          output: await fs.readFile(filePath, 'utf-8'),
          truncated: false,
        };
      }

      const fileHandle = await fs.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(MAX_BACKGROUND_OUTPUT_BYTES);
        await fileHandle.read(buffer, 0, MAX_BACKGROUND_OUTPUT_BYTES, stats.size - MAX_BACKGROUND_OUTPUT_BYTES);
        return {
          output: buffer.toString('utf-8'),
          truncated: true,
        };
      } finally {
        await fileHandle.close();
      }
    } catch {
      return null;
    }
  }

  private extractXmlTag(text: string, tagName: string): string | undefined {
    const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`<${escapedTag}>\\s*([\\s\\S]*?)\\s*</${escapedTag}>`, 'i'));
    return match ? match[1] : undefined;
  }

  private parseExitCode(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value !== 'string') {
      return undefined;
    }
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private extractExitCodeFromSummary(summary: string | undefined): number | undefined {
    if (!summary) return undefined;
    const match = summary.match(/exit code\s+(-?\d+)/i);
    return match ? this.parseExitCode(match[1]) : undefined;
  }

  private extractDescriptionFromSummary(summary: string): string | undefined {
    const match = summary.match(/Background command "([^"]+)"/);
    return match?.[1];
  }

  private trimOuterNewline(value: string): string {
    return value.replace(/^\n/, '').replace(/\n$/, '');
  }

  private truncatePreview(value: string): string {
    return value.length > BACKGROUND_OUTPUT_PREVIEW_CHARS
      ? `${value.slice(0, BACKGROUND_OUTPUT_PREVIEW_CHARS)}...`
      : value;
  }

  private asRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' ? value as Record<string, any> : undefined;
  }

  private getString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }
  
  /**
   * Locate session file by scanning projects directory
   * This is a fallback if we can't derive path directly
   */
  private async locateSessionFile(projectsDir: string, sessionId: string): Promise<string | null> {
    // Optimization: Check index first (O(1) lookup)
    try {
      const info = await this.sessionInfoService.getSessionInfo(sessionId);
      if (info.file_path) {
        try {
          await fs.access(info.file_path);
          return info.file_path;
        } catch {
          this.logger.debug('Indexed file path not found on disk, falling back to scan', { sessionId, path: info.file_path });
        }
      }
    } catch (error) {
      this.logger.debug('Failed to query session info for file path', { sessionId, error });
    }

    try {
      const dirs = await fs.readdir(projectsDir);
      for (const dir of dirs) {
        try {
          const candidateDir = path.join(projectsDir, dir);
          const stat = await fs.stat(candidateDir);
          if (!stat.isDirectory()) continue;
          const files = await fs.readdir(candidateDir);
          for (const file of files) {
            if (!file.endsWith('.jsonl') || file.startsWith('agent-')) continue;
            const potentialPath = path.join(candidateDir, file);
            const entries = await this.parseJsonlFile(potentialPath);
            if (entries.some((entry) => entry.sessionId === sessionId)) {
              return potentialPath;
            }
          }
        } catch {
          // continue
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Parse a single JSONL file
   */
  private async parseJsonlFile(filePath: string): Promise<RawJsonEntry[]> {
    try {
      // Use readline for memory efficiency
      const fileStream = fsSync.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      const entries: RawJsonEntry[] = [];
      
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          // ignore
        }
      }
      
      return entries;
    } catch (error) {
      this.logger.error('Failed to read JSONL file', error, { filePath });
      return [];
    }
  }

  private extractFirstText(message?: Anthropic.Message | Anthropic.MessageParam): string {
    if (!message || typeof message !== 'object') {
      return '';
    }

    const content = 'content' in message ? message.content : undefined;
    if (typeof content === 'string') {
      return content.trim().slice(0, 120);
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          if ('text' in block && typeof block.text === 'string' && block.text.trim()) {
            return block.text.trim().slice(0, 120);
          }
          if ('thinking' in block && typeof (block as { thinking?: string }).thinking === 'string' && (block as { thinking?: string }).thinking?.trim()) {
            return (block as { thinking?: string }).thinking!.trim().slice(0, 120);
          }
        }
      }
    }

    return '';
  }
  
  /**
   * Reconstruct conversation chain from flat entries
   */
  private buildConversationChain(sessionId: string, entries: RawJsonEntry[]): ConversationMessage[] | null {
    const messages: ConversationMessage[] = entries
      .filter(
        (entry) =>
          (entry.type === 'user' || entry.type === 'assistant') &&
          (entry.sessionId === sessionId || !entry.sessionId)
      )
      .map(entry => ({
        uuid: entry.uuid || '',
        type: entry.type as 'user' | 'assistant' | 'system',
        message: entry.message!,
        timestamp: entry.timestamp || '',
        sessionId: entry.sessionId || sessionId,
        model: typeof entry.message === 'object' && entry.message && 'model' in entry.message ? String(entry.message.model || '') : undefined,
        usage: typeof entry.message === 'object' && entry.message && 'usage' in entry.message ? normalizeTokenUsage((entry.message as { usage?: unknown }).usage) : undefined,
        parentUuid: entry.parentUuid,
        isSidechain: entry.isSidechain,
        userType: entry.userType,
        cwd: entry.cwd,
        version: entry.version,
        durationMs: entry.durationMs
      }));

    if (messages.length === 0) return null;
    
    // Reconstruct order
    // Map UUID -> Message
    const messageMap = new Map<string, ConversationMessage>();
    messages.forEach(m => messageMap.set(m.uuid, m));
    
    // Find roots (no parent or parent not in set) - usually just one root
    // But we need to reconstruct the linear chain.
    // For simple list display, sorting by timestamp is usually "good enough" but threading is better.
    // Let's use the recursive build logic from before but simplified.
    
    // Find the first message (usually no parentUuid)
    const head = messages.find(m => !m.parentUuid);
    if (!head) return messages.sort((a,b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    const chain: ConversationMessage[] = [];
    const visited = new Set<string>();
    
    const traverse = (current: ConversationMessage) => {
        if (visited.has(current.uuid)) return;
        visited.add(current.uuid);
        chain.push(current);
        
        // Find children
        const children = messages.filter(m => m.parentUuid === current.uuid);
        children.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        children.forEach(traverse);
    };
    
    traverse(head);
    
    // Add orphans
    const orphans = messages.filter(m => !visited.has(m.uuid));
    orphans.sort((a,b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    return [...chain, ...orphans];
  }

  private decodeProjectPath(encodedPath: string): string {
    if (!encodedPath.startsWith('-')) {
      return encodedPath;
    }

    return encodedPath.replace(/^-/, '/').replace(/-/g, '/');
  }

  private applyFilters<T extends {
    projectPath?: string;
    createdAt?: string;
    updatedAt?: string;
    sessionInfo?: SessionInfo;
  }>(conversations: T[], filter?: ConversationListQuery): T[] {
    if (!filter) {
      return conversations;
    }

    let filtered = conversations;

    if (filter.projectPath) {
      filtered = filtered.filter((conversation) => conversation.projectPath === filter.projectPath);
    }

    if (filter.archived !== undefined) {
      filtered = filtered.filter((conversation) => Boolean(conversation.sessionInfo?.archived) === filter.archived);
    }

    if (filter.pinned !== undefined) {
      filtered = filtered.filter((conversation) => Boolean(conversation.sessionInfo?.pinned) === filter.pinned);
    }

    if (filter.hasContinuation !== undefined) {
      filtered = filtered.filter((conversation) => {
        const hasContinuation = Boolean(conversation.sessionInfo?.continuation_session_id);
        return hasContinuation === filter.hasContinuation;
      });
    }

    const sortBy = filter.sortBy === 'updated' ? 'updatedAt' : 'createdAt';
    const order = filter.order === 'asc' ? 1 : -1;

    return [...filtered].sort((a, b) => {
      const aTime = new Date(a[sortBy] || 0).getTime();
      const bTime = new Date(b[sortBy] || 0).getTime();
      return (aTime - bTime) * order;
    });
  }

  private applyPagination<T>(conversations: T[], filter?: ConversationListQuery): T[] {
    if (!filter) {
      return conversations;
    }

    const limit = filter.limit ?? 20;
    const offset = filter.offset ?? 0;
    return conversations.slice(offset, offset + limit);
  }

  private async listConversationsFromFilesystem(filter?: ConversationListQuery): Promise<{
    conversations: ConversationSummary[];
    total: number;
  }> {
    const projectsDir = path.join(this.claudeHomePath, 'projects');

    try {
      const projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
      const conversations: ConversationSummary[] = [];

      for (const projectEntry of projectEntries) {
        if (!projectEntry.isDirectory()) continue;

        const projectDir = path.join(projectsDir, projectEntry.name);
        const files = await fs.readdir(projectDir);

        for (const file of files) {
          if (!file.endsWith('.jsonl') || file.startsWith('agent-')) continue;

          const filePath = path.join(projectDir, file);
          const scanned = await this.scanConversationFile(filePath, projectEntry.name);
          conversations.push(...scanned);
        }
      }

      const filtered = this.applyFilters(conversations, filter);
      return {
        conversations: this.applyPagination(filtered, filter),
        total: filtered.length,
      };
    } catch {
      return {
        conversations: [],
        total: 0,
      };
    }
  }

  private async scanConversationFile(filePath: string, projectDirName: string): Promise<ConversationSummary[]> {
    const entries = await this.parseJsonlFile(filePath);
    const summaryBySession = new Map<string, string>();
    let pendingSummary = '';

    for (const entry of entries) {
      if (entry.type === 'summary' && typeof entry.summary === 'string') {
        pendingSummary = entry.summary;
        continue;
      }

      if (!entry.sessionId) continue;
      if (pendingSummary && !summaryBySession.has(entry.sessionId)) {
        summaryBySession.set(entry.sessionId, pendingSummary);
        pendingSummary = '';
      }
    }

    const sessionIds = [...new Set(entries.map((entry) => entry.sessionId).filter((value): value is string => Boolean(value)))];
    const conversations: ConversationSummary[] = [];

    for (const sessionId of sessionIds) {
      const messages = this.buildConversationChain(sessionId, entries) || [];
      if (messages.length === 0) continue;

      const sessionInfo = await this.sessionInfoService.getSessionInfo(sessionId);
      const assistantMessages = messages.filter((message) => message.type === 'assistant');
      const totalDuration = messages.reduce((sum, message) => sum + (message.durationMs || 0), 0);
      const projectPath = messages.find((message) => message.cwd)?.cwd || this.decodeProjectPath(projectDirName);

      conversations.push({
        sessionId,
        projectPath,
        summary: summaryBySession.get(sessionId) || this.extractFirstText(messages[0]?.message) || 'No summary available',
        sessionInfo,
        createdAt: messages[0]?.timestamp || sessionInfo.created_at,
        updatedAt: messages[messages.length - 1]?.timestamp || sessionInfo.updated_at,
        messageCount: messages.length,
        totalDuration,
        model:
          assistantMessages.find((message) => message.model)?.model ||
          assistantMessages[0]?.model ||
          'Unknown',
        status: 'completed',
        toolMetrics: undefined,
      });
    }

    return conversations;
  }

  private async getConversationMetadataFromFile(sessionId: string): Promise<{
    summary: string;
    projectPath: string;
    model: string;
    totalDuration: number;
  } | null> {
    const filePath = await this.locateMainSessionFile(sessionId);
    if (!filePath) {
      return null;
    }

    const conversations = await this.scanConversationFile(filePath, path.basename(path.dirname(filePath)));
    const conversation = conversations.find((item) => item.sessionId === sessionId);
    if (!conversation) {
      return null;
    }

    return {
      summary: conversation.summary,
      projectPath: conversation.projectPath,
      model: conversation.model,
      totalDuration: conversation.totalDuration,
    };
  }
}
