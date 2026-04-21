import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Project, type RufloAgent } from '../lib/api';
import { Play, Loader2, Bot, TerminalSquare, Globe, Users, X, FolderOpen, GitBranch, Cpu, Activity, FileText, Zap, Code, ClipboardList, Search, FlaskConical, Rocket, BookOpen, UserCog, Compass, ArrowLeft, Star } from 'lucide-react';
import { ClaudeIcon, CodexIcon } from './CliIcons';
import { SessionMicButton } from './SessionMicButton';
import { ModelPicker } from './ModelPicker';

interface SessionLauncherProps {
  project: Project;
  onSessionCreated: (sessionId: string, projectName?: string, mode?: 'session' | 'terminal') => void;
  onWebPageCreated?: (url: string) => void;
  // External trigger: open the TaskModal in the given mode/CLI when set
  // (e.g. clicking the "Claude Agent" quick-launch on a project card).
  // The launcher calls onPendingLaunchHandled after consuming it.
  pendingLaunchMode?: LaunchMode;
  pendingLaunchCliType?: 'claude' | 'codex';
  onPendingLaunchHandled?: () => void;
}

type LaunchMode = 'session' | 'agent' | null;

/* ================================================================
   Agent picker wizard — intent → agent → task
   ================================================================
   Curated mapping from "what does the user want to do" to the
   OctoAlly default agents (see server/src/data/agents/), plus a
   "Custom / my agents" card that auto-surfaces any installed
   agent whose name is outside the default set. Power users can
   still browse all via the "Browse all" escape hatch.

   Descriptions come from the backend (api.projects.rufloAgents)
   so they stay in sync with the installed .md frontmatter — no
   manual paraphrases to maintain. Names listed here that aren't
   installed in a given project are filtered out at render time.
*/

// Names shipped in server/src/data/agents/ — kept in sync by hand,
// changes here should match additions/removals in that directory.
const DEFAULT_AGENT_NAMES = new Set<string>([
  'ai-engineer', 'api-documenter', 'architect-reviewer', 'backend-architect',
  'cloud-architect', 'code-reviewer-pro', 'database-optimizer', 'data-engineer',
  'data-scientist', 'debugger', 'deployment-engineer', 'devops-incident-responder',
  'documentation-expert', 'dx-optimizer', 'electron-pro', 'frontend-developer',
  'full-stack-developer', 'golang-pro', 'graphql-architect', 'incident-responder',
  'legacy-modernizer', 'ml-engineer', 'mobile-developer', 'nextjs-pro',
  'performance-engineer', 'postgresql-pglite-pro', 'product-manager', 'prompt-engineer',
  'python-pro', 'qa-expert', 'react-pro', 'security-auditor',
  'test-automator', 'typescript-pro', 'ui-designer', 'ux-designer',
]);

interface IntentDef {
  key: string;
  label: string;
  tagline: string;
  icon: typeof Bot;
  color: string;
  // Curated: explicit agent names, resolved against the installed set.
  recommended?: string[];
  domainSpecific?: string[];
  // Dynamic: custom resolver for intents whose membership can't be listed
  // up front (e.g. "Custom" surfaces anything not in DEFAULT_AGENT_NAMES).
  dynamic?: (agents: RufloAgent[]) => RufloAgent[];
  // Section label shown above the agent list when dynamic is used.
  dynamicLabel?: string;
}

const INTENTS: IntentDef[] = [
  {
    key: 'write-code',
    label: 'Write code',
    tagline: 'Build a feature, fix a bug, refactor',
    icon: Code,
    color: '#60a5fa',
    recommended: ['full-stack-developer', 'frontend-developer', 'backend-architect'],
    domainSpecific: [
      'python-pro', 'typescript-pro', 'golang-pro', 'react-pro', 'nextjs-pro',
      'mobile-developer', 'electron-pro', 'graphql-architect',
      'ai-engineer', 'ml-engineer', 'data-engineer',
    ],
  },
  {
    key: 'plan-estimate',
    label: 'Plan / scope / estimate',
    tagline: 'Quote a project, break it down, assess risk',
    icon: ClipboardList,
    color: '#a78bfa',
    recommended: ['product-manager', 'architect-reviewer'],
    domainSpecific: ['cloud-architect', 'prompt-engineer'],
  },
  {
    key: 'review-audit',
    label: 'Review / audit',
    tagline: 'Code review, quality, security',
    icon: Search,
    color: '#f59e0b',
    recommended: ['code-reviewer-pro', 'security-auditor'],
    domainSpecific: ['architect-reviewer', 'performance-engineer', 'database-optimizer'],
  },
  {
    key: 'test-validate',
    label: 'Test / validate',
    tagline: 'Write tests, TDD, validate',
    icon: FlaskConical,
    color: '#34d399',
    recommended: ['test-automator', 'qa-expert'],
    domainSpecific: ['debugger'],
  },
  {
    key: 'ship-deploy',
    label: 'Ship / deploy',
    tagline: 'Release, CI/CD, incident response',
    icon: Rocket,
    color: '#ec4899',
    recommended: ['deployment-engineer', 'devops-incident-responder'],
    domainSpecific: ['dx-optimizer', 'incident-responder', 'cloud-architect'],
  },
  {
    key: 'docs-design',
    label: 'Docs / design / data',
    tagline: 'Documentation, UX, data & DB',
    icon: BookOpen,
    color: '#22d3ee',
    recommended: ['documentation-expert', 'ux-designer'],
    domainSpecific: [
      'ui-designer', 'api-documenter', 'data-scientist',
      'postgresql-pglite-pro', 'legacy-modernizer',
    ],
  },
  {
    key: 'custom',
    label: 'Custom / my agents',
    tagline: 'Agents you added outside the default set',
    icon: UserCog,
    color: '#94a3b8',
    dynamic: (agents) => agents.filter((a) => !DEFAULT_AGENT_NAMES.has(a.name)),
    dynamicLabel: 'Your agents',
  },
];

type WizardStep = 'intent' | 'agent' | 'browse-all' | 'task';

function TaskModal({
  mode,
  project,
  agents,
  codexReady,
  initialCliType,
  onClose,
  onLaunch,
}: {
  mode: LaunchMode;
  project: Project;
  agents: RufloAgent[];
  codexReady: boolean;
  initialCliType?: 'claude' | 'codex';
  onClose: () => void;
  onLaunch: (task: string, agentType?: string, cliType?: 'claude' | 'codex', model?: string, rememberModel?: boolean, inheritMcp?: boolean) => void;
}) {
  const [task, setTask] = useState('');
  const [agentType, setAgentType] = useState(agents[0]?.name || 'coder');
  const [cliType, setCliType] = useState<'claude' | 'codex'>(initialCliType || 'claude');
  const [sessionPrompt, setSessionPrompt] = useState<string | null>(null);
  const [model, setModel] = useState<string>(project.default_model || '');
  const [rememberModel, setRememberModel] = useState(false);
  // Agent mode only: when true, launch Claude as a full session with the
  // agent persona injected as a prompt, so user MCP servers are available.
  // When false, use the native --agent flag (tool-scoped, no MCP unless
  // declared in the agent .md).
  const [inheritMcp, setInheritMcp] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Wizard state — only used when mode === 'agent'. In session mode the
  // wizard is bypassed entirely and we go straight to the task step.
  const [wizardStep, setWizardStep] = useState<WizardStep>(mode === 'agent' ? 'intent' : 'task');
  const [selectedIntent, setSelectedIntent] = useState<IntentDef | null>(null);
  const [browseQuery, setBrowseQuery] = useState('');

  // Lookup map: agent name → full RufloAgent (with description, category)
  const agentByName = new Map(agents.map((a) => [a.name, a]));

  useEffect(() => {
    if (wizardStep === 'task') textareaRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, wizardStep]);

  const sessionPromptVal = (sessionPrompt ?? project.session_prompt ?? '').trim();
  const effectiveTask = task.trim() || 'Start up and ask me what I want you to do and NOTHING ELSE';
  const finalTask = sessionPromptVal
    ? `${effectiveTask}\n\n---\nAdditional Instructions:\n${sessionPromptVal}`
    : effectiveTask;

  const handleLaunch = () => {
    const modelToSend = cliType === 'claude' ? model : '';
    onLaunch(
      finalTask,
      mode === 'agent' ? agentType : undefined,
      cliType,
      modelToSend,
      rememberModel && !!modelToSend,
      mode === 'agent' && cliType === 'claude' ? inheritMcp : undefined,
    );
  };

  // Pick an agent and advance to the task step
  const pickAgent = (name: string) => {
    setAgentType(name);
    setWizardStep('task');
  };

  // Resolve curated agent name lists into actual RufloAgent objects,
  // silently dropping any that aren't installed in this project.
  const resolveAgents = (names: string[]): RufloAgent[] =>
    names.map((n) => agentByName.get(n)).filter((a): a is RufloAgent => Boolean(a));

  // Count agents available in an intent — curated or dynamic.
  const countIntentAgents = (intent: IntentDef): number => {
    if (intent.dynamic) return intent.dynamic(agents).length;
    return resolveAgents([...(intent.recommended ?? []), ...(intent.domainSpecific ?? [])]).length;
  };

  // For "Browse all" — flat list filtered by search query, grouped by backend category
  const browseFiltered = browseQuery.trim()
    ? agents.filter((a) => {
        const q = browseQuery.toLowerCase();
        return a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q);
      })
    : agents;
  const browseGrouped = browseFiltered.reduce<Record<string, RufloAgent[]>>((acc, a) => {
    const cat = a.category || '(uncategorized)';
    (acc[cat] ??= []).push(a);
    return acc;
  }, {});

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative rounded-xl border shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 border-b shrink-0"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2">
            {mode === 'agent' ? (
              <Bot className="w-5 h-5" style={{ color: '#ef4444' }} />
            ) : (
              <Zap className="w-5 h-5" style={{ color: '#60a5fa' }} />
            )}
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {mode === 'agent' ? 'Launch Agent' : 'Launch Session'}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* ============================================================
              STEP: intent — agent mode wizard, step 1 of 3
              "What do you want to do?"
              ============================================================ */}
          {mode === 'agent' && wizardStep === 'intent' && (
            <>
              <div>
                <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                  What do you want to do?
                </h3>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  Pick an intent and we'll suggest the right agent for the job. {agents.length} agents installed in this project.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {INTENTS.map((intent) => {
                  const count = countIntentAgents(intent);
                  const Icon = intent.icon;
                  return (
                    <button
                      key={intent.key}
                      onClick={() => { setSelectedIntent(intent); setWizardStep('agent'); }}
                      disabled={count === 0}
                      className="text-left rounded-lg border p-4 transition-colors hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
                      title={count === 0 ? 'No agents from this intent are installed in this project' : undefined}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className="w-4 h-4" style={{ color: intent.color }} />
                        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {intent.label}
                        </span>
                      </div>
                      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {intent.tagline}
                      </p>
                      <p className="text-[10px] mt-2 font-mono" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
                        {count} agent{count === 1 ? '' : 's'}
                      </p>
                    </button>
                  );
                })}
                {/* Browse all escape hatch */}
                <button
                  onClick={() => setWizardStep('browse-all')}
                  className="text-left rounded-lg border border-dashed p-4 transition-colors hover:bg-white/5 col-span-2"
                  style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Compass className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
                    <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Browse all {agents.length} agents →
                    </span>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Search by name or description, grouped by category. For power users.
                  </p>
                </button>
              </div>
            </>
          )}

          {/* ============================================================
              STEP: agent — agent mode wizard, step 2 of 3
              List of recommended + domain-specific agents in the chosen intent
              ============================================================ */}
          {mode === 'agent' && wizardStep === 'agent' && selectedIntent && (
            <>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setSelectedIntent(null); setWizardStep('intent'); }}
                  className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded hover:bg-white/10"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <ArrowLeft className="w-3 h-3" />
                  Back
                </button>
                <div className="flex items-center gap-1.5 ml-2">
                  <selectedIntent.icon className="w-4 h-4" style={{ color: selectedIntent.color }} />
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {selectedIntent.label}
                  </h3>
                </div>
              </div>

              {/* Dynamic intent (e.g. Custom) — single flat list */}
              {selectedIntent.dynamic && (() => {
                const list = selectedIntent.dynamic(agents);
                if (list.length === 0) return (
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    No agents match this category yet. Drop your .md files into <code>~/.claude/agents/</code> or <code>&lt;project&gt;/.claude/agents/</code>.
                  </p>
                );
                return (
                  <div>
                    <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                      {selectedIntent.dynamicLabel ?? 'Agents'}
                    </span>
                    <div className="space-y-2 mt-2">
                      {list.map((a) => (
                        <button
                          key={a.name}
                          onClick={() => pickAgent(a.name)}
                          className="w-full text-left rounded-lg border p-3 transition-colors hover:bg-white/5"
                          style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
                        >
                          <div className="text-sm font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>
                            {a.name}
                          </div>
                          <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {a.description}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Recommended (curated intents) */}
              {!selectedIntent.dynamic && (() => {
                const recs = resolveAgents(selectedIntent.recommended ?? []);
                if (recs.length === 0) return null;
                return (
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Star className="w-3 h-3" style={{ color: '#fbbf24' }} />
                      <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                        Recommended
                      </span>
                    </div>
                    <div className="space-y-2">
                      {recs.map((a) => (
                        <button
                          key={a.name}
                          onClick={() => pickAgent(a.name)}
                          className="w-full text-left rounded-lg border p-3 transition-colors hover:bg-white/5"
                          style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
                        >
                          <div className="text-sm font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>
                            {a.name}
                          </div>
                          <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {a.description}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Domain-specific (curated intents) */}
              {!selectedIntent.dynamic && (() => {
                const domains = resolveAgents(selectedIntent.domainSpecific ?? []);
                if (domains.length === 0) return null;
                return (
                  <div>
                    <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                      Domain-specific
                    </span>
                    <div className="space-y-2 mt-2">
                      {domains.map((a) => (
                        <button
                          key={a.name}
                          onClick={() => pickAgent(a.name)}
                          className="w-full text-left rounded-lg border p-3 transition-colors hover:bg-white/5"
                          style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
                        >
                          <div className="text-sm font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>
                            {a.name}
                          </div>
                          <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {a.description}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <button
                onClick={() => setWizardStep('browse-all')}
                className="text-xs underline"
                style={{ color: 'var(--text-secondary)' }}
              >
                Browse all {agents.length} agents instead →
              </button>
            </>
          )}

          {/* ============================================================
              STEP: browse-all — flat list of every installed agent,
              filterable by name or description, grouped by backend category
              ============================================================ */}
          {mode === 'agent' && wizardStep === 'browse-all' && (
            <>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setWizardStep('intent')}
                  className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded hover:bg-white/10"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <ArrowLeft className="w-3 h-3" />
                  Back
                </button>
                <h3 className="text-sm font-semibold ml-2" style={{ color: 'var(--text-primary)' }}>
                  All agents ({browseFiltered.length}/{agents.length})
                </h3>
              </div>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-secondary)' }} />
                <input
                  type="text"
                  value={browseQuery}
                  onChange={(e) => setBrowseQuery(e.target.value)}
                  placeholder="Search by name or description..."
                  autoFocus
                  className="w-full pl-9 pr-3 py-2 rounded-lg border text-sm outline-none"
                  style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                />
              </div>
              <div className="space-y-4">
                {Object.keys(browseGrouped).sort().map((cat) => (
                  <div key={cat}>
                    <div className="text-[11px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                      {cat} ({browseGrouped[cat].length})
                    </div>
                    <div className="space-y-1">
                      {browseGrouped[cat].map((a) => (
                        <button
                          key={a.name}
                          onClick={() => pickAgent(a.name)}
                          className="w-full text-left rounded border px-3 py-2 transition-colors hover:bg-white/5"
                          style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
                        >
                          <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {a.name}
                          </div>
                          <div className="text-[11px] mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                            {a.description}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {browseFiltered.length === 0 && (
                  <p className="text-xs text-center py-8" style={{ color: 'var(--text-secondary)' }}>
                    No agents match "{browseQuery}"
                  </p>
                )}
              </div>
            </>
          )}

          {/* ============================================================
              STEP: task — final step, also the entry point for session mode
              CLI selector + info box + task input + prompt override + launch
              ============================================================ */}
          {wizardStep === 'task' && (
            <>
              {/* Selected agent recap (only in agent mode) */}
              {mode === 'agent' && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setWizardStep(selectedIntent ? 'agent' : 'intent')}
                    className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded hover:bg-white/10"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <ArrowLeft className="w-3 h-3" />
                    Change agent
                  </button>
                  <div className="flex items-center gap-1.5 ml-2">
                    <Bot className="w-4 h-4" style={{ color: '#ef4444' }} />
                    <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {agentType}
                    </span>
                    {agentByName.get(agentType)?.description && (
                      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        — {agentByName.get(agentType)!.description.slice(0, 80)}{(agentByName.get(agentType)!.description.length > 80) ? '…' : ''}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Inherit-MCP toggle — Claude agent mode only. When checked,
                  Claude launches as a full session with the agent persona in
                  the prompt, exposing the user's MCP servers to the agent.
                  When unchecked, uses native --agent (tool-scoped, no MCP). */}
              {mode === 'agent' && cliType === 'claude' && (
                <label
                  className="flex items-start gap-2 cursor-pointer select-none rounded-lg border p-3"
                  style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
                >
                  <input
                    type="checkbox"
                    checked={inheritMcp}
                    onChange={(e) => setInheritMcp(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded accent-orange-500 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Inherit MCP tools
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                      {inheritMcp
                        ? 'Launches as full session with agent persona in the prompt — all your MCP servers available (chrome-devtools, docs-search, …). Trades native --agent tool scoping for MCP access.'
                        : 'Uses native --agent flag. Strict tool scope from the agent\'s .md file — MCP tools NOT available unless explicitly declared there.'}
                    </div>
                  </div>
                </label>
              )}

              {/* CLI type + (when Claude) model selector nested under it */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>CLI:</span>
                  <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
                    <button
                      onClick={() => setCliType('claude')}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors"
                      style={{
                        background: cliType === 'claude' ? 'var(--accent-bg, rgba(59,130,246,0.15))' : 'var(--bg-primary)',
                        color: cliType === 'claude' ? 'var(--accent)' : 'var(--text-secondary)',
                        borderRight: '1px solid var(--border)',
                      }}
                    >
                      <ClaudeIcon className="w-3.5 h-3.5" />
                      Claude
                    </button>
                    <button
                      onClick={() => setCliType('codex')}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors"
                      style={{
                        background: cliType === 'codex' ? 'var(--accent-bg, rgba(59,130,246,0.15))' : 'var(--bg-primary)',
                        color: cliType === 'codex' ? 'var(--accent)' : 'var(--text-secondary)',
                      }}
                    >
                      <CodexIcon className="w-3.5 h-3.5" />
                      Codex
                    </button>
                  </div>
                </div>

                {cliType === 'claude' && (
                  <div
                    className="ml-2 pl-3 pt-1 pb-0.5"
                    style={{ borderLeft: '2px solid var(--border)' }}
                  >
                    <ModelPicker
                      label="Model"
                      value={model}
                      onChange={setModel}
                      inheritLabel={project.default_model ? `Project default (${project.default_model})` : 'Use default (global or CLI)'}
                    />
                    {model && project.id && (
                      <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={rememberModel}
                          onChange={(e) => setRememberModel(e.target.checked)}
                          className="w-3 h-3 rounded accent-orange-500"
                        />
                        <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                          Remember as project default
                        </span>
                      </label>
                    )}
                  </div>
                )}
              </div>

              {/* Info box — only for session mode, since the agent step is now self-explanatory via the wizard */}
              {mode === 'session' && (
                <div
                  className="rounded-lg border p-4 space-y-2"
                  style={{ background: 'var(--bg-primary)', borderColor: '#60a5fa', borderWidth: '1px' }}
                >
                  <div className="flex items-center gap-2 text-sm font-medium" style={{ color: '#60a5fa' }}>
                    <Zap className="w-4 h-4" />
                    Interactive Session
                  </div>
                  <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Launches an interactive Claude or Codex session for your project. Best for general development, debugging, and tasks you want to guide directly.
                  </div>
                </div>
              )}

              {/* Task input */}
              <div>
                <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Task / Objective</h3>
                <textarea
                  ref={textareaRef}
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder={`Describe what you want ${mode === 'agent' ? `the ${agentType} agent` : 'Claude'} to do...\n\nLeave empty to use default: "Start up and ask me what I want you to do"`}
                  rows={5}
                  className="w-full px-4 py-3 rounded-lg border text-sm outline-none resize-y"
                  style={{
                    background: 'var(--bg-primary)',
                    borderColor: 'var(--border)',
                    color: 'var(--text-primary)',
                    minHeight: '120px',
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      if (cliType === 'codex' && !codexReady) return;
                      handleLaunch();
                    }
                  }}
                />
                <div className="flex items-center justify-between mt-1.5">
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Cmd+Enter to launch
                  </p>
                  <SessionMicButton
                    small
                    onText={(text) => setTask((prev) => prev ? `${prev} ${text}` : text)}
                  />
                </div>
              </div>

              {/* Prompt override — switches between CLAUDE.md and AGENTS.md based on CLI toggle */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {cliType === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'} Prompt Override
                  </h3>
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Prepended to task as additional instructions
                  </span>
                </div>
                <textarea
                  value={sessionPrompt ?? project.session_prompt ?? ''}
                  onChange={(e) => setSessionPrompt(e.target.value)}
                  placeholder={`Additional instructions prepended to the task (supplements your project's ${cliType === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'})...`}
                  rows={2}
                  className="w-full px-4 py-3 rounded-lg border text-sm outline-none resize-y"
                  style={{
                    background: 'var(--bg-primary)',
                    borderColor: 'var(--border)',
                    color: 'var(--text-primary)',
                  }}
                />
                {sessionPrompt !== null && (
                  <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                    Modified for this session only.
                  </p>
                )}
              </div>

              {/* Launch button */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleLaunch}
                  disabled={cliType === 'codex' && !codexReady}
                  className="flex items-center gap-2 px-6 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  {mode === 'agent' ? (
                    <Users className="w-4 h-4" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                  Launch
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function SessionLauncher({ project, onSessionCreated, onWebPageCreated, pendingLaunchMode, pendingLaunchCliType, onPendingLaunchHandled }: SessionLauncherProps) {
  const [webUrl, setWebUrl] = useState('');
  const [launchMode, setLaunchMode] = useState<LaunchMode>(pendingLaunchMode ?? null);
  const queryClient = useQueryClient();

  // Consume external trigger to open TaskModal (e.g. project-card quick-launch).
  useEffect(() => {
    if (pendingLaunchMode) {
      setLaunchMode(pendingLaunchMode);
      onPendingLaunchHandled?.();
    }
  }, [pendingLaunchMode, onPendingLaunchHandled]);

  // Fetch available agent types for this project (reads .claude/agents/ — standard Claude Code feature)
  const { data: agentsData } = useQuery({
    queryKey: ['project-agents', project.id],
    queryFn: () => api.projects.rufloAgents(project.id),
    staleTime: 120_000,
  });
  const agents = agentsData?.agents ?? [];

  const createMutation = useMutation({
    mutationFn: (opts: { task: string; mode: 'session' | 'agent'; agentType?: string; cliType?: 'claude' | 'codex'; model?: string; rememberModel?: boolean; inheritMcp?: boolean }) => {
      return api.sessions.create({
        project_path: project.path,
        task: opts.task,
        mode: opts.mode,
        agent_type: opts.agentType,
        project_id: project.id,
        cli_type: opts.cliType,
        model: opts.model || undefined,
        remember_model: opts.rememberModel || undefined,
        inherit_mcp: opts.inheritMcp,
      });
    },
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (vars.rememberModel) queryClient.invalidateQueries({ queryKey: ['projects'] });
      setLaunchMode(null);
      if (data.session?.id) {
        onSessionCreated(data.session.id, undefined, 'session');
      }
    },
  });

  const terminalMutation = useMutation({
    mutationFn: () => {
      return api.sessions.create({ project_path: project.path, mode: 'terminal', project_id: project.id });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (data.session?.id) {
        onSessionCreated(data.session.id, undefined, 'terminal');
      }
    },
  });

  const handleLaunch = (task: string, agentType?: string, cliType?: 'claude' | 'codex', model?: string, rememberModel?: boolean, inheritMcp?: boolean) => {
    const mode = agentType ? 'agent' : 'session';
    createMutation.mutate({ task, mode, agentType, cliType, model, rememberModel, inheritMcp });
  };

  // Fetch git status for project info (may fail if not a git repo)
  const { data: gitData, isError: gitError } = useQuery({
    queryKey: ['git-status', project.path],
    queryFn: () => api.git.status(project.path),
    staleTime: 30_000,
    retry: false,
  });

  // Fetch active sessions count
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
  });
  const activeSessions = (sessionsData?.sessions || []).filter(
    (s) => s.project_id === project.id && (s.status === 'running' || s.status === 'detached')
  );

  const btnBase = "flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 border whitespace-nowrap min-w-0";

  return (
    <div className="h-full overflow-y-auto p-6 pt-8">
      <div className="w-full max-w-4xl mx-auto space-y-6">
        {/* Logo */}
        <div className="flex justify-center">
          <img src="/octoally-icon.png" alt="" className="w-20 h-20 object-contain" />
        </div>
        {/* Project info card */}
        <div
          className="rounded-xl border p-5"
          style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
        >
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {project.name}
              </h3>
              {project.description && (
                <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {project.description}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--success)' }}
              >
                <Cpu className="w-3 h-3" />
                Ready
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <FolderOpen className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Path</span>
              </div>
              <p className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }} title={project.path}>
                {project.path.replace(/^\/home\/[^/]+/, '~')}
              </p>
            </div>
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <GitBranch className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Branch</span>
              </div>
              {gitError ? (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>No git repo</p>
              ) : (
                <p className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                  {gitData?.branch || '...'}
                  {gitData && (gitData.ahead > 0 || gitData.behind > 0) && (
                    <span style={{ color: 'var(--warning)' }}>
                      {gitData.ahead > 0 ? ` +${gitData.ahead}` : ''}
                      {gitData.behind > 0 ? ` -${gitData.behind}` : ''}
                    </span>
                  )}
                </p>
              )}
            </div>
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Activity className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Sessions</span>
              </div>
              <p className="text-xs" style={{ color: activeSessions.length > 0 ? 'var(--success)' : 'var(--text-primary)' }}>
                {activeSessions.length} active
              </p>
              {gitData?.files && gitData.files.length > 0 && (
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--warning)' }}>{gitData.files.length} file{gitData.files.length !== 1 ? 's' : ''} changed</p>
              )}
            </div>
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <FileText className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Agents</span>
              </div>
              <p className="text-xs" style={{ color: agents.length > 0 ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                {agents.length > 0 ? `${agents.length} available` : 'None'}
              </p>
            </div>
          </div>
        </div>

        {/* Launch buttons */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setLaunchMode('session')}
            disabled={createMutation.isPending}
            className={btnBase}
            style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
          >
            {createMutation.isPending && launchMode === 'session' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Zap className="w-4 h-4" style={{ color: '#60a5fa' }} />
            )}
            Launch Session
          </button>
          <button
            onClick={() => setLaunchMode('agent')}
            disabled={createMutation.isPending}
            className={btnBase}
            style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
          >
            {createMutation.isPending && launchMode === 'agent' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Bot className="w-4 h-4" style={{ color: '#ef4444' }} />
            )}
            Launch Agent
          </button>
          <button
            onClick={() => terminalMutation.mutate()}
            disabled={terminalMutation.isPending}
            className={btnBase}
            style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
            title="Open a plain terminal in the project directory"
          >
            {terminalMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <TerminalSquare className="w-4 h-4" style={{ color: '#f59e0b' }} />
            )}
            Launch Terminal
          </button>
        </div>

        {/* Web page section */}
        {onWebPageCreated && (() => {
          const defaultUrl = project.default_web_url || 'http://localhost:3000';
          const resolvedUrl = webUrl.trim() || defaultUrl;
          return (
            <div
              className="rounded-xl border p-4 space-y-3"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--bg-secondary)',
              }}
            >
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Open Web Page
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={webUrl}
                  onChange={(e) => setWebUrl(e.target.value)}
                  placeholder={defaultUrl}
                  className="flex-1 px-3 py-2 rounded-lg border text-sm outline-none"
                  style={{
                    background: 'var(--bg-primary)',
                    borderColor: 'var(--border)',
                    color: 'var(--text-primary)',
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onWebPageCreated(resolvedUrl);
                      setWebUrl('');
                    }
                  }}
                />
                <button
                  onClick={() => {
                    onWebPageCreated(resolvedUrl);
                    setWebUrl('');
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  <Globe className="w-4 h-4" />
                  Open
                </button>
              </div>
            </div>
          );
        })()}

        {(createMutation.isError || terminalMutation.isError) && (
          <p className="text-sm" style={{ color: 'var(--error)' }}>
            {((createMutation.error || terminalMutation.error) as Error).message}
          </p>
        )}

        {/* Task modal */}
        {launchMode && (
          <TaskModal
            mode={launchMode}
            project={project}
            agents={agents}
            codexReady={true}
            initialCliType={pendingLaunchCliType}
            onClose={() => setLaunchMode(null)}
            onLaunch={handleLaunch}
          />
        )}

      </div>
    </div>
  );
}
