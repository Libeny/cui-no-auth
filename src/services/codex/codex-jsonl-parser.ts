import * as fs from 'fs';
import * as readline from 'readline';
import type { CodexJsonlEntry } from './codex-types.js';

export async function parseCodexJsonlFile(filePath: string): Promise<CodexJsonlEntry[]> {
  const entries: CodexJsonlEntry[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as CodexJsonlEntry);
    } catch {
      // Codex session files can be tailed while being written. Ignore partial or bad lines.
    }
  }

  return entries;
}
