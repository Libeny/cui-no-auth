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
});
