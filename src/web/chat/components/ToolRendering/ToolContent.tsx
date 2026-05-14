import React, { useState } from 'react';
import { Activity, CornerDownRight } from 'lucide-react';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ChatMessage, ToolResult, SubagentSummary, BackgroundTaskSummary } from '../../types';
import { ReadTool } from './tools/ReadTool';
import { EditTool } from './tools/EditTool';
import { WriteTool } from './tools/WriteTool';
import { BashTool } from './tools/BashTool';
import { SearchTool } from './tools/SearchTool';
import { TodoTool } from './tools/TodoTool';
import { WebTool } from './tools/WebTool';
import { TaskTool } from './tools/TaskTool';
import { PlanTool } from './tools/PlanTool';
import { FallbackTool } from './tools/FallbackTool';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/web/chat/components/ui/collapsible';

interface ToolContentProps {
  toolName: string;
  toolInput: any;
  toolResult?: ToolResult;
  workingDirectory?: string;
  toolUseId?: string;
  childrenMessages?: Record<string, ChatMessage[]>;
  toolResults?: Record<string, any>;
  subagent?: SubagentSummary;
  backgroundTask?: BackgroundTaskSummary;
}

export function ToolContent({ 
  toolName, 
  toolInput, 
  toolResult, 
  workingDirectory, 
  toolUseId, 
  childrenMessages, 
  toolResults,
  subagent,
  backgroundTask
}: ToolContentProps) {
  const [isErrorExpanded, setIsErrorExpanded] = useState(false);
  // Extract result content - handle both string and ContentBlockParam[] formats
  const getResultContent = (): string => {
    if (!toolResult?.result) return '';
    
    if (typeof toolResult.result === 'string') {
      return toolResult.result;
    }
    
    if (Array.isArray(toolResult.result)) {
      return toolResult.result
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('\n');
    }
    
    return '';
  };

  const resultContent = getResultContent();
  const isError = toolResult?.is_error === true;
  const isPending = toolResult?.status === 'pending';
  const backgroundTaskLink = backgroundTask ? <BackgroundTaskLink task={backgroundTask} /> : null;

  // Skip rendering for pending tools
  if (isPending && toolName !== 'Agent') {
    return null;
  }

  // Handle error display at root level
  if (isError) {
    const errorMessage = resultContent || 'Tool execution failed';
    const firstLine = errorMessage.split('\n')[0].trim();
    const hasMultipleLines = errorMessage.includes('\n');
    
    return (
      <div className="flex flex-col gap-1 -mt-0.5">
        <Collapsible open={isErrorExpanded} onOpenChange={setIsErrorExpanded}>
          <CollapsibleTrigger className="flex items-center gap-1 text-sm text-destructive cursor-pointer select-none hover:text-destructive/80" aria-label="Toggle error details">
            <CornerDownRight 
              size={12} 
              className={`transition-transform ${isErrorExpanded ? 'rotate-90' : ''}`}
            />
            Error: {firstLine}
          </CollapsibleTrigger>
          
          <CollapsibleContent>
            <div className="text-destructive bg-destructive/10 rounded-md p-3 border border-destructive text-sm">
              {errorMessage}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    );
  }

  // Route to appropriate tool-specific component
  switch (toolName) {
    case 'Read':
      return (
        <ReadTool
          input={toolInput}
          result={resultContent}
          workingDirectory={workingDirectory}
        />
      );
    
    case 'Edit':
    case 'MultiEdit':
      return (
        <EditTool
          input={toolInput}
          result={resultContent}
          isMultiEdit={toolName === 'MultiEdit'}
          workingDirectory={workingDirectory}
        />
      );
    
    case 'Write':
      return (
        <WriteTool
          input={toolInput}
          result={resultContent}
          workingDirectory={workingDirectory}
        />
      );
    
    case 'Bash':
      return (
        <>
          <BashTool
            input={toolInput}
            result={resultContent}
          />
          {backgroundTaskLink}
        </>
      );
    
    case 'Grep':
    case 'Glob':
    case 'LS':
      return (
        <SearchTool
          input={toolInput}
          result={resultContent}
          toolType={toolName}
        />
      );
    
    case 'TodoRead':
    case 'TodoWrite':
      return (
        <TodoTool
          input={toolInput}
          result={resultContent}
          isWrite={toolName === 'TodoWrite'}
        />
      );
    
    case 'WebSearch':
    case 'WebFetch':
      return (
        <WebTool
          input={toolInput}
          result={resultContent}
          toolType={toolName}
        />
      );
    
    case 'Task':
      return (
        <TaskTool
          input={toolInput}
          result={resultContent}
          toolUseId={toolUseId}
          childrenMessages={childrenMessages}
          toolResults={toolResults}
        />
      );

    case 'TaskOutput':
      return (
        <>
          <FallbackTool
            toolName={toolName}
            input={toolInput}
            result={resultContent}
          />
          {backgroundTaskLink}
        </>
      );

    case 'Agent':
      return (
        <div className="flex flex-col gap-1 -mt-0.5">
          {!isPending ? (
            <FallbackTool
              toolName={toolName}
              input={toolInput}
              result={resultContent}
            />
          ) : null}
          <div className="pl-4">
            <a
              href={subagent ? `/c/${subagent.sessionId}/subagents/${subagent.subagentId}${window.location.hash || ''}` : undefined}
              target="_blank"
              rel="noreferrer"
              className={`text-sm flex items-center gap-1 ${subagent ? 'text-foreground hover:text-foreground/80 underline underline-offset-4' : 'text-muted-foreground'}`}
            >
              <CornerDownRight size={16} />
              {subagent ? (isPending ? '查看 sub-agent 执行进展' : '查看 sub-agent 执行过程') : 'sub-agent 详情暂不可用'}
            </a>
          </div>
        </div>
      );
    
    case 'exit_plan_mode':
    case 'ExitPlanMode':
      return (
        <PlanTool
          input={toolInput}
          result={resultContent}
        />
      );
    
    default:
      return (
        <>
          <FallbackTool
            toolName={toolName}
            input={toolInput}
            result={resultContent}
          />
          {backgroundTaskLink}
        </>
      );
  }
}

function BackgroundTaskLink({ task }: { task: BackgroundTaskSummary }) {
  const href = `/c/${task.sessionId}/background-tasks/${task.taskId}${window.location.hash || ''}`;
  const statusText = getBackgroundTaskStatusText(task);

  return (
    <div className="pl-4">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-sm flex items-center gap-1 text-foreground hover:text-foreground/80 underline underline-offset-4"
      >
        <Activity size={16} />
        查看后台任务 · {statusText}
      </a>
    </div>
  );
}

function getBackgroundTaskStatusText(task: BackgroundTaskSummary): string {
  if (task.status === 'running') return '运行中';
  if (task.status === 'completed') return task.exitCode !== undefined ? `已完成 (${task.exitCode})` : '已完成';
  if (task.status === 'failed') return task.exitCode !== undefined ? `失败 (${task.exitCode})` : '失败';
  if (task.status === 'stopped') return '已停止';
  return '状态未知';
}
