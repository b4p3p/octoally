# ANALISI 2026-09-04: lag del terminale e rendering rotto su KDE Wayland

Data: 2026-09-04
Stato: **parzialmente risolto**. Il rendering rotto e Alt+Invio sono risolti
e il fix e' scritto (non ancora rilasciato). Il lag residuo della digitazione e'
circoscritto ma **non ancora spiegato**: manca la scomposizione della catena
lato server.
Scopo: documento analizzabile da un'altra sessione. Contiene i numeri misurati,
le ipotesi gia' escluse (da non rifare) e gli errori operativi da non ripetere.

## 1. Sintomi riportati

Su questa macchina, e solo su questa, l'utente riferisce che la console di
OctoAlly e' inutilizzabile:

- premendo spazio il cursore non si muove, idem backspace;
- Alt+Invio non funziona: il primo non fa niente, il secondo crea due righe;
- premendo Alt compare il puntatore a croce;
- testo sfocato e righe sovrapposte, "console completamente rotta";
- la stessa versione (1.1.5) gira bene su due PC con Linux Mint.

Precisazione emersa a fine indagine: il lag si sente **solo nel terminale**.
Il resto dell'interfaccia (per esempio la modal Task/Objective) e' fluido.

## 2. Ambiente

Macchina con il difetto:

| voce | valore |
|---|---|
| OS | Ubuntu 26.04.1, kernel 7.0.0-31 |
| desktop | KDE Plasma su **Wayland**, `kwinrc: Scale=1.75` |
| GPU | RTX 5090 (driver 595.84) + Radeon integrata (Granite Ridge) |
| monitor | 3 schermi, tutti su NVIDIA; DP-3 3840x2160 **@160 Hz**, VRR mai |
| tmux | **3.6** |
| node | v22.23.2 |
| app | OctoAlly 1.1.5, Electron 41.1.1 (Chromium 146) |

Macchine di confronto: due PC Linux Mint, stessa versione di OctoAlly, nessun
difetto. **Da rilevare**: `tmux -V` su quei PC (vedi sezione 7).

## 3. Causa accertata numero 1: XWayland con scaling frazionario

L'app girava dentro **XWayland** su un desktop scalato a 1.75. In quella
condizione il compositore riceve una finestra disegnata a scala intera e la
stira: il testo si sfoca e, cosa piu' grave, ogni cella di xterm.js cade su
pixel non interi, quindi la griglia del terminale smette di essere esatta e i
glifi si sovrappongono alla riga sopra.

Prova osservata, non dedotta: per un errore operativo si sono trovate aperte
contemporaneamente due finestre della stessa app sullo stesso schermo, una su
Wayland nativo e una su XWayland. Solo la seconda aveva il difetto.

**Fix applicato** in `desktop-electron/src/main.ts` (subito dopo
`const cliPath = resolveCliPath()`):

```ts
if (process.platform === 'linux') {
  app.commandLine.appendSwitch(
    'ozone-platform-hint',
    process.env.OCTOALLY_OZONE || 'auto',
  );
}
```

`auto` sceglie Wayland solo se la sessione e' Wayland, quindi e' un no-op su
X11, macOS e Windows. `OCTOALLY_OZONE=x11` riporta al comportamento vecchio.

Effetto verificato: `devicePixelRatio` passa da scala stirata a **1.75 reale**,
il processo mappa `libwayland-egl` e i buffer `wayland-cursor`, e l'utente
conferma che nitidezza e leggibilita' migliorano nettamente.

Stato: il codice e' modificato e compila (`npm run build` in `desktop-electron`,
lo switch e' nel bundle). Il typecheck riporta tre errori **preesistenti** e non
correlati (`main.ts` `setBackgroundColor`, due `string | null` in
`speech/index.ts`). Il binario installato in `/opt/OctoAlly` e' del 25 agosto e
**non contiene ancora il fix**: finche' non si ricostruisce il pacchetto,
avviando dall'icona si torna su XWayland e i difetti tornano.

## 4. Causa accertata numero 2: Alt+Invio era XWayland

Su Wayland nativo il difetto non si riproduce piu'. Misurato due volte:

- con eventi iniettati via CDP: tre Alt+Invio consecutivi producono tre righe
  (`q`, `w`, `e`), **il primo compreso**;
- con i tasti fisici dell'utente: eventi `a`, `Alt`, `Enter+ALT`, `b`, `Alt`,
  `Enter+ALT`, `c`, byte inviati `[97] [27,13] [98] [27,13] [99]`, risultato tre
  righe `a` / `b` / `c`.

xterm.js manda sempre `ESC CR` (`[27,13]`), identico a ogni pressione. Su
XWayland il primo Alt veniva perso nel passaggio per il compositore.

Il puntatore a croce **non e' un difetto**: xterm.js attiva la classe
`column-select` quando Alt e' premuto, per la selezione rettangolare. Succede
anche su Mint.

## 5. Il lag residuo: cosa e' stato misurato

Tutte le misure sono state prese via CDP (`--remote-debugging-port=9222`) sul
renderer reale, con l'utente che digitava davvero.

| misura | risultato |
|---|---|
| consegna dell'evento dal sistema a Chromium | mediana **0,4 ms**, max 2,6 |
| giro completo tasto -> ridisegno | mediana **23,9 ms**, p90 38,3, max 189,7 |
| intervallo fra i frame | mediana **6,2 ms**, max 6,4, zero sopra 50 ms |
| long task nel periodo di osservazione | **zero** |
| buchi fra i frame | **zero** |
| CPU profile del renderer (2,6 s, 10 spazi) | **idle 99,6%**, ~7 ms di JS |
| `Performance.getMetrics` (3,3 s, 15 spazi) | script 3,2 ms, **layout 3 ms**, style 1,7 ms, task totale 17,7 ms, **0,5% CPU** |
| byte prodotti sul PTY per tasto | lettera **36-44**, spazio/backspace **1058-1980**, burst fino a 17 KB |

Lettura: il client non e' il collo di bottiglia. I 24 ms sono quasi tutti nella
catena fra il tasto e il ritorno dell'output, cioe' fuori dal browser.

Perche' la modal e' fluida e il terminale no: nella modal il carattere lo scrive
il browser in locale, costo zero. Il terminale non ha eco locale, ogni carattere
deve fare il giro completo prima di comparire. In Konsole quel giro non esiste:
il processo e' attaccato al PTY.

L'utente ha verificato che **Claude Code dentro Konsole e' fluido**, quindi
l'overhead e' nella catena di OctoAlly e non in Claude Code ne' nella macchina.

Catena di output completa, da accorciare o da giustificare:

```
Claude Code -> tmux -> pipe-pane -> `cat > /tmp/octoally-pipes/<id>.fifo`
  -> pty-worker legge la fifo -> IPC al processo server -> WebSocket -> client
  -> batching su requestAnimationFrame -> xterm.js -> DOM
```

## 6. Ipotesi gia' escluse (non rifarle)

1. **Renderer DOM di xterm.js**: escluso da due misure indipendenti (CPU
   profile e contatori layout/style). Il commento in `Terminal.tsx:252` che
   motiva la scelta del renderer DOM resta valido e non va toccato per motivi
   di prestazioni.
2. **Consegna dell'input dal sistema**: 0,4 ms di mediana.
3. **Presentazione dei frame irregolare**: 6,2 ms costanti, coerenti con il
   monitor a 160 Hz.
4. **Copia fra GPU diverse**: tutti e tre i monitor sono su `card1` (NVIDIA) e
   Chromium rende su `renderD128` (NVIDIA). Nessun percorso cross-GPU.
5. **Filtro dell'input lato server**: `TERMINAL_RESPONSE_RE`
   (`pty-worker.ts:539`) richiede sempre `ESC [`, quindi non tocca `ESC CR`.
   `handleInput` scrive il payload con una sola `write`.
6. **Throttle o debounce nel server**: non esistono sul percorso dell'output
   (verificato leggendo `pty-worker.ts`).
7. **Conflitto multi-client su tmux**: un solo client attaccato, geometria
   coerente col pane.
8. **Il SIGSEGV di `octoally-desktop`**: non e' un crash da uso. Vedi sezione 8.
9. **Vulkan / `libvulkan_nouveau`**: l'ICD di NVK e' presente su una macchina
   col driver proprietario (igiene di sistema, `nouveau_icd.json` andrebbe
   tolto), ma non ha parte in questo problema e Chromium su Linux non usa
   Vulkan di default.

## 7. Cosa resta aperto

1. **Scomporre i 24 ms** nei segmenti della catena della sezione 5. Va fatto in
   `dev:isolated` con timestamp ai passaggi: `onData` nel client, arrivo al
   server, write sul PTY, lettura dalla fifo, IPC, invio WebSocket,
   `term.write`. Non farlo sull'installazione viva.
2. **Differenza con i Mint**: l'ipotesi piu' promettente e' la **versione di
   tmux** (qui 3.6, recentissima; tutta la catena di output passa da
   `pipe-pane`). Primo passo, a costo zero: `tmux -V` sui due Mint. Se sono
   3.2/3.4, installare qui la stessa versione in parallelo (socket separato) e
   confrontare.
3. **Verificare il costo dei due hop evitabili**: il processo `cat` sulla fifo e
   il passaggio IPC worker -> server.
4. Il batching su `requestAnimationFrame` nel client vale al massimo 6 ms a
   160 Hz: e' l'ultimo posto dove guardare, non il primo.

Nota sul contrasto percepito: questo schermo e' a 160 Hz, dove il resto del
sistema risponde in 6 ms. Gli stessi 24 ms su un pannello a 60 Hz si notano
meno. Non spiega tutto, ma va tenuto presente confrontando le macchine.

## 8. Errori operativi commessi durante l'indagine

Elencati perche' hanno prodotto sintomi che sembravano il difetto in esame.

1. **`tmux pipe-pane` su un pane gestito da OctoAlly**: OctoAlly instrada
   l'output del pane in una fifo proprio con `pipe-pane` (`pty-worker.ts:250`,
   `pipe-pane -O -t <name> "cat > <fifo>"`). Agganciare una misura con
   `pipe-pane` sostituisce quel pipe, e toglierla lo rimuove: **la sessione
   diventa muta nella UI**. Ripristinarlo a mano non basta, perche' il worker ha
   gia' chiuso il lettore e il `cat` resta in `wait_for_partner`. Lo ricrea solo
   il worker al successivo `attach-session`, cioe' chiudendo e riaprendo la
   sessione nella UI.
2. **`octoally-desktop --version` non stampa la versione**: apre una finestra.
3. **Lanciare l'app dalla shell di un pane OctoAlly non funziona**: il
   pty-worker avvia i pane con `env -u ...`, senza `WAYLAND_DISPLAY` ne' un
   `DISPLAY` utilizzabile. Chromium non inizializza nessuna piattaforma
   Ozone, stampa `Missing X server or $DISPLAY`, esce e produce un **general
   protection fault nel teardown**. Quel SIGSEGV era stato attribuito al
   passaggio a Wayland: non c'entra. Per avviarla serve passare l'ambiente
   della sessione grafica (`XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`,
   `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `XDG_SESSION_TYPE`,
   `XDG_CURRENT_DESKTOP`). Stessa causa per un `kscreen-doctor` abortito: da
   quella shell Qt chiama `qFatal`.

4. **`Page.reload` via CDP** smonta la vista del terminale nella dashboard: va
   riaperta a mano.
5. **`strace` sul pty-worker non e' utilizzabile**: `ptrace_scope=1` consente di
   tracciare solo i propri discendenti.
6. Il **CPU profile di V8 non vede layout, style e paint**: usarlo da solo per
   assolvere o condannare un renderer e' sbagliato. Servono i contatori di
   `Performance.getMetrics`, che qui hanno confermato l'assoluzione.

## 9. Come rifare le misure

Avviare la finestra con la porta di debug, con l'ambiente grafico esplicito:

```sh
env XDG_RUNTIME_DIR=/run/user/1000 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 \
    XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=KDE \
    /opt/OctoAlly/octoally-desktop --ozone-platform-hint=auto \
    --remote-debugging-port=9222
```

Poi, da Node 22 (che ha `WebSocket` nativo), connettersi al target elencato da
`http://localhost:9222/json` e valutare espressioni con `Runtime.evaluate`.

Sonda che misura, per ogni tasto reale, il ritardo di consegna dell'evento e il
tempo fino al ridisegno:

```js
window.__p = { keys: [], frames: [], pend: null };
const rows = document.querySelector('.xterm-rows');
const ta = document.querySelector('.xterm-helper-textarea');
ta.addEventListener('keydown', e => {
  const now = performance.now();
  window.__p.keys.push({ k: e.key, consegna: now - e.timeStamp, t: now, alt: e.altKey });
  window.__p.pend = now;
}, true);
new MutationObserver(() => {
  const p = window.__p.pend;
  if (p != null) { window.__p.keys.at(-1).render = performance.now() - p; window.__p.pend = null; }
}).observe(rows, { childList: true, subtree: true, characterData: true });
```

Hook che registra i byte realmente inviati al server (utile per Alt+Invio):

```js
const orig = WebSocket.prototype.send;
WebSocket.prototype.send = function (d) {
  if (typeof d === 'string' && d.includes('"type":"input"')) {
    const o = JSON.parse(d);
    (window.__sent = window.__sent || []).push([...o.data].map(c => c.charCodeAt(0)));
  }
  return orig.apply(this, arguments);
};
```

Contatori di layout e style attorno a un burst: `Performance.enable` e due
`Performance.getMetrics`, differenza su `LayoutDuration`, `RecalcStyleDuration`,
`ScriptDuration`, `TaskDuration`.

Attenzione: per tracciare i frame WebSocket con `Network.webSocketFrameSent` /
`Received` la connessione deve nascere **dopo** `Network.enable`, quindi serve
un reload, che pero' smonta la vista del terminale (vedi sezione 8).
