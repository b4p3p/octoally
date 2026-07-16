# ANALISI — Pivot del terminale e scelta della base

Data: 2026-06-16
Scopo: documento **analizzabile** per decidere se/come abbandonare il modello
"terminale web multi-client scalato" di OctoAlly e su quale base ripartire.
Mette insieme (a) l'analisi architetturale fatta in sessione e (b) la ricerca
multi-fonte sui sistemi esistenti (21 claim confermati su 25, fonti primarie).

> Nota di metodo: ogni opzione riporta il livello di **affidabilità** della
> valutazione. "Verificato 3-0" = claim confermato all'unanimità in verifica
> adversariale su fonte primaria (repo/doc ufficiali). I giudizi di *maturità /
> idoneità a forkare* restano in parte ingegneristici, da confermare leggendo il
> codice prima di qualsiasi commitment.

---

## 0. TL;DR

- **kitty NON è la strada** (verificato): non è embeddabile in un'app né nel
  browser, è già l'anti-pattern #6 del nostro handoff, e ci toglierebbe la
  persistenza tmux. Scartato.
- Il **dolore (resize / multi-client)** è strutturale del modello *un PTY
  condiviso a geometria singola*. Si risolve **alla radice** passando a
  **una sessione PTY dedicata per client** (niente più viewer scalati in
  competizione sulla stessa size).
- Architettura bersaglio: **Motore headless (su IP)** + **client desktop ricco
  (lavoro serio, terminali veri multi-tab)** + **client telefono/web come
  telecomando** (legge la console, manda comandi veloci). Il vincolo geometria
  si attiva solo nel caso "stessa sessione live su due viste insieme", che
  diventa un caso di bordo.
- **Due percorsi realistici** (dettaglio §6):
  - **Path A — evolutivo (rischio minimo):** tieni il motore Node/Hono + tmux,
    costruisci il client desktop come **Electron + xterm.js, 1 PTY per tab**
    (= modello del terminale di VS Code → il resize si risolve per costruzione),
    declassa la web UI a lettore+telecomando. Riusa ~l'80% di quello che hai,
    niente Rust.
  - **Path B — pivot nativo:** **Tauri 2 + Rust (portable-pty)**, PTY nativo per
    client. Più pulito su resize/perf e binario leggero, ma riscrittura del
    motore in Rust e basi di riferimento ancora PoC-grade. Base candidata da
    *audit*: **maiTerm**; libreria emulatore matura: **wezterm-term (WezTerm)**.
- **Raccomandazione:** partire da **Path A** per smettere di soffrire subito,
  tenendo Path B come traiettoria se/quando serve il terminale nativo/GPU.
  Prima di forkare qualunque cosa: **audit del codice** di maiTerm e opcode/crystal.

---

## 1. Il problema (perché siamo qui)

Stack attuale: React/Vite + Node/Hono + **xterm.js + node-pty + tmux + WebSocket**,
più un client **Electron**. È lo standard di settore (ttyd, wetty, code-server,
sshx) — non c'è una libreria magica che lo aggira.

Il vincolo che fa male (handoff multi-client, §2): **una sessione = un PTY = UNA
sola geometria (cols×rows) alla volta.** Con più client sulla stessa finestra,
tmux rimpicciolisce al client più piccolo. Da qui il modello "viewer scalati in
CSS" e tutti i bug di scala/resize/leggibilità.

**Causa tecnica del resize** (verificato 3-0): vim/tmux leggono la dimensione dal
**PTY del kernel** (ioctl `TIOCGWINSZ` + `SIGWINCH`), *non* da xterm.js. Se il
front-end ridimensiona la vista ma il PTY backend non viene aggiornato (o viene
deliberatamente non aggiornato, com'è giusto per i viewer passivi), la winsize
resta stale. **Implicazione:** un backend con **un PTY dedicato per client**
risolve il resize molto più nettamente del modello tmux condiviso multi-client.
Fonti: xterm.js#3873, node-pty#266, tmux#4003.

---

## 2. La direzione architetturale (indipendente dalla base)

Separare i due ruoli che oggi OctoAlly mescola:

```
        ┌─────────────────────────────────────────────┐
        │   MOTORE (headless, su una macchina, su IP)  │
        │   PTY/tmux + agenti Claude Code SDK          │
        │   DB progetti/prompt + API HTTP/WebSocket    │
        └───────────────┬──────────────────┬───────────┘
                        │                  │
         ┌──────────────┴───────┐   ┌──────┴───────────────┐
         │  CLIENT DESKTOP       │   │  CLIENT TELEFONO/WEB  │
         │  terminali VERI,      │   │  legge console +      │
         │  multi-tab, 1 PTY/tab │   │  comandi veloci       │
         │  = dove LAVORI        │   │  = telecomando da IP  │
         └───────────────────────┘   └───────────────────────┘
```

- **Desktop** = lavoro serio. 1 PTY per tab, vista a proprietario unico → reflow,
  zoom, resize "veri". Il terminale ricco vive qui.
- **Telefono/web** = telecomando: **read** via `capture-pane`/stream (solo testo,
  niente geometria) + **write** via `send-keys`/input. Dal bagno leggi e mandi
  "continua"/approvi un tool/scrivi un prompt corto. **Non** ridimensiona il PTY
  → il bug non può presentarsi su questo percorso.
- **Da IP in sicurezza:** Tailscale/WireGuard invece di esporre la porta a
  Internet (il motore ha terminali+agenti = superficie RCE).
- **Bonus naturale:** notifiche push quando l'agente finisce o chiede conferma.

**kitty — perché è fuori (verificato):** è un emulatore desktop GPU, non
embeddabile in un'app/browser; le richieste di reparent/XEmbed sono state
respinte (issue #2612 chiusa, #7083 rifiutata). Sostituire tmux con `kitty @`
toglierebbe persistenza/detach. = anti-pattern #6.

---

## 3. Le opzioni concrete (dalla ricerca)

### A. maiTerm — *la singola base più vicina a tutte e 3 le esigenze*
- **Cosa copre:** (1) terminale ibrido nativo (alacritty_terminal in Rust =
  parser VTE/scrollback + xterm.js come renderer DOM sottile, ~60fps);
  (2) organizzazione **workspace/progetto** con split pane ricorsivi + multi-tab
  + scrollback persistente in SQLite; (3) **Claude Code profonda**: MCP server
  con 25+ tool, hook di lifecycle (SessionStart/PreToolUse…), auto-resume,
  "agent bridge" tra due sessioni Claude.
- **Stack:** Tauri 2 + Svelte 5 + Rust (alacritty_terminal 0.25, portable-pty,
  rusqlite).
- **Licenza:** da verificare nel repo.
- **Affidabilità:** verificato 3-0 sulle feature, **ma fonte unica = README** e
  progetto auto-dichiarato "fully written by AI", senza verifica di terzi.
- **Pro:** è già *quasi* la nostra tripletta in un solo progetto, su lo stack
  Tauri che risolve il resize alla radice.
- **Contro/Caveat:** è più "terminale+workspace" che **orchestratore di sessioni
  AI** (manca la profondità branch-per-sessione di Claude Squad/Crystal).
  **Da auditare il codice prima di forkare.**
- Link: https://github.com/Flexmark-Intl/maiterm · https://maiterm.dev

### B. Tauri 2 + xterm.js + native PTY in Rust (portable-pty) — *costruisci tu sul pattern validato*
- **Cosa copre:** il **livello terminale** (1). È l'equivalente Tauri del tuo
  attuale Electron+node-pty: sostituisci node-pty con **portable-pty** lato Rust.
- **Stack/Licenza:** Tauri 2 + xterm.js + portable-pty; **tauri-plugin-pty** è
  **MIT** (~8k download/mese, API spawn/onData/write/resize).
- **Affidabilità:** pattern verificato 3-0, ma i progetti di riferimento sono
  **PoC**: `tauri-terminal` (Tauri 1.x, datato), `Terminon` (PoC monoautore,
  0 stelle, **nessuna licenza dichiarata = non forkabile legalmente finché non
  chiarita**), `tauri-plugin-pty` (early ma funzionante).
- **Pro:** controllo totale, binario leggero, PTY-per-client = resize pulito.
- **Contro:** parti più "da zero" sul resto (orchestrazione, UI, DB).
- Link: https://github.com/Tnze/tauri-plugin-pty ·
  https://github.com/Shabari-K-S/terminon · https://github.com/marc2332/tauri-terminal

### C. WezTerm / crate `wezterm-term` — *l'emulatore maturo + multiplexer*
- **Cosa copre:** (1) emulatore **GPU cross-platform E multiplexer**, Rust, in un
  solo progetto. Architettura **client-server con "hot-swappable GUI attachments
  without session loss"** → rilevante al multi-client/remoto, alternativa a tmux.
  Il crate **wezterm-term** è riusabile come **libreria** indipendente dalla GUI.
- **Licenza:** **MIT** (sia WezTerm sia wezterm-term). Verificato 3-0.
- **Pro:** la base emulatore più solida e battle-tested; il mux risolve il
  "stessa sessione su più viste" meglio di tmux.
- **Contro:** usare wezterm-term come libreria = **costruisci renderer e gestione
  PTY da zero** (più lavoro che forkare maiTerm/Terminon); possibile fallback a
  software rendering su alcuni setup Intel/RDP.
- Link: https://github.com/wezterm/wezterm ·
  https://github.com/wezterm/wezterm/blob/main/term/README.md ·
  https://wezterm.org/multiplexing.html

### D. claudecodeui (siteboon) — *gestore sessioni stile OctoAlly, ma web*
- **Cosa copre:** (2) GUI **multi-CLI** (Claude Code, Cursor, Codex, Gemini),
  resume conversazioni, sessioni multiple, history, file-tree, Git, TaskMaster
  opzionale, controllo **remoto**. Molto vicino al "gestore stile OctoAlly".
- **Stack:** web React/Vite (NON desktop nativo). Molto attivo (~12k stelle,
  push 2026-06-16).
- **Licenza:** **AGPL-3.0** (copyleft di rete → obblighi se servito come SaaS).
- **Affidabilità:** verificato 3-0 sul gestore; **il claim "terminale xterm.js
  multi-tab embedded" è stato REFUTATO (1-2).**
- **Pro:** ottimo riferimento per il *telecomando remoto* e la gestione sessioni.
- **Contro:** stesso stack xterm.js che già usi → **non** risolve il bisogno di
  terminale nativo; AGPL pesante; copre il "prompt/workflow" solo in parte.
- Link: https://github.com/siteboon/claudecodeui

### E. Vibe Kanban (BloopAI) — *orchestratore multi-agente kanban*
- **Cosa copre:** (2)+(3) orchestrazione kanban per **10+ agenti** (Claude Code,
  Codex, Gemini, Copilot, Amp, Cursor, OpenCode, Droid, CCR, Qwen): worktree git
  per workspace, planning, run agenti, **review diff con commenti inline**,
  preview app.
- **Stack:** **Rust ~50% + React/TS ~46%**, web self-hostable via Docker (no
  Tauri/Electron).
- **Affidabilità / DISCREPANZA APERTA:** il README dichiara esplicitamente
  **"sunsetting"**, ma in verifica adversariale il claim "è in sunset/rischioso"
  ha ricevuto **vote 0-3 (refutato)**. **Da controllare direttamente sul repo
  prima di adottarlo o scartarlo.**
- **Pro:** il modello di orchestrazione più ricco tra i candidati.
- **Contro:** se davvero in sunsetting, rischioso come base da forkare.
- Link: https://github.com/BloopAI/vibe-kanban

### F. Non verificati in questo report — da valutare con un secondo giro
Assenza di evidenza ≠ evidenza di assenza. Citati ma **non** auditati qui:
**opcode** (getAsterisk / winfunc — Tauri, Claude Code GUI), **crystal**
(stravu — Electron, sessioni parallele in worktree), **claude-squad**,
**conductor**, **OpenCovibe**, **Codeman**. Diversi sono *esattamente*
orchestratori di sessioni Claude Code dedicati: vanno valutati per licenza,
stack, e profondità SDK rispetto a maiTerm/Vibe Kanban.

---

## 4. Tabella comparativa

| Opzione | Copre (1/2/3) | Stack | Licenza | Maturità | Fit Claude Code | Resize risolto |
|---|---|---|---|---|---|---|
| **A. maiTerm** | 1 + 2 + 3 (parz.) | Tauri2 / Svelte5 / Rust | da verif. | media (AI-written, README-only) | alta (MCP+hook+resume) | sì (Tauri PTY) |
| **B. Tauri2+portable-pty** | 1 | Tauri2 / xterm.js / Rust | MIT (plugin) | PoC | da costruire | sì (per costruzione) |
| **C. WezTerm / wezterm-term** | 1 (+mux) | Rust | MIT | alta | da costruire | sì (mux nativo) |
| **D. claudecodeui** | 2 | React/Vite web | AGPL-3.0 | alta (~12k★) | alta (multi-CLI) | no (stesso xterm.js) |
| **E. Vibe Kanban** | 2 + 3 | Rust + React, Docker | da verif. | alta ma "sunsetting?" | alta (10+ agenti) | n/a (web) |
| **Attuale OctoAlly** | 2 + 3 | Node/Hono + Electron + xterm.js + tmux | — | in uso | in uso | no (multi-client) |

---

## 5. Decisioni aperte (da chiudere prima di scegliere)

1. **Audit maiTerm:** essendo "fully written by AI" con sola fonte README, regge a
   un'ispezione del codice (qualità, robustezza multi-client, correttezza resize)?
2. **Vibe Kanban è davvero in sunsetting?** README vs verifica si contraddicono.
3. **Orchestratori non verificati** (opcode, crystal, claude-squad, conductor):
   licenza/stack/profondità SDK rispetto a maiTerm?
4. **Requisito (3) — come embeddare gli agenti:** `claude-agent-sdk` headless
   (`claude -p`, stream-json) **dentro** il backend, *oppure* delegare a un **MCP
   server** (come fa maiTerm)? Trade-off controllo programmatico vs disaccoppiamento.
5. **Electron vs Tauri:** Path A riusa l'Electron che hai (zero Rust); Path B
   (Tauri/Rust) è più pulito ma è una riscrittura del motore.

---

## 6. Raccomandazione finale / da dove partire

**Parti da Path A (evolutivo).** Motivo: smette di farti soffrire *subito*, riusa
il motore (tmux/pty/API/DB) e l'Electron che hai già, e **risolve il resize per
costruzione** spostando il lavoro serio su **terminali a proprietario unico,
1 PTY per tab** (esattamente il terminale integrato di VS Code, che è xterm.js in
Electron). In parallelo, **declassa la web UI a "lettore console + telecomando"**
per l'uso da telefono/IP — è meno codice e zero vincolo geometria.

**Tieni Path B (Tauri/Rust) come traiettoria**, non come salto immediato: lo
attivi *se e quando* ti serve davvero il terminale nativo/GPU o un binario
leggero. Quando lo farai, i due punti di partenza più seri sono **maiTerm**
(forkare, dopo audit) o **wezterm-term** (libreria, più lavoro ma battle-tested).

**Prossimo passo concreto (1 giro di valutazione):** prima di scrivere codice,
**audit del codice** di `maiTerm`, `opcode`, `crystal` (e check del sunsetting di
Vibe Kanban) per chiudere le decisioni aperte §5. Solo allora si sceglie fork vs
build.

---

## 7. Fonti (primarie, salvo dove indicato)

- maiTerm — https://github.com/Flexmark-Intl/maiterm · https://maiterm.dev
- tauri-plugin-pty (MIT) — https://github.com/Tnze/tauri-plugin-pty
- Terminon — https://github.com/Shabari-K-S/terminon
- tauri-terminal — https://github.com/marc2332/tauri-terminal
- WezTerm — https://github.com/wezterm/wezterm ·
  https://github.com/wezterm/wezterm/blob/main/term/README.md ·
  https://wezterm.org/multiplexing.html
- claudecodeui (AGPL-3.0) — https://github.com/siteboon/claudecodeui
- Vibe Kanban — https://github.com/BloopAI/vibe-kanban
- opcode — https://github.com/getAsterisk/opcode · https://github.com/winfunc/opcode
- crystal — https://github.com/stravu/crystal
- alacritty_terminal (crate) — https://crates.io/crates/alacritty_terminal
- Claude Agent SDK (stream-json) — https://code.claude.com/docs/en/agent-sdk/streaming-output
- Resize/PTY winsize — https://github.com/xtermjs/xterm.js/issues/3873 ·
  https://github.com/microsoft/node-pty/issues/266 · https://github.com/tmux/tmux/issues/4003
- kitty embedding (rifiutato) — https://github.com/kovidgoyal/kitty/issues/2612 ·
  https://github.com/kovidgoyal/kitty/issues/7083
