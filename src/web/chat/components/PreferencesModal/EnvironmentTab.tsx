import React, { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, X, Check } from 'lucide-react';
import { api } from '../../services/api';
import type { EnvPreset } from '../../../../types/config';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

interface EnvironmentTabProps {
  onPresetsChange?: () => void;
}

interface EnvVarRow {
  key: string;
  value: string;
}

/** Mask values for keys that look like secrets */
function maskValue(key: string, value: string): string {
  const sensitivePatterns = [/KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /CREDENTIAL/i];
  if (sensitivePatterns.some(p => p.test(key)) && value.length > 4) {
    return value.substring(0, 4) + '****';
  }
  return value;
}

export function EnvironmentTab({ onPresetsChange }: EnvironmentTabProps) {
  const [presets, setPresets] = useState<EnvPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingPreset, setEditingPreset] = useState<EnvPreset | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Form state
  const [formName, setFormName] = useState('');
  const [formProxy, setFormProxy] = useState('');
  const [formNoProxy, setFormNoProxy] = useState('');
  const [formEnvVars, setFormEnvVars] = useState<EnvVarRow[]>([]);

  const loadPresets = async () => {
    try {
      const data = await api.getEnvPresets();
      setPresets(data);
    } catch (error) {
      console.error('Failed to load env presets:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPresets();
  }, []);

  const resetForm = () => {
    setFormName('');
    setFormProxy('');
    setFormNoProxy('');
    setFormEnvVars([]);
    setEditingPreset(null);
    setIsCreating(false);
  };

  const openCreateForm = () => {
    resetForm();
    setIsCreating(true);
  };

  const openEditForm = (preset: EnvPreset) => {
    setFormName(preset.name);
    setFormProxy(preset.proxy || '');
    setFormNoProxy(preset.noProxy || '');
    setFormEnvVars(
      preset.envVars
        ? Object.entries(preset.envVars).map(([key, value]) => ({ key, value }))
        : []
    );
    setEditingPreset(preset);
    setIsCreating(false);
  };

  const handleSave = async () => {
    const envVars: Record<string, string> = {};
    for (const row of formEnvVars) {
      const trimmedKey = row.key.trim();
      if (trimmedKey) {
        envVars[trimmedKey] = row.value;
      }
    }

    const presetData = {
      name: formName.trim(),
      proxy: formProxy.trim() || undefined,
      noProxy: formNoProxy.trim() || undefined,
      envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
    };

    try {
      if (editingPreset) {
        await api.updateEnvPreset(editingPreset.id, presetData);
      } else {
        await api.createEnvPreset(presetData);
      }
      await loadPresets();
      onPresetsChange?.();
      resetForm();
    } catch (error) {
      console.error('Failed to save env preset:', error);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this environment preset?')) return;
    try {
      await api.deleteEnvPreset(id);
      await loadPresets();
      onPresetsChange?.();
      if (editingPreset?.id === id) {
        resetForm();
      }
    } catch (error) {
      console.error('Failed to delete env preset:', error);
    }
  };

  const addEnvVarRow = () => {
    setFormEnvVars([...formEnvVars, { key: '', value: '' }]);
  };

  const updateEnvVarRow = (index: number, field: 'key' | 'value', val: string) => {
    const updated = [...formEnvVars];
    updated[index] = { ...updated[index], [field]: val };
    setFormEnvVars(updated);
  };

  const removeEnvVarRow = (index: number) => {
    setFormEnvVars(formEnvVars.filter((_, i) => i !== index));
  };

  const isEditing = isCreating || editingPreset !== null;

  if (loading) {
    return (
      <div className="px-6 pb-6 overflow-y-auto h-full">
        <div className="py-4 text-sm text-neutral-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="px-6 pb-6 overflow-y-auto h-full">
      <div className="py-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Environment Presets
          </h3>
          {!isEditing && (
            <Button
              onClick={openCreateForm}
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
            >
              <Plus size={14} />
              Add Preset
            </Button>
          )}
        </div>

        <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
          Configure proxy and environment variable presets that can be applied per conversation.
        </p>

        {/* Preset List */}
        {!isEditing && presets.length === 0 && (
          <div className="text-sm text-neutral-500 dark:text-neutral-400 py-8 text-center">
            No presets configured. Click "Add Preset" to create one.
          </div>
        )}

        {!isEditing && presets.map((preset) => (
          <div
            key={preset.id}
            className="flex items-center justify-between py-3 border-b border-neutral-100 dark:border-neutral-800 last:border-b-0"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {preset.name}
              </div>
              {preset.proxy && (
                <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                  Proxy: {preset.proxy}
                </div>
              )}
              {preset.envVars && Object.keys(preset.envVars).length > 0 && (
                <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                  Env: {Object.entries(preset.envVars).map(([k, v]) => `${k}=${maskValue(k, v)}`).join(', ')}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1 ml-2">
              <Button
                onClick={() => openEditForm(preset)}
                variant="ghost"
                size="icon"
                className="h-7 w-7"
              >
                <Pencil size={14} />
              </Button>
              <Button
                onClick={() => handleDelete(preset.id)}
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-red-500 hover:text-red-600"
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
        ))}

        {/* Create/Edit Form */}
        {isEditing && (
          <div className="border border-neutral-200 dark:border-neutral-700 rounded-lg p-4 mt-2">
            <h4 className="text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-3">
              {editingPreset ? 'Edit Preset' : 'New Preset'}
            </h4>

            <div className="space-y-3">
              <div>
                <Label htmlFor="preset-name" className="text-xs text-neutral-600 dark:text-neutral-400">
                  Name
                </Label>
                <Input
                  id="preset-name"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Clash, Corporate VPN"
                  className="mt-1 h-9"
                />
              </div>

              <div>
                <Label htmlFor="preset-proxy" className="text-xs text-neutral-600 dark:text-neutral-400">
                  Proxy URL
                </Label>
                <Input
                  id="preset-proxy"
                  value={formProxy}
                  onChange={(e) => setFormProxy(e.target.value)}
                  placeholder="e.g. http://127.0.0.1:7897"
                  className="mt-1 h-9"
                />
              </div>

              <div>
                <Label htmlFor="preset-noproxy" className="text-xs text-neutral-600 dark:text-neutral-400">
                  No Proxy
                </Label>
                <Input
                  id="preset-noproxy"
                  value={formNoProxy}
                  onChange={(e) => setFormNoProxy(e.target.value)}
                  placeholder="e.g. localhost,127.0.0.1"
                  className="mt-1 h-9"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-xs text-neutral-600 dark:text-neutral-400">
                    Custom Environment Variables
                  </Label>
                  <Button
                    type="button"
                    onClick={addEnvVarRow}
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                  >
                    <Plus size={12} className="mr-1" />
                    Add
                  </Button>
                </div>
                {formEnvVars.map((row, i) => (
                  <div key={i} className="flex items-center gap-2 mt-1">
                    <Input
                      value={row.key}
                      onChange={(e) => updateEnvVarRow(i, 'key', e.target.value)}
                      placeholder="KEY"
                      className="h-8 flex-1 font-mono text-xs"
                    />
                    <span className="text-neutral-400">=</span>
                    <Input
                      value={row.value}
                      onChange={(e) => updateEnvVarRow(i, 'value', e.target.value)}
                      placeholder="value"
                      className="h-8 flex-1 font-mono text-xs"
                    />
                    <Button
                      type="button"
                      onClick={() => removeEnvVarRow(i)}
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 flex-shrink-0"
                    >
                      <X size={14} />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
              <Button
                onClick={resetForm}
                variant="ghost"
                size="sm"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                size="sm"
                disabled={!formName.trim()}
              >
                <Check size={14} className="mr-1" />
                {editingPreset ? 'Update' : 'Create'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
