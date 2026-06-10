# Console multi-client con viste indipendenti — Design

Data: 2026-06-10
Stato: approvato (design), in attesa di piano di implementazione

## Problema

OctoAlly è multi-client: più browser/finestre (o l'app desktop) possono
puntare allo stesso server e osservare/usare le stesse sessioni. Oggi però
due client sullo stesso server **si rompono a vicenda** le viste. Due radici
distinte:

1. **Impostazioni di aspetto condivise.** `app_font_size` e
   `terminal_font_size` sono salvati nella tabella `settings` del DB
   (`server/src/routes/settings.ts` → `DEFAULTS`). Il client li legge da
   `api.settings` (`App.tsx:84`, `Terminal.tsx:75`) e li scrive da
   `SettingsModal.tsx:127-128`. Essendo nel DB, **cambiarli in un client li
   cambia in tutti**.

2. **Geometria del pty condivisa e ridimensionata dal layout locale.** Ogni
   sessione ha **un** pty con **una** dimensione (`cols × rows`). Il client usa
   `FitAddon` per adattare il terminale alla card e invia un `resize`
   (`Terminal.tsx`). Il server accetta il `resize` da **qualunque** connessione
   (`server/src/routes/terminal.ts:82-83,166-168` →
   `resizeSession`). Quando un client cambia layout (colonne griglia,
   fullscreen, font del terminale), il re-fit ridimensiona il pty **per tutti**
   → l'altro client riceve il resize e va in reflow/garbage. È il "bug
   bruttissimo" osservato: cambiando le colonne in un browser, la console
   dell'altro client si è corrotta.

### Vincolo tecnico fondamentale

Una TUI interattiva (Claude, Codex, vim) disegna l'output per **una sola**
geometria: manda a capo, posiziona box e cursore in base alle `cols × rows`
comunicate, e ridisegna a ogni cambio dimensione. Non è possibile avere reflow
**indipendenti** della stessa sessione a dimensioni diverse: ci sarebbe una
sola istanza che disegna su "un foglio". Analogia: un terminale TUI è un **PDF
impaginato** (zoomabile ma non re-impaginabile), non un documento Word
riflowabile.

Conseguenza: lo **stile** (font, tema, zoom, scala, layout) può essere
per-client; la **geometria** del pty è necessariamente una sola.

## Obiettivo

Permettere più client sullo stesso server/sessione con **viste indipendenti**:
font, zoom, colonne della griglia, progetto/vista navigato — ciascuno per
client — **senza** che le impostazioni di un client tocchino gli altri né
rompano i terminali condivisi.

Scenario di riferimento dell'utente: un client a 3 colonne / font 120%, un
altro a font 100%, uno su un progetto e l'altro su un altro — contemporanei,
senza rompersi.

## Non-goals

- Reflow per-client indipendente della stessa sessione (impossibile per le TUI).
- Geometria per-sessione **persistita** come attributo configurabile (l'override
  è transitorio, a richiesta — vedi Parte 2). Si potrà aggiungere in seguito.
- Autenticazione / restrizioni d'accesso (fuori ambito).

## Design

### Parte 1 — Impostazioni di visualizzazione per-client

Spostare le impostazioni di **aspetto** da DB-condiviso a `localStorage`
(per-browser).

- `app_font_size` → `localStorage` (es. chiave `octoally-app-font-size`).
- `terminal_font_size` → `localStorage` (es. `octoally-terminal-font-size`).
- Già per-client e da lasciare invariate: colonne/righe griglia
  (`octoally-active-terminals-cols`/`-rows`), sessioni minimizzate, navigazione
  progetto/vista (stato React locale).
- **Migrazione soft**: alla prima lettura, se manca il valore locale, usare il
  valore presente nel DB come seed iniziale, poi vivere in `localStorage`.
- File toccati: `dashboard/src/App.tsx`, `dashboard/src/components/Terminal.tsx`,
  `dashboard/src/components/SettingsModal.tsx`. Il `SettingsModal` scrive in
  `localStorage` invece che via `api.settings.update`.
- Lato server: `app_font_size`/`terminal_font_size` restano nei `DEFAULTS` per
  retrocompatibilità (seed di migrazione) ma non sono più la fonte di verità per
  il client. Nessuna rimozione necessaria in questa fase.

Risultato: l'aspetto è isolato per client. Niente più propagazione del font.

### Parte 2 — Geometria del pty: server-owned, default + controller a richiesta

La geometria appartiene alla **sessione** (server), non a un client. Nessun
client-master automatico.

#### Stato della sessione (server, `session-manager`)

Aggiungere allo stato di sessione attivo:
- `defaultGeometry: { cols, rows }` — dimensione "a riposo" (es. `140 × 40`).
- `geometry: { cols, rows }` — dimensione corrente del pty.
- `controller: WebSocket | null` — il client che attualmente possiede la
  geometria (override a richiesta).

#### Regole

- **A riposo** (`controller === null`): `geometry = defaultGeometry`. Tutti i
  client sono **viewer**: renderizzano alla `geometry` e scalano via CSS. Nessun
  client manda `resize`.
- **Override on-demand**: un client invia `claim-control` con le `cols/rows`
  della propria finestra → il server imposta `controller = ws`, ridimensiona il
  pty a quelle dimensioni e fa **broadcast `geometry-changed { cols, rows }`** a
  tutti i subscriber → gli altri client si riscalano. Il client controller ha il
  reflow su misura.
- **Rilascio**: il client invia `release-control` (o la sua WS si chiude) → il
  server imposta `controller = null`, riporta `geometry = defaultGeometry`,
  applica un singolo `resize` pulito al default e fa broadcast `geometry-changed`.
- **Autorità del server**: un messaggio `resize` proveniente da una connessione
  che **non** è il `controller` viene **ignorato**. Questo chiude il buco che
  causava i conflitti.

#### Client (`Terminal.tsx`, `ActiveTerminals.tsx`)

- xterm viene creato/aggiornato alla `geometry` ricevuta dal server (il
  replay/serialize via `@xterm/addon-serialize` è già prodotto a quella
  dimensione → wrapping sempre corretto).
- Il terminale **non** invia più `resize` derivato dal `FitAddon` in modalità
  viewer. La card viene riempita con `transform: scale()` calcolato da
  dimensione card + font/zoom locali.
- Controllo UI su ogni terminale: **"adatta alla mia finestra"** (invia
  `claim-control`) e **"rilascia"** (invia `release-control`). Stato di default:
  viewer scalato.
- Alla ricezione di `geometry-changed`, il client riadatta xterm alla nuova
  geometria e ricalcola la scala.

#### Protocollo WebSocket (`server/src/routes/terminal.ts`)

Messaggi client → server aggiunti: `claim-control { cols, rows }`,
`release-control`. Messaggio server → client aggiunto: `geometry-changed
{ cols, rows }`. Il `resize` esistente resta, ma è onorato solo dal controller.

### Edge cases

- **Codex** non ridisegna su SIGWINCH → usare il `refresh`/capture esistente
  (`sendReplay(sessionId, ws, true)`) dopo un cambio di geometria.
- **Claim quasi simultaneo** da due client → l'ultimo vince (il server
  serializza i messaggi sulla sessione); il client precedente riceve
  `geometry-changed` e torna viewer.
- **Controller che muore senza release** → gestito dal `ws.on('close')`: stesso
  percorso del rilascio (torna al default).
- **Direct mode (no tmux/dtach)**: l'attuale sistema gira in direct mode; le
  regole sopra non dipendono da tmux. I commenti nel codice che citano tmux
  vanno riconciliati ma il comportamento si basa sul pty diretto.

## Architettura e flusso dati

1. Sessione spawnata → pty creato a `defaultGeometry`. Stato `controller = null`.
2. Client si connette (`/api/terminal/:id`) → subscribe + replay alla
   `geometry` corrente → renderizza scalato (viewer).
3. Client preme "adatta alla mia finestra" → `claim-control` → server resize +
   `geometry-changed` broadcast → tutti i client riadattano.
4. Client rilascia o si disconnette → server torna a `defaultGeometry` +
   `geometry-changed` broadcast.
5. Impostazioni di aspetto (font, colonne, progetto) restano interamente locali
   al client e non transitano mai dal server.

## Testing

- **Esclusivamente in ambiente isolato**: server dev (porta dedicata) + DB dev
  separato + **sessioni di TEST**. Mai sui terminali di lavoro reali.
- Casi:
  - Due browser sulla stessa sessione di test: cambiare font/colonne in uno **non**
    altera l'altro (Parte 1).
  - Cambiare font del terminale in un viewer non invia `resize` e non corrompe
    l'altro client (Parte 2).
  - `claim-control` in un client → l'altro riceve `geometry-changed` e scala;
    `release-control` → torna a `defaultGeometry`.
  - Chiusura del controller senza release → ritorno pulito al default.
  - Sessione Codex: refresh corretto dopo cambio geometria.

## File coinvolti (sintesi)

- `dashboard/src/App.tsx` — leggere `app_font_size` da localStorage.
- `dashboard/src/components/Terminal.tsx` — font da localStorage; viewer scaling
  via CSS; claim/release; gestione `geometry-changed`; stop al resize automatico
  in modalità viewer.
- `dashboard/src/components/ActiveTerminals.tsx` — controlli claim/release;
  scala per card.
- `dashboard/src/components/SettingsModal.tsx` — scrivere i font in localStorage.
- `server/src/routes/terminal.ts` — protocollo claim/release; resize solo dal
  controller; broadcast `geometry-changed`.
- `server/src/services/session-manager.ts` — stato `defaultGeometry`/`geometry`/
  `controller`; spawn a default; gestione close del controller.
