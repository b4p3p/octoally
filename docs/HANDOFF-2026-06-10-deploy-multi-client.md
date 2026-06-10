# HANDOFF — Deploy feature "console multi-client" + fix DX

Data: 2026-06-10
Scopo: riprendere il lavoro dopo che il deploy del server avrà riavviato il
backend (la sessione Claude Code corrente cade in quel momento).

---

## TL;DR — dove eravamo

Tutto il lavoro è **committato su `main` (locale)**, **non pushato**, **non
ancora deployato** sul server reale. Resta da: (1) decidere il push, (2) fare il
deploy (`npm run deploy`) che riavvia il server reale e attiva la feature, (3)
verificare il multi-client vero.

## Cosa è stato fatto (tutto su `main`, working tree pulito)

1. **Feature: console multi-client con viste indipendenti** — merge commit
   `9175188` (dal branch `feat/console-multi-client`, ancora esistente).
   - Impostazioni di aspetto **per-client** (font app/terminale in
     `localStorage`, migrazione soft dal DB): `dashboard/src/App.tsx`,
     `dashboard/src/components/SettingsModal.tsx`, `Terminal.tsx`.
   - **Geometria del PTY posseduta dal server** (`DEFAULT_GEOMETRY` 140×40) +
     **controller a richiesta**: `server/src/services/session-manager.ts`,
     `server/src/routes/terminal.ts`. Il `resize` è onorato solo dal controller;
     `claim-control`/`release-control`; `geometry-changed` in broadcast.
   - **Client viewer scaling** (CSS) + pulsante "adatta alla mia finestra"
     (claim/release) nella toolbar del terminale: `Terminal.tsx`.
   - Spec: `docs/superpowers/specs/2026-06-10-console-multi-client-design.md`
   - Piano: `docs/superpowers/plans/2026-06-10-console-multi-client.md`
   - **Testato a due client** (browser dev): un client fa claim → PTY a 174 col,
     l'altro (viewer) si riscala **senza garbage**. Bug originale risolto.

2. **Fix DX (tooling, non feature)** — commit `f2b5c61`:
   - `scripts/ensure-runtime-deps.sh` (nuovo, idempotente): installa
     tmux/dtach/build-essential come `install.sh`.
   - `scripts/deploy-dev.sh`: chiama `ensure-runtime-deps` all'avvio (parità
     dev/prod). Il riavvio del server era già presente.
   - `package.json`: `npm run dev:isolated` (server+dashboard dev su porte+DB
     separati), `npm run dev:setup` (bootstrap), `scripts/dev-setup.sh` (nuovo).
   - `install.sh` NON toccato (resta self-contained per `curl|bash`).

3. **Sistema**: `dtach` e `tmux` installati (`sudo apt install dtach tmux`).
   Da ora le sessioni **future** persistono ai riavvii del server (le 3 attuali,
   in direct mode, muoiono comunque al primo riavvio).

## Stato git (al momento dell'handoff)

- Branch: `main` (avanti di `origin/main`, NON pushato).
- Ultimi commit:
  - `f2b5c61` fix(dev): parità deps dev/prod, ambiente dev isolato e bootstrap
  - `9175188` Merge branch 'feat/console-multi-client' …
  - `63bf4d1` feat(terminali): UI controller a richiesta (claim/release) …
  - `e7aaaaa` feat(terminali): viewer scaling lato client + font per-client
  - `1745521` feat(terminali): impostazioni per-client + geometria server-owned
  - `6af6d44` docs(terminali): spec e piano
- Branch `feat/console-multi-client` ancora presente (eliminabile dopo il merge).

## Ambiente (porte)

- **Installazione reale**: server `42010`, DB `~/.octoally/octoally.db`, app
  desktop Electron. Gira il **build vecchio** finché non si fa il deploy.
- **Dev isolato**: `npm run dev:isolated` → server `42020` (DB
  `~/.octoally/octoally-dev.db`) + dashboard `42021`. Override via env
  `OCTOALLY_DEV_PORT` / `OCTOALLY_DEV_DB` / `OCTOALLY_DEV_VITE_PORT`.

## PASSI RIMANENTI (da fare dopo l'handoff)

### 1. (opzionale) Push di `main`
```
git push origin main
```

### 2. Deploy del nuovo server (ATTENZIONE: chiude le 3 sessioni reali)
- Salvare/chiudere il lavoro nelle sessioni reali (questa sessione inclusa).
- Eseguire:
```
cd ~/progetti/octoally
npm run deploy          # richiede sudo per l'app Electron
```
- `deploy-dev.sh`: installa deps (già presenti), ferma il server, builda,
  rsync server+dashboard in `~/octoally`, aggiorna l'asar Electron (sudo),
  riavvia il server.
- Riavviare l'app desktop se necessario.

### 3. Verifica post-deploy
```
curl -s localhost:42010/api/health
node -e "console.log(require(process.env.HOME+'/octoally/version.json'))"
```
- Lanciare una sessione di prova dall'app desktop.
- **Test multi-client vero**: aprire la stessa sessione nell'app desktop E in un
  browser su `http://localhost:42010`. In uno premere "adatta alla mia finestra"
  (claim) → l'altro deve **riscalarsi senza garbage** (prima si rompeva).
- Verificare che il server ora usi **tmux** (sessioni persistenti): le nuove
  sessioni devono sopravvivere a `octoally stop && octoally start`.

## Come riprendere — IMPORTANTE se su un ALTRO PC

PREREQUISITO: il lavoro deve essere stato **pushato** su `origin/main` prima di
spegnere. Senza push, non è disponibile altrove (vive solo sul PC originale).
Anche QUESTO documento va committato+pushato per ritrovarlo.

### Su un altro PC (sviluppo del codice — portabile ovunque)
1. Clonare o aggiornare il repo:
   ```
   git clone https://github.com/b4p3p/octoally.git   # oppure: git pull origin main
   cd octoally
   ```
2. Bootstrap dell'ambiente di sviluppo (una volta per macchina):
   ```
   npm run dev:setup        # installa dtach/tmux/build-essential + npm deps
   ```
3. Avviare l'ambiente dev **isolato** (mai tocca un'installazione):
   ```
   npm run dev:isolated     # server 42020 + dashboard 42021 (DB octoally-dev.db)
   ```
4. Far leggere a Claude questo file e proseguire dai "PASSI RIMANENTI".

### Nota: deploy e test sulle SESSIONI REALI sono legati alla macchina
Il deploy (`npm run deploy`) e il test multi-client "vero" agiscono
sull'installazione locale di QUEL PC (`~/octoally` + app desktop). Le 3 sessioni
di lavoro reali citate sopra erano sul PC originale: su un altro PC non ci sono.
Quindi su un altro PC puoi: continuare lo **sviluppo**, ed eventualmente fare il
deploy sulla SUA installazione (se OctoAlly è installato lì). Non c'è nulla da
"recuperare" delle sessioni reali — erano effimere.

### Sulla stessa macchina (al riaccendere)
1. `cd ~/progetti/octoally`, nuova sessione Claude Code.
2. Far leggere questo file; proseguire dai "PASSI RIMANENTI".

## Note / limiti noti

- **Font del terminale in modalità viewer**: lo scaling fit-to-card normalizza
  l'aspetto, quindi "font 120% vs 100%" non si distingue tra viewer; il controllo
  pieno della dimensione c'è in modalità **controller** (claim). Rifinitura
  eventuale, non bloccante.
- Backup automatico dell'asar Electron in `${ELECTRON_ASAR}.bak` durante il deploy.
- Per sviluppare senza rischi usare SEMPRE `npm run dev:isolated` (mai
  `npm run dev`, che userebbe porta 42010 + DB reale).
