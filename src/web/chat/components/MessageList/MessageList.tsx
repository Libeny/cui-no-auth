import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { RefreshCw } from 'lucide-react';
import { MessageItem } from './MessageItem';
import type { ChatMessage, ToolResult, SubagentSummary } from '../../types';

export interface MessageListProps {
  messages: ChatMessage[];
  toolResults?: Record<string, ToolResult>;
  childrenMessages?: Record<string, ChatMessage[]>;
  subagentByToolUseId?: Record<string, SubagentSummary>;
  expandedTasks?: Set<string>;
  onToggleTaskExpanded?: (toolUseId: string) => void;
  isLoading?: boolean;
  isStreaming?: boolean;
  onRefresh?: () => Promise<'updated' | 'noop'>;
  refreshFeedback?: {
    outcome: 'updated' | 'noop';
    source: 'auto' | 'manual';
    token: number;
  } | null;
}

// Item types for virtual list
type VirtualItem =
  | { type: 'message'; message: ChatMessage; isFirstInGroup: boolean; isLastInGroup: boolean; showDivider: boolean }
  | { type: 'loading' }
  | { type: 'streaming-indicator' };

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  toolResults = {},
  childrenMessages = {},
  subagentByToolUseId = {},
  expandedTasks = new Set(),
  onToggleTaskExpanded,
  isLoading,
  isStreaming,
  onRefresh,
  refreshFeedback,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMessageCountRef = useRef(0);
  const [showBottomButton, setShowBottomButton] = useState(false);
  const [showTopButton, setShowTopButton] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [topNotice, setTopNotice] = useState<string | null>(null);
  const [floatingNotice, setFloatingNotice] = useState<string | null>(null);
  const [showUpdateHint, setShowUpdateHint] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const pullStartYRef = useRef<number | null>(null);
  const isPullingRef = useRef(false);
  const noticeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const activeRefreshTokenRef = useRef<number | null>(null);

  // Filter out user messages that only contain tool_result blocks
  const displayMessages = useMemo(() => messages.filter(message => {
    if (message.type === 'user' && Array.isArray(message.content)) {
      const allToolResults = message.content.every((block: any) => block.type === 'tool_result');
      if (allToolResults) {
        return false;
      }
    }
    return true;
  }), [messages]);

  // Build virtual items list with group information
  const virtualItems = useMemo<VirtualItem[]>(() => {
    const items: VirtualItem[] = [];

    let currentGroupType: string | null = null;
    let groupStartIndex = 0;

    displayMessages.forEach((message, index) => {
      const isNewGroup = message.type !== currentGroupType;
      const isLastMessage = index === displayMessages.length - 1;
      const nextMessage = displayMessages[index + 1];
      const isLastInGroup = isLastMessage || (nextMessage && nextMessage.type !== message.type);

      // Check if we should show divider after this group
      const showDivider = isLastInGroup &&
        message.type === 'user' &&
        nextMessage &&
        nextMessage.type === 'assistant';

      if (isNewGroup) {
        currentGroupType = message.type;
        groupStartIndex = index;
      }

      items.push({
        type: 'message',
        message,
        isFirstInGroup: isNewGroup,
        isLastInGroup,
        showDivider: showDivider || (isLastInGroup && message.type === 'user' && isLastMessage && !!isStreaming)
      });
    });

    // Add loading indicator
    if (isLoading && displayMessages.length === 0) {
      items.push({ type: 'loading' });
    }

    // Add streaming indicator
    if (!isLoading && isStreaming && displayMessages.length > 0) {
      const hasLoadingToolUse = displayMessages.some(message => {
        if (message.type === 'assistant' && Array.isArray(message.content)) {
          return message.content.some((block: any) => {
            if (block.type === 'tool_use') {
              const toolResult = toolResults[block.id];
              return !toolResult || toolResult.status === 'pending';
            }
            return false;
          });
        }
        return false;
      });

      if (!hasLoadingToolUse) {
        items.push({ type: 'streaming-indicator' });
      }
    }

    return items;
  }, [displayMessages, isLoading, isStreaming, toolResults]);

  // Virtual list configuration
  // Use a larger estimate (200px) to prevent "bottom drift" when scrolling
  // It's better to overestimate than underestimate for scroll-to-bottom reliability
  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => containerRef.current,
    estimateSize: useCallback(() => 800, []), // Use larger estimate for code blocks
    overscan: 5, // Render 5 extra items above/below viewport
    measureElement: (element) => {
      // Measure actual element height
      return element?.getBoundingClientRect().height ?? 800;
    },
  });

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const newMessageCount = displayMessages.length;
    const oldCount = lastMessageCountRef.current;

    if (newMessageCount > oldCount && oldCount > 0) {
      const container = containerRef.current;
      if (!container) return;

      // Only auto-scroll if user is near the bottom (within 300px)
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 300;

      if (isNearBottom) {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(virtualItems.length - 1, { align: 'end', behavior: 'smooth' });
        });
      } else {
        setShowUpdateHint(true);
      }
    }
    lastMessageCountRef.current = newMessageCount;
  }, [displayMessages.length, virtualItems.length, virtualizer]);

  // Detect scroll position for bottom navigation button
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;
      const isScrolledDown = scrollTop > 500;
      setIsNearBottom(isNearBottom);
      setShowBottomButton(!isNearBottom);
      setShowTopButton(isScrolledDown);
      if (isNearBottom) {
        setShowUpdateHint(false);
      }
    };

    container.addEventListener('scroll', handleScroll);
    handleScroll();
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Track first message ID to detect session change
  const firstMessageIdRef = useRef<string | null>(null);
  const hasScrolledRef = useRef(false);

  // Initial scroll to bottom when messages are loaded
  useEffect(() => {
    const firstMessageId = displayMessages[0]?.id || null;
    const container = containerRef.current;

    // Reset scroll flag if session changed (first message ID changed)
    if (firstMessageId !== firstMessageIdRef.current) {
      hasScrolledRef.current = false;
      firstMessageIdRef.current = firstMessageId;
    }

    // Only scroll once when messages first load
    if (virtualItems.length > 0 && !hasScrolledRef.current && container) {
      hasScrolledRef.current = true;

      // Wait for virtual list to calculate initial size and layout to stabilize
      // Use setTimeout to allow for layout paint
      setTimeout(() => {
        virtualizer.scrollToIndex(virtualItems.length - 1, { align: 'end' });
        
        // Double check scroll position after a short delay
        setTimeout(() => {
           const { scrollHeight, scrollTop, clientHeight } = container;
           if (scrollHeight - scrollTop - clientHeight > 100) {
             virtualizer.scrollToIndex(virtualItems.length - 1, { align: 'end' });
           }
        }, 100);
      }, 50);
    }
  }, [displayMessages, virtualItems.length, virtualizer]);

  // Jump to bottom
  const scrollToBottom = useCallback(() => {
    virtualizer.scrollToIndex(virtualItems.length - 1, { align: 'end', behavior: 'auto' });
    setShowUpdateHint(false);
  }, [virtualizer, virtualItems.length]);

  // Jump to top
  const scrollToTop = useCallback(() => {
    // Use 'auto' instead of 'smooth' for reliable scrolling to top on large lists
    virtualizer.scrollToIndex(0, { align: 'start', behavior: 'auto' });
  }, [virtualizer]);

  const showTransientNotice = useCallback((message: string) => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
    }
    if (message === '暂无最新消息') {
      setTopNotice(null);
      setFloatingNotice(message);
    } else {
      setFloatingNotice(null);
      setTopNotice(message);
    }
    noticeTimerRef.current = setTimeout(() => {
      setTopNotice(null);
      setFloatingNotice(null);
      noticeTimerRef.current = null;
    }, 2200);
  }, []);

  useEffect(() => {
    if (!refreshFeedback || refreshFeedback.token === activeRefreshTokenRef.current) {
      return;
    }

    activeRefreshTokenRef.current = refreshFeedback.token;

    if (refreshFeedback.outcome === 'noop') {
      if (refreshFeedback.source === 'manual') {
        showTransientNotice('暂无最新消息');
      }
      return;
    }

    if (isNearBottom) {
      showTransientNotice('已更新');
    } else {
      setShowUpdateHint(true);
    }
  }, [refreshFeedback, isNearBottom, showTransientNotice]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  const executeRefresh = useCallback(async () => {
    if (!onRefresh || isRefreshing) {
      return;
    }

    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
      setPullDistance(0);
      pullStartYRef.current = null;
      isPullingRef.current = false;
    }
  }, [isRefreshing, onRefresh]);

  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || container.scrollTop > 0 || isRefreshing) {
      pullStartYRef.current = null;
      isPullingRef.current = false;
      return;
    }

    pullStartYRef.current = event.touches[0]?.clientY ?? null;
    isPullingRef.current = true;
  }, [isRefreshing]);

  const handleTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || !isPullingRef.current || pullStartYRef.current === null || isRefreshing) {
      return;
    }

    if (container.scrollTop > 0) {
      setPullDistance(0);
      isPullingRef.current = false;
      pullStartYRef.current = null;
      return;
    }

    const currentY = event.touches[0]?.clientY ?? pullStartYRef.current;
    const deltaY = currentY - pullStartYRef.current;
    if (deltaY <= 0) {
      setPullDistance(0);
      return;
    }

    event.preventDefault();
    setPullDistance(Math.min(96, deltaY * 0.5));
  }, [isRefreshing]);

  const handleTouchEnd = useCallback(() => {
    if (!isPullingRef.current) {
      setPullDistance(0);
      return;
    }

    const shouldRefresh = pullDistance >= 60 && !!onRefresh && !isRefreshing;
    if (shouldRefresh) {
      void executeRefresh();
      return;
    }

    setPullDistance(0);
    pullStartYRef.current = null;
    isPullingRef.current = false;
  }, [executeRefresh, isRefreshing, onRefresh, pullDistance]);

  if (displayMessages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 overflow-y-auto bg-background">
        <div className="text-center p-8 text-muted-foreground">
          <p>No messages yet. Start by typing a message below.</p>
        </div>
      </div>
    );
  }

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div
      className="flex-1 overflow-y-auto bg-background relative"
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {floatingNotice && (
        <div className="fixed left-1/2 top-20 z-30 -translate-x-1/2 rounded-full border border-border/60 bg-background/95 px-4 py-2 text-xs text-muted-foreground shadow-lg backdrop-blur-sm">
          {floatingNotice}
        </div>
      )}

      <div
        className="sticky top-3 z-20 flex justify-center pointer-events-none"
        style={{
          transform: `translateY(${Math.min(pullDistance, 72)}px)`,
          opacity: pullDistance > 0 || isRefreshing || topNotice ? 1 : 0,
          transition: pullDistance > 0 ? 'none' : 'opacity 180ms ease, transform 180ms ease',
        }}
      >
        <div className="rounded-full border border-border/60 bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
          {isRefreshing
            ? '更新中...'
            : topNotice
              ? topNotice
              : pullDistance >= 60
                ? '松手刷新'
                : '下滑刷新'}
        </div>
      </div>

      {/* Navigation buttons */}
      <div className="fixed right-6 bottom-32 z-20 flex flex-col gap-2">
        {onRefresh && (
          <button
            onClick={() => void executeRefresh()}
            disabled={isRefreshing}
            className="w-10 h-10 rounded-full bg-background border border-border shadow-lg flex items-center justify-center hover:bg-muted transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        )}
        {showUpdateHint && (
          <div className="max-w-[180px] rounded-full bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-lg border border-border backdrop-blur-sm text-center">
            已更新，请向下滑
          </div>
        )}
        {showTopButton && (
          <button
            onClick={scrollToTop}
            className="w-10 h-10 rounded-full bg-background border border-border shadow-lg flex items-center justify-center hover:bg-muted transition-colors"
            title="回到顶部"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
        )}
        {showBottomButton && (
          <button
            onClick={scrollToBottom}
            className="w-10 h-10 rounded-full bg-background border border-border shadow-lg flex items-center justify-center hover:bg-muted transition-colors"
            title="跳转到底部"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        )}
      </div>
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        <div
          className="absolute top-0 left-0 w-full"
          style={{ transform: `translateY(${virtualRows[0]?.start ?? 0}px)` }}
        >
          {virtualRows.map((virtualRow) => {
            const item = virtualItems[virtualRow.index];

            if (item.type === 'loading') {
              return (
                <div
                  key="loading"
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="flex items-center justify-center p-8"
                >
                  <div className="flex gap-1">
                    <span className="w-1 h-1 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.32s]" />
                    <span className="w-1 h-1 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.16s]" />
                    <span className="w-1 h-1 bg-blue-500 rounded-full animate-bounce" />
                  </div>
                </div>
              );
            }

            if (item.type === 'streaming-indicator') {
              return (
                <div
                  key="streaming"
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="flex items-start px-4 mt-2 max-w-3xl mx-auto"
                >
                  <div className="w-4 h-5 flex-shrink-0 flex items-center justify-center text-foreground relative">
                    <div className="w-2.5 h-2.5 bg-foreground rounded-full mt-3.5 animate-pulse" />
                  </div>
                </div>
              );
            }

            // Message item
            return (
              <div
                key={item.message.messageId}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className="flex flex-col gap-2 px-4 py-1 max-w-3xl mx-auto w-full box-border"
              >
                <MessageItem
                  message={item.message}
                  toolResults={toolResults}
                  childrenMessages={childrenMessages}
                  subagentByToolUseId={subagentByToolUseId}
                  expandedTasks={expandedTasks}
                  onToggleTaskExpanded={onToggleTaskExpanded}
                  isFirstInGroup={item.isFirstInGroup}
                  isLastInGroup={item.isLastInGroup}
                  isStreaming={isStreaming}
                />
                {item.showDivider && (
                  <div className="h-px bg-border/20 my-2 w-full" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
