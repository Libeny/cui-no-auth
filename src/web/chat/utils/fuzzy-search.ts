export function fuzzyTextMatch(text: string, query: string): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return true;
  }

  const normalizedText = normalizeSearchText(text);
  if (!normalizedText) {
    return false;
  }

  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every(token => normalizedText.includes(token) || isSubsequence(normalizedText, token));
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isSubsequence(text: string, query: string): boolean {
  let queryIndex = 0;

  for (const character of text) {
    if (character === query[queryIndex]) {
      queryIndex += 1;
      if (queryIndex === query.length) {
        return true;
      }
    }
  }

  return query.length === 0;
}
