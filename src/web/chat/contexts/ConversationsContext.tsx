import React, { createContext, useContext, useState, useEffect, ReactNode, useRef } from 'react';
import { api } from '../services/api';
import { useStreamStatus } from './StreamStatusContext';
import { useStreaming } from '../hooks/useStreaming';
import type { ConversationSummary, WorkingDirectory, ConversationSummaryWithLiveStatus, StreamEvent } from '../types';

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
  loadConversations: (limit?: number, filters?: {
    hasContinuation?: boolean;
    archived?: boolean;
    pinned?: boolean;
  }, showLoading?: boolean) => Promise<void>;
  loadMoreConversations: () => Promise<void>;
  getMostRecentWorkingDirectory: () => string | null;
}

const ConversationsContext = createContext<ConversationsContextType | undefined>(undefined);

const INITIAL_LIMIT = 20;
const LOAD_MORE_LIMIT = 40;

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<ConversationSummaryWithLiveStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recentDirectories, setRecentDirectories] = useState<Record<string, RecentDirectory>>({});
  const { subscribeToStreams, getStreamStatus, streamStatuses } = useStreamStatus();
  
  // Track current state for event handlers
  const conversationsRef = useRef(conversations);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);

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

  const loadConversations = async (limit?: number, filters?: {
    hasContinuation?: boolean;
    archived?: boolean;
    pinned?: boolean;
  }, showLoading: boolean = true) => {
    if (showLoading) {
      setLoading(true);
      setError(null);
    }
    
    try {
      const loadLimit = limit || INITIAL_LIMIT;
      // Load working directories from API in parallel with conversations
      const [data, apiDirectories] = await Promise.all([
        api.getConversations({ 
          limit: loadLimit,
          offset: 0,
          sortBy: 'updated',
          order: 'desc',
          ...filters
        }),
        loadWorkingDirectories()
      ]);
      
      setConversations(data.conversations);
      updateRecentDirectories(data.conversations, apiDirectories);
      setHasMore(data.conversations.length === loadLimit);
      
      // Subscribe to streams for ongoing conversations
      const ongoingStreamIds = data.conversations
        .filter(conv => conv.status === 'ongoing' && conv.streamingId)
        .map(conv => conv.streamingId as string);
      
      if (ongoingStreamIds.length > 0) {
        subscribeToStreams(ongoingStreamIds);
      }
    } catch (err) {
      if (showLoading) setError('Failed to load conversations');
      console.error('Error loading conversations:', err);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  const loadMoreConversations = async (filters?: {
    hasContinuation?: boolean;
    archived?: boolean;
    pinned?: boolean;
  }) => {
    if (loadingMore || !hasMore) return;
    
    setLoadingMore(true);
    setError(null);
    try {
      const data = await api.getConversations({ 
        limit: LOAD_MORE_LIMIT,
        offset: conversations.length,
        sortBy: 'updated',
        order: 'desc',
        ...filters
      });
      
      if (data.conversations.length === 0) {
        setHasMore(false);
      } else {
        setConversations(prev => {
          // Create a set of existing session IDs to avoid duplicates
          const existingIds = new Set(prev.map(conv => conv.sessionId));
          const newConversations = data.conversations.filter(conv => !existingIds.has(conv.sessionId));
          return [...prev, ...newConversations];
        });
        // When loading more, we don't need to fetch API directories again
        updateRecentDirectories([...conversations, ...data.conversations]);
        setHasMore(data.conversations.length === LOAD_MORE_LIMIT);
        
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

  // Effect to merge live status with conversations
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

  // Subscribe to global events for real-time list updates
  useStreaming('global', {
    onMessage: (event) => {
      if (event.type === 'index_update') {
        // Refresh the list silently when any session is updated
        // Use current conversations length to maintain pagination
        const currentCount = conversationsRef.current.length || INITIAL_LIMIT;
        // Note: we can't easily access current filters here, so we default.
        // If strict filter correctness is needed, filters should be moved to state.
        // For now, reloading with default filters is acceptable or we pass empty filters 
        // which might reset tab view? Actually `loadConversations` uses default filters if not passed.
        // To do this perfectly, we'd need to lift `activeTab` or filters into this context.
        // For MVP, let's just reload.
        loadConversations(currentCount, undefined, false);
      }
    }
  });

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
        getMostRecentWorkingDirectory 
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