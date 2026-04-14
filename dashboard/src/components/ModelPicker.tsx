import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ModelEntry } from '../lib/api';
import { Check, ChevronDown, RefreshCw, Sparkles } from 'lucide-react';

interface ModelPickerProps {
  value: string;
  onChange: (next: string) => void;
  /** Label shown above the picker. */
  label?: string;
  /** Extra hint shown beneath the picker. */
  hint?: string;
  /** Label for the "inherit default" option (empty string value). Omit to hide it. */
  inheritLabel?: string;
  className?: string;
}

function displayLabel(id: string): string {
  if (!id) return '';
  // Compress "claude-opus-4-6[1m]" → "opus 4-6 1M" for readability
  const m = id.match(/^claude-(opus|sonnet|haiku)-(.+?)(\[1m\])?$/);
  if (m) {
    const [, family, rest, one] = m;
    const version = rest.replace(/-\d{8}$/, ''); // strip trailing YYYYMMDD stamp
    return `${family} ${version}${one ? ' 1M' : ''}`;
  }
  return id;
}

function kindBadge(entry: ModelEntry): string {
  if (entry.kind === 'alias') return 'alias';
  if (entry.has1m) return '1M';
  return '';
}

export function ModelPicker({ value, onChange, label, hint, inheritLabel, className }: ModelPickerProps) {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['models'],
    queryFn: () => api.models.list(),
    staleTime: 60_000,
  });
  const models = data?.models ?? [];

  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCustomMode(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const { aliases, discovered } = useMemo(() => {
    const a: ModelEntry[] = [];
    const d: ModelEntry[] = [];
    for (const m of models) (m.kind === 'alias' ? a : d).push(m);
    return { aliases: a, discovered: d };
  }, [models]);

  const isCustom = !!value && !models.some((m) => m.id === value);
  const currentLabel = value
    ? (isCustom ? value : displayLabel(value))
    : (inheritLabel || 'Select…');

  function pick(id: string): void {
    onChange(id);
    setOpen(false);
    setCustomMode(false);
  }

  function commitCustom(): void {
    const v = customDraft.trim();
    if (!v) return;
    onChange(v);
    setOpen(false);
    setCustomMode(false);
    setCustomDraft('');
  }

  return (
    <div className={className}>
      {label && (
        <label className="block mb-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
          {label}
        </label>
      )}
      <div ref={rootRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm"
          style={{
            background: 'var(--bg-primary)',
            color: value ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: '1px solid var(--border)',
            outline: 'none',
          }}
        >
          <span className="flex items-center gap-1.5 truncate">
            <Sparkles className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
            <span className="truncate">{currentLabel}</span>
            {isCustom && (
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide shrink-0"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              >
                custom
              </span>
            )}
          </span>
          <ChevronDown className="w-4 h-4 shrink-0 opacity-60" />
        </button>

        {open && (
          <div
            className="absolute left-0 right-0 mt-1 rounded-lg shadow-xl z-20 overflow-hidden"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
          >
            <div className="max-h-72 overflow-y-auto py-1">
              {inheritLabel !== undefined && (
                <button
                  type="button"
                  onClick={() => pick('')}
                  className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm transition-colors hover:opacity-90"
                  style={{ color: 'var(--text-primary)', background: value === '' ? 'var(--bg-tertiary)' : 'transparent' }}
                >
                  <span className="italic" style={{ color: 'var(--text-secondary)' }}>{inheritLabel}</span>
                  {value === '' && <Check className="w-3.5 h-3.5" />}
                </button>
              )}

              {aliases.length > 0 && (
                <>
                  <div className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>
                    Aliases (auto-updated)
                  </div>
                  {aliases.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => pick(m.id)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm transition-colors hover:opacity-90"
                      style={{
                        color: 'var(--text-primary)',
                        background: value === m.id ? 'var(--bg-tertiary)' : 'transparent',
                      }}
                    >
                      <span>{m.id}</span>
                      <span className="flex items-center gap-1.5">
                        {kindBadge(m) && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                            {kindBadge(m)}
                          </span>
                        )}
                        {value === m.id && <Check className="w-3.5 h-3.5" />}
                      </span>
                    </button>
                  ))}
                </>
              )}

              {discovered.length > 0 && (
                <>
                  <div className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>
                    Recently used
                  </div>
                  {discovered.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => pick(m.id)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm transition-colors hover:opacity-90"
                      style={{
                        color: 'var(--text-primary)',
                        background: value === m.id ? 'var(--bg-tertiary)' : 'transparent',
                      }}
                    >
                      <span className="truncate text-left">{displayLabel(m.id)}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {m.has1m && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                            1M
                          </span>
                        )}
                        {value === m.id && <Check className="w-3.5 h-3.5" />}
                      </span>
                    </button>
                  ))}
                </>
              )}

              <div className="border-t mt-1 pt-1" style={{ borderColor: 'var(--border)' }}>
                {customMode ? (
                  <div className="flex items-center gap-1.5 px-2 py-1.5">
                    <input
                      autoFocus
                      value={customDraft}
                      onChange={(e) => setCustomDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitCustom();
                        else if (e.key === 'Escape') { setCustomMode(false); setCustomDraft(''); }
                      }}
                      placeholder="claude-opus-4-7 or opus"
                      className="flex-1 px-2 py-1 rounded text-xs"
                      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', outline: 'none' }}
                    />
                    <button
                      type="button"
                      onClick={commitCustom}
                      className="px-2 py-1 rounded text-xs font-medium"
                      style={{ background: 'var(--accent)', color: '#fff' }}
                    >
                      Use
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setCustomMode(true); setCustomDraft(isCustom ? value : ''); }}
                    className="w-full text-left px-3 py-1.5 text-sm transition-colors hover:opacity-90"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Custom…
                  </button>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => { refetch(); }}
              disabled={isFetching}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px]"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-secondary)',
                borderTop: '1px solid var(--border)',
                opacity: isFetching ? 0.6 : 1,
              }}
            >
              <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} />
              {isFetching ? 'Refreshing…' : 'Rescan ~/.claude.json'}
            </button>
          </div>
        )}
      </div>
      {hint && (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function modelBadgeLabel(id: string | null | undefined): string {
  if (!id) return '';
  return displayLabel(id);
}
