import { describe, expect, it } from 'vitest';
import { parseArgs } from '@/cli-parser';

describe('parseArgs', () => {
  it('parses history polling interval in seconds', () => {
    const config = parseArgs(['node', 'server', '--history-poll-interval-seconds', '60']);

    expect(config.historyPollIntervalSeconds).toBe(60);
  });

  it('supports the short history polling interval alias', () => {
    const config = parseArgs(['node', 'server', '--history-poll-interval', '15']);

    expect(config.historyPollIntervalSeconds).toBe(15);
  });
});
