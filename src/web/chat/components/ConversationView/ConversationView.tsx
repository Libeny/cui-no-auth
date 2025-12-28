import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { MessageList } from '../MessageList/MessageList';
import { Composer, ComposerRef } from '@/web/chat/components/Composer';
import { ConversationHeader } from '../ConversationHeader/ConversationHeader';
import { api } from '../../services/api';
import { useStreaming, useConversationMessages } from '../../hooks';
import type { ChatMessage, ConversationDetailsResponse, ConversationMessage, ConversationSummary } from '../../types';

// Wrapper component to force full remount on session change
export function ConversationView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  // Use sessionId as key to force complete remount of the content component
  // This ensures all state (messages, streaming, etc.) is reset instantly without stale data flash
  return <ConversationViewContent key={sessionId} sessionId={sessionId} />;
}

// Inner component with actual logic
function ConversationViewContent({ sessionId }: { sessionId?: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState<string>('Conversation');
  const [isPermissionDecisionLoading, setIsPermissionDecisionLoading] = useState(false);
  const [conversationSummary, setConversationSummary] = useState<ConversationSummary | null>(null);
  const [currentWorkingDirectory, setCurrentWorkingDirectory] = useState<string>('');
  const composerRef = useRef<ComposerRef>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // activeSessionIdRef is no longer strictly needed for race conditions due to key={sessionId}, 
  // but kept for safety in async callbacks
  const activeSessionIdRef = useRef<string | null>(sessionId || null);

  // Use shared conversation messages hook
  const {
    messages,
    toolResults,
    currentPermissionRequest,
    childrenMessages,
    expandedTasks,
    clearMessages,
    addMessage,
    setAllMessages,
    handleStreamMessage,
    toggleTaskExpanded,
    clearPermissionRequest,
    setPermissionRequest,
  } = useConversationMessages({
    onResult: (newSessionId) => {
      // Navigate to the new session page if session changed
      if (newSessionId && newSessionId !== sessionId) {
        navigate(`/c/${newSessionId}`);
      }
    },
    onError: (err) => {
      setError(err);
      setStreamingId(null);
    },
    onClosed: () => {
      setStreamingId(null);
    },
  });

  // Clear navigation state to prevent issues on refresh
  useEffect(() => {
    const state = location.state;
    
    if (state) {
      // Clear the state to prevent issues on refresh
      window.history.replaceState({}, document.title);
    }
  }, [location]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Cancel pending request and clear streaming when unmounting
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Fetch conversation data
  const fetchConversation = useCallback(async (showLoading = true, shouldFocus = true) => {
    if (!sessionId) return;

    // Cancel any previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    if (showLoading) {
      setIsLoading(true);
      setError(null);
    }

    try {
      const details = await api.getConversationDetails(sessionId);

      console.log('[ConversationView] API 返回数据:', {
        messagesCount: details.messages?.length,
        totalMessages: details.totalMessages
      });

      const chatMessages = convertToChatlMessages(details);
      console.log('[ConversationView] 转换后消息数:', chatMessages.length);

      // Load all messages from backend
      setAllMessages(chatMessages);
      console.log('[ConversationView] setAllMessages 已调用');
      
      // Set working directory from the most recent message with a working directory
      const messagesWithCwd = chatMessages.filter(msg => msg.workingDirectory);
      if (messagesWithCwd.length > 0) {
        const latestCwd = messagesWithCwd[messagesWithCwd.length - 1].workingDirectory;
        if (latestCwd) {
          setCurrentWorkingDirectory(latestCwd);
        }
      }
      
      // Check if this conversation has an active stream
      const conversationsResponse = await api.getConversations({ limit: 100 });

      const currentConversation = conversationsResponse.conversations.find(
        conv => conv.sessionId === sessionId
      );
      
      if (currentConversation) {
        setConversationSummary(currentConversation);
        
        // Set conversation title from custom name or summary
        const title = currentConversation.sessionInfo.custom_name || currentConversation.summary || 'Untitled';
        setConversationTitle(title);
        
        if (currentConversation.status === 'ongoing' && currentConversation.streamingId) {
          // Active stream, check for existing pending permissions
          setStreamingId(currentConversation.streamingId);
          
          try {
            const { permissions } = await api.getPermissions({
              streamingId: currentConversation.streamingId,
              status: 'pending'
            });
            
            if (permissions.length > 0) {
              // Take the most recent pending permission (by timestamp)
              const mostRecentPermission = permissions.reduce((latest, current) => 
                new Date(current.timestamp) > new Date(latest.timestamp) ? current : latest
              );
              
              setPermissionRequest(mostRecentPermission);
            }
          } catch (permissionError) {
            // Don't break conversation loading if permission fetching fails
            console.warn('[ConversationView] Failed to fetch existing permissions:', permissionError);
          }
        }
      }
    } catch (err: any) {
      // Ignore AbortError as it's intentional
      if (err.name === 'AbortError') return;

      if (showLoading) setError(err.message || 'Failed to load conversation');
      console.error('Failed to refresh conversation:', err);
    } finally {
      if (showLoading) setIsLoading(false);
      
      // Focus the input after loading is complete
      if (shouldFocus) {
        setTimeout(() => {
          composerRef.current?.focusInput();
        }, 100);
      }
    }
  }, [sessionId, setAllMessages, setPermissionRequest]);

  // Initial load
  useEffect(() => {
    fetchConversation(true, true);
  }, [fetchConversation]);

  // Listen for content updates on session-specific stream
  // Only connect AFTER initial load is complete to prevent connection flooding during rapid switching
  const sessionStreamId = (!isLoading && sessionId) ? `session-${sessionId}` : null;
  useStreaming(sessionStreamId, {
    onMessage: (event) => {
      if (event.type === 'session_content_update') {
        // Handle real-time content updates for this session
        const { messages: newMessages } = event.data;

        if (newMessages && Array.isArray(newMessages)) {
          console.log('[ConversationView] Received content update, new messages:', newMessages.length);

          // Add each new message to the conversation
          newMessages.forEach((msg: any) => {
            handleStreamMessage(msg);
          });
        }
      }
    }
  });

  // Subscribe to session content updates (for historical/completed sessions)
  useEffect(() => {
    if (!sessionId || isLoading) return;

    // Generate or retrieve client ID
    let clientId = sessionStorage.getItem('cui-client-id');
    if (!clientId) {
      clientId = `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      sessionStorage.setItem('cui-client-id', clientId);
    }

    // Subscribe to this session
    const subscribe = async () => {
      try {
        console.log('[ConversationView] Subscribing to session:', sessionId, 'clientId:', clientId);

        const response = await fetch('/api/subscriptions/subscribe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-client-id': clientId
          },
          body: JSON.stringify({ sessionId })
        });

        if (response.ok) {
          const data = await response.json();
          console.log('[ConversationView] Subscribed:', data);
        } else {
          console.warn('[ConversationView] Subscribe failed:', response.statusText);
        }
      } catch (error) {
        console.error('[ConversationView] Subscribe error:', error);
      }
    };

    // Only subscribe if we don't have an active streaming connection
    // AND if the session is not "ongoing" according to our local state
    // (This prevents double-updates during active generation)
    if (!streamingId) {
      subscribe();
    }

    // Cleanup: Unsubscribe when leaving
    return () => {
      const unsubscribe = async () => {
        try {
          console.log('[ConversationView] Unsubscribing from session:', sessionId, 'clientId:', clientId);

          await fetch('/api/subscriptions/unsubscribe', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-client-id': clientId
            },
            body: JSON.stringify({ sessionId })
          });

          console.log('[ConversationView] Unsubscribed');
        } catch (error) {
          console.error('[ConversationView] Unsubscribe error:', error);
        }
      };

      unsubscribe();
    };
  }, [sessionId, streamingId, isLoading]);

  const { isConnected, disconnect } = useStreaming(streamingId, {
    onMessage: handleStreamMessage,
    onError: (err) => {
      setError(err.message);
      setStreamingId(null);
    },
  });

  const handleSendMessage = async (message: string, workingDirectory?: string, model?: string, permissionMode?: string) => {
    if (!sessionId) return;

    setError(null);

    try {
      const response = await api.startConversation({
        resumedSessionId: sessionId,
        initialPrompt: message,
        workingDirectory: workingDirectory || currentWorkingDirectory,
        model,
        permissionMode
      });

      // Navigate immediately to the new session
      navigate(`/c/${response.sessionId}`);
    } catch (err: any) {
      setError(err.message || 'Failed to send message');
    }
  };

  const handleStop = async () => {
    if (!streamingId) return;

    try {
      // Call the API to stop the conversation
      await api.stopConversation(streamingId);
      
      // Disconnect the streaming connection
      disconnect();
      
      // Clear the streaming ID
      setStreamingId(null);
      
      // Streaming has stopped
    } catch (err: any) {
      console.error('Failed to stop conversation:', err);
      setError(err.message || 'Failed to stop conversation');
    }
  };

  const handlePermissionDecision = async (requestId: string, action: 'approve' | 'deny', denyReason?: string) => {
    if (isPermissionDecisionLoading) return;

    setIsPermissionDecisionLoading(true);
    try {
      await api.sendPermissionDecision(requestId, { action, denyReason });
      // Clear the permission request after successful decision
      clearPermissionRequest();
    } catch (err: any) {
      console.error('Failed to send permission decision:', err);
      setError(err.message || 'Failed to send permission decision');
    } finally {
      setIsPermissionDecisionLoading(false);
    }
  };


  return (
    <div className="h-full flex flex-col bg-background relative" role="main" aria-label="Conversation view">
      <ConversationHeader 
        title={conversationSummary?.sessionInfo.custom_name || conversationTitle}
        sessionId={sessionId}
        isArchived={conversationSummary?.sessionInfo.archived || false}
        isPinned={conversationSummary?.sessionInfo.pinned || false}
        subtitle={conversationSummary ? {
          date: new Date(conversationSummary.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          repo: conversationSummary.projectPath.split('/').pop() || 'project',
          commitSHA: conversationSummary.sessionInfo.initial_commit_head,
          changes: conversationSummary.toolMetrics ? {
            additions: conversationSummary.toolMetrics.linesAdded,
            deletions: conversationSummary.toolMetrics.linesRemoved
          } : undefined
        } : undefined}
        onTitleUpdate={async (newTitle) => {
          // Update local state immediately for instant feedback
          setConversationTitle(newTitle);
          
          // Update the conversation summary with the new custom name
          if (conversationSummary) {
            setConversationSummary({
              ...conversationSummary,
              sessionInfo: {
                ...conversationSummary.sessionInfo,
                custom_name: newTitle
              }
            });
          }
          
          // Optionally refresh from backend to ensure consistency
          try {
            const conversationsResponse = await api.getConversations({ limit: 100 });
            const updatedConversation = conversationsResponse.conversations.find(
              conv => conv.sessionId === sessionId
            );
            if (updatedConversation) {
              setConversationSummary(updatedConversation);
              const title = updatedConversation.sessionInfo.custom_name || updatedConversation.summary || 'Untitled';
              setConversationTitle(title);
            }
          } catch (error) {
            console.error('Failed to refresh conversation after rename:', error);
          }
        }}
        onPinToggle={async (isPinned) => {
          if (conversationSummary) {
            setConversationSummary({
              ...conversationSummary,
              sessionInfo: {
                ...conversationSummary.sessionInfo,
                pinned: isPinned
              }
            });
          }
        }}
      />
      
      {error && (
        <div
          className="bg-red-500/10 border-b border-red-500 text-red-600 dark:text-red-400 px-4 py-2 text-sm text-center animate-in slide-in-from-top duration-300"
          role="alert"
          aria-label="Error message"
        >
          {error}
        </div>
      )}

      <MessageList
        messages={messages}
        toolResults={toolResults}
        childrenMessages={childrenMessages}
        expandedTasks={expandedTasks}
        onToggleTaskExpanded={toggleTaskExpanded}
        isLoading={isLoading}
        isStreaming={!!streamingId}
      />

      <div 
        className="sticky bottom-0 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm z-10 w-full flex justify-center px-2 pb-6"
        aria-label="Message composer section"
      >
        <div className="w-full max-w-3xl">
          <Composer
            ref={composerRef}
            onSubmit={handleSendMessage}
            onStop={handleStop}
            onPermissionDecision={handlePermissionDecision}
            isLoading={isConnected || isPermissionDecisionLoading}
            placeholder="Continue the conversation..."
            permissionRequest={currentPermissionRequest}
            showPermissionUI={true}
            showStopButton={true}
            enableFileAutocomplete={true}
            dropdownPosition="above"
            workingDirectory={conversationSummary?.projectPath}
            onFetchFileSystem={async (directory) => {
              try {
                const response = await api.listDirectory({
                  path: directory || currentWorkingDirectory,
                  recursive: true,
                  respectGitignore: true,
                });
                return response.entries;
              } catch (error) {
                console.error('Failed to fetch file system entries:', error);
                return [];
              }
            }}
            onFetchCommands={async (workingDirectory) => {
              try {
                const response = await api.getCommands(workingDirectory || currentWorkingDirectory);
                return response.commands;
              } catch (error) {
                console.error('Failed to fetch commands:', error);
                return [];
              }
            }}
          />
        </div>
      </div>

    </div>
  );
}

// Helper function to convert API response to chat messages
function convertToChatlMessages(details: ConversationDetailsResponse): ChatMessage[] {
  console.log('[convertToChatlMessages] 开始转换, 输入消息数:', details.messages?.length);

  if (!details.messages || !Array.isArray(details.messages)) {
    console.error('[convertToChatlMessages] messages 不是数组!', details);
    return [];
  }

  // Create a map for quick parent message lookup
  const messageMap = new Map<string, ConversationMessage>();
  details.messages.forEach(msg => messageMap.set(msg.uuid, msg));

  const filtered = details.messages
    .filter(msg => !msg.isSidechain)
    .filter(msg => msg.message); // Skip messages without message field (system errors, etc.)

  console.log('[convertToChatlMessages] 过滤后:', filtered.length);

  const result = filtered.map(msg => {
      // Extract content from the message structure
      let content = msg.message;

      // Handle Anthropic message format
      if (typeof msg.message === 'object' && 'content' in msg.message) {
        content = msg.message.content;
      }

      return {
        id: msg.uuid,
        messageId: msg.uuid, // For historical messages, use UUID as messageId
        type: msg.type as 'user' | 'assistant' | 'system',
        content: content,
        timestamp: msg.timestamp,
        workingDirectory: msg.cwd, // Add working directory from backend message
      };
    });

  console.log('[convertToChatlMessages] 转换完成, 返回消息数:', result.length);
  return result;
}
