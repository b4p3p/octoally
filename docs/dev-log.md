# HiveCommand Dev Log

## 2026-03-17 — Change hard refresh shortcut from Ctrl+Shift+F5 to Ctrl+Shift+R

**File:** `desktop-electron/src/main.ts`

Changed the Electron hard refresh (bypass cache) keybinding from Ctrl+Shift+F5 to Ctrl+Shift+R.
F5 still performs a normal page refresh. Ctrl+Shift+R matches the standard browser convention
for cache-bypassing reload, which users expect.
