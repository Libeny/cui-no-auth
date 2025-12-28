import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MessageItem } from './MessageItem';
import type { ChatMessage, ToolResult } from '../../types';

export interface MessageListProps {
  messages: ChatMessage[];
  toolResults?: Record<string, ToolResult>;
  childrenMessages?: Record<string, ChatMessage[]>;
  expandedTasks?: Set<string>;
  onToggleTaskExpanded?: (toolUseId: string) => void;
  isLoading?: boolean;
  isStreaming?: boolean;
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
  expandedTasks = new Set(),
  onToggleTaskExpanded,
  isLoading,
  isStreaming
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMessageCountRef = useRef(0);
  const [showBottomButton, setShowBottomButton] = useState(false);
  const [showTopButton, setShowTopButton] = useState(false);

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
      setShowBottomButton(!isNearBottom);
      setShowTopButton(isScrolledDown);
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
  }, [virtualizer, virtualItems.length]);

  // Jump to top
  const scrollToTop = useCallback(() => {
    // Use 'auto' instead of 'smooth' for reliable scrolling to top on large lists
    virtualizer.scrollToIndex(0, { align: 'start', behavior: 'auto' });
  }, [virtualizer]);

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
    >
      {/* Navigation buttons */}
      <div className="fixed right-6 bottom-32 z-20 flex flex-col gap-2">
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
