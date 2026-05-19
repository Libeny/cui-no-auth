import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

describe('read-only composer rendering', () => {
  it('keeps the Home composer rendered but disabled in read-only mode', () => {
    const source = readFileSync('src/web/chat/components/Home/Home.tsx', 'utf-8');

    expect(source).not.toContain('{!readOnly && (\n              <div className="w-full">');
    expect(source).toContain('disabled={readOnly || isSubmitting}');
  });

  it('keeps the conversation composer rendered but disabled in read-only mode', () => {
    const source = readFileSync('src/web/chat/components/ConversationView/ConversationView.tsx', 'utf-8');

    expect(source).not.toContain('{!readOnly && (\n      <div');
    expect(source).toContain("disabled={readOnly || resolvedProvider !== 'claude'}");
  });

  it('does not render message counts in the Home task list item', () => {
    const source = readFileSync('src/web/chat/components/Home/TaskItem.tsx', 'utf-8');

    expect(source).not.toContain('messageCount');
  });

  it('uses agent and time filters on Home instead of Archive tabs', () => {
    const taskTabs = readFileSync('src/web/chat/components/Home/TaskTabs.tsx', 'utf-8');
    const home = readFileSync('src/web/chat/components/Home/Home.tsx', 'utf-8');
    const taskList = readFileSync('src/web/chat/components/Home/TaskList.tsx', 'utf-8');

    expect(taskTabs).toContain("label: 'All'");
    expect(taskTabs).toContain('Claude Code');
    expect(taskTabs).toContain('Codex');
    expect(taskTabs).toContain('1h');
    expect(taskTabs).toContain('6h');
    expect(taskTabs).toContain('Today');
    expect(taskTabs).toContain('3d');
    expect(taskTabs).toContain('7d');
    expect(taskTabs).not.toContain('15d');
    expect(taskTabs).not.toContain('All Agents');
    expect(taskTabs).not.toContain('value="archive"');
    expect(home).toContain("useState<HomeTimeFilter>('today')");
    expect(home).not.toContain("'archive'");
    expect(taskList).not.toContain('No archived tasks.');
  });

  it('shows refresh feedback as an overlay without shifting the Home header layout', () => {
    const home = readFileSync('src/web/chat/components/Home/Home.tsx', 'utf-8');

    expect(home).toContain('pointer-events-none fixed left-1/2 top-4');
    expect(home).not.toContain("refreshNotice && refreshNotice !== '暂无最新消息'");
  });

  it('does not expose a clear/delete button in the Home session search field', () => {
    const taskTabs = readFileSync('src/web/chat/components/Home/TaskTabs.tsx', 'utf-8');

    expect(taskTabs).not.toContain('aria-label="Clear search"');
    expect(taskTabs).not.toContain("onClick={() => onSearchQueryChange('')}");
    expect(taskTabs).not.toContain('import { Search, X }');
    expect(taskTabs).not.toContain('type="search"');
  });

  it('places the Home session search field between agent and time filters', () => {
    const taskTabs = readFileSync('src/web/chat/components/Home/TaskTabs.tsx', 'utf-8');

    const agentFilterIndex = taskTabs.indexOf('aria-label="Filter conversations by agent"');
    const searchFieldIndex = taskTabs.indexOf('aria-label="Search conversations by summary or session id"');
    const timeFilterIndex = taskTabs.indexOf('aria-label="Filter conversations by time"');

    expect(agentFilterIndex).toBeGreaterThan(-1);
    expect(searchFieldIndex).toBeGreaterThan(agentFilterIndex);
    expect(timeFilterIndex).toBeGreaterThan(searchFieldIndex);
  });

  it('does not expose custom calendar filtering in the Home filter bar', () => {
    const taskTabs = readFileSync('src/web/chat/components/Home/TaskTabs.tsx', 'utf-8');
    const home = readFileSync('src/web/chat/components/Home/Home.tsx', 'utf-8');

    expect(taskTabs).not.toContain('aria-label="Open custom date and time filter"');
    expect(taskTabs).not.toContain('type="datetime-local"');
    expect(taskTabs).not.toContain("onTimeFilterChange('custom')");
    expect(home).not.toContain('customDateTime');
    expect(home).not.toContain("if (filter === 'custom')");
  });

  it('uses transparent PNG brand assets for Claude Code and Codex filters', () => {
    const taskTabs = readFileSync('src/web/chat/components/Home/TaskTabs.tsx', 'utf-8');

    expect(taskTabs).toContain("iconSrc: '/agent-icons/claude-code.png'");
    expect(taskTabs).toContain("iconSrc: '/agent-icons/codex.png'");
    expect(taskTabs).toContain('src={option.iconSrc}');
  });

  it('does not expose archive actions in the primary chat UI', () => {
    const taskItem = readFileSync('src/web/chat/components/Home/TaskItem.tsx', 'utf-8');
    const conversationHeader = readFileSync('src/web/chat/components/ConversationHeader/ConversationHeader.tsx', 'utf-8');
    const preferencesModal = readFileSync('src/web/chat/components/PreferencesModal/PreferencesModal.tsx', 'utf-8');

    expect(taskItem).not.toContain('Archive task');
    expect(conversationHeader).not.toContain('Archive Task');
    expect(preferencesModal).not.toContain('Archive All Sessions');
  });
});
