import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Port and API proxy target are env-overridable so a dev instance can run
// alongside an installed OctoAlly without colliding on ports or backend.
const vitePort = Number(process.env.VITE_PORT) || 42011;
const apiTarget = process.env.OCTOALLY_API_TARGET || 'http://127.0.0.1:42010';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: vitePort,
    proxy: {
      '/api': {
        target: apiTarget,
        ws: true,
      },
    },
  },
});
