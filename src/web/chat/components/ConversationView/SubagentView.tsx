import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ConversationHeader } from '../ConversationHeader/ConversationHeader';
import { MessageList } from '../MessageList/MessageList';
import { api } from '../../services/api';
import type { ChatMessage, ConversationMessage, SubagentDetailsResponse } from '../../types';

export function SubagentView() {
  const { sessionId, subagentId } = useParams<{ sessionId: string; subagentId: string }>();
  const [details, setDetails] = useState<SubagentDetailsResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !subagentId) return;

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    api.getSubagentDetails(sessionId, subagentId)
      .then((response) => {
        if (cancelled) return;
        setDetails(response);
        setMessages(convertSubagentMessages(response.messages));
      })
      .catch((err: any) => {
        if (!cancelled) {
          setError(err?.message || 'Failed to load sub-agent conversation');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, subagentId]);

  return (
    <div className="h-full flex flex-col bg-background relative" role="main" aria-label="Sub-agent conversation view">
      <ConversationHeader
        title={details?.subagent.summary || subagentId || 'Sub-agent'}
        backHref={sessionId ? `/c/${sessionId}` : '/'}
        subtitle={{
          date: details?.subagent.firstTimestamp
            ? new Date(details.subagent.firstTimestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : undefined,
          repo: `sub-agent · ${(details?.subagent.subagentId || subagentId || '').replace(/^agent-/, '')}`,
        }}
      />

      {error ? (
        <div
          className="bg-red-500/10 border-b border-red-500 text-red-600 dark:text-red-400 px-4 py-2 text-sm text-center"
          role="alert"
          aria-label="Sub-agent load error"
        >
          {error}
        </div>
      ) : null}

      <MessageList
        messages={messages}
        toolResults={buildToolResults(messages)}
        isLoading={isLoading}
        isStreaming={false}
      />
    </div>
  );
}

function convertSubagentMessages(messages: ConversationMessage[]): ChatMessage[] {
  return messages
    .filter((msg) => msg.message)
    .map((msg) => {
      let content: ChatMessage['content'] = '';
      if (typeof msg.message === 'object' && 'content' in msg.message) {
        content = msg.message.content as ChatMessage['content'];
      }

      return {
        id: msg.uuid,
        messageId: msg.uuid,
        type: msg.type as 'user' | 'assistant' | 'system',
        content,
        timestamp: msg.timestamp,
        model: msg.model,
        usage: msg.usage,
        workingDirectory: msg.cwd,
      };
    });
}

function buildToolResults(messages: ChatMessage[]) {
  const toolResults: Record<string, { status: 'pending' | 'completed'; result?: any; is_error?: boolean }> = {};

  messages.forEach((message) => {
    if (message.type === 'assistant' && Array.isArray(message.content)) {
      message.content.forEach((block: any) => {
        if (block.type === 'tool_use' && block.id) {
          toolResults[block.id] = { status: 'pending' };
        }
      });
    }

    if (message.type === 'user' && Array.isArray(message.content)) {
      message.content.forEach((block: any) => {
        if (block.type === 'tool_result' && 'tool_use_id' in block) {
          toolResults[block.tool_use_id] = {
            status: 'completed',
            result: block.content,
            is_error: block.is_error,
          };
        }
      });
    }
  });

  return toolResults;
}
