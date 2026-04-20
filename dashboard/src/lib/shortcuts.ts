/**
 * Keyboard shortcut registry + global dispatcher.
 *
 * - Action catalog is static (ACTIONS below). Each action has an ID, display
 *   name, category, default key combo, and a `fireInEditableByDefault` flag.
 * - Bindings are per-user, persisted to the server's settings table as a JSON
 *   string under key `shortcut_bindings`. Users can override combo + fire-in-
 *   editable per action via the Settings modal.
 * - Components call `useShortcut(actionId, handler)` to register behavior.
 *   A single window keydown listener dispatches to the latest-registered
 *   handler for the matched action.
 * - By default, shortcuts do NOT fire when the user is typing in an
 *   input/textarea/contenteditable/xterm terminal — per-action opt-in via the
 *   binding's `fireInEditable` flag.
 */

import { useEffect, useRef } from 'react';
import { create } from 'zustand';

/* ---------- Action catalog --------------------------------------------- */

export type ActionCategory = 'Navigation' | 'Actions';

export interface ActionDef {
  id: string;
  name: string;
  description?: string;
  category: ActionCategory;
  defaultCombo: string;
  /** Default for the `fireInEditable` flag. Users can override per-binding. */
  fireInEditableByDefault?: boolean;
}

export const ACTIONS: readonly ActionDef[] = [
  {
    id: 'nav.nextTab',
    name: 'Next Tab',
    description: 'Cycle to the next project tab',
    category: 'Navigation',
    defaultCombo: 'mod+shift+arrowright',
    // Navigation must work even when focus is inside the terminal or an
    // input — otherwise users get stuck after the first switch.
    fireInEditableByDefault: true,
  },
  {
    id: 'nav.prevTab',
    name: 'Previous Tab',
    description: 'Cycle to the previous project tab',
    category: 'Navigation',
    defaultCombo: 'mod+shift+arrowleft',
    fireInEditableByDefault: true,
  },
  {
    id: 'nav.nextSidebar',
    name: 'Next Sidebar Button',
    description: 'Move to the next left-sidebar button in the current project',
    category: 'Navigation',
    defaultCombo: 'mod+shift+arrowdown',
    fireInEditableByDefault: true,
  },
  {
    id: 'nav.prevSidebar',
    name: 'Previous Sidebar Button',
    description: 'Move to the previous left-sidebar button in the current project',
    category: 'Navigation',
    defaultCombo: 'mod+shift+arrowup',
    fireInEditableByDefault: true,
  },
  {
    id: 'terminal.nextTab',
    name: 'Next Terminal Tab',
    description: 'Cycle to the next terminal/agent tab in the current project',
    category: 'Navigation',
    // Punctuation shortcuts (Ctrl+Shift+.) are a trap: Shift+. produces `>` on
    // US layouts, so e.key is `>`, not `.`, and the combo never matches.
    // Ctrl+Alt+Arrow is intercepted by Linux DEs for workspace switching.
    // Alt+Shift+Arrow is layout-independent and rarely bound by the OS.
    defaultCombo: 'alt+shift+arrowright',
    fireInEditableByDefault: true,
  },
  {
    id: 'terminal.prevTab',
    name: 'Previous Terminal Tab',
    description: 'Cycle to the previous terminal/agent tab in the current project',
    category: 'Navigation',
    defaultCombo: 'alt+shift+arrowleft',
    fireInEditableByDefault: true,
  },
  {
    id: 'nav.goHome',
    name: 'Go to Projects Page',
    description: 'Jump to the main projects page (card view)',
    category: 'Navigation',
    defaultCombo: 'mod+shift+h',
    fireInEditableByDefault: true,
  },
  {
    id: 'home.nextCard',
    name: 'Next Project Card',
    description: 'Select the next card on the projects page',
    category: 'Navigation',
    defaultCombo: 'arrowright',
    fireInEditableByDefault: false,
  },
  {
    id: 'home.prevCard',
    name: 'Previous Project Card',
    description: 'Select the previous card on the projects page',
    category: 'Navigation',
    defaultCombo: 'arrowleft',
    fireInEditableByDefault: false,
  },
  {
    id: 'home.nextRowCard',
    name: 'Next Row (Project Cards)',
    description: 'Move card selection down one row on the projects page',
    category: 'Navigation',
    defaultCombo: 'arrowdown',
    fireInEditableByDefault: false,
  },
  {
    id: 'home.prevRowCard',
    name: 'Previous Row (Project Cards)',
    description: 'Move card selection up one row on the projects page',
    category: 'Navigation',
    defaultCombo: 'arrowup',
    fireInEditableByDefault: false,
  },
  {
    id: 'home.openSelectedCard',
    name: 'Open Selected Project Card',
    description: 'Open the currently selected card on the projects page',
    category: 'Navigation',
    defaultCombo: 'enter',
    fireInEditableByDefault: false,
  },
  {
    id: 'nav.blurInput',
    name: 'Release Focus from Input',
    description: 'Blur the currently focused input/terminal — useful to "escape" before using other shortcuts or the mouse',
    category: 'Navigation',
    defaultCombo: '',  // unbound by default; user picks a combo they like
    fireInEditableByDefault: true,
  },
  {
    id: 'dictation.toggle',
    name: 'Toggle Dictation',
    description: 'Start or stop the top-bar dictation button',
    category: 'Actions',
    defaultCombo: 'mod+shift+d',
    fireInEditableByDefault: true,
  },
  {
    id: 'session.launchClaude',
    name: 'Launch Claude Session',
    description: 'Start a Claude session in the current project (or the selected card on the projects page)',
    category: 'Actions',
    defaultCombo: 'mod+shift+l',
    fireInEditableByDefault: true,
  },
  {
    id: 'session.launchCodex',
    name: 'Launch Codex Session',
    description: 'Start a Codex session in the current project (or the selected card on the projects page)',
    category: 'Actions',
    // cOdex — second letter pairs with L for cLaude.
    defaultCombo: 'mod+shift+o',
    fireInEditableByDefault: true,
  },
  {
    id: 'session.launchTerminal',
    name: 'Launch Terminal',
    description: 'Start a plain terminal in the current project (or the selected card on the projects page)',
    category: 'Actions',
    defaultCombo: 'mod+shift+t',
    fireInEditableByDefault: true,
  },
  {
    id: 'terminal.closeTab',
    name: 'Close Terminal Tab',
    description: 'Close the currently-active terminal/agent tab (opens confirm; Enter kills)',
    category: 'Actions',
    defaultCombo: 'mod+shift+x',
    fireInEditableByDefault: true,
  },
] as const;

export function getAction(id: string): ActionDef | undefined {
  return ACTIONS.find((a) => a.id === id);
}

/* ---------- Key normalization ------------------------------------------ */

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);

/**
 * Canonical combo string format: `mod1+mod2+...+key`, modifiers alphabetized.
 * Modifier tokens: `ctrl`, `alt`, `shift`, `meta`, `mod` (platform-aware: meta
 * on macOS, ctrl elsewhere). Stored bindings typically use `mod`; at dispatch
 * time we compare against the actual event which uses `ctrl` / `meta`.
 */
export function eventToCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.altKey) parts.push('alt');
  if (e.ctrlKey) parts.push('ctrl');
  if (e.metaKey) parts.push('meta');
  if (e.shiftKey) parts.push('shift');
  parts.sort();
  const key = normalizeKey(e.key);
  if (!key) return '';
  // Ignore pure-modifier events
  if (['alt', 'ctrl', 'meta', 'shift', 'control', 'option', 'command'].includes(key)) return '';
  parts.push(key);
  return parts.join('+');
}

export function normalizeKey(key: string): string {
  const k = key.toLowerCase();
  if (k === ' ') return 'space';
  if (k === 'escape') return 'escape';
  if (k === 'arrowleft') return 'arrowleft';
  if (k === 'arrowright') return 'arrowright';
  if (k === 'arrowup') return 'arrowup';
  if (k === 'arrowdown') return 'arrowdown';
  if (k === 'control') return 'ctrl';
  if (k === 'option') return 'alt';
  if (k === 'command') return 'meta';
  return k;
}

/** Expand `mod` tokens to the current platform's physical modifier. */
export function resolveCombo(combo: string): string {
  if (!combo) return '';
  const parts = combo.split('+').map((p) => p.trim().toLowerCase());
  const resolved = parts.map((p) => (p === 'mod' ? (IS_MAC ? 'meta' : 'ctrl') : p));
  const mods = resolved.filter((p) => ['alt', 'ctrl', 'meta', 'shift'].includes(p)).sort();
  const key = resolved.filter((p) => !['alt', 'ctrl', 'meta', 'shift'].includes(p))[0] ?? '';
  return key ? [...mods, key].join('+') : '';
}

/** Display a combo for the UI, platform-localized. Modifiers are emitted in
 *  the conventional order (Ctrl → Alt → Shift → Meta on Windows/Linux; Ctrl
 *  → Opt → Shift → Cmd on macOS) regardless of the alphabetized storage
 *  order — that's a match-key detail, not a user-facing one. */
export function displayCombo(combo: string | null | undefined): string {
  if (!combo) return 'Unbound';
  const resolved = resolveCombo(combo);
  if (!resolved) return 'Unbound';
  const all = resolved.split('+');
  const modifierOrder = IS_MAC
    ? ['ctrl', 'alt', 'shift', 'meta']  // Opt shown where alt lands
    : ['ctrl', 'alt', 'shift', 'meta'];
  const mods = modifierOrder.filter((m) => all.includes(m));
  const keyPart = all.find((p) => !modifierOrder.includes(p)) ?? '';
  const ordered = keyPart ? [...mods, keyPart] : mods;

  const sym = (p: string): string => {
    if (IS_MAC) {
      if (p === 'meta') return '⌘';
      if (p === 'ctrl') return '⌃';
      if (p === 'alt') return '⌥';
      if (p === 'shift') return '⇧';
    } else {
      if (p === 'meta') return 'Win';
      if (p === 'ctrl') return 'Ctrl';
      if (p === 'alt') return 'Alt';
      if (p === 'shift') return 'Shift';
    }
    // Heavy-weight arrow glyphs render much larger/clearer than the default
    // ← → ↑ ↓ at small font sizes.
    if (p === 'arrowleft') return '⬅';
    if (p === 'arrowright') return '➡';
    if (p === 'arrowup') return '⬆';
    if (p === 'arrowdown') return '⬇';
    if (p === 'space') return 'Space';
    if (p === 'escape') return 'Esc';
    if (p === 'period') return '.';
    if (p === 'comma') return ',';
    return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
  };
  const mapped = ordered.map(sym);
  return IS_MAC ? mapped.join(' ') : mapped.join('+');
}

/** True if the combo has at least one modifier (excluding shift alone) and one key. */
export function isValidCombo(combo: string): boolean {
  const resolved = resolveCombo(combo);
  if (!resolved) return false;
  const parts = resolved.split('+');
  const mods = parts.filter((p) => ['alt', 'ctrl', 'meta'].includes(p));
  const keyParts = parts.filter((p) => !['alt', 'ctrl', 'meta', 'shift'].includes(p));
  return mods.length >= 1 && keyParts.length === 1;
}

/* ---------- Editable-target detection ---------------------------------- */

export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    const textLike = ['text', 'search', 'url', 'email', 'tel', 'password', 'number', ''].includes(type);
    return textLike && !el.disabled && !el.readOnly;
  }
  // xterm helper textarea
  if (el.closest('.xterm, .xterm-helper-textarea')) return true;
  return false;
}

/* ---------- Binding store ---------------------------------------------- */

export interface Binding {
  /** Canonical combo string (with `mod`), or null to unbind this action. */
  combo: string | null;
  /** Fire this action even when focus is in an editable target. */
  fireInEditable?: boolean;
}

export type Bindings = Record<string, Binding>;

interface ShortcutStore {
  bindings: Bindings;
  loaded: boolean;
  setBindings: (b: Bindings) => void;
  hydrate: (raw: string | null | undefined) => void;
  getEffective: (actionId: string) => Binding;
  setBinding: (actionId: string, patch: Partial<Binding>) => void;
  resetBinding: (actionId: string) => void;
  serialize: () => string;
}

export const useShortcutStore = create<ShortcutStore>((set, get) => ({
  bindings: {},
  loaded: false,
  setBindings: (bindings) => set({ bindings, loaded: true }),
  hydrate: (raw) => {
    if (!raw) {
      set({ bindings: {}, loaded: true });
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        set({ bindings: parsed as Bindings, loaded: true });
        return;
      }
    } catch {}
    set({ bindings: {}, loaded: true });
  },
  getEffective: (actionId) => {
    const def = getAction(actionId);
    const user = get().bindings[actionId];
    return {
      combo: user?.combo !== undefined ? user.combo : def?.defaultCombo ?? null,
      fireInEditable:
        user?.fireInEditable !== undefined
          ? user.fireInEditable
          : !!def?.fireInEditableByDefault,
    };
  },
  setBinding: (actionId, patch) => {
    const current = get().bindings[actionId] ?? {};
    set({ bindings: { ...get().bindings, [actionId]: { ...current, ...patch } } });
  },
  resetBinding: (actionId) => {
    const next = { ...get().bindings };
    delete next[actionId];
    set({ bindings: next });
  },
  serialize: () => JSON.stringify(get().bindings),
}));

/** Find the action ID currently bound to a resolved combo, if any. */
export function findActionByCombo(combo: string, ignoreActionId?: string): string | null {
  if (!combo) return null;
  const { getEffective } = useShortcutStore.getState();
  for (const action of ACTIONS) {
    if (action.id === ignoreActionId) continue;
    const b = getEffective(action.id);
    if (b.combo && resolveCombo(b.combo) === combo) return action.id;
  }
  return null;
}

/* ---------- Dispatcher + useShortcut hook ------------------------------ */

type Handler = (e: KeyboardEvent) => void;

const handlers = new Map<string, Handler>();

let installed = false;

/* ---------- Keyboard-nav focus suppression ---------------------------- */

/**
 * When a keyboard nav shortcut switches the active tab or sidebar button,
 * the newly visible terminal should NOT steal focus (that would trap the
 * user — they wanted to keep navigating with the keyboard, not type into
 * the terminal). Mouse clicks on a tab should still focus the terminal.
 *
 * cycleTab / cycleSidebar call `markKeyboardNav()` before switching, which
 * raises a short-lived flag. Terminal.tsx's visible-on-become-active focus
 * effect checks `isKeyboardNavActive()` and skips its focus() calls while
 * the flag is up.
 */
let _keyboardNavUntil = 0;
export function markKeyboardNav(ms = 500): void {
  _keyboardNavUntil = Date.now() + ms;
}
export function isKeyboardNavActive(): boolean {
  return Date.now() < _keyboardNavUntil;
}

/**
 * Suspend all shortcut dispatch. Settings modal, capture overlay, and any
 * future bind-key UI should call `pushSuspend()` on mount and the returned
 * function on unmount. Counter-based so nested consumers (modal + capture
 * overlay inside it) both suppress cleanly.
 */
let _suspendCount = 0;
export function pushSuspend(): () => void {
  _suspendCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (_suspendCount > 0) _suspendCount--;
  };
}
export function isSuspended(): boolean {
  return _suspendCount > 0;
}

export function installShortcutDispatcher(): () => void {
  if (installed) return () => {};
  installed = true;
  const listener = (e: KeyboardEvent) => {
    if (isSuspended()) return;
    const combo = eventToCombo(e);
    if (!combo) return;
    const { getEffective } = useShortcutStore.getState();
    for (const action of ACTIONS) {
      const b = getEffective(action.id);
      if (!b.combo) continue;
      if (resolveCombo(b.combo) !== combo) continue;
      if (isEditableTarget(e.target) && !b.fireInEditable) return;
      const h = handlers.get(action.id);
      if (h) {
        e.preventDefault();
        e.stopPropagation();
        h(e);
      }
      return;
    }
  };
  window.addEventListener('keydown', listener, { capture: true });
  return () => {
    installed = false;
    window.removeEventListener('keydown', listener, { capture: true } as EventListenerOptions);
  };
}

/**
 * Register a handler for a named action. Latest-mounted handler wins.
 * Unregisters on unmount. The handler ref is kept fresh across renders so
 * closures over state always see the latest value.
 *
 * Pass `enabled: false` to skip registration — useful for components that
 * mount multiple copies (e.g. project tabs) where only the visible one
 * should own the shortcut.
 */
export function useShortcut(actionId: string, handler: Handler, enabled: boolean = true): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const wrapper: Handler = (e) => ref.current(e);
    const prior = handlers.get(actionId);
    handlers.set(actionId, wrapper);
    return () => {
      if (handlers.get(actionId) === wrapper) {
        if (prior) handlers.set(actionId, prior);
        else handlers.delete(actionId);
      }
    };
  }, [actionId, enabled]);
}
