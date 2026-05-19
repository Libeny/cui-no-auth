import React, { useState, useEffect, useRef, useDeferredValue } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConversations } from '../../contexts/ConversationsContext';
import { api } from '../../services/api';
import { Header } from './Header';
import { ALL_DIRECTORIES_VALUE, Composer, ComposerRef } from '@/web/chat/components/Composer';
import { TaskTabs, type HomeTimeFilter } from './TaskTabs';
import { TaskList } from './TaskList';
import type { ConversationSourceFilter, EnvPreset } from '../../types';

export function Home() {
  const navigate = useNavigate();
  const { 
    conversations, 
    loading, 
    loadingMore, 
    hasMore, 
    error, 
    loadConversations, 
    loadMoreConversations,
    recentDirectories,
    getMostRecentWorkingDirectory,
    listRefreshFeedback,
  } = useConversations();
  const [sourceFilter, setSourceFilter] = useState<ConversationSourceFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [timeFilter, setTimeFilter] = useState<HomeTimeFilter>('today');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedDirectory, setSelectedDirectory] = useState<string | undefined>(ALL_DIRECTORIES_VALUE);
  const [envPresets, setEnvPresets] = useState<EnvPreset[]>([]);
  const [selectedEnvPresetId, setSelectedEnvPresetId] = useState<string | undefined>(undefined);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(true);
  const conversationCountRef = useRef(conversations.length);
  const composerRef = useRef<ComposerRef>(null);
  const refreshNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const lastListFeedbackTokenRef = useRef<number | null>(null);

  // Update the ref whenever conversations change
  useEffect(() => {
    conversationCountRef.current = conversations.length;
  }, [conversations.length]);

  useEffect(() => {
    return () => {
      if (refreshNoticeTimerRef.current) {
        clearTimeout(refreshNoticeTimerRef.current);
      }
    };
  }, []);

  // Load env presets on mount
  useEffect(() => {
    api.getEnvPresets().then(setEnvPresets).catch(() => { /* ignore */ });
  }, []);

  useEffect(() => {
    let cancelled = false;

    api.getAuthStatus()
      .then((status) => {
        if (!cancelled) {
          setReadOnly(status.readOnly !== false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReadOnly(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const getUpdatedAfterForTimeFilter = (filter: HomeTimeFilter): string | undefined => {
    if (filter === 'all') return undefined;

    const now = new Date();
    if (filter === 'today') {
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      return startOfDay.toISOString();
    }

    const hoursByFilter: Record<Exclude<HomeTimeFilter, 'all' | 'today'>, number> = {
      '1h': 1,
      '6h': 6,
      '3d': 24 * 3,
      '7d': 24 * 7,
    };
    return new Date(now.getTime() - hoursByFilter[filter] * 60 * 60 * 1000).toISOString();
  };

  const getConversationFilters = (
    projectPath: string | undefined = selectedDirectory,
    provider: ConversationSourceFilter = sourceFilter,
    query: string = deferredSearchQuery,
    time: HomeTimeFilter = timeFilter,
  ) => {
    const filters: {
      provider: ConversationSourceFilter;
      projectPath?: string;
      query?: string;
      updatedAfter?: string;
    } = { provider };

    const trimmedQuery = query.trim();
    if (trimmedQuery) {
      filters.query = trimmedQuery;
    }

    const updatedAfter = getUpdatedAfterForTimeFilter(time);
    if (updatedAfter) {
      filters.updatedAfter = updatedAfter;
    }

    if (projectPath && projectPath !== ALL_DIRECTORIES_VALUE) {
      filters.projectPath = projectPath;
    }

    return filters;
  };

  // Auto-refresh on navigation back to Home
  useEffect(() => {
    // Refresh on component mount if we have conversations
    if (conversationCountRef.current > 0) {
      loadConversations(conversationCountRef.current, getConversationFilters(selectedDirectory, sourceFilter, deferredSearchQuery, timeFilter));
    }
    
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array means this runs only on mount

  useEffect(() => {
    if (readOnly) {
      return;
    }

    // Focus the input after a brief delay to ensure DOM is ready
    const timer = setTimeout(() => {
      composerRef.current?.focusInput();
    }, 100);
    
    return () => clearTimeout(timer);
  }, [readOnly]);

  // Reload conversations when filters change
  useEffect(() => {
    const filters = getConversationFilters(selectedDirectory, sourceFilter, deferredSearchQuery, timeFilter);
    console.log('[Home] Loading conversations with filters:', filters);
    loadConversations(undefined, filters);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDirectory, sourceFilter, deferredSearchQuery, timeFilter]);

  const showRefreshNotice = (message: string) => {
    if (refreshNoticeTimerRef.current) {
      clearTimeout(refreshNoticeTimerRef.current);
    }
    setRefreshNotice(message);
    refreshNoticeTimerRef.current = setTimeout(() => {
      setRefreshNotice(null);
      refreshNoticeTimerRef.current = null;
    }, 2200);
  };

  useEffect(() => {
    if (!listRefreshFeedback || listRefreshFeedback.token === lastListFeedbackTokenRef.current) {
      return;
    }

    lastListFeedbackTokenRef.current = listRefreshFeedback.token;
    showRefreshNotice('已更新');
  }, [listRefreshFeedback]);

  const handleManualRefresh = async () => {
    setIsManualRefreshing(true);
    try {
      const outcome = await loadConversations(conversationCountRef.current || undefined, getConversationFilters(), false);
      showRefreshNotice(outcome === 'updated' ? '列表已更新' : '暂无最新消息');
    } finally {
      setIsManualRefreshing(false);
    }
  };

  const handleComposerSubmit = async (text: string, workingDirectory?: string, model?: string, permissionMode?: string, envPresetId?: string) => {
    if (readOnly) return;

    setIsSubmitting(true);

    try {
      const response = await api.startConversation({
        workingDirectory: workingDirectory || '',
        initialPrompt: text,
        model: model === 'default' ? undefined : model,
        permissionMode: permissionMode === 'default' ? undefined : permissionMode,
        envPresetId: envPresetId || undefined,
      });

      // Navigate to the conversation page
      navigate(`/c/${response.sessionId}`);
    } catch (error) {
      console.error('Failed to start conversation:', error);
      // You might want to show an error message to the user here
      alert(`Failed to start conversation: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-screen w-full bg-background">
      <Header onRefresh={handleManualRefresh} isRefreshing={isManualRefreshing} />

      <main className="relative flex flex-1 w-full h-full overflow-hidden transition-all duration-[250ms] z-[1]">
        {refreshNotice && (
          <div className="pointer-events-none fixed left-1/2 top-4 z-[60] -translate-x-1/2 rounded-full border border-border/60 bg-background/95 px-4 py-2 text-xs text-muted-foreground shadow-lg backdrop-blur-sm">
            {refreshNotice}
          </div>
        )}
        <div className="flex flex-col h-full w-full">
          <div className="z-0 mx-auto flex flex-col w-full max-w-3xl h-full">
            <div className="sticky top-0 z-50 flex flex-col items-center bg-background">
              <div className="flex items-center gap-3 mb-4 pt-4">
                <div className="flex items-center">
                  <div className="w-[27px] h-[27px] flex items-center justify-center">
                    <svg width="24" height="24" viewBox="4.5 5.2 11.7 13.3" fill="currentColor">
                      <circle cx="10.3613" cy="6.44531" r="1.03516" />
                      <circle cx="5.69336" cy="9.15039" r="1.03516" />
                      <circle cx="15.0195" cy="9.15039" r="1.03516" />
                      <circle cx="5.69336" cy="14.5801" r="1.03516" />
                      <circle cx="15.0195" cy="14.5801" r="1.03516" />
                      <circle cx="10.3613" cy="17.2754" r="1.03516" />
                      <path d="M10.3613 13.4961C11.2695 13.4961 11.9922 12.7734 11.9922 11.8652C11.9922 10.9668 11.25 10.2344 10.3613 10.2344C9.47266 10.2344 8.73047 10.9766 8.73047 11.8652C8.73047 12.7539 9.46289 13.4961 10.3613 13.4961Z" />
                    </svg>
                  </div>
                </div>
                <h1 className="text-2xl font-semibold font-sans text-foreground">{readOnly ? 'Conversations' : 'What is the next task?'}</h1>
              </div>
              
              <div className="w-full">
                <Composer 
                  ref={composerRef}
                  workingDirectory={selectedDirectory}
                  onSubmit={handleComposerSubmit}
                  isLoading={isSubmitting}
                  disabled={readOnly || isSubmitting}
                  placeholder={readOnly ? 'Read-only mode: starting conversations is disabled' : 'Describe your task'}
                  showDirectorySelector={true}
                  allowAllDirectoriesOption={true}
                  showModelSelector={true}
                  enableFileAutocomplete={false}
                  recentDirectories={recentDirectories}
                  getMostRecentWorkingDirectory={getMostRecentWorkingDirectory}
                  onDirectoryChange={(directory) => {
                    console.log('[Home] Directory changed:', directory);
                    setSelectedDirectory(directory);
                    // Focus input after directory change
                    setTimeout(() => {
                      composerRef.current?.focusInput();
                    }, 50);
                  }}
                  onModelChange={(model) => {
                    // Focus input after model change
                    setTimeout(() => {
                      composerRef.current?.focusInput();
                    }, 50);
                  }}
                  envPresets={envPresets}
                  selectedEnvPresetId={selectedEnvPresetId}
                  onEnvPresetChange={setSelectedEnvPresetId}
                  onFetchCommands={async (workingDirectory) => {
                    const response = await api.getCommands(workingDirectory);
                    return response.commands;
                  }}
                />
              </div>

              <TaskTabs 
                sourceFilter={sourceFilter}
                onSourceFilterChange={setSourceFilter}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                timeFilter={timeFilter}
                onTimeFilterChange={setTimeFilter}
              />
            </div>

            <TaskList 
              scrollRef={listContainerRef}
              conversations={conversations}
              loading={loading}
              loadingMore={loadingMore}
              hasMore={hasMore}
              error={error}
              onLoadMore={() => loadMoreConversations()}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
