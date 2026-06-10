# Console multi-client con viste indipendenti — Implementation Plan

> Spec: `docs/superpowers/specs/2026-06-10-console-multi-client-design.md`

**Goal:** Permettere più client sullo stesso server/sessione con font, zoom,
layout e progetto indipendenti per client, senza che si rompano i terminali
condivisi.

**Architecture:** (1) impostazioni di aspetto da DB → `localStorage`
(per-client). (2) geometria del pty posseduta dal server con `defaultGeometry`
fissa + `controller` a richiesta; i client sono viewer che scalano via CSS e non
mandano `resize` salvo quando sono controller.

**Tech Stack:** Fastify + ws (server), React + xterm.js + Vite (client).

**Testing:** nessun framework nel repo → verifica con `tsc` + prove manuali in
ambiente isolato (server dev 42020 + DB dev + sessioni di TEST), mai sui
terminali reali. Ordine: prima ambiente isolato, poi implementazione, poi prove.

---

## Task 0: Ambiente isolato per i test

**Files:** nessuno (operativo).

- [ ] Fermare il dashboard dev che punta al backend reale.
- [ ] Avviare server dev: `cd server && PORT=42020 DB_PATH=$HOME/.octoally/octoally-dev.db npm run dev` (background).
- [ ] Avviare dashboard dev: `cd dashboard && VITE_PORT=42021 OCTOALLY_API_TARGET=http://127.0.0.1:42020 npm run dev` (background).
- [ ] Creare 1 sessione di TEST nel DB dev (terminale `bash` su un progetto qualsiasi) via UI o REST, da usare per le prove multi-client.
- [ ] Verifica: `curl 42020/api/sessions` mostra la sessione di test; l'app desktop/installazione (42010) resta intoccata.

## Task 1: `app_font_size` per-client (localStorage)

**Files:**
- Modify: `dashboard/src/App.tsx` (lettura `app_font_size`)
- Modify: `dashboard/src/components/SettingsModal.tsx` (scrittura font app)

- [ ] In `App.tsx`, sostituire la lettura da `appSettings?.settings?.app_font_size`
  con un valore da `localStorage` (`octoally-app-font-size`), con seed dal DB
  solo se la chiave locale è assente (migrazione soft).
- [ ] In `SettingsModal.tsx`, scrivere `app_font_size` in `localStorage` invece che
  via `api.settings.update`; aggiornare il rendering immediatamente.
- [ ] Verifica: `tsc -b` dashboard pulito. In due browser sul dev, cambiare il
  font app in uno non cambia l'altro.

## Task 2: Stato geometria lato server

**Files:**
- Modify: `server/src/services/session-manager.ts` (struttura sessione attiva, spawn, `resizeSession`)

- [ ] Aggiungere alla struttura della sessione attiva i campi `defaultGeometry
  {cols,rows}` (init 140×40), `geometry {cols,rows}` (init = default),
  `controller: WebSocket | null` (init null).
- [ ] Alla spawn (`spawnSession`/`spawnTerminal`/`spawnAgent`/`spawnAdopt`): creare
  il pty a `defaultGeometry` invece che alla dimensione del primo client.
- [ ] `resizeSession(sessionId, cols, rows, ws?)`: aggiungere param opzionale `ws`;
  applicare il resize SOLO se `ws === active.controller`; aggiornare
  `active.geometry`. Mantenere la firma retrocompatibile (chiamate interne
  passano il controller).
- [ ] Aggiungere `setController(sessionId, ws|null)` e `getGeometry(sessionId)`.
- [ ] Verifica: `tsc --noEmit` server pulito.

## Task 3: Protocollo claim/release + broadcast geometry-changed

**Files:**
- Modify: `server/src/routes/terminal.ts` (gestione messaggi WS)
- Modify: `server/src/services/session-manager.ts` (helper broadcast + close controller)

- [ ] In `session-manager.ts`, aggiungere `broadcastGeometry(sessionId)` che invia
  `{type:'geometry-changed', cols, rows}` a tutti i `subscribers`.
- [ ] In `terminal.ts`, nel handler messaggi (ramo sessione già running):
  - `claim-control {cols,rows}`: `setController(id, socket)`, `resizeSession(id,
    cols, rows, socket)`, `broadcastGeometry(id)`.
  - `release-control`: `setController(id, null)`, riportare `geometry =
    defaultGeometry`, `resizeSession(id, default.cols, default.rows, <internal>)`,
    `broadcastGeometry(id)`.
  - `resize {cols,rows}`: passare `socket` a `resizeSession` (onorato solo se
    controller).
- [ ] In `attachTerminal`/`ws.on('close')`: se la socket che si chiude è il
  controller, eseguire lo stesso percorso di `release-control` (torna a default).
- [ ] All'attach di una nuova connessione, inviare subito `geometry-changed` con la
  geometria corrente così il client crea xterm alla dimensione giusta.
- [ ] Verifica: `tsc --noEmit` server. Con `curl`/wscat: una connessione non-controller
  che manda `resize` NON cambia la geometria; `claim-control` la cambia e gli
  altri ricevono `geometry-changed`.

## Task 4: Client viewer scaling + geometry-changed (Terminal.tsx)

**Files:**
- Modify: `dashboard/src/components/Terminal.tsx`

- [ ] Alla ricezione di `geometry-changed {cols,rows}`: chiamare
  `term.resize(cols, rows)` (dimensione logica xterm = geometria server) e
  ricalcolare la scala CSS.
- [ ] Sostituire il fit→resize automatico (in modalità viewer / `passiveResize` e
  in griglia) con uno **scaling CSS**: calcolare `scale = min(cardW/termW,
  cardH/termH)` e applicare `transform: scale(scale)` al contenitore xterm, senza
  inviare `resize`.
- [ ] Mantenere l'invio di `resize` SOLO quando il terminale è in modalità
  controller (vedi Task 5).
- [ ] `terminal_font_size` da `localStorage` (`octoally-terminal-font-size`) con seed
  dal DB; il font cambia solo la cella xterm/scala locale, mai la geometria.
- [ ] Verifica: `tsc -b` dashboard. Nel dev, una sessione di test in griglia
  renderizza scalata e leggibile; cambiare font in un viewer non manda resize
  (controllare i log del server).

## Task 5: Controlli claim/release in UI (ActiveTerminals)

**Files:**
- Modify: `dashboard/src/components/ActiveTerminals.tsx`
- Modify: `dashboard/src/components/Terminal.tsx` (prop `isController` + invio claim/release)

- [ ] Aggiungere un pulsante per terminale "adatta alla mia finestra" / "rilascia"
  che imposta lo stato controller di quel terminale.
- [ ] Quando un terminale diventa controller: inviare `claim-control` con le cols/rows
  reali calcolate dalla card al font corrente (via FitAddon `proposeDimensions`),
  e da lì in poi inviare `resize` sui cambi di dimensione. Quando rilascia:
  inviare `release-control` e tornare viewer (scaling CSS).
- [ ] Verifica: `tsc -b`. Nel dev con due browser sulla stessa sessione di test:
  claim in uno → l'altro riceve `geometry-changed` e scala; release → torna al
  default; nessun garbage in nessuno dei due durante i cambi.

## Task 6: Verifica integrata + pulizia

- [ ] Prova end-to-end in ambiente isolato con due browser sulla stessa sessione di
  test: font diversi, colonne diverse, progetti diversi, claim/release — nessuna
  propagazione, nessun garbage.
- [ ] `tsc` server + dashboard puliti.
- [ ] Riconciliare commenti che citano tmux dove il comportamento è ora descritto in
  termini di geometria/controller.
- [ ] Riepilogo finale dei file modificati per il commit (l'utente decide quando
  committare).

## Self-review (coverage vs spec)

- Parte 1 (font per-client): Task 1 (app) + Task 4 (terminale). ✓
- Parte 2 (geometria server-owned): Task 2 (stato) + Task 3 (protocollo) + Task 4
  (viewer scaling) + Task 5 (controller a richiesta). ✓
- Edge: close del controller → default (Task 3); Codex refresh (riuso `sendReplay`
  esistente, da invocare dopo geometry-changed in Task 4). ✓
- Testing isolato: Task 0 + Task 6. ✓
