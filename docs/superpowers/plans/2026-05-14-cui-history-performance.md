# CUI History Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep CUI responsive when the machine has many Claude/Codex sessions and large working directories.

**Architecture:** Disable Composer file autocomplete by default, keep capped filesystem traversal for callers that still use the filesystem API, and persist Codex metadata in the existing SQLite session index so list/detail requests can avoid full JSONL scans. Claude Code and Codex scan cycles still discover new or changed files, but reuse file path, size, and mtime to skip unchanged files and parse changed files with bounded concurrency. Defaults are 4 Claude Code scan workers and 6 Codex scan workers, for 10 total when both indexers run at startup. CUI defaults to read-only mode so viewing history cannot spawn agents or mutate sessions accidentally.

**Tech Stack:** TypeScript, Express, React, Vitest, better-sqlite3.

---

### Task 1: Remove Composer File Autocomplete And Cap Filesystem API

**Files:**
- Modify: `src/services/file-system-service.ts`
- Modify: `src/routes/filesystem.routes.ts`
- Modify: `src/types/index.ts`
- Modify: `src/web/chat/components/ConversationView/ConversationView.tsx`
- Modify: `src/web/chat/components/Home/Home.tsx`
- Test: `tests/unit/file-system-service.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving recursive listing respects `maxEntries` and `maxDepth`, and reports `truncated`.

- [ ] **Step 2: Implement bounded traversal**

Add `maxEntries` and `maxDepth` options to `FileSystemService.listDirectory()`, stop recursion once caps are reached, and return `truncated`.

- [ ] **Step 3: Disable Composer file autocomplete**

Make Home and ConversationView pass `enableFileAutocomplete={false}` and stop passing `onFetchFileSystem`.

### Task 1.5: Default Read-Only Mode

**Files:**
- Modify: `src/types/config.ts`
- Modify: `src/cli-parser.ts`
- Modify: `src/cui-server.ts`
- Modify: `src/routes/system.routes.ts`
- Modify: `src/routes/conversation.routes.ts`
- Modify: `src/web/chat/components/Home/Home.tsx`
- Modify: `src/web/chat/components/ConversationView/ConversationView.tsx`
- Test: `tests/unit/cli-parser.test.ts`
- Test: `tests/unit/server-args.test.ts`
- Test: `tests/unit/routes/conversation.routes.test.ts`

- [ ] **Step 1: Add config/CLI switch**

Default `server.readOnly` to `true`, expose `--read-only` and `--allow-write`, and return `readOnly` in system status.

- [ ] **Step 2: Block writes server-side**

Reject conversation start/resume and session mutation routes when read-only mode is enabled.

- [ ] **Step 3: Hide write UI**

Fetch system status in Home and ConversationView; hide the Composer when `readOnly` is true.

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- tests/unit/file-system-service.test.ts
```

Expected: pass.

### Task 2: Persist Codex Metadata

**Files:**
- Modify: `src/services/session-info-service.ts`
- Modify: `src/services/codex/codex-history-reader.ts`
- Modify: `src/services/codex/codex-types.ts`
- Modify: `src/cui-server.ts`
- Test: `tests/unit/services/session-info-service.test.ts`
- Test: `tests/unit/services/codex-history-reader.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving Codex lists can be served from SQLite without JSONL files, and unchanged files are not reparsed when indexed metadata matches path, size, and mtime.

- [ ] **Step 2: Add Codex SQLite query**

Add `SessionInfoService.getCodexConversations()` mirroring `getConversations()` but filtering `session_id LIKE 'codex:%'`.

- [ ] **Step 3: Wire reader to SQLite**

Pass `SessionInfoService` into `CodexHistoryReader`; have `listConversations()` prefer indexed rows, `locateSessionFile()` use indexed `file_path`, and `scanSessionMetadata()` bulk-upsert fresh metadata.

- [ ] **Step 4: Add bounded scan concurrency**

Parse changed Codex JSONL files with a small concurrency cap so large scans are faster without loading all file contents into memory.

### Task 2.5: Add Claude Code Scan Concurrency

**Files:**
- Modify: `src/services/history-indexer.ts`
- Test: `tests/unit/services/history-indexer.test.ts`

- [ ] **Step 1: Add bounded workers**

Collect changed Claude Code JSONL files, then parse them with 4 default workers.

- [ ] **Step 2: Keep total startup concurrency bounded**

Set Codex scan concurrency to 6 by default so Claude Code + Codex scanning totals 10 workers when both run.

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- tests/unit/services/codex-history-reader.test.ts tests/unit/services/session-info-service.test.ts
```

Expected: pass.

### Task 3: Final Verification

**Files:**
- Verify all modified TypeScript files.

- [ ] **Step 1: Run focused tests**

```bash
npm test -- tests/unit/services/codex-history-reader.test.ts tests/unit/services/codex-history-indexer.test.ts tests/unit/services/session-info-service.test.ts tests/unit/file-system-service.test.ts
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Completion audit**

Check every user requirement against concrete code and command evidence before calling the work complete.
