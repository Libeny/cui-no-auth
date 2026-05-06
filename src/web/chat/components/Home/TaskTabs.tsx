import React from 'react';
import { Filter } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/web/chat/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/web/chat/components/ui/select';
import type { ConversationSourceFilter } from '../../types';

interface TaskTabsProps {
  activeTab: 'tasks' | 'history' | 'archive';
  onTabChange: (tab: 'tasks' | 'history' | 'archive') => void;
  sourceFilter: ConversationSourceFilter;
  onSourceFilterChange: (provider: ConversationSourceFilter) => void;
}

export function TaskTabs({ activeTab, onTabChange, sourceFilter, onSourceFilterChange }: TaskTabsProps) {
  return (
    <Tabs value={activeTab} onValueChange={(value) => onTabChange(value as 'tasks' | 'history' | 'archive')} className="w-full mt-4">
      <div className="flex w-full items-center justify-between gap-3 border-b border-border/30">
        <TabsList className="w-64 flex justify-start gap-4 bg-transparent rounded-none h-auto p-0">
          <TabsTrigger 
            value="tasks" 
            className="data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-foreground border-0 rounded-none pb-3 pt-2 px-2 text-muted-foreground hover:text-muted-foreground/80 transition-colors"
            aria-label="Tab selector to view all tasks"
          >
            Tasks
          </TabsTrigger>
          <TabsTrigger 
            value="history"
            className="data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-foreground border-0 rounded-none pb-3 pt-2 px-2 text-muted-foreground hover:text-muted-foreground/80 transition-colors"
            aria-label="Tab selector to view history"
          >
            History
          </TabsTrigger>
          <TabsTrigger 
            value="archive"
            className="data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-foreground border-0 rounded-none pb-3 pt-2 px-2 text-muted-foreground hover:text-muted-foreground/80 transition-colors"
            aria-label="Tab selector to view archived tasks"
          >
            Archive
          </TabsTrigger>
        </TabsList>
        <Select value={sourceFilter} onValueChange={(value) => onSourceFilterChange(value as ConversationSourceFilter)}>
          <SelectTrigger
            size="sm"
            className="mb-2 h-8 w-[142px] shrink-0 rounded-md border-border/70 bg-background text-xs font-medium shadow-none"
            aria-label="Filter task source"
          >
            <Filter size={14} />
            <SelectValue placeholder="全部" />
          </SelectTrigger>
          <SelectContent align="end" className="z-[220]">
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="claude">Claude Code</SelectItem>
            <SelectItem value="codex">Codex</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </Tabs>
  );
}
