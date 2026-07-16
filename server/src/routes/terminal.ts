import { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import {
  attachTerminal, writeToSession, resizeSession, reconnectSession,
  getPendingSpawn, consumePendingSpawn, spawnSession, spawnTerminal, spawnAdopt, spawnAgent,
  sendReplay,
  claimControl, releaseControl, isController, getGeometry, broadcastGeometry,
  DEFAULT_GEOMETRY,
} from '../services/session-manager.js';

/** Send the current PTY geometry to a freshly attached socket so it can size
 *  xterm to the PTY and scale the render locally. */
function sendGeometry(sessionId: string, socket: { send: (s: string) => void }): void {
  const g = getGeometry(sessionId);
  try { socket.send(JSON.stringify({ type: 'geometry-changed', cols: g.cols, rows: g.rows })); } catch { /* ignore */ }
}

/** Full message protocol for a live (attached) session socket. Shared by the
 *  passive, active, and post-spawn pending paths so a socket never speaks a
 *  reduced dialect: claim-control/release-control always work, and resize is
 *  honored ONLY from the current controller — viewers never resize the shared
 *  PTY (this is what prevents cross-client garbage). */
function handleLiveMessage(sessionId: string, socket: WebSocket, msg: any): void {
  switch (msg.type) {
    case 'input':
      writeToSession(sessionId, msg.data, msg.paste);
      break;
    case 'claim-control':
      // This connection becomes the geometry owner; the PTY adopts its
      // requested size and all viewers are told to re-scale.
      claimControl(sessionId, socket, msg.cols, msg.rows);
      break;
    case 'release-control':
      // Back to viewer; PTY returns to DEFAULT_GEOMETRY for everyone.
      releaseControl(sessionId, socket);
      break;
    case 'resize':
      if (isController(sessionId, socket)) resizeSession(sessionId, msg.cols, msg.rows);
      break;
    case 'refresh':
      // Client requested a fresh display — use tmux capture-pane
      // to get the current visual state (like adopt does).
      console.log(`[REFRESH] ${sessionId}: client requested capture-pane refresh`);
      sendReplay(sessionId, socket, true);
      break;
  }
}
import { getDb } from '../db/index.js';

/**
 * Terminal WebSocket route
 * Connect to /api/terminal/:sessionId to get live PTY output and send input
 *
 * Supports "lazy spawn": sessions created via REST stay pending until the
 * first WebSocket sends a resize with actual terminal dimensions. This
 * ensures tmux is created at the exact right size — no resize/redraw needed.
 */
export const terminalRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Params: { sessionId: string };
    Querystring: { passive?: string; attempt?: string };
  }>('/terminal/:sessionId', { websocket: true }, (socket, req) => {
    const { sessionId } = req.params;
    const isPassive = req.query.passive === '1';
    const attempt = req.query.attempt || '?';

    // Check if this is a pending session that needs to be spawned.
    // Use getPendingSpawn (peek) instead of consume — React StrictMode
    // double-mounts effects, so the first WebSocket may close immediately.
    // Only consume after successful spawn.
    const pending = getPendingSpawn(sessionId);
    if (pending) {
      let spawned = false;
      // True once attachTerminal succeeded — only then is the session in
      // activeSessions and able to honor claim/resize/refresh messages.
      let liveAttached = false;
      // Latest claim-control received before the spawn+attach completed. The
      // creating client (Electron full view) sends its claim right at WS open,
      // while the spawn is still in flight — without buffering it the claim
      // would be silently dropped, the PTY would stay at DEFAULT_GEOMETRY and
      // the fresh session would render with a wrong right margin until the
      // client reconnected (the "new session opens mis-sized" bug).
      let pendingClaim: { cols: number; rows: number } | null = null;

      // If this WebSocket closes before spawning, do nothing — the pending
      // spawn stays in the map for the next connection to pick up.
      socket.on('close', () => {
        // nothing to clean up if not yet spawned
      });

      socket.on('message', async (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (!liveAttached && msg.type === 'claim-control') {
            // Remember the claim; it is applied as soon as the PTY exists.
            pendingClaim = { cols: msg.cols, rows: msg.rows };
            return;
          }

          if (!spawned && msg.type === 'resize') {
            // Now consume — this connection will own the spawn
            const info = consumePendingSpawn(sessionId);
            if (!info) {
              // Another connection beat us — try normal attach
              const attached = attachTerminal(sessionId, socket);
              if (attached) {
                spawned = true;
                liveAttached = true;
                if (pendingClaim) {
                  claimControl(sessionId, socket, pendingClaim.cols, pendingClaim.rows);
                  pendingClaim = null;
                }
              }
              return;
            }

            spawned = true;
            try {
              // The PTY is owned by the server at DEFAULT_GEOMETRY; the first
              // client's dimensions only trigger the spawn, they don't set the
              // size. Clients are viewers that scale locally until one claims
              // control. (adopt keeps the dtach pane's own size.)
              const gc = DEFAULT_GEOMETRY.cols, gr = DEFAULT_GEOMETRY.rows;
              if (info.mode === 'adopt' && info.socketPath) {
                await spawnAdopt(sessionId, info.socketPath, info.projectPath, info.task, msg.cols, msg.rows);
              } else if (info.mode === 'terminal') {
                await spawnTerminal(sessionId, info.projectPath, gc, gr);
              } else if (info.mode === 'agent' && info.agentType) {
                await spawnAgent(sessionId, info.projectPath, info.task, info.agentType, gc, gr, info.cliType, info.model, info.inheritMcp);
              } else {
                await spawnSession(sessionId, info.projectPath, info.task, gc, gr, info.cliType, info.model);
              }
              const attached = attachTerminal(sessionId, socket);
              if (!attached) {
                socket.send(JSON.stringify({ type: 'error', message: 'Failed to attach after spawn' }));
                socket.close();
              } else {
                liveAttached = true;
                if (pendingClaim) {
                  // Honor the claim that arrived while spawning: this client
                  // becomes the controller and the PTY adopts its geometry.
                  claimControl(sessionId, socket, pendingClaim.cols, pendingClaim.rows);
                  pendingClaim = null;
                } else {
                  sendGeometry(sessionId, socket);
                }
              }
            } catch (err: any) {
              socket.send(JSON.stringify({ type: 'error', message: `Spawn failed: ${err.message}` }));
              socket.close();
            }
            return;
          }

          if (liveAttached) handleLiveMessage(sessionId, socket, msg);
        } catch {
          if (liveAttached) writeToSession(sessionId, raw.toString());
        }
      });

      socket.send(JSON.stringify({ type: 'connected', sessionId }));
      return;
    }

    // Normal flow: session already running.
    //
    // Passive connections (grid/thumbnail terminals): subscribe + replay
    // immediately — they never send resize so we can't wait for one.
    //
    // Active connections: don't subscribe yet. Wait for the browser to send
    // its resize so we can resize the tmux pane, wait for reflow, then send
    // a clean capture-pane snapshot. Only THEN subscribe for live output.
    // This prevents tmux resize-redraw garbage from reaching the client.

    // Both passive and active paths need async reconnect (worker fork),
    // so wrap in an async IIFE to handle awaiting properly.
    (async () => {
      if (isPassive) {
        let attached = attachTerminal(sessionId, socket);
        if (!attached) {
          await reconnectSession(sessionId);
          attached = attachTerminal(sessionId, socket);
        }
        if (!attached) {
          // Mark dead sessions as failed so they stop appearing in the grid
          getDb().prepare(`
            UPDATE sessions SET status = 'failed', completed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ? AND status IN ('running', 'detached')
          `).run(sessionId);
          socket.send(JSON.stringify({ type: 'error', message: 'Session not found or not running' }));
          socket.close();
          return;
        }
        // Passive terminals forward input and handle refresh. They never resize
        // the shared PTY *unless* they explicitly claim control (e.g. the user
        // zooms a grid card): claim-control lets the program reflow at the
        // viewer's size; without it, passive views still leave geometry alone.
        socket.on('message', (raw: Buffer | string) => {
          try {
            const msg = JSON.parse(raw.toString());
            handleLiveMessage(sessionId, socket, msg);
          } catch { /* ignore */ }
        });
        sendGeometry(sessionId, socket);
        socket.send(JSON.stringify({ type: 'connected', sessionId }));
        return;
      }

      // Active connection: subscribe + replay.
      let attached = attachTerminal(sessionId, socket);
      if (!attached) {
        await reconnectSession(sessionId);
        attached = attachTerminal(sessionId, socket);
      }
      if (!attached) {
        getDb().prepare(`
          UPDATE sessions SET status = 'failed', completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status IN ('running', 'detached')
        `).run(sessionId);
        socket.send(JSON.stringify({ type: 'error', message: 'Session not found or not running' }));
        socket.close();
        return;
      }

      // Handle incoming messages from the browser terminal
      socket.on('message', (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());
          handleLiveMessage(sessionId, socket, msg);
        } catch {
          writeToSession(sessionId, raw.toString());
        }
      });

      sendGeometry(sessionId, socket);
      socket.send(JSON.stringify({ type: 'connected', sessionId }));
    })().catch((err) => {
      console.error(`[WS] Error in terminal handler for ${sessionId}:`, err);
      try {
        socket.send(JSON.stringify({ type: 'error', message: 'Internal error' }));
        socket.close();
      } catch { /* ignore */ }
    });
  });
};
