import React, { useState } from 'react';
import { ChevronDown, Globe } from 'lucide-react';
import { DropdownSelector, DropdownOption } from '../DropdownSelector';
import { Button } from '../ui/button';
import type { EnvPreset } from '../../types';

interface EnvPresetDropdownProps {
  presets: EnvPreset[];
  selectedPresetId: string | undefined;
  onPresetSelect: (presetId: string | undefined) => void;
  onManagePresets?: () => void;
}

export function EnvPresetDropdown({
  presets,
  selectedPresetId,
  onPresetSelect,
  onManagePresets,
}: EnvPresetDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Build options: "Direct" (no proxy) + all presets + manage entry
  const options: DropdownOption<string>[] = [
    { value: '__direct__', label: 'Direct' },
    ...presets.map(p => ({
      value: p.id,
      label: p.name,
      description: p.proxy || undefined,
    })),
    ...(onManagePresets ? [{ value: '__manage__', label: 'Manage...' }] : []),
  ];

  const selectedPreset = presets.find(p => p.id === selectedPresetId);
  const displayText = selectedPreset ? selectedPreset.name : 'Direct';

  return (
    <DropdownSelector
      options={options}
      value={selectedPresetId || '__direct__'}
      onChange={(value) => {
        if (value === '__manage__') {
          onManagePresets?.();
          setIsOpen(false);
          return;
        }
        onPresetSelect(value === '__direct__' ? undefined : value);
        setIsOpen(false);
      }}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      showFilterInput={false}
      renderOption={(option) => (
        <div className="flex flex-col items-start gap-0.5 w-full">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{option.label}</span>
          </div>
          {option.description && (
            <span className="text-xs text-muted-foreground/80">{option.description}</span>
          )}
        </div>
      )}
      renderTrigger={({ onClick }) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-muted-foreground hover:bg-muted/50 rounded-full"
          onClick={onClick}
          aria-label="Select environment preset"
        >
          <span className="flex items-center gap-1.5">
            <Globe size={14} />
            <span className="block max-w-[128px] overflow-hidden text-ellipsis whitespace-nowrap">{displayText}</span>
            <ChevronDown size={14} />
          </span>
        </Button>
      )}
    />
  );
}
