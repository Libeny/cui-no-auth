import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/web/chat/components/ui/collapsible';
import type { TokenUsage, TokenUsageSummary } from '../../types';
import { formatTokenCount } from '../../utils/token-format';

interface TokenSummaryPanelProps {
  usageSummary?: TokenUsageSummary;
}

export function TokenSummaryPanel({ usageSummary }: TokenSummaryPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState('All');
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedUsage = useMemo<TokenUsage | undefined>(() => {
    if (!usageSummary) {
      return undefined;
    }

    if (selectedModel === 'All') {
      return usageSummary.total;
    }

    return usageSummary.byModel.find((item) => item.model === selectedModel) || usageSummary.total;
  }, [selectedModel, usageSummary]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root || root.contains(event.target as Node)) {
        return;
      }

      setIsOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isOpen]);

  if (!usageSummary || !selectedUsage) {
    return null;
  }

  const models = ['All', ...usageSummary.byModel.map((item) => item.model)];

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div ref={rootRef} className="relative">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-normal text-foreground transition-colors hover:bg-secondary whitespace-nowrap"
            aria-label="Toggle token summary"
          >
            <BarChart3 size={19} className="flex-shrink-0" />
            <span className="hidden sm:inline">Tokens</span>
            <ChevronDown
              size={14}
              className={`hidden transition-transform sm:block ${isOpen ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[min(24rem,calc(100vw-1.5rem))] rounded-lg border border-border/60 bg-background/80 p-3 text-xs shadow-xl backdrop-blur-xl">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="font-medium text-foreground">Token Summary</div>
              <div className="font-mono text-muted-foreground">{formatTokenCount(totalTokens(usageSummary.total))} total</div>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-1.5" aria-label="Filter token summary by model">
              {models.map((model) => (
                <button
                  key={model}
                  type="button"
                  onClick={() => setSelectedModel(model)}
                  className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                    selectedModel === model
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border/70 bg-background/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {model}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <UsageStat label="Input" value={selectedUsage.inputTokens} />
              <UsageStat label="Output" value={selectedUsage.outputTokens} />
              <UsageStat label="Cache write" value={selectedUsage.cacheCreationInputTokens} />
              <UsageStat label="Cache read" value={selectedUsage.cacheReadInputTokens} />
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function UsageStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border/40 bg-background/40 px-2.5 py-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono text-sm text-foreground">{formatTokenCount(value)}</div>
    </div>
  );
}

function totalTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens
  );
}
