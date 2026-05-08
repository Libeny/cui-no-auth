import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Activity, FileText } from 'lucide-react';
import { ConversationHeader } from '../ConversationHeader/ConversationHeader';
import { api } from '../../services/api';
import type { BackgroundTaskDetailsResponse, BackgroundTaskSummary } from '../../types';
import { Badge } from '@/web/chat/components/ui/badge';

export function BackgroundTaskView() {
  const { sessionId, taskId } = useParams<{ sessionId: string; taskId: string }>();
  const [details, setDetails] = useState<BackgroundTaskDetailsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !taskId) return;

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const response = await api.getBackgroundTaskDetails(sessionId, taskId);
        if (cancelled) return;
        setDetails(response);
        setError(null);

        if (response.task.status === 'running') {
          refreshTimer = setTimeout(load, 2000);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Failed to load background task');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    };
  }, [sessionId, taskId]);

  const task = details?.task;

  return (
    <div className="h-full flex flex-col bg-background relative" role="main" aria-label="Background task view">
      <ConversationHeader
        title={task?.description || task?.summary || taskId || 'Background task'}
        backHref={sessionId ? `/c/${sessionId}` : '/'}
        subtitle={{
          date: task?.createdAt
            ? new Date(task.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : undefined,
          repo: `background task · ${task ? getStatusText(task) : 'loading'}`,
        }}
      />

      {error ? (
        <div
          className="bg-red-500/10 border-b border-red-500 text-red-600 dark:text-red-400 px-4 py-2 text-sm text-center"
          role="alert"
          aria-label="Background task load error"
        >
          {error}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {isLoading && !details ? (
            <div className="text-sm text-muted-foreground">Loading background task...</div>
          ) : null}

          {task ? (
            <>
              <TaskMetadata task={task} outputSource={details?.outputSource || 'none'} />
              <section className="min-w-0">
                <div className="mb-2 flex items-center gap-2 text-xs font-mono text-muted-foreground">
                  <FileText size={14} />
                  <span>Output</span>
                  {details?.outputTruncated ? <Badge variant="outline">tail</Badge> : null}
                </div>
                <pre className="min-h-40 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/30 p-3 text-xs leading-relaxed text-foreground">
                  {details?.output || 'No output captured yet.'}
                </pre>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TaskMetadata({ task, outputSource }: { task: BackgroundTaskSummary; outputSource: BackgroundTaskDetailsResponse['outputSource'] }) {
  return (
    <section className="grid gap-2 rounded-md border border-border/70 bg-background p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={task.status === 'failed' ? 'destructive' : task.status === 'running' ? 'secondary' : 'outline'}>
          <Activity size={12} />
          {getStatusText(task)}
        </Badge>
        {task.taskType ? <Badge variant="outline">{task.taskType}</Badge> : null}
        <Badge variant="outline">{outputSource === 'file' ? 'live .output' : outputSource === 'snapshot' ? 'persisted snapshot' : 'no output'}</Badge>
      </div>
      <div className="grid gap-1 text-muted-foreground">
        <MetadataRow label="Task ID" value={task.taskId} />
        <MetadataRow label="Output file" value={task.outputFile || 'Not recorded'} />
        <MetadataRow label="File state" value={task.outputFileExists ? formatFileState(task) : 'Missing'} />
        {task.summary ? <MetadataRow label="Summary" value={task.summary} /> : null}
        {task.updatedAt ? <MetadataRow label="Updated" value={new Date(task.updatedAt).toLocaleString()} /> : null}
      </div>
    </section>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[96px_1fr]">
      <span className="font-mono text-muted-foreground/80">{label}</span>
      <span className="min-w-0 break-all text-foreground">{value}</span>
    </div>
  );
}

function getStatusText(task: BackgroundTaskSummary): string {
  if (task.status === 'running') return '运行中';
  if (task.status === 'completed') return task.exitCode !== undefined ? `已完成 (${task.exitCode})` : '已完成';
  if (task.status === 'failed') return task.exitCode !== undefined ? `失败 (${task.exitCode})` : '失败';
  return '状态未知';
}

function formatFileState(task: BackgroundTaskSummary): string {
  const parts = ['Exists'];
  if (task.outputFileSize !== undefined) {
    parts.push(`${task.outputFileSize} bytes`);
  }
  if (task.outputFileUpdatedAt) {
    parts.push(new Date(task.outputFileUpdatedAt).toLocaleString());
  }
  return parts.join(' · ');
}
