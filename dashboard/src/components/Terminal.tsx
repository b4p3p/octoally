import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { RotateCcw, ExternalLink, ZoomIn, ZoomOut } from 'lucide-react';
import { useSpeechStore } from '../lib/speech';
import { isKeyboardNavActive } from '../lib/shortcuts';
import { api } from '../lib/api';
import { HistoryViewer } from './HistoryViewer';
import '@xterm/xterm/css/xterm.css';

const POPOUT_SKIP_KEY = 'octoally-popout-confirm-skip';
function shouldSkipPopOutConfirm(): boolean {
  try { return localStorage.getItem(POPOUT_SKIP_KEY) === 'true'; } catch { return false; }
}
function setSkipPopOutConfirm(skip: boolean): void {
  try { localStorage.setItem(POPOUT_SKIP_KEY, String(skip)); } catch { /* ignore */ }
}

// Global event: when any terminal connects, notify all others to retry immediately.
// This prevents staggered reconnects after a server restart.
const serverAliveListeners = new Set<() => void>();
function notifyServerAlive() {
  for (const fn of serverAliveListeners) fn();
}


// Global terminal connection tracking — lets App.tsx show a "connecting" indicator
const pendingTerminals = new Set<string>();
const connectionListeners = new Set<() => void>();
export function getPendingTerminalCount() { return pendingTerminals.size; }
export function onTerminalConnectionChange(fn: () => void) {
  connectionListeners.add(fn);
  return () => { connectionListeners.delete(fn); };
}
function notifyConnectionChange() {
  for (const fn of connectionListeners) fn();
}

interface TerminalProps {
  sessionId: string;
  visible?: boolean;
  /** When true, disconnect the WebSocket and stop receiving data.
   *  Used to yield the session to another Terminal (e.g. ActiveTerminals grid). */
  suspended?: boolean;
  /** When true, don't send resize commands to the server PTY.
   *  Grid/thumbnail views use this to avoid corrupting the PTY column width
   *  that the main terminal depends on. */
  passiveResize?: boolean;
  /** When true (default) this terminal is a real fit-to-container terminal: it
   *  fits to its own size and drives the PTY geometry (resize/claim-control), so
   *  the program reflows and the cursor stays aligned. Set false only for a
   *  legacy CSS-scaled viewer (no longer used — scaling a terminal mis-aligns
   *  rows/box-drawing/cursor; every view now drives its own PTY instead). */
  isController?: boolean;
  /** Hide the xterm.js cursor. Used for RuFlo sessions where the CLI renders its own cursor. */
  hideCursor?: boolean;
  /** CLI type — Codex sessions need capture-pane refresh on tab switch/resize */
  cliType?: 'claude' | 'codex';
  onExit?: (exitCode: number) => void;
  onReconnect?: () => void;
  onPopOut?: () => void;
}

export function Terminal({ sessionId, visible = true, suspended = false, passiveResize = false, isController = true, hideCursor = false, cliType, onExit, onReconnect, onPopOut }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [connected, setConnected] = useState(false);

  // Read terminal font size from settings
  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
    staleTime: 30_000,
  });
  // terminal_font_size is a per-client display preference: prefer localStorage,
  // seeding from the shared DB value for backward compatibility.
  const configuredFontSize = Number(localStorage.getItem('octoally-terminal-font-size') || settingsData?.settings?.terminal_font_size) || 12;
  const [showHistory, setShowHistory] = useState(false);
  const [popOutConfirm, setPopOutConfirm] = useState(false);
  const [popOutSkipChecked, setPopOutSkipChecked] = useState(false);

  async function doPopOut() {
    setPopOutConfirm(false);
    if (popOutSkipChecked) setSkipPopOutConfirm(true);
    try {
      const result = await api.sessions.popOut(sessionId);
      if (result.ok) onPopOut?.();
    } catch { /* ignore */ }
  }

  function handlePopOutClick() {
    if (shouldSkipPopOutConfirm()) {
      void doPopOut();
    } else {
      setPopOutSkipChecked(false);
      setPopOutConfirm(true);
    }
  }

  // Expose connect/disconnect so the suspension effect can control it
  const connectFnRef = useRef<(() => void) | null>(null);
  const disconnectFnRef = useRef<(() => void) | null>(null);
  const isSuspendedRef = useRef(suspended);
  const passiveResizeRef = useRef(passiveResize);
  passiveResizeRef.current = passiveResize;
  const hideCursorRef = useRef(hideCursor);
  hideCursorRef.current = hideCursor;
  // "Wants control" = the `isController` prop (full/expanded view: yes; grid: no).
  // "Effective controller" = isControllerRef: whether THIS client CURRENTLY drives
  // the shared PTY. The server arbitrates — only ONE controller per session across
  // all clients. A full view claims on connect/focus; if another client then
  // claims, the server sends `control-lost` and we drop to viewer (scale + apply
  // the controller's geometry). This is what lets the same session be open
  // full-screen on browser AND Electron without the two fighting.
  const isControllerRef = useRef(isController);
  const applyScaleRef = useRef<(() => void) | null>(null);
  // Per-client LOCAL zoom for viewers: a CSS magnify multiplier applied on top
  // of the fit-to-card scale. Only affects THIS client's view — never the shared
  // PTY — so zooming a grid card on one client doesn't change anything for the
  // others. 1 = whole terminal visible (fit); >1 = magnified; <1 = smaller.
  const viewerZoomRef = useRef(1);
  const cliTypeRef = useRef(cliType);
  cliTypeRef.current = cliType;
  // Debounce timer for Codex capture-pane refreshes — prevents multiple
  // effects (suspension + visible) from stacking duplicate captures.
  const codexRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  isSuspendedRef.current = suspended;

  // Hard refresh — the dedicated "screen is messed up, fix it" path. Always
  // clears the xterm buffer first so stale stacked renders are discarded,
  // then forces the CLI to redraw into the clean buffer. Intentionally heavier
  // than the passive refit that tab switches / visibility changes use.
  const hardRefresh = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const fit = fitRef.current;
    const w = wsRef.current;
    // Only the controller owns the geometry; a viewer fitting here would drift
    // its xterm away from the server-owned PTY size (overlap/garbage).
    if (fit && isControllerRef.current) fit.fit();

    if (!w || w.readyState !== WebSocket.OPEN) {
      // WebSocket not open — full reconnect, server will replay into clean buffer
      term.reset();
      disconnectFnRef.current?.();
      setTimeout(() => connectFnRef.current?.(), 50);
      return;
    }

    if (cliTypeRef.current === 'codex') {
      // Codex doesn't redraw on SIGWINCH. Send resize so tmux pane matches
      // our width, then clear and request a capture-pane refresh.
      w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      setTimeout(() => {
        if (w.readyState !== WebSocket.OPEN) return;
        term.reset();
        w.send(JSON.stringify({ type: 'refresh' }));
      }, 300);
      return;
    }

    if (hideCursorRef.current) {
      // Claude session/agent: reset first to clear stacked renders.
      term.reset();
      if (isControllerRef.current) {
        // Controller owns the PTY: SIGWINCH-toggle so Claude redraws clean.
        const cols = term.cols;
        const rows = term.rows;
        w.send(JSON.stringify({ type: 'resize', cols: cols - 1, rows }));
        setTimeout(() => {
          if (w.readyState !== WebSocket.OPEN) return;
          w.send(JSON.stringify({ type: 'resize', cols, rows }));
        }, 100);
      } else {
        // Viewer: the server ignores its resize, so a SIGWINCH toggle would
        // just blank the screen. Ask for a capture-pane snapshot at the
        // current PTY geometry instead, then rescale.
        w.send(JSON.stringify({ type: 'refresh' }));
        applyScaleRef.current?.();
      }
      return;
    }

    // Plain terminal — reconnect for a fresh server replay.
    term.reset();
    disconnectFnRef.current?.();
    setTimeout(() => connectFnRef.current?.(), 50);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    // Create terminal
    const term = new XTerm({
      cursorBlink: false,
      cursorStyle: hideCursor ? 'bar' : 'block',
      cursorWidth: hideCursor ? 1 : undefined,
      cursorInactiveStyle: hideCursor ? 'none' : 'outline',
      fontSize: configuredFontSize,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      scrollback: 10000,
      allowProposedApi: true,
      theme: {
        background: '#0f1117',
        foreground: '#e4e8f1',
        cursor: hideCursor ? '#0f1117' : '#3b82f6',
        cursorAccent: hideCursor ? '#0f1117' : undefined,
        selectionBackground: '#3b82f680',
        black: '#1a1d27',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e4e8f1',
        brightBlack: '#4b5563',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fde047',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#f9fafb',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Renderer: xterm's default DOM renderer (NO WebGL/canvas addon). The
    // dashboard CSS-scales viewer terminals to fit their card; scaling a WebGL
    // canvas by a non-integer factor mis-positions rows and box-drawing glyphs
    // — Claude's separator lines overlap the text and typing appears to
    // overwrite the line above. This happens in both the browser and Electron
    // (anywhere the render is scaled). The DOM renderer lays rows out by integer
    // CSS line-height, so it stays pixel-correct at any scale or devicePixelRatio.

    // Make URLs in terminal output clickable — open in system browser
    term.loadAddon(new WebLinksAddon((event, url) => {
      event.preventDefault();
      console.log('[octoally] Link clicked in terminal:', url);
      // In Electron: use IPC to call shell.openExternal directly (avoids
      // xterm.js WebLinksAddon's window.open() which opens about:blank).
      // In browser: use server API to call xdg-open/open.
      if ('electronAPI' in window) {
        (window as any).electronAPI.invoke('open-external', url);
      } else {
        fetch('/api/open-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        }).catch(e => console.error('[octoally] open-url failed:', e));
      }
    }));

    // Fit after a small delay to ensure container is sized. Viewers stay at the
    // server-owned PTY geometry (applied via geometry-changed) and only scale;
    // fitting a viewer here would drift its geometry and race geometry-changed.
    requestAnimationFrame(() => {
      if (isControllerRef.current) fitAddon.fit();
      else scheduleScale();
    });

    // Intercept Ctrl+Shift+C to copy selection
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C' && e.type === 'keydown') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel);
        e.preventDefault();
        return false;
      }
      // Ctrl+Shift+V: read clipboard explicitly and send as input.
      // Can't rely on browser firing a paste event — synthetic keystrokes
      // (e.g. from text expanders like espanso via xdotool) don't trigger it.
      if (e.ctrlKey && e.shiftKey && e.key === 'V' && e.type === 'keydown') {
        navigator.clipboard.readText().then(text => {
          if (text) {
            const w = wsRef.current;
            if (w && w.readyState === WebSocket.OPEN) {
              w.send(JSON.stringify({ type: 'input', data: text, paste: true }));
            }
          }
        }).catch(() => {});
        e.preventDefault();
        return false;
      }
      return true;
    });

    // Handle paste via native browser event — works in all contexts including WebKitGTK/Tauri
    // Listen on xterm's hidden textarea in capture phase, stop propagation to prevent xterm's
    // built-in paste handler from also firing (which would cause double paste)
    const xtermTextarea = containerRef.current.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
    const pasteTarget = xtermTextarea || containerRef.current;
    const pasteHandler = (ev: Event) => {
      const ce = ev as ClipboardEvent;
      const text = ce.clipboardData?.getData('text');
      const w = wsRef.current;
      if (text && w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'input', data: text, paste: true }));
        ce.preventDefault();
        ce.stopImmediatePropagation();
      }
    };
    pasteTarget.addEventListener('paste', pasteHandler, { capture: true });

    termRef.current = term;
    fitRef.current = fitAddon;

    // RAF-based write batching — accumulate WS data and flush once per frame
    let pendingData = '';
    let rafId: number | null = null;

    function flushWrite() {
      rafId = null;
      if (pendingData) {
        const data = pendingData;
        pendingData = '';
        term.write(data);
      }
    }

    // Send user input to server
    // Filter out xterm.js focus reporting sequences (\x1b[I = focus in, \x1b[O = focus out)
    // These get sent when terminal gains/loses focus and Claude Code's TUI interprets them as input
    term.onData((data: string) => {
      if (data === '\x1b[I' || data === '\x1b[O') return;
      const w = wsRef.current;
      if (w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'input', data }));
      }
    });

    term.onBinary((data: string) => {
      const w = wsRef.current;
      if (w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // WebSocket connection with auto-reconnect
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let intentionalClose = false;
    // Suspension: close without showing disconnect messages or triggering reconnect
    let suspendedClose = false;
    // Set when doResize wanted to send but WS wasn't open yet
    let pendingResize = false;

    // Scale the rendered terminal to fill the card WITHOUT changing the PTY
    // geometry. Used by every viewer (any client that isn't the controller):
    // xterm stays at the server-owned geometry, we only CSS-scale the pixels.
    function applyScale() {
      const container = containerRef.current;
      const xtermEl = container?.querySelector('.xterm') as HTMLElement | null;
      if (!container || !xtermEl) return;
      if (isControllerRef.current) {
        // Controller drives its own size — no scaling; let xterm own its layout.
        xtermEl.style.transform = '';
        xtermEl.style.transformOrigin = '';
        xtermEl.style.width = '';
        xtermEl.style.height = '';
        return;
      }
      xtermEl.style.transform = '';
      // Measure the ACTUAL terminal content (.xterm-screen = cols×rows in px).
      // .xterm itself is constrained to the container, so we must (a) read the
      // natural size from .xterm-screen and (b) FORCE .xterm to that natural
      // size before scaling — otherwise the scaled .xterm box (and its
      // viewport/scrollbar) lands mid-card while the content overflows it.
      const screenEl = xtermEl.querySelector('.xterm-screen') as HTMLElement | null;
      const natW = screenEl?.offsetWidth || xtermEl.offsetWidth;
      const natH = screenEl?.offsetHeight || xtermEl.offsetHeight;
      if (!natW || !natH) return;
      xtermEl.style.width = `${natW}px`;
      xtermEl.style.height = `${natH}px`;
      const fitScale = Math.min(container.clientWidth / natW, container.clientHeight / natH);
      // Apply the per-client local zoom multiplier on top of fit (see viewerZoomRef).
      const scale = (fitScale > 0 ? fitScale : 1) * viewerZoomRef.current;
      xtermEl.style.transformOrigin = 'top left';
      xtermEl.style.transform = `scale(${scale > 0 ? scale : 1})`;
    }
    applyScaleRef.current = applyScale;

    // Coalesced, post-layout rescale. Measuring synchronously right after
    // term.resize() (geometry-changed) or a layout change reads STALE .xterm
    // dimensions, so the computed scale is wrong and — because nothing re-runs
    // it — stays wrong. Deferring to the next frame measures the settled size.
    let scaleRaf: number | null = null;
    function scheduleScale() {
      if (isControllerRef.current) return;
      if (scaleRaf !== null) return;
      scaleRaf = requestAnimationFrame(() => {
        scaleRaf = null;
        applyScale();
      });
    }

    function connectWs() {
      if (isSuspendedRef.current) return;

      // Close any existing connection first
      const old = wsRef.current;
      if (old && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) {
        suspendedClose = true;
        old.close();
        wsRef.current = null;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams();
      if (passiveResizeRef.current) params.set('passive', '1');
      params.set('attempt', String(reconnectAttempts));
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/terminal/${sessionId}?${params}`);
      wsRef.current = ws;
      pendingTerminals.add(sessionId);
      notifyConnectionChange();

      ws.onopen = () => {
        setConnected(true);
        pendingTerminals.delete(sessionId);
        notifyConnectionChange();
        reconnectAttempts = 0;
        // If a resize was missed while WS was connecting, send it now. This also
        // triggers lazy-spawn of pending sessions; the server ignores its
        // dimensions for geometry unless we're the controller.
        if (pendingResize) {
          pendingResize = false;
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
        // A view that WANTS control (full/expanded) claims it on connect — the
        // server arbitrates and demotes any previous controller. Viewers scale.
        if (isController) {
          isControllerRef.current = true;
          fitAddon.fit();
          ws.send(JSON.stringify({ type: 'claim-control', cols: term.cols, rows: term.rows }));
        } else {
          isControllerRef.current = false;
          applyScale();
        }
        term.focus();
        notifyServerAlive();

        // Force tmux reflow: resize to cols-1 then back to correct width.
        // Only for sessions (hideCursor=true) where CLI redraws
        // on SIGWINCH. Plain terminals (bash) don't redraw old output, so
        // force-resize just corrupts the tmux pane history via lossy reflow.
        // SKIP for Codex: Codex TUI redraws accumulate in tmux scrollback,
        // causing capture-pane to show duplicate output.
        // Only the controller may resize the shared PTY.
        if (isControllerRef.current && hideCursorRef.current && cliTypeRef.current !== 'codex') {
          const cols = term.cols;
          const rows = term.rows;
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols: cols - 1, rows }));
              setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'resize', cols, rows }));
                }
              }, 100);
            }
          }, 200);
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          switch (msg.type) {
            case 'output':
              reconnectAttempts = 0;
              // Defense-in-depth: strip focus reporting enable/disable sequences
              // so xterm.js never enters sendFocusMode (which causes focus/blur
              // events to be sent as input, corrupting Codex TUI rendering)
              pendingData += msg.data.replace(/\x1b\[\?1004[hl]/g, '');
              if (rafId === null) {
                rafId = requestAnimationFrame(flushWrite);
              }
              break;
            case 'exit':
              if (msg.reason === 'popped-out') {
                term.write(`\r\n\x1b[36m[Popped out to system terminal]\x1b[0m\r\n`);
              } else {
                term.write(`\r\n\x1b[33m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
              }
              intentionalClose = true;
              onExit?.(msg.exitCode);
              break;
            case 'error':
              term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
              intentionalClose = true;
              break;
            case 'geometry-changed':
              // The server owns the PTY geometry. Viewers size xterm to it and
              // scale locally; the controller already drives the size itself.
              if (!isControllerRef.current && (term.cols !== msg.cols || term.rows !== msg.rows)) {
                term.resize(msg.cols, msg.rows);
              }
              // Defer: term.resize relayouts on the next frame; measuring now
              // would scale against the old size.
              scheduleScale();
              break;
            case 'control-lost':
              // Another client took geometry control of this shared session.
              // Drop to viewer: stop driving and render the controller's geometry
              // scaled to our container. The geometry-changed that follows the
              // other client's claim resizes our xterm; we start scaling now.
              isControllerRef.current = false;
              scheduleScale();
              break;
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (suspendedClose) {
          suspendedClose = false;
          return;
        }
        if (intentionalClose) {
          term.write('\r\n\x1b[90m[Disconnected]\x1b[0m\r\n');
          return;
        }

        // Exponential backoff reconnect
        if (reconnectAttempts < 30) {
          const delay = Math.min(100 * Math.pow(1.5, reconnectAttempts), 5000);
          reconnectAttempts++;
          if (!passiveResizeRef.current) {
            term.write(`\r\n\x1b[90m[Disconnected — reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts}/30)...]\x1b[0m\r\n`);
          }
          reconnectTimer = setTimeout(() => {
            term.clear();
            connectWs();
          }, delay);
        } else {
          term.write('\r\n\x1b[31m[Connection lost — max reconnect attempts reached]\x1b[0m\r\n');
        }
      };
    }

    function disconnectWs() {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        suspendedClose = true;
        ws.close();
      }
      wsRef.current = null;
    }

    // When another terminal connects, immediately retry if we're stuck in backoff.
    // Don't touch terminals that are already OPEN or CONNECTING — interrupting
    // a CONNECTING socket causes a cascade of reconnections.
    function onServerAlive() {
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      // Only act if we're waiting on a backoff timer
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        reconnectAttempts = 0;
        term.clear();
        connectWs();
      }
    }
    serverAliveListeners.add(onServerAlive);

    // Expose to the suspension effect
    connectFnRef.current = connectWs;
    disconnectFnRef.current = disconnectWs;

    // Initial connection (unless suspended)
    if (!isSuspendedRef.current) {
      connectWs();
    }

    // Handle resize — debounced
    let lastCols = term.cols;
    let lastRows = term.rows;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let firstResize = true;

    function doResize() {
      if (!isControllerRef.current) {
        // Viewer: never resize the shared PTY — just rescale the render to the card.
        applyScale();
        return;
      }
      fitAddon.fit();
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        if (!passiveResizeRef.current) {
          const w = wsRef.current;
          if (w && w.readyState === WebSocket.OPEN) {
            w.send(JSON.stringify({
              type: 'resize',
              cols: term.cols,
              rows: term.rows,
            }));
            // Force PTY redraw via SIGWINCH toggle
            const cols = term.cols;
            const rows = term.rows;
            setTimeout(() => {
              if (w.readyState === WebSocket.OPEN) {
                w.send(JSON.stringify({ type: 'resize', cols: cols - 1, rows }));
                setTimeout(() => {
                  if (w.readyState === WebSocket.OPEN) {
                    w.send(JSON.stringify({ type: 'resize', cols, rows }));
                  }
                }, 50);
              }
            }, 50);
          } else {
            // WS not open yet — send when it connects
            pendingResize = true;
          }
        }
      }
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && (entry.contentRect.width < 10 || entry.contentRect.height < 10)) return;

      if (firstResize) {
        firstResize = false;
        // Always send one initial resize: it triggers lazy-spawn of pending
        // sessions. The server ignores the dimensions for geometry unless we're
        // the controller. After that, viewers only scale.
        if (isControllerRef.current) fitAddon.fit();
        const w = wsRef.current;
        if (w && w.readyState === WebSocket.OPEN) {
          w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        } else {
          pendingResize = true;
        }
        applyScale();
        return;
      }

      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doResize, 100);
    });
    resizeObserver.observe(containerRef.current);

    // The container observer above only fires when the CARD changes size. A
    // viewer's render ALSO changes size when the server-owned PTY geometry
    // changes (term.resize on geometry-changed) — the card stays the same, so
    // that observer never fires and the CSS scale goes stale. This was the
    // multi-client "broken layout" bug. Observing .xterm itself catches those
    // geometry-driven relayouts and rescales once the new size is laid out.
    // CSS transform doesn't affect the layout box, so applyScale never loops it.
    const xtermElForScale = containerRef.current.querySelector('.xterm') as HTMLElement | null;
    const xtermResizeObserver = xtermElForScale ? new ResizeObserver(() => scheduleScale()) : null;
    if (xtermElForScale) xtermResizeObserver?.observe(xtermElForScale);

    return () => {
      intentionalClose = true;
      pendingTerminals.delete(sessionId);
      notifyConnectionChange();
      serverAliveListeners.delete(onServerAlive);
      connectFnRef.current = null;
      disconnectFnRef.current = null;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (scaleRaf !== null) cancelAnimationFrame(scaleRaf);
      resizeObserver.disconnect();
      xtermResizeObserver?.disconnect();
      pasteTarget.removeEventListener('paste', pasteHandler, { capture: true } as EventListenerOptions);
      wsRef.current?.close();
      term.dispose();
    };
  }, [sessionId, onExit]);

  // Claim geometry control for this client (a full/expanded view that "wants
  // control"). The server makes us the sole controller and demotes any previous
  // one (it gets `control-lost`). No-op for views that don't want control (grid).
  const claimControl = useCallback(() => {
    if (!isController) return;
    const w = wsRef.current;
    const term = termRef.current;
    if (!w || w.readyState !== WebSocket.OPEN || !term) return;
    isControllerRef.current = true;
    // Clear any viewer CSS scale so FitAddon measures the real container.
    const xtermEl = containerRef.current?.querySelector('.xterm') as HTMLElement | null;
    if (xtermEl) { xtermEl.style.transform = ''; xtermEl.style.transformOrigin = ''; xtermEl.style.width = ''; xtermEl.style.height = ''; }
    fitRef.current?.fit();
    w.send(JSON.stringify({ type: 'claim-control', cols: term.cols, rows: term.rows }));
  }, [isController]);
  const claimControlRef = useRef(claimControl);
  claimControlRef.current = claimControl;

  // Live-apply per-client terminal font size changes (emitted by SettingsModal).
  useEffect(() => {
    const onFont = (e: Event) => {
      const size = Number((e as CustomEvent).detail);
      const term = termRef.current;
      if (!term || !size) return;
      term.options.fontSize = size;
      // Viewer: font is local-only; rescale, never fit (would drift geometry).
      if (isControllerRef.current) fitRef.current?.fit();
      applyScaleRef.current?.();
    };
    window.addEventListener('octoally-terminal-font-size', onFont);
    return () => window.removeEventListener('octoally-terminal-font-size', onFont);
  }, []);

  // Suspension effect: disconnect WebSocket when suspended, reconnect when resumed.
  // This ensures only one Terminal connects to a given session at a time.
  // Skip the initial mount — the main effect already handles the first connection.
  const suspendInitRef = useRef(true);
  useEffect(() => {
    if (suspendInitRef.current) {
      suspendInitRef.current = false;
      return;
    }
    if (suspended) {
      disconnectFnRef.current?.();
    } else {
      // Resume — full reset of xterm (clears viewport + scrollback) then
      // reconnect so the server replay renders into a completely clean terminal.
      if (termRef.current && connectFnRef.current) {
        termRef.current.reset();
        connectFnRef.current();
        // For Codex: raw replay buffer contains garbled chunks from different widths.
        // After reconnect settles, refit to current container width, send resize
        // to the server (tmux pane may be at a different width from Active Sessions
        // grid), then trigger a capture-pane refresh for clean display.
        // Use debounced timer so visible effect's refresh doesn't stack with this one.
        if (cliType === 'codex') {
          if (codexRefreshTimer.current) clearTimeout(codexRefreshTimer.current);
          codexRefreshTimer.current = setTimeout(() => {
            codexRefreshTimer.current = null;
            const term = termRef.current;
            const fit = fitRef.current;
            const w = wsRef.current;
            if (term && w && w.readyState === WebSocket.OPEN) {
              if (fit) fit.fit();
              w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
              // Allow tmux + Codex to reflow at new width before capturing
              setTimeout(() => {
                if (w.readyState === WebSocket.OPEN) {
                  term.reset();
                  w.send(JSON.stringify({ type: 'refresh' }));
                }
              }, 300);
            }
          }, 500);
        }
      }
    }
  }, [suspended]);

  // When passiveResize changes from true→false (grid→full terminal), the
  // replayed output is at the wrong (narrow grid) width. Clear the terminal
  // and reconnect so the server sends a fresh replay at the correct width
  // and the resize goes through to the PTY.
  const prevPassiveRef = useRef(passiveResize);
  useEffect(() => {
    const wasPassive = prevPassiveRef.current;
    prevPassiveRef.current = passiveResize;

    if (wasPassive && !passiveResize && !suspended && termRef.current) {
      // Switching from passive (grid) to active (full) — clear and reconnect
      termRef.current.reset();
      disconnectFnRef.current?.();
      setTimeout(() => connectFnRef.current?.(), 50);
    }
  }, [passiveResize, suspended]);

  // Update font size when setting changes (without recreating the terminal)
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const w = wsRef.current;
    if (!term) return;
    if (term.options.fontSize !== configuredFontSize) {
      term.options.fontSize = configuredFontSize;
      if (isControllerRef.current) {
        fit?.fit();
        // Controller owns the PTY: notify new dimensions + SIGWINCH redraw.
        if (w && w.readyState === WebSocket.OPEN) {
          w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          setTimeout(() => {
            w.send(JSON.stringify({ type: 'resize', cols: term.cols - 1, rows: term.rows }));
            setTimeout(() => w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })), 50);
          }, 50);
        }
      } else {
        // Viewer: font is local-only; rescale, never resize the shared PTY.
        applyScaleRef.current?.();
      }
    }
  }, [configuredFontSize]);

  // Reactively hide/show the xterm.js cursor when hideCursor prop changes
  // (e.g. when session data loads after mount)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (hideCursor) {
      // DECTCEM: hide cursor at VT level + make cursor transparent
      term.write('\x1b[?25l');
      term.options.cursorBlink = false;
      term.options.cursorInactiveStyle = 'none';
    } else {
      term.write('\x1b[?25h');
      term.options.cursorBlink = false;
      term.options.cursorInactiveStyle = 'outline';
    }
  }, [hideCursor]);

  // Re-focus and refit terminal when it becomes visible.
  // Single RAF + short delay ensures DOM layout is settled before measuring.
  // Skip auto-focus when the tab change came from a keyboard shortcut —
  // otherwise the user gets trapped in the terminal and can't keep navigating.
  useEffect(() => {
    if (visible && !suspended && termRef.current) {
      const skipFocus = isKeyboardNavActive();
      termRef.current.scrollToBottom();
      if (!skipFocus) termRef.current.focus();
      let cancelled = false;
      requestAnimationFrame(() => {
        if (cancelled) return;
        const fit = fitRef.current;
        const term = termRef.current;
        const w = wsRef.current;
        if (fit && term) {
          if (isController) {
            // Full/expanded view: re-claim control on becoming visible (switching
            // back to this tab/client, or returning from an expanded modal). The
            // server makes us the controller again and demotes whoever had it.
            claimControlRef.current();
          } else {
            // Viewer: rescale to the card; never touch the shared PTY.
            applyScaleRef.current?.();
          }
          // Codex: after a (re)claim, capture-pane refresh for correct display —
          // raw replay chunks from different widths render garbled for Codex.
          if (cliType === 'codex' && w && w.readyState === WebSocket.OPEN) {
            if (codexRefreshTimer.current) clearTimeout(codexRefreshTimer.current);
            codexRefreshTimer.current = setTimeout(() => {
              codexRefreshTimer.current = null;
              if (!cancelled && w.readyState === WebSocket.OPEN) {
                term.reset();
                w.send(JSON.stringify({ type: 'refresh' }));
              }
            }, 500);
          }
          term.scrollToBottom();
          if (!skipFocus) term.focus();
        }
      });
      return () => { cancelled = true; };
    }
  }, [visible, suspended, cliType]);

  // Re-focus terminal when returning from a different browser tab
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && visible && !suspended && termRef.current) {
        const term = termRef.current;
        term.focus();
        requestAnimationFrame(() => {
          // Viewer: rescale only; fitting would drift the geometry.
          if (isControllerRef.current) fitRef.current?.fit();
          else applyScaleRef.current?.();
          term.scrollToBottom();
          term.focus();
        });
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [visible, suspended]);

  // Dictation mode: route transcriptions to this terminal when it's the visible/active one
  const dictationMode = useSpeechStore((s) => s.dictationMode);
  const lastTranscription = useSpeechStore((s) => s.lastTranscription);
  const dictationLastSent = useRef('');
  useEffect(() => {
    if (!dictationMode || !visible || suspended) return;
    if (!lastTranscription || lastTranscription === dictationLastSent.current) return;
    dictationLastSent.current = lastTranscription;
    const w = wsRef.current;
    if (w && w.readyState === WebSocket.OPEN) {
      w.send(JSON.stringify({ type: 'input', data: lastTranscription }));
      termRef.current?.focus();
    }
  }, [lastTranscription, dictationMode, visible, suspended]);

  // Voice command: press Enter in active terminal
  const pendingEnter = useSpeechStore((s) => s.pendingEnter);
  useEffect(() => {
    if (pendingEnter === 0 || !visible || suspended) return;
    const w = wsRef.current;
    if (w && w.readyState === WebSocket.OPEN) {
      console.log('[STT] Sending Enter (\\r) to terminal', sessionId);
      w.send(JSON.stringify({ type: 'input', data: '\r' }));
    }
  }, [pendingEnter, visible, suspended]);

  // Voice command: send control sequences (delete words, clear text)
  useEffect(() => {
    const handler = (e: Event) => {
      if (!visible || suspended) return;
      const { data } = (e as CustomEvent).detail;
      const w = wsRef.current;
      if (w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'input', data }));
      }
    };
    window.addEventListener('octoally:terminal-input', handler);
    return () => window.removeEventListener('octoally:terminal-input', handler);
  }, [visible, suspended]);

  // Voice command / external refresh event — shares the hardRefresh path so
  // voice "refresh terminal" and the refresh button behave identically.
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId } = (e as CustomEvent).detail;
      if (targetId !== sessionId) return;
      hardRefresh();
    };
    window.addEventListener('octoally:refresh-terminal', handler);
    return () => window.removeEventListener('octoally:refresh-terminal', handler);
  }, [sessionId, hardRefresh]);

  // Focus terminal on demand (e.g. switching from grid to single view)
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId } = (e as CustomEvent).detail;
      if (targetId !== sessionId) return;
      const term = termRef.current;
      if (term) {
        term.scrollToBottom();
        term.focus();
      }
    };
    window.addEventListener('octoally:focus-terminal', handler);
    return () => window.removeEventListener('octoally:focus-terminal', handler);
  }, [sessionId]);

  return (
    <div className="h-full relative group/terminal" onClick={() => { termRef.current?.focus(); claimControlRef.current(); }}>
      <div className="absolute top-2 right-5 z-10 flex items-center gap-2">
        {connected && !suspended && (
          <>
            <button
              onClick={() => {
                const term = termRef.current;
                const fit = fitRef.current;
                const w = wsRef.current;
                if (!term) return;
                if (isControllerRef.current) {
                  // Controller: change font, refit, resize the PTY → real reflow.
                  const current = term.options.fontSize || 13;
                  if (current <= 6) return;
                  term.options.fontSize = current - 1;
                  fit?.fit();
                  if (w && w.readyState === WebSocket.OPEN) {
                    w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                    // Force PTY redraw via SIGWINCH toggle
                    setTimeout(() => {
                      w.send(JSON.stringify({ type: 'resize', cols: term.cols - 1, rows: term.rows }));
                      setTimeout(() => w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })), 50);
                    }, 50);
                  }
                } else {
                  // Viewer: LOCAL CSS magnify only — never touches the font or the
                  // shared PTY, so other clients are unaffected.
                  viewerZoomRef.current = Math.max(0.3, viewerZoomRef.current / 1.15);
                  applyScaleRef.current?.();
                }
              }}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              title="Zoom out"
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            <button
              onClick={() => {
                const term = termRef.current;
                const fit = fitRef.current;
                const w = wsRef.current;
                if (!term) return;
                if (isControllerRef.current) {
                  // Controller: change font, refit, resize the PTY → real reflow.
                  const current = term.options.fontSize || 13;
                  if (current >= 32) return;
                  term.options.fontSize = current + 1;
                  fit?.fit();
                  if (w && w.readyState === WebSocket.OPEN) {
                    w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                    setTimeout(() => {
                      w.send(JSON.stringify({ type: 'resize', cols: term.cols - 1, rows: term.rows }));
                      setTimeout(() => w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })), 50);
                    }, 50);
                  }
                } else {
                  // Viewer: LOCAL CSS magnify only — see Zoom out.
                  viewerZoomRef.current = Math.min(8, viewerZoomRef.current * 1.15);
                  applyScaleRef.current?.();
                }
              }}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              title="Zoom in"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <button
              onClick={handlePopOutClick}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              title="Pop out to system terminal — you can bring it back from the tab bar"
            >
              <ExternalLink className="w-3 h-3" />
            </button>
            <button
              onClick={hardRefresh}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--accent)', color: 'white' }}
              title="Refresh terminal display"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </>
        )}
        {!connected && !suspended && (
          <>
            {onReconnect && (
              <button onClick={onReconnect}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors"
                style={{ background: 'var(--accent)', color: 'white' }}>
                <RotateCcw className="w-3 h-3" /> Reconnect
              </button>
            )}
            <div className="px-2 py-1 rounded text-xs" style={{ background: 'var(--error)', color: 'white' }}>
              Disconnected
            </div>
          </>
        )}
      </div>
      <div
        ref={containerRef}
        className={`h-full w-full overflow-hidden${hideCursor ? ' hide-xterm-cursor' : ''}`}
        style={{
          padding: '4px',
          background: '#0f1117',
        }}
      />
      {showHistory && (
        <HistoryViewer sessionId={sessionId} onClose={() => setShowHistory(false)} />
      )}
      {popOutConfirm && createPortal(
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setPopOutConfirm(false)}
        >
          <div
            className="rounded-lg border shadow-2xl max-w-md w-full mx-4 p-5"
            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <ExternalLink className="w-4 h-4" style={{ color: 'var(--accent)' }} />
              <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                Pop out to system terminal?
              </h3>
            </div>
            <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
              The session will keep running in your default system terminal (gnome-terminal, iTerm2, …).
              OctoAlly will close this tab.
            </p>
            <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
              You can bring it back any time from the <strong style={{ color: 'var(--text-primary)' }}>scan icon</strong> in the tab bar — it will appear under <em>External</em>.
            </p>
            <label className="flex items-center gap-2 mb-4 text-xs cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={popOutSkipChecked}
                onChange={(e) => setPopOutSkipChecked(e.target.checked)}
              />
              Don't ask again
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPopOutConfirm(false)}
                className="px-3 py-1.5 rounded text-sm transition-colors hover:bg-white/5"
                style={{ color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              >
                Cancel
              </button>
              <button
                onClick={() => void doPopOut()}
                className="px-3 py-1.5 rounded text-sm transition-colors"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                Pop out
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
