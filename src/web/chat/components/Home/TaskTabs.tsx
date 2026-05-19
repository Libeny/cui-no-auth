import React from 'react';
import { Search } from 'lucide-react';
import type { ConversationSourceFilter } from '../../types';

export type HomeTimeFilter = 'all' | '1h' | '6h' | 'today' | '3d' | '7d';

interface TaskTabsProps {
  sourceFilter: ConversationSourceFilter;
  onSourceFilterChange: (provider: ConversationSourceFilter) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  timeFilter: HomeTimeFilter;
  onTimeFilterChange: (filter: HomeTimeFilter) => void;
}

const sourceOptions: Array<{
  value: ConversationSourceFilter;
  label: string;
  ariaLabel: string;
  iconSrc?: string;
}> = [
  { value: 'all', label: 'All', ariaLabel: 'All agents' },
  { value: 'claude', label: '', ariaLabel: 'Claude Code', iconSrc: '/agent-icons/claude-code.png' },
  { value: 'codex', label: '', ariaLabel: 'Codex', iconSrc: '/agent-icons/codex.png' },
];

const timeOptions: Array<{ value: HomeTimeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: 'today', label: 'Today' },
  { value: '3d', label: '3d' },
  { value: '7d', label: '7d' },
];

export function TaskTabs({
  sourceFilter,
  onSourceFilterChange,
  searchQuery,
  onSearchQueryChange,
  timeFilter,
  onTimeFilterChange,
}: TaskTabsProps) {
  return (
    <div className="w-full mt-4 border-b border-border/30 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="inline-flex shrink-0 rounded-md border border-border/70 bg-muted/20 p-0.5"
          role="group"
          aria-label="Filter conversations by agent"
        >
          {sourceOptions.map((option) => {
            const isActive = sourceFilter === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onSourceFilterChange(option.value)}
                className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-[5px] px-2.5 text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                } ${option.label ? 'min-w-[42px] px-2' : 'w-8 px-0'}`}
                aria-label={option.ariaLabel}
                aria-pressed={isActive}
                title={option.ariaLabel}
              >
                {option.iconSrc && (
                  <img
                    src={option.iconSrc}
                    alt=""
                    className="h-4 w-4 shrink-0 object-contain"
                    draggable={false}
                  />
                )}
                {option.label && <span>{option.label}</span>}
              </button>
            );
          })}
        </div>

        <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border/70 bg-background px-3">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="Search summary or session id"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            aria-label="Search conversations by summary or session id"
          />
        </div>

        <div
          className="inline-flex shrink-0 rounded-md border border-border/70 bg-muted/20 p-0.5"
          role="group"
          aria-label="Filter conversations by time"
        >
          {timeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onTimeFilterChange(option.value)}
              className={`h-8 rounded-[5px] px-2.5 text-xs font-medium transition-colors ${
                timeFilter === option.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              aria-pressed={timeFilter === option.value}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
