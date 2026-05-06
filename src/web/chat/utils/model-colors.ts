export type ModelColorFamily = 'claude' | 'gpt' | 'external' | 'unknown';

const baseBadgeClass = 'rounded-full border px-2 py-0.5 font-mono tracking-normal';

const modelBadgeClasses: Record<ModelColorFamily, string> = {
  claude: 'border-orange-500/35 bg-orange-500/10 text-orange-700 dark:text-orange-300',
  gpt: 'border-blue-500/35 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  external: 'border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300',
  unknown: 'border-border/70 bg-muted/30 text-muted-foreground',
};

const modelTextClasses: Record<ModelColorFamily, string> = {
  claude: 'text-orange-700 dark:text-orange-300',
  gpt: 'text-blue-700 dark:text-blue-300',
  external: 'text-red-700 dark:text-red-300',
  unknown: 'text-muted-foreground',
};

export function getModelColorFamily(model?: string): ModelColorFamily {
  if (!model) return 'unknown';

  const normalized = model.trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.startsWith('claude-')) return 'claude';
  if (normalized.startsWith('gpt-') || normalized.startsWith('codex') || normalized.startsWith('o3')) return 'gpt';

  return 'external';
}

export function getModelBadgeClass(model?: string): string {
  return `${baseBadgeClass} ${modelBadgeClasses[getModelColorFamily(model)]}`;
}

export function getModelTextClass(model?: string): string {
  return modelTextClasses[getModelColorFamily(model)];
}
