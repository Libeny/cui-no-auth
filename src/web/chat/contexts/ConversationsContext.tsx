import React, { createContext, useContext, useState, useEffect, ReactNode, useRef } from 'react';
import { api } from '../services/api';
import { useStreamStatus } from './StreamStatusContext';
import { useStreaming } from '../hooks/useStreaming';
import type { ConversationSourceFilter, ConversationSummary, WorkingDirectory, ConversationSummaryWithLiveStatus, StreamEvent } from '../types';

type ConversationFilters = {
  hasContinuation?: boolean;
  archived?: boolean;
  pinned?: boolean;
  projectPath?: string;
  provider?: ConversationSourceFilter;
};

interface RecentDirectory {
  lastDate: string;
  shortname: string;
}

interface ConversationsContextType {
  conversations: ConversationSummaryWithLiveStatus[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  recentDirectories: Record<string, RecentDirectory>;
  loadConversations: (limit?: number, filters?: ConversationFilters, showLoading?: boolean) => Promise<'updated' | 'noop'>;
  loadMoreConversations: (filters?: ConversationFilters) => Promise<void>;
  getMostRecentWorkingDirectory: () => string | null;
  listRefreshFeedback: {
    outcome: 'updated';
    source: 'auto';
    token: number;
  } | null;
}

const ConversationsContext = createContext<ConversationsContextType | undefined>(undefined);

const INITIAL_LIMIT = 20;
const LOAD_MORE_LIMIT = 40;
const INDEX_UPDATE_THROTTLE_MS = 30000;

function getConversationProvider(conversation: Pick<ConversationSummary, 'sessionId' | 'provider'>): 'claude' | 'codex' {
  return conversation.provider || (conversation.sessionId.startsWith('codex:') ? 'codex' : 'claude');
}

function withProvider<T extends ConversationSummary>(conversation: T, fallback?: 'claude' | 'codex'): T {
  return {
    ...conversation,
    provider: conversation.provider || fallback || getConversationProvider(conversation),
  };
}

function sortConversationsByUpdated<T extends ConversationSummary>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function dedupeConversationsBySessionId<T extends ConversationSummary>(items: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const item of items) {
    if (seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    deduped.push(item);
  }

  return deduped;
}

async function loadConversationPage(
  limit: number,
  offset: number,
  filters: ConversationFilters,
): Promise<{ conversations: ConversationSummaryWithLiveStatus[]; total: number }> {
  const { provider = 'all', ...queryFilters } = filters;
  const baseQuery = {
    ...queryFilters,
    sortBy: 'updated' as const,
    order: 'desc' as const,
  };

  if (provider === 'claude') {
    const data = await api.getConversations({ ...baseQuery, limit, offset });
    return {
      conversations: data.conversations.map((conversation) => withProvider(conversation, 'claude')),
      total: data.total,
    };
  }

  if (provider === 'codex') {
    const data = await api.getCodexConversations({ ...baseQuery, limit, offset });
    return {
      conversations: data.conversations.map((conversation) => withProvider(conversation, 'codex')),
      total: data.total,
    };
  }

  const mergedLimit = offset + limit;
  const [claudeData, codexData] = await Promise.all([
    api.getConversations({ ...baseQuery, limit: mergedLimit, offset: 0 }),
    api.getCodexConversations({ ...baseQuery, limit: mergedLimit, offset: 0 }),
  ]);
  const merged = dedupeConversationsBySessionId(sortConversationsByUpdated([
    ...claudeData.conversations.map((conversation) => withProvider(conversation, 'claude')),
    ...codexData.conversations.map((conversation) => withProvider(conversation, 'codex')),
  ]));

  return {
    conversations: merged.slice(offset, offset + limit),
    total: claudeData.total + codexData.total,
  };
}

function conversationMatchesFilters(conversation: ConversationSummary, filters: ConversationFilters): boolean {
  const provider = getConversationProvider(conversation);
  if (filters.provider && filters.provider !== 'all' && provider !== filters.provider) return false;
  if (filters.projectPath && conversation.projectPath !== filters.projectPath) return false;
  if (filters.archived !== undefined && Boolean(conversation.sessionInfo.archived) !== filters.archived) return false;
  if (filters.pinned !== undefined && Boolean(conversation.sessionInfo.pinned) !== filters.pinned) return false;
  if (filters.hasContinuation !== undefined && Boolean(conversation.sessionInfo.continuation_session_id) !== filters.hasContinuation) return false;
  return true;
}

function conversationFromUpdate(sessionId: string, metadata: any): ConversationSummaryWithLiveStatus {
  const provider = metadata?.provider || (sessionId.startsWith('codex:') ? 'codex' : 'claude');
  const createdAt = metadata.createdAt || new Date().toISOString();
  const updatedAt = metadata.updatedAt || createdAt;

  return {
    ...metadata,
    provider,
    sessionId,
    projectPath: metadata.projectPath || metadata.sessionInfo?.project_path || '',
    summary: metadata.summary || metadata.sessionInfo?.summary || 'No summary available',
    sessionInfo: metadata.sessionInfo || {
      custom_name: '',
      created_at: createdAt,
      updated_at: updatedAt,
      version: provider === 'codex' ? 1 : 3,
      pinned: false,
      archived: false,
      continuation_session_id: '',
      initial_commit_head: '',
      permission_mode: 'default',
      summary: metadata.summary,
      project_path: metadata.projectPath,
      message_count: metadata.messageCount,
      model: metadata.model,
      sessionId,
    },
    createdAt,
    updatedAt,
    messageCount: metadata.messageCount || 0,
    totalDuration: metadata.totalDuration || 0,
    model: metadata.model || 'Unknown',
    status: metadata.status || 'completed',
  };
}

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<ConversationSummaryWithLiveStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recentDirectories, setRecentDirectories] = useState<Record<string, RecentDirectory>>({});
  const [listRefreshFeedback, setListRefreshFeedback] = useState<{
    outcome: 'updated';
    source: 'auto';
    token: number;
  } | null>(null);
  const { subscribeToStreams, getStreamStatus, streamStatuses } = useStreamStatus();
  
  // Track current state for event handlers
  const conversationsRef = useRef(conversations);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);

  // Track active filters so ALL refresh paths (SSE, archive, pin, etc.) reuse them
  const activeFiltersRef = useRef<ConversationFilters>({});
  const lastIndexRefreshAtRef = useRef(0);
  const pendingIndexRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadWorkingDirectories = async (): Promise<Record<string, RecentDirectory> | null> => {
    try {
      const response = await api.getWorkingDirectories();
      const directories: Record<string, RecentDirectory> = {};
      
      response.directories.forEach(dir => {
        directories[dir.path] = {
          lastDate: dir.lastDate,
          shortname: dir.shortname
        };
      });
      
      return directories;
    } catch (err) {
      console.error('Failed to load working directories from API:', err);
      return null;
    }
  };

  const updateRecentDirectories = (convs: ConversationSummary[], apiDirectories?: Record<string, RecentDirectory> | null) => {
    const newDirectories: Record<string, RecentDirectory> = {};
    
    // First, add API directories if available
    if (apiDirectories) {
      Object.assign(newDirectories, apiDirectories);
    }
    
    // Then, process conversations and merge with API data
    convs.forEach(conv => {
      if (conv.projectPath) {
        const pathParts = conv.projectPath.split('/');
        const shortname = pathParts[pathParts.length - 1] || conv.projectPath;
        
        // If API didn't provide this directory, or if conversation is more recent
        if (!newDirectories[conv.projectPath] || 
            new Date(conv.updatedAt) > new Date(newDirectories[conv.projectPath].lastDate)) {
          newDirectories[conv.projectPath] = {
            lastDate: conv.updatedAt,
            shortname: apiDirectories?.[conv.projectPath]?.shortname || shortname
          };
        }
      }
    });
    
    setRecentDirectories(newDirectories);
  };

  const buildListFingerprint = (items: ConversationSummaryWithLiveStatus[]) =>
    items
      .map((item) => `${getConversationProvider(item)}:${item.sessionId}:${item.updatedAt}:${item.summary}:${item.status}`)
      .join('|');

  const loadConversations = async (limit?: number, filters?: ConversationFilters, showLoading: boolean = true): Promise<'updated' | 'noop'> => {
    // When filters are explicitly provided, persist them as active filters.
    // When filters are undefined (e.g. from TaskList archive/pin/rename),
    // reuse the last active filters to preserve projectPath filtering.
    if (filters !== undefined) {
      activeFiltersRef.current = filters;
    }
    const effectiveFilters = filters ?? activeFiltersRef.current;

    if (showLoading) {
      setLoading(true);
      setError(null);
    }

    try {
      const loadLimit = limit || INITIAL_LIMIT;
      const previousFingerprint = buildListFingerprint(conversationsRef.current);
      // Load working directories from API in parallel with conversations
      const [data, apiDirectories] = await Promise.all([
        loadConversationPage(loadLimit, 0, effectiveFilters),
        loadWorkingDirectories()
      ]);
      
      const nextConversations = dedupeConversationsBySessionId(data.conversations);
      setConversations(nextConversations);
      updateRecentDirectories(nextConversations, apiDirectories);
      setHasMore(nextConversations.length < data.total);
      const nextFingerprint = buildListFingerprint(nextConversations);
      
      // Subscribe to streams for ongoing conversations
      const ongoingStreamIds = nextConversations
        .filter(conv => conv.status === 'ongoing' && conv.streamingId)
        .map(conv => conv.streamingId as string);
      
      if (ongoingStreamIds.length > 0) {
        subscribeToStreams(ongoingStreamIds);
      }
      return nextFingerprint !== previousFingerprint ? 'updated' : 'noop';
    } catch (err) {
      if (showLoading) setError('Failed to load conversations');
      console.error('Error loading conversations:', err);
      return 'noop';
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  const loadMoreConversations = async (filters?: ConversationFilters) => {
    if (loadingMore || !hasMore) return;

    // Use provided filters or fall back to active filters (preserves projectPath)
    const effectiveFilters = filters ?? activeFiltersRef.current;

    setLoadingMore(true);
    setError(null);
    try {
      const offset = conversationsRef.current.length;
      const data = await loadConversationPage(LOAD_MORE_LIMIT, offset, effectiveFilters);
      
      if (data.conversations.length === 0) {
        setHasMore(false);
      } else {
        setConversations(prev => {
          // Create a set of existing session IDs to avoid duplicates
          const existingIds = new Set(prev.map(conv => conv.sessionId));
          const newConversations = data.conversations.filter(conv => !existingIds.has(conv.sessionId));
          return dedupeConversationsBySessionId(sortConversationsByUpdated([...prev, ...newConversations]));
        });
        // When loading more, we don't need to fetch API directories again
        updateRecentDirectories([...conversationsRef.current, ...data.conversations]);
        setHasMore(offset + data.conversations.length < data.total);
        
        // Subscribe to streams for any new ongoing conversations
        const newOngoingStreamIds = data.conversations
          .filter(conv => conv.status === 'ongoing' && conv.streamingId)
          .map(conv => conv.streamingId as string);
        
        if (newOngoingStreamIds.length > 0) {
          subscribeToStreams(newOngoingStreamIds);
        }
      }
    } catch (err) {
      setError('Failed to load more conversations');
      console.error('Error loading more conversations:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  const getMostRecentWorkingDirectory = (): string | null => {
    if (conversations.length === 0) return null;
    
    // Sort by updatedAt to get the most recently used
    const sorted = [...conversations].sort((a, b) => 
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    
    return sorted[0]?.projectPath || null;
  };

  const scheduleThrottledIndexRefresh = () => {
    const now = Date.now();
    const elapsed = now - lastIndexRefreshAtRef.current;
    const runRefresh = () => {
      lastIndexRefreshAtRef.current = Date.now();
      pendingIndexRefreshRef.current = null;
      const currentCount = conversationsRef.current.length || INITIAL_LIMIT;
      loadConversations(currentCount, activeFiltersRef.current, false);
    };

    if (elapsed >= INDEX_UPDATE_THROTTLE_MS && !pendingIndexRefreshRef.current) {
      runRefresh();
      return;
    }

    if (pendingIndexRefreshRef.current) {
      return;
    }

    const delay = Math.max(0, INDEX_UPDATE_THROTTLE_MS - elapsed);
    pendingIndexRefreshRef.current = setTimeout(runRefresh, delay);
  };

  const applySessionListUpdate = (sessionId: string, eventType: 'created' | 'modified', metadata: any) => {
    const nextConversation = conversationFromUpdate(sessionId, metadata);
    const matchesActiveFilters = conversationMatchesFilters(nextConversation, activeFiltersRef.current);

    setConversations(prev => {
      const existingIndex = prev.findIndex(c => c.sessionId === sessionId);

      if (!matchesActiveFilters) {
        return existingIndex >= 0 ? prev.filter((_, index) => index !== existingIndex) : prev;
      }

      if (eventType === 'created') {
        if (existingIndex === -1) {
          return sortConversationsByUpdated([nextConversation, ...prev]);
        }
        return prev;
      }

      if (existingIndex >= 0) {
        const oldUpdatedAt = new Date(prev[existingIndex].updatedAt).getTime();
        const newUpdatedAt = new Date(nextConversation.updatedAt).getTime();

        if (newUpdatedAt > oldUpdatedAt) {
          const updatedSession = {
            ...prev[existingIndex],
            ...nextConversation,
            sessionInfo: {
              ...prev[existingIndex].sessionInfo,
              ...(nextConversation.sessionInfo || {}),
              updated_at: nextConversation.updatedAt,
              message_count: nextConversation.messageCount,
              summary: nextConversation.summary || prev[existingIndex].sessionInfo.summary,
              project_path: nextConversation.projectPath || prev[existingIndex].sessionInfo.project_path,
              model: nextConversation.model || prev[existingIndex].sessionInfo.model,
            },
          };
          const newList = prev.filter((_, i) => i !== existingIndex);
          return sortConversationsByUpdated([updatedSession, ...newList]);
        }

        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          ...nextConversation,
          sessionInfo: {
            ...updated[existingIndex].sessionInfo,
            ...(nextConversation.sessionInfo || {}),
            message_count: nextConversation.messageCount,
            summary: nextConversation.summary || updated[existingIndex].sessionInfo.summary,
          },
        };
        return updated;
      }

      if (prev.length === 0 || new Date(nextConversation.updatedAt) > new Date(prev[0].updatedAt)) {
        return sortConversationsByUpdated([nextConversation, ...prev]);
      }

      return prev;
    });

    if (nextConversation.projectPath) {
      setRecentDirectories(prev => {
        const pathParts = nextConversation.projectPath.split('/');
        const shortname = pathParts[pathParts.length - 1] || nextConversation.projectPath;

        return {
          ...prev,
          [nextConversation.projectPath]: {
            lastDate: nextConversation.updatedAt,
            shortname: prev[nextConversation.projectPath]?.shortname || shortname,
          },
        };
      });
    }

    setListRefreshFeedback({
      outcome: 'updated',
      source: 'auto',
      token: Date.now(),
    });
  };

  // Effect to merge live status with conversations - REMOVED for performance optimization
  // The TaskItem component now handles live status subscription individually
  // via the LiveTaskStatus component.
  /*
  useEffect(() => {
    setConversations(prevConversations => {
      return prevConversations.map(conv => {
        // If conversation has a streamingId and is ongoing, merge with live status
        if (conv.streamingId && conv.status === 'ongoing') {
          const liveStatus = getStreamStatus(conv.streamingId);
          if (liveStatus) {
            return {
              ...conv,
              liveStatus,
              // Update status to completed if stream indicates completion
              status: liveStatus.connectionState === 'disconnected' && 
                      liveStatus.currentStatus === 'Completed' ? 'completed' : conv.status
            };
          }
        }
        return conv;
      });
    });
  }, [streamStatuses, getStreamStatus]);
  */

  // Subscribe to global events for real-time list updates
  useStreaming('global', {
    onMessage: (event) => {
      console.log('[ConversationsContext] onMessage called, event type:', event.type);
      if (event.type === 'index_update') {
        scheduleThrottledIndexRefresh();
      } else if (event.type === 'session_list_update') {
        const { sessionId, eventType, metadata } = event.data;
        applySessionListUpdate(sessionId, eventType, metadata);
      }
    }
  });

  useEffect(() => {
    return () => {
      if (pendingIndexRefreshRef.current) {
        clearTimeout(pendingIndexRefreshRef.current);
      }
    };
  }, []);

  return (
    <ConversationsContext.Provider 
      value={{ 
        conversations, 
        loading, 
        loadingMore, 
        hasMore, 
        error, 
        recentDirectories,
        loadConversations, 
        loadMoreConversations, 
        getMostRecentWorkingDirectory,
        listRefreshFeedback,
      }}
    >
      {children}
    </ConversationsContext.Provider>
  );
}

export function useConversations() {
  const context = useContext(ConversationsContext);
  if (context === undefined) {
    throw new Error('useConversations must be used within a ConversationsProvider');
  }
  return context;
}
