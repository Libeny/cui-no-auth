import type { ConversationSummary } from '@/types/index.js';

export const CODEX_SESSION_PREFIX = 'codex:';

export interface CodexReaderOptions {
  codexHomePath?: string;
}

export interface CodexJsonlEntry {
  timestamp?: string;
  type?: string;
  payload?: CodexPayload;
}

export type CodexPayload =
  | CodexSessionMetaPayload
  | CodexTurnContextPayload
  | CodexResponseItemPayload
  | CodexEventPayload
  | Record<string, unknown>;

export interface CodexSessionMetaPayload {
  id?: string;
  cwd?: string;
  timestamp?: string;
  cli_version?: string;
  model?: string;
  model_provider?: {
    name?: string;
    model?: string;
  };
}

export interface CodexTurnContextPayload {
  cwd?: string;
  model?: string;
  summary?: string;
  turn_id?: string;
}

export type CodexResponseItemPayload =
  | CodexMessagePayload
  | CodexReasoningPayload
  | CodexFunctionCallPayload
  | CodexFunctionCallOutputPayload
  | CodexWebSearchCallPayload;

export interface CodexMessagePayload {
  type: 'message';
  role?: 'developer' | 'system' | 'user' | 'assistant';
  content?: CodexContentBlock[];
  phase?: string;
  session_id?: string;
}

export interface CodexContentBlock {
  type?: string;
  text?: string;
}

export interface CodexReasoningPayload {
  type: 'reasoning';
  summary?: unknown;
  encrypted_content?: string;
  content?: unknown;
}

export interface CodexFunctionCallPayload {
  type: 'function_call';
  name?: string;
  call_id?: string;
  arguments?: string | Record<string, unknown>;
}

export interface CodexFunctionCallOutputPayload {
  type: 'function_call_output';
  call_id?: string;
  output?: unknown;
}

export interface CodexWebSearchCallPayload {
  type: 'web_search_call';
  action?: unknown;
  status?: string;
}

export type CodexEventPayload =
  | CodexTaskStartedEvent
  | CodexTaskCompleteEvent
  | CodexUserMessageEvent
  | CodexAgentMessageEvent
  | CodexExecCommandEndEvent
  | CodexMcpToolCallEndEvent
  | CodexWebSearchEndEvent
  | CodexTokenCountEvent;

export interface CodexTaskStartedEvent {
  type: 'task_started';
  started_at?: string;
  turn_id?: string;
  model_context_window?: number;
}

export interface CodexTaskCompleteEvent {
  type: 'task_complete';
  last_agent_message?: string;
}

export interface CodexUserMessageEvent {
  type: 'user_message';
  message?: string;
}

export interface CodexAgentMessageEvent {
  type: 'agent_message';
  message?: string;
  phase?: string;
}

export interface CodexExecCommandEndEvent {
  type: 'exec_command_end';
  call_id?: string;
  command?: string;
  cwd?: string;
  stdout?: string;
  stderr?: string;
  formatted_output?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
}

export interface CodexMcpToolCallEndEvent {
  type: 'mcp_tool_call_end';
  call_id?: string;
  result?: unknown;
}

export interface CodexWebSearchEndEvent {
  type: 'web_search_end';
  call_id?: string;
  query?: string;
  action?: unknown;
}

export interface CodexTokenCountEvent {
  type: 'token_count';
  info?: unknown;
}

export interface CodexSessionMetadata {
  sessionId: string;
  rawSessionId: string;
  filePath: string;
  projectPath: string;
  summary: string;
  messageCount: number;
  totalDuration: number;
  model: string;
  createdAt: string;
  updatedAt: string;
  fileSize?: number;
  lastScannedAt?: number;
}

export type CodexConversationSummary = ConversationSummary & {
  provider: 'codex';
};

export function toCodexSessionId(rawSessionId: string): string {
  return rawSessionId.startsWith(CODEX_SESSION_PREFIX)
    ? rawSessionId
    : `${CODEX_SESSION_PREFIX}${rawSessionId}`;
}

export function fromCodexSessionId(sessionId: string): string {
  return sessionId.startsWith(CODEX_SESSION_PREFIX)
    ? sessionId.slice(CODEX_SESSION_PREFIX.length)
    : sessionId;
}
