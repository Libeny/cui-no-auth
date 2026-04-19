import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConversations } from '../../contexts/ConversationsContext';
import { api } from '../../services/api';
import { Header } from './Header';
import { ALL_DIRECTORIES_VALUE, Composer, ComposerRef } from '@/web/chat/components/Composer';
import { TaskTabs } from './TaskTabs';
import { TaskList } from './TaskList';
import type { EnvPreset } from '../../types';

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
  const [activeTab, setActiveTab] = useState<'tasks' | 'history' | 'archive'>('tasks');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedDirectory, setSelectedDirectory] = useState<string | undefined>(ALL_DIRECTORIES_VALUE);
  const [envPresets, setEnvPresets] = useState<EnvPreset[]>([]);
  const [selectedEnvPresetId, setSelectedEnvPresetId] = useState<string | undefined>(undefined);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
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

  // Get filter parameters based on active tab + selected directory
  const getFiltersForTab = (tab: 'tasks' | 'history' | 'archive', projectPath?: string) => {
    const base = (() => {
      switch (tab) {
        case 'tasks':
          return { archived: false, hasContinuation: false };
        case 'history':
          return { hasContinuation: true };
        case 'archive':
          return { archived: true, hasContinuation: false };
        default:
          return {};
      }
    })();
    return projectPath && projectPath !== ALL_DIRECTORIES_VALUE ? { ...base, projectPath } : base;
  };

  // Auto-refresh on navigation back to Home
  useEffect(() => {
    // Refresh on component mount if we have conversations
    if (conversationCountRef.current > 0) {
      loadConversations(conversationCountRef.current, getFiltersForTab(activeTab, selectedDirectory));
    }
    
    // Focus the input after a brief delay to ensure DOM is ready
    const timer = setTimeout(() => {
      composerRef.current?.focusInput();
    }, 100);
    
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array means this runs only on mount

  // Reload conversations when tab or directory changes
  useEffect(() => {
    const filters = getFiltersForTab(activeTab, selectedDirectory);
    console.log('[Home] Loading conversations with filters:', filters);
    loadConversations(undefined, filters);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedDirectory]);

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
    const container = listContainerRef.current;
    const scrollTop = container?.scrollTop ?? 0;
    showRefreshNotice(scrollTop > 80 ? '列表已更新，请向上查看' : '列表已更新');
  }, [listRefreshFeedback]);

  const handleManualRefresh = async () => {
    setIsManualRefreshing(true);
    try {
      const outcome = await loadConversations(conversationCountRef.current || undefined, undefined, false);
      showRefreshNotice(outcome === 'updated' ? '列表已更新' : '暂无最新消息');
    } finally {
      setIsManualRefreshing(false);
    }
  };

  // Auto-refresh on focus - REMOVED
  // Real-time updates are now handled by SSE in ConversationsContext
  /*
  useEffect(() => {
    const handleFocus = () => {
      // Only refresh if we have loaded conversations before
      if (conversationCountRef.current > 0) {
        loadConversations(conversationCountRef.current, getFiltersForTab(activeTab));
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && conversationCountRef.current > 0) {
        loadConversations(conversationCountRef.current, getFiltersForTab(activeTab));
      }
    };

    // Listen for window focus
    window.addEventListener('focus', handleFocus);
    // Listen for tab visibility change
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadConversations, activeTab]);
  */

  const handleComposerSubmit = async (text: string, workingDirectory?: string, model?: string, permissionMode?: string, envPresetId?: string) => {
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
        <div className="flex flex-col h-full w-full">
          <div className="z-0 mx-auto flex flex-col w-full max-w-3xl h-full">
            <div className="sticky top-0 z-50 flex flex-col items-center bg-background">
              {refreshNotice && (
                <div className="mb-2 rounded-full border border-border/60 bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                  {refreshNotice}
                </div>
              )}
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
                <h1 className="text-2xl font-semibold font-sans text-foreground">What is the next task?</h1>
              </div>
              
              <div className="w-full">
                <Composer 
                  ref={composerRef}
                  workingDirectory={selectedDirectory}
                  onSubmit={handleComposerSubmit}
                  isLoading={isSubmitting}
                  placeholder="Describe your task"
                  showDirectorySelector={true}
                  allowAllDirectoriesOption={true}
                  showModelSelector={true}
                  enableFileAutocomplete={true}
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
                  onFetchFileSystem={async (directory) => {
                    const response = await api.listDirectory({
                      path: directory,
                      recursive: true,
                      respectGitignore: true,
                    });
                    return response.entries;
                  }}
                  onFetchCommands={async (workingDirectory) => {
                    const response = await api.getCommands(workingDirectory);
                    return response.commands;
                  }}
                />
              </div>

              <TaskTabs 
                activeTab={activeTab}
                onTabChange={setActiveTab}
              />
            </div>

            <TaskList 
              scrollRef={listContainerRef}
              conversations={conversations}
              loading={loading}
              loadingMore={loadingMore}
              hasMore={hasMore}
              error={error}
              activeTab={activeTab}
              onLoadMore={(filters) => loadMoreConversations(
                selectedDirectory && selectedDirectory !== ALL_DIRECTORIES_VALUE
                  ? { ...filters, projectPath: selectedDirectory }
                  : filters
              )}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
