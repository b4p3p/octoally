import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { X, Settings, Check, Loader2, Zap, Bot, Type, Globe, RotateCcw, BarChart3, Download, Trash2, Keyboard } from 'lucide-react';
import { ClaudeIcon, CodexIcon } from './CliIcons';
import {
  ACTIONS,
  type ActionDef,
  useShortcutStore,
  eventToCombo,
  resolveCombo,
  displayCombo,
  isValidCombo,
  findActionByCombo,
  getAction,
  pushSuspend,
} from '../lib/shortcuts';

interface SettingsModalProps {
  onClose: () => void;
}

function CommandInput({
  label,
  icon,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
        {icon}
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg text-sm"
        style={{
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          outline: 'none',
        }}
        onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
        onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
      />
    </div>
  );
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
  });
  const { data: networkData } = useQuery({
    queryKey: ['network-info'],
    queryFn: () => fetch('/api/network-info').then((r) => r.json()) as Promise<{ addresses: string[]; port: number }>,
  });

  const [sessionClaudeCmd, setSessionClaudeCmd] = useState('');
  const [sessionCodexCmd, setSessionCodexCmd] = useState('');
  const [agentClaudeCmd, setAgentClaudeCmd] = useState('');
  const [agentCodexCmd, setAgentCodexCmd] = useState('');
  const [fontSize, setFontSize] = useState('12');
  const [appFontSize, setAppFontSize] = useState('16');
  const [serverPort, setServerPort] = useState('42010');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data?.settings) {
      const s = data.settings;
      setSessionClaudeCmd(s.session_claude_command || '');
      setSessionCodexCmd(s.session_codex_command || '');
      setAgentClaudeCmd(s.agent_claude_command || '');
      setAgentCodexCmd(s.agent_codex_command || '');
      setFontSize(s.terminal_font_size || '12');
      setAppFontSize(s.app_font_size || '16');
      setServerPort(s.server_port || '42010');
      useShortcutStore.getState().hydrate(s.shortcut_bindings || null);
    }
  }, [data]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    // Suspend global shortcuts while the modal is open so binding captures
    // (and typing in inputs) don't fire navigation actions in the background.
    const release = pushSuspend();
    return () => {
      window.removeEventListener('keydown', handleKey);
      release();
    };
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: (settings: Record<string, string>) => api.settings.update(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  function handleSave() {
    mutation.mutate({
      session_claude_command: sessionClaudeCmd,
      session_codex_command: sessionCodexCmd,
      agent_claude_command: agentClaudeCmd,
      agent_codex_command: agentCodexCmd,
      terminal_font_size: fontSize,
      app_font_size: appFontSize,
      server_port: serverPort,
      shortcut_bindings: useShortcutStore.getState().serialize(),
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{
          width: '100%',
          maxWidth: '900px',
          maxHeight: '90vh',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5" style={{ color: 'var(--accent)' }} />
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Settings
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md transition-colors hover:opacity-80"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body — 2-column grid */}
        <div className="px-6 py-5 overflow-y-auto" style={{ maxHeight: '65vh' }}>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-secondary)' }} />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
              {/* ── LEFT COLUMN ── */}
              <div className="space-y-6">
                {/* Session Commands */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4" style={{ color: '#60a5fa' }} />
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Session Commands
                    </h4>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    The CLI command used when launching sessions.
                  </p>
                  <div className="space-y-3 pl-1">
                    <CommandInput
                      label="Claude"
                      icon={<ClaudeIcon className="w-3.5 h-3.5" style={{ color: '#60a5fa' }} />}
                      value={sessionClaudeCmd}
                      onChange={setSessionClaudeCmd}
                      placeholder="claude"
                    />
                    <CommandInput
                      label="Codex"
                      icon={<CodexIcon className="w-3.5 h-3.5" style={{ color: '#60a5fa' }} />}
                      value={sessionCodexCmd}
                      onChange={setSessionCodexCmd}
                      placeholder="claude"
                    />
                  </div>
                </div>

                {/* Agent Commands */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Bot className="w-4 h-4" style={{ color: '#ef4444' }} />
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Agent Commands
                    </h4>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    The CLI command used when launching Agent sessions.
                  </p>
                  <div className="space-y-3 pl-1">
                    <CommandInput
                      label="Claude"
                      icon={<ClaudeIcon className="w-3.5 h-3.5" style={{ color: '#ef4444' }} />}
                      value={agentClaudeCmd}
                      onChange={setAgentClaudeCmd}
                      placeholder="claude"
                    />
                    <CommandInput
                      label="Codex"
                      icon={<CodexIcon className="w-3.5 h-3.5" style={{ color: '#ef4444' }} />}
                      value={agentCodexCmd}
                      onChange={setAgentCodexCmd}
                      placeholder="claude"
                    />
                  </div>
                </div>

                {/* Server */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4" style={{ color: '#22c55e' }} />
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Server
                    </h4>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Port for the OctoAlly server. Changes take effect on restart.
                  </p>
                  <div className="space-y-2 pl-1">
                    <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                      Port
                    </label>
                    <input
                      type="number"
                      min="1024"
                      max="65535"
                      value={serverPort}
                      onChange={(e) => setServerPort(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg text-sm"
                      style={{
                        background: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                        outline: 'none',
                      }}
                      onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
                      onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
                    />
                    {networkData?.addresses && networkData.addresses.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-1">
                        {networkData.addresses.map((ip) => (
                          <span
                            key={ip}
                            className="px-2 py-0.5 rounded text-xs font-mono"
                            style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                          >
                            http://{ip}:{serverPort}
                          </span>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={async () => {
                        try {
                          await fetch('/api/restart', { method: 'POST' });
                        } catch {}
                      }}
                      className="flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
                      style={{ background: 'var(--warning)', color: '#000' }}
                    >
                      <RotateCcw className="w-3 h-3" />
                      Restart Server
                    </button>
                  </div>
                </div>
              </div>

              {/* ── RIGHT COLUMN ── */}
              <div className="space-y-6">
                {/* Appearance */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Type className="w-4 h-4" style={{ color: '#a855f7' }} />
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Appearance
                    </h4>
                  </div>
                  <div className="space-y-4 pl-1">
                    {/* App Font Size */}
                    <div className="space-y-2">
                      <label className="flex items-center justify-between text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                        <span>App Font Size</span>
                        <span
                          className="px-2 py-0.5 rounded text-xs tabular-nums"
                          style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}
                        >
                          {appFontSize}px
                        </span>
                      </label>
                      <input
                        type="range"
                        min="10"
                        max="32"
                        step="1"
                        value={appFontSize}
                        onChange={(e) => {
                          setAppFontSize(e.target.value);
                          document.documentElement.style.setProperty('--app-font-size', `${e.target.value}px`);
                        }}
                        className="w-full accent-purple-500"
                        style={{ height: '4px' }}
                      />
                      <div className="flex justify-between text-xs" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>
                        <span>10</span>
                        <span>32</span>
                      </div>
                    </div>

                    {/* Terminal Font Size */}
                    <div className="space-y-2">
                      <label className="flex items-center justify-between text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                        <span>Terminal Font Size</span>
                        <span
                          className="px-2 py-0.5 rounded text-xs tabular-nums"
                          style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}
                        >
                          {fontSize}px
                        </span>
                      </label>
                      <input
                        type="range"
                        min="8"
                        max="24"
                        step="1"
                        value={fontSize}
                        onChange={(e) => setFontSize(e.target.value)}
                        className="w-full accent-purple-500"
                        style={{ height: '4px' }}
                      />
                      <div className="flex justify-between text-xs" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>
                        <span>8</span>
                        <span>24</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Claude Status Bar */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="w-4 h-4" style={{ color: '#06b6d4' }} />
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Claude Status Bar
                    </h4>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Custom status bar for Claude Code showing git branch, model, context usage, cost, and session duration.
                  </p>
                  {(() => {
                    const { data: slData, isLoading: slLoading } = useQuery({
                      queryKey: ['statusline'],
                      queryFn: () => api.settings.statusline.get(),
                    });
                    const [slBusy, setSlBusy] = useState(false);
                    const [slResult, setSlResult] = useState<string | null>(null);

                    const handleToggle = async () => {
                      setSlBusy(true);
                      setSlResult(null);
                      try {
                        if (slData?.installed) {
                          await api.settings.statusline.uninstall();
                          setSlResult('Status bar removed.');
                        } else {
                          await api.settings.statusline.install();
                          setSlResult('Status bar installed! It will appear on your next Claude Code interaction.');
                        }
                        queryClient.invalidateQueries({ queryKey: ['statusline'] });
                      } catch (err: any) {
                        setSlResult(`Error: ${err.message || 'Failed'}`);
                      } finally {
                        setSlBusy(false);
                      }
                    };

                    return (
                      <>
                        <button
                          onClick={handleToggle}
                          disabled={slBusy || slLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
                          style={{
                            background: slData?.installed ? '#ef4444' : '#06b6d4',
                            color: '#fff',
                            opacity: slBusy || slLoading ? 0.6 : 1,
                          }}
                        >
                          {slBusy ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : slData?.installed ? (
                            <Trash2 className="w-3 h-3" />
                          ) : (
                            <Download className="w-3 h-3" />
                          )}
                          {slBusy
                            ? (slData?.installed ? 'Removing...' : 'Installing...')
                            : (slData?.installed ? 'Uninstall Status Bar' : 'Install Status Bar')}
                        </button>
                        {slResult && (
                          <p className="text-xs mt-1" style={{ color: slResult.startsWith('Error') ? '#ef4444' : '#22c55e' }}>
                            {slResult}
                          </p>
                        )}
                      </>
                    );
                  })()}
                </div>

                {/* Reinitialize */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <RotateCcw className="w-4 h-4" style={{ color: '#f59e0b' }} />
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Reinitialize OctoAlly
                    </h4>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Resets all Claude/Codex settings, removes old artifacts, and reinstalls default agents and skills.
                    Your projects are preserved.
                  </p>
                  {(() => {
                    const [running, setRunning] = useState(false);
                    const [result, setResult] = useState<string | null>(null);
                    return (
                      <>
                        <button
                          onClick={async () => {
                            if (!confirm(
                              'This will:\n\n' +
                              '• Remove .claude/, .codex/, CLAUDE.md from all projects\n' +
                              '• Reset session commands to defaults\n' +
                              '• Remove broken symlinks and old config\n' +
                              '• Reinstall all default agents and skills\n\n' +
                              'Your projects will be preserved. Claude/Codex will ask you to trust each folder again on next use.\n\nContinue?'
                            )) return;
                            setRunning(true);
                            setResult(null);
                            try {
                              const res = await api.projects.rufloUninstallAll();
                              queryClient.invalidateQueries({ queryKey: ['projects'] });
                              queryClient.invalidateQueries({ queryKey: ['ruflo-disposition'] });
                              const parts: string[] = [];
                              if (res.projectsCleaned > 0) parts.push(`reset ${res.projectsCleaned} project(s)`);
                              const agentCount = res.globalCleaned.filter((s: string) => s.includes('agent')).length;
                              if (agentCount > 0) parts.push(`installed agents`);
                              const otherCount = res.globalCleaned.length - agentCount;
                              if (otherCount > 0) parts.push(`cleaned ${otherCount} global item(s)`);
                              setResult(parts.length > 0
                                ? `Done — ${parts.join(', ')}.`
                                : 'Already clean — reinstalled agents.');
                            } catch (err: any) {
                              setResult(`Error: ${err.message || 'Failed'}`);
                            } finally {
                              setRunning(false);
                            }
                          }}
                          disabled={running}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
                          style={{ background: '#f59e0b', color: '#000', opacity: running ? 0.6 : 1 }}
                        >
                          {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                          {running ? 'Reinitializing...' : 'Reinitialize'}
                        </button>
                        {result && (
                          <p className="text-xs mt-1" style={{ color: result.startsWith('Error') ? '#ef4444' : '#22c55e' }}>
                            {result}
                          </p>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>
          )}

          {/* Keyboard Shortcuts — full-width section */}
          {!isLoading && <ShortcutsSection />}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-6 py-4 shrink-0"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={mutation.isPending}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: saved ? 'var(--success, #22c55e)' : 'var(--accent)',
              color: '#fff',
              opacity: mutation.isPending ? 0.7 : 1,
            }}
          >
            {mutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : saved ? (
              <Check className="w-3.5 h-3.5" />
            ) : null}
            {saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ====================================================================
   Keyboard Shortcuts section (rendered inside SettingsModal body)
   ==================================================================== */

function ShortcutsSection() {
  // Subscribing here ensures the section re-renders when any binding changes,
  // so each ShortcutRow's `getEffective` read picks up the latest state.
  useShortcutStore((s) => s.bindings);
  const groups = ACTIONS.reduce<Record<string, ActionDef[]>>((acc, a) => {
    (acc[a.category] ??= []).push(a);
    return acc;
  }, {});

  return (
    <div className="mt-6 pt-6 space-y-4" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        <Keyboard className="w-4 h-4" style={{ color: '#f59e0b' }} />
        <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Keyboard Shortcuts
        </h4>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        Click <span className="font-mono">Set</span> and press a key combination. Shortcuts don't
        fire while you're typing in an input unless the "In inputs" toggle is on.
      </p>

      {Object.entries(groups).map(([category, actions]) => (
        <div key={category} className="space-y-1.5">
          <div
            className="text-[11px] uppercase tracking-wider font-semibold"
            style={{ color: 'var(--text-secondary)' }}
          >
            {category}
          </div>
          <div
            className="rounded-lg overflow-hidden"
            style={{ border: '1px solid var(--border)' }}
          >
            {actions.map((action, idx) => (
              <ShortcutRow
                key={action.id}
                action={action}
                isLast={idx === actions.length - 1}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ShortcutRow({
  action,
  isLast,
}: {
  action: ActionDef;
  isLast: boolean;
}) {
  const [capturing, setCapturing] = useState(false);
  // Primitive selectors — returning fresh objects from a zustand selector
  // triggers React's "getSnapshot should be cached" infinite-render crash.
  const userBinding = useShortcutStore((s) => s.bindings[action.id]);
  const setBinding = useShortcutStore((s) => s.setBinding);
  const resetBinding = useShortcutStore((s) => s.resetBinding);

  const def = getAction(action.id);
  const effectiveCombo =
    userBinding?.combo !== undefined ? userBinding.combo : def?.defaultCombo ?? null;
  const effectiveFireInEditable =
    userBinding?.fireInEditable !== undefined
      ? userBinding.fireInEditable
      : !!def?.fireInEditableByDefault;

  const isDefault =
    effectiveCombo === def?.defaultCombo &&
    !!effectiveFireInEditable === !!def?.fireInEditableByDefault;

  return (
    <>
      <div
        className="flex items-center gap-3 px-3 py-2.5"
        style={{
          background: 'var(--bg-primary)',
          borderBottom: isLast ? undefined : '1px solid var(--border)',
        }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
            {action.name}
          </div>
          {action.description && (
            <div
              className="text-[11px] mt-0.5 truncate"
              style={{ color: 'var(--text-secondary)' }}
            >
              {action.description}
            </div>
          )}
        </div>

        {/* Current combo / unbound */}
        <div
          className="px-3 py-1.5 rounded text-sm font-mono font-semibold shrink-0"
          style={{
            background: effectiveCombo ? 'var(--bg-tertiary)' : 'transparent',
            color: effectiveCombo ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: '1px solid var(--border)',
            minWidth: 120,
            textAlign: 'center',
            fontVariantEmoji: 'text',  // avoid emoji font rendering for arrow glyphs
          }}
        >
          {displayCombo(effectiveCombo)}
        </div>

        {/* Fire-in-editable toggle */}
        <label
          className="flex items-center gap-1 text-[11px] shrink-0 cursor-pointer"
          style={{ color: 'var(--text-secondary)' }}
          title="Also fire this shortcut when focus is in an input, textarea, or terminal"
        >
          <input
            type="checkbox"
            checked={!!effectiveFireInEditable}
            onChange={(e) => setBinding(action.id, { fireInEditable: e.target.checked })}
            className="accent-orange-500"
          />
          In inputs
        </label>

        <button
          onClick={() => setCapturing(true)}
          className="px-2 py-1 rounded text-[11px] font-medium transition-colors shrink-0"
          style={{
            background: 'var(--accent)',
            color: '#fff',
          }}
        >
          Set
        </button>

        <button
          onClick={() => setBinding(action.id, { combo: null })}
          className="px-2 py-1 rounded text-[11px] font-medium transition-colors shrink-0"
          style={{
            background: 'transparent',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}
          title="Unbind"
        >
          Clear
        </button>

        <button
          onClick={() => resetBinding(action.id)}
          disabled={isDefault}
          className="px-2 py-1 rounded text-[11px] font-medium transition-colors shrink-0"
          style={{
            background: 'transparent',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
            opacity: isDefault ? 0.4 : 1,
            cursor: isDefault ? 'default' : 'pointer',
          }}
          title="Reset to default"
        >
          Reset
        </button>
      </div>

      {capturing && (
        <CaptureOverlay
          action={action}
          onCancel={() => setCapturing(false)}
          onCaptured={(combo) => {
            setBinding(action.id, { combo });
            setCapturing(false);
          }}
        />
      )}
    </>
  );
}

function CaptureOverlay({
  action,
  onCancel,
  onCaptured,
}: {
  action: ActionDef;
  onCancel: () => void;
  onCaptured: (combo: string) => void;
}) {
  const [captured, setCaptured] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      // Ignore pure-modifier presses — wait for a real key
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const combo = eventToCombo(e);
      if (!isValidCombo(combo)) {
        setError('Need at least one modifier (Ctrl/Cmd/Alt) plus a key.');
        return;
      }
      setError(null);
      const resolved = resolveCombo(combo);
      const conflictId = findActionByCombo(resolved, action.id);
      if (conflictId) {
        const def = getAction(conflictId);
        setConflict(def?.name ?? conflictId);
        setCaptured(combo);
        return;
      }
      setCaptured(combo);
      setConflict(null);
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true } as EventListenerOptions);
  }, [action.id, onCancel]);

  const handleConfirm = () => {
    if (captured) onCaptured(captured);
  };

  const handleReassign = () => {
    // Clear the conflicting action's binding, then confirm this capture.
    if (!captured) return;
    const resolved = resolveCombo(captured);
    const conflictId = findActionByCombo(resolved, action.id);
    if (conflictId) {
      useShortcutStore.getState().setBinding(conflictId, { combo: null });
    }
    onCaptured(captured);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onCancel}
    >
      <div
        className="rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4 space-y-3"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Keyboard className="w-4 h-4" style={{ color: '#f59e0b' }} />
          <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Set shortcut: {action.name}
          </h4>
        </div>

        <div
          className="flex items-center justify-center py-6 rounded-lg font-mono text-lg"
          style={{
            background: 'var(--bg-primary)',
            color: captured ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}
        >
          {captured ? displayCombo(captured) : 'Press keys...'}
        </div>

        {error && (
          <p className="text-xs" style={{ color: '#ef4444' }}>
            {error}
          </p>
        )}

        {conflict && (
          <p className="text-xs" style={{ color: '#f59e0b' }}>
            Already bound to <span className="font-semibold">{conflict}</span>. Reassign it to this
            action?
          </p>
        )}

        <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          Press Esc to cancel.
        </p>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-xs font-medium"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}
          >
            Cancel
          </button>
          {captured && !conflict && (
            <button
              onClick={handleConfirm}
              className="px-3 py-1.5 rounded-md text-xs font-medium"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              Save
            </button>
          )}
          {captured && conflict && (
            <button
              onClick={handleReassign}
              className="px-3 py-1.5 rounded-md text-xs font-medium"
              style={{ background: '#f59e0b', color: '#000' }}
            >
              Reassign
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
