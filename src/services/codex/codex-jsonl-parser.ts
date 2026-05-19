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
      entries.push(JSON.parse(stripEncryptedContent(line)) as CodexJsonlEntry);
    } catch {
      // Codex session files can be tailed while being written. Ignore partial or bad lines.
    }
  }

  return entries;
}

function stripEncryptedContent(line: string): string {
  if (!line.includes('"encrypted_content"')) return line;
  return stripJsonStringProperty(line, 'encrypted_content');
}

function stripJsonStringProperty(line: string, propertyName: string): string {
  const keyMatch = new RegExp(`"${propertyName}"\\s*:\\s*"`).exec(line);
  if (!keyMatch) return line;

  let index = keyMatch.index + keyMatch[0].length;
  let escaped = false;

  for (; index < line.length; index += 1) {
    const char = line[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      break;
    }
  }

  if (index >= line.length) return line;

  let start = keyMatch.index;
  let end = index + 1;

  while (end < line.length && /\s/.test(line[end])) end += 1;

  if (line[end] === ',') {
    end += 1;
  } else {
    let beforeStart = start - 1;
    while (beforeStart >= 0 && /\s/.test(line[beforeStart])) beforeStart -= 1;
    if (line[beforeStart] === ',') {
      start = beforeStart;
    }
  }

  return line.slice(0, start) + line.slice(end);
}
