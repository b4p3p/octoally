/**
 * Leading-edge throttle for terminal output going to WebSocket clients.
 *
 * The first chunk after a quiet period is sent at once; whatever arrives during
 * the following window is coalesced and sent when the window ends, which also
 * re-arms the window. A steady burst therefore costs one message per window
 * (the flood protection the browser needs), while an isolated keystroke pays
 * no delay at all: the trailing debounce this replaces made every isolated
 * keystroke wait the full window before its echo could leave the server.
 */
export interface OutputBatcher {
  push(data: string): void;
  dispose(): void;
}

export function createOutputBatcher(send: (data: string) => void, windowMs = 16): OutputBatcher {
  let pending = '';
  let timer: NodeJS.Timeout | null = null;

  const arm = () => {
    timer = setTimeout(() => {
      timer = null;
      if (!pending) return;
      const data = pending;
      pending = '';
      send(data);
      arm();
    }, windowMs);
  };

  return {
    push(data) {
      if (timer) {
        pending += data;
        return;
      }
      send(data);
      arm();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = '';
    },
  };
}
