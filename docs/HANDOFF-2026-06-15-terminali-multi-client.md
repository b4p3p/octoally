# HANDOFF — Rendering terminali multi-client (lezioni e architettura)

Data: 2026-06-15
Commit del fix: `2b2524b` — *fix(terminali): rendering multi-client robusto (viewer scalati DOM + terminali reali)*

Scopo di questo documento: **non rifare daccapo** il calvario di oggi. Raccoglie
il vincolo fondamentale, l'architettura a cui siamo arrivati (che funziona),
tutti i bug incontrati con causa+fix, gli anti-pattern, e come verificare.

---

## 1. Obiettivo

Permettere agli utenti di:
- collegarsi a un **indirizzo IP** (browser) e vedere le sessioni aperte dal
  gestionale;
- fare la stessa cosa dal **client Electron** sul proprio PC;
- **contemporaneamente** (browser + Electron sulle stesse sessioni).

## 2. Il vincolo FONDAMENTALE (leggere prima di tutto)

**Una sessione = un PTY = UNA sola dimensione (cols×rows) alla volta.**
Non è un limite nostro: è strutturale. La doc di tmux: con più client sulla
stessa finestra, tmux rimpicciolisce alla dimensione del **client più piccolo**
e riempie il resto di puntini — *"this assumption is baked deep into tmux"*.

Conseguenza diretta: **non puoi avere reflow per-card su client diversi** con un
PTY condiviso. Le uniche due strategie esistenti (entrambe valide, le abbiamo
toccate):
1. **una geometria condivisa** (la più piccola / l'ultima attiva), gli altri in
   letterbox — modello tmux nativo;
2. **vista per-client scalata**: il server possiede la dimensione del terminale,
   ogni client **scala la propria vista** (CSS). È anche il modello del canvas di
   sshx. **È quello che usiamo.**

Lo stack (xterm.js + node-pty/PTY worker + WebSocket + tmux) è lo **standard di
settore** (ttyd, gotty, wetty, code-server, sshx). Non c'è una libreria magica
che aggira il vincolo sopra.

## 3. Architettura finale (IL MODELLO CHE FUNZIONA)

Nel componente `dashboard/src/components/Terminal.tsx` la prop chiave è
`isController` (default ora **`true`**):

- **Vista a tutto schermo / sessione singola / modale espanso = CONTROLLER**
  (`isController=true`): è un terminale **vero**. Fa `fit()` alla propria area e
  **guida la geometria del PTY** (claim-control/resize) → reflow vero, zoom del
  font, scroll nativi, cursore esatto. È il posto dove si **lavora**.

- **Griglia (Active Sessions + griglia di progetto) = VIEWER**
  (`isController={false}`): mostra il terminale **scalato in CSS** per riempire
  la card. **NON guida la geometria del PTY.** Quindi cambiare la disposizione
  (cols/rows) su un client **non tocca** il PTY → gli altri client non si
  rompono (multi-client sicuro). L'xterm del viewer è sempre alla geometria del
  PTY (via `geometry-changed`) → cursore allineato, niente sovrascrittura.

- Solo **UN** terminale per sessione è connesso/attivo alla volta lato stesso
  client (meccanismo `suspended`: la griglia sospende le viste piene; il modale
  fa cedere la grid-card). Tra client **diversi** invece convivono: uno guida
  (controller), gli altri scalano (viewer).

Lato server (`server/src/routes/terminal.ts` + `services/session-manager.ts`):
- geometria **server-owned**, `DEFAULT_GEOMETRY = 140×40` (orizzontale ~16:9).
- `claim-control` / `release-control` / `resize` (resize onorato **solo** dal
  controller). `release` e la **chiusura del socket** riportano a
  `DEFAULT_GEOMETRY`.
- Il ramo WebSocket **passivo** ora onora anch'esso claim-control/resize (serve
  per lo zoom delle sessioni Terminal/Codex).

## 4. Bug incontrati oggi → causa → fix (NON ripeterli)

In ordine, ognuno scoperto **misurando il DOM reale** (non a intuito):

1. **Layout rotto cambiando fullscreen→3 colonne** (bug iniziale)
   → scale "stale": `applyScale` calcolava prima che il layout si assestasse e
   l'observer era solo sul container → mai ricalcolato.
   → Fix: rescale differito (rAF) + `ResizeObserver` anche su `.xterm`.

2. **Geometry drift del viewer** (xterm a ~89 righe mentre il PTY a 40)
   → chiamate a `fitAddon.fit()` non condizionate nei cicli di vita (visible,
   visibilitychange, refresh, font) ridimensionavano l'xterm del viewer.
   → Fix: **i viewer non fanno mai `fit()`**; gating su `isController`.

3. **Clipping orizzontale** (metà colonne tagliate)
   → `applyScale` misurava `.xterm` (vincolato al container) invece di
   `.xterm-screen` (dimensione reale).
   → Fix: misurare `.xterm-screen` **e forzare** `.xterm` alla dimensione
   naturale prima di scalare (altrimenti la scrollbar finisce a metà card).

4. **Zoom +/- non faceva nulla** (viewer fit-to-card compensava il font)
   → con il fit, cambiare il font è ininfluente.
   → Decisione: lo zoom **vero** (reflow) vive nel controller. Nel viewer lo
   zoom è locale (o assente). *(Vedi punto aperto sotto.)*

5. **Barrato / righe sovrapposte SOLO nel browser**
   → renderer **WebGL** di xterm a **devicePixelRatio frazionario** (scala
   display HiDPI / zoom browser su Linux) disallinea righe e box-drawing.
   Electron gira a dpr pulito → non si vedeva.
   → Fix: **rimosso WebGL**, si usa il **renderer DOM** ovunque (impagina per
   line-height CSS intero → corretto a qualsiasi dpr/scala). Costo: un filo più
   CPU su output pesanti, accettabile per una dashboard che scala terminali.

6. **"Scrive sulla riga sopra" / cambiare layout rompeva l'altro client**
   → avevamo fatto le grid-card **controller**: due client guidavano lo stesso
   PTY → conflitto di geometria.
   → Fix: grid-card = **viewer** (non guidano il PTY). *(Vedi sezione 3.)*

7. **Margine grande + testo sballato su octoally (solo browser)**
   → la **geometria della sessione era rimasta bloccata stretta/verticale**
   (es. 54×37) dai tanti resize del debug. Un viewer la mostra fedelmente →
   margine enorme in card orizzontale.
   → Le sessioni **nuove** nascono a 140×40 e tornano lì alla chiusura del
   controller → non capita. octoally era danneggiata. **NON** aggiungere
   un'auto-normalizzazione che resetta la geometria all'attach (vedi
   anti-pattern #4).

## 5. Anti-pattern (cose che SEMBRANO giuste ma peggiorano)

1. **Grid-card come controller** → conflitto multi-client. La griglia deve
   essere viewer.
2. **CSS-scale + renderer WebGL** → artefatti a dpr frazionario. Usare il DOM
   renderer per le viste scalate.
3. **"Deploy and pray"** sull'installazione reale ad ogni tentativo → ci ha
   bruciato più volte. **Testare PRIMA in `npm run dev:isolated`** (porte
   42020/42021, DB separato) con Chrome DevTools MCP, misurando il DOM.
4. **Auto-normalizzare la geometria** (reset a DEFAULT quando "nessun
   controller") → cambia la geometria → **ri-avvolge lo scrollback** di tutti i
   viewer → mash. Trade-off peggiore del problema. NON farlo (o farlo solo
   insieme a un capture-pane refresh, ma per le sessioni Claude lo scrollback è
   gestito da Claude → spesso inutile).
5. **Connettere un terzo client di test** (es. browser DevTools automatizzato)
   sulle stesse sessioni mentre l'utente lavora → aggiunge churn e destabilizza
   la sua vista. Scollegarlo prima di concludere.
6. **Passare a sshx/ttyd** per risolvere → è la stessa classe di stack;
   perderemmo le feature del gestionale (spawn Claude/Codex, progetti,
   persistenza). Tienili come riferimento, non come sostituto.

## 6. Come verificare (metodo che ha funzionato)

- Ambiente isolato: `npm run dev:isolated` → server 42020 + dashboard 42021, DB
  `~/.octoally/octoally-dev.db`. **Mai** testare prima sull'installazione reale.
- Chrome DevTools MCP per **misurare il DOM reale** (non guardare solo a occhio):
  `transform`/`scale`, `.xterm-screen` offsetW/H, container, `canvas` count
  (0 = DOM renderer attivo), righe sovrapposte (`rowStep` vs altezza riga),
  `devicePixelRatio` (emulare anche dpr 1.5 per HiDPI).
- Per il PTY reale: `tmux -L octoally list-panes -t of-<sid> -F "#{pane_width}x#{pane_height}"`.
- **rehab come "controllo pulito"**: una sessione poco toccata. Se rehab è
  pulita e un'altra no → il problema è la sessione (geometria/scrollback
  danneggiati), non il codice.
- Casi da provare: scrittura+cursore, riga lunga (reflow/scala), 2 colonne,
  expand→collapse (geometria torna), zoom, **cambio layout su un client mentre
  l'altro guarda** (l'altro NON deve rompersi: il PTY resta invariato), dpr 1.5.

## 7. Punti aperti / possibili miglioramenti

- **Zoom locale per-client nella griglia** (CSS, non condiviso): oggi lo zoom
  in griglia "prende il controllo" → ridimensiona il PTY condiviso → cambia su
  **tutti** i client. Per il multi-client sarebbe meglio uno zoom **locale**
  (ingrandimento CSS della sola vista del client). Con il renderer DOM ora è
  fattibile pulito. È il prossimo ritocco naturale.
- **Cursore nel browser**: per le sessioni Claude il cursore di xterm è nascosto
  (lo disegna Claude); si vede nel terminale **attivo/focalizzato**. Nella
  griglia (vista passiva scalata) il caret non è attivo. Per scrivere nel
  browser: espandere/cliccare nella console. Non è un bug, ma valutare se
  rendere il caret più visibile nei viewer.
- **Sessioni con geometria danneggiata** (come octoally oggi): non c'è
  auto-fix sicuro (vedi anti-pattern #4). La via pulita è chiudere/riaprire la
  sessione (nasce a 140×40). Le sessioni nuove non hanno il problema.
- **Riconciliazione multi-client più furba**: valutare l'opzione tmux
  `window-size latest` come alternativa/aggiunta al modello viewer scalato.

## 8. Riferimenti

- ttyd — https://tsl0922.github.io/ttyd/ (condividere un terminale via web)
- sshx — https://sshx.io/ (terminali collaborativi, canvas multi-client; buon
  riferimento per l'idea, non sostituto)
- tmux multi-client window sizing (limite strutturale): vedi sezione 2.
