# ANALISI 2026-09-05: il lag dei 24 ms, misurato dalla macchina che funziona

Data: 2026-09-05
Segue: `ANALISI-2026-09-04-lag-terminale-wayland.md`, che chiudeva con due
domande aperte (scomporre i 24 ms, e capire la differenza con i Mint).
Stato: **causa trovata, fix implementato e misurato qui in A/B**. Non e' la
versione di tmux. Resta da validare la percezione a 160 Hz sulla macchina KDE.
Scopo: dare all'altra console (la macchina KDE Wayland) il confronto che da
li' non era possibile fare, piu' il punto esatto del codice da cambiare.

## 0. In due righe

I 24 ms non sono un difetto di quella macchina: sono un `setTimeout(..., 16)`
nel server, sul percorso dell'output verso il WebSocket, presente dal primo
commit e uguale su tutte le macchine. Il documento precedente lo aveva escluso
(sezione 6.6) **cercandolo nel file sbagliato**: sta in `session-manager.ts`,
non in `pty-worker.ts`. La macchina KDE lo *vede* e i Mint no perche' li' il
termine di paragone e' un pannello a 160 Hz e una Konsole che risponde in 6 ms.

## 1. Ambiente di questa macchina (quella senza il difetto)

Da confrontare con la tabella della sezione 2 del documento precedente.

| voce | qui (funziona) | li' (difetto) |
|---|---|---|
| OS | Linux Mint 22 Wilma, kernel 6.8.0-137 | Ubuntu 26.04.1, kernel 7.0.0-31 |
| desktop | **X11**, Cinnamon, nessuno scaling | KDE Wayland, `Scale=1.75` |
| **tmux** | **3.4** (3.4-1ubuntu0.1) | **3.6** |
| node | v22.21.1 | v22.23.2 |
| GPU | RTX 3060 | RTX 5090 (595.84) + Radeon integrata |
| monitor | 2560x1440 **@ 59,95 Hz** (+ due 1080p @ 60) | 3840x2160 **@ 160 Hz** |
| binario installato | `/opt/OctoAlly` del 31 luglio | `/opt/OctoAlly` del 25 agosto |

Il `tmux -V` chiesto dalla sezione 7.2 e' quindi **3.4**. L'ipotesi era
ragionevole, ma la sezione 3 qui sotto la smentisce con una misura.

## 2. Misure fatte qui, tutte headless

Nessuna GUI, nessun CDP: sono misure del solo trasporto lato server, quindi
riproducibili identiche sull'altra macchina e direttamente confrontabili.

### 2.1 La catena tmux + pipe-pane + fifo: 0,31 ms

`scripts/bench-tmux-chain.mjs` (nuovo, in questo commit) replica esattamente il
percorso di `pty-worker.ts`: un pty node-pty che tiene un `tmux attach-session`,
un pane che gira `cat` (cosi' l'unica "applicazione" nel giro e' l'eco della
line discipline), `pipe-pane -O` verso una fifo, un lettore sulla fifo. Usa un
socket tmux e una fifo propri: **non tocca nessuna sessione OctoAlly viva**
(l'errore operativo n. 1 del documento precedente).

```
tmux 3.4 / node v22.21.1 / 200 iterazioni
write(pty) -> tmux -> eco tty -> pipe-pane -> cat -> fifo   [ms]
  min 0,12   p50 0,31   p90 0,70   p99 0,88   max 1,97   persi 0
```

**Tutta** la catena che il documento precedente indicava come sospetta — tmux,
`pipe-pane`, il processo `cat`, la fifo — costa **0,31 ms**. E' l'1,3% dei 24 ms.
Anche se tmux 3.6 fosse tre volte piu' lento, parleremmo di 1 ms.

### 2.2 L'hop IPC worker -> server: 0,03-0,11 ms

Con i volumi reali per tasto riportati dal documento precedente (lettera ~40 B,
spazio ~1,5 KB, burst 17 KB), round-trip su due hop:

```
    40 byte : p50 0,027   p90 0,036
  1500 byte : p50 0,033   p90 0,044
 17000 byte : p50 0,108   p90 0,128
```

Risponde alla domanda aperta 7.3: i due hop "evitabili" (il `cat` sulla fifo e
l'IPC) **non valgono la pena di essere tolti**. Insieme stanno sotto il
mezzo millisecondo.

## 3. La causa: `session-manager.ts:711`

Il throttle sull'output esiste, ma non e' nel worker. E' nel processo server,
nel ramo `case 'output'` che riceve i messaggi IPC dal worker:

```ts
// server/src/services/session-manager.ts:696-714
if (!active.wsPendingData) {
  active.wsPendingData = msg.data;
  setTimeout(() => {
    const data = active.wsPendingData!;
    active.wsPendingData = null;
    for (const ws of active.subscribers) {
      ws.send(JSON.stringify({ type: 'output', sessionId, data }));
    }
  }, 16); // ~60fps — one WS message per frame
} else {
  active.wsPendingData += msg.data;
}
```

E' un **debounce trailing**: il primo chunk dopo un periodo di quiete non
parte subito, apre una finestra e aspetta 16 ms. Il caso peggiore e'
esattamente quello interattivo — si digita un tasto quando l'output e' fermo,
quindi `wsPendingData` e' vuoto, quindi **i 16 ms si pagano sempre per intero**.
Durante un burst continuo invece i chunk si accodano e il costo si ammortizza:
il throttle e' tarato sul caso che non fa male e penalizza quello che fa male.

La riga esiste dal commit iniziale (`288348b`, 12 marzo) e non e' mai stata
rivista. Il motivo nel commento e' vero e va conservato: mandare ogni chunk di
`pipe-pane` come messaggio WS separato affoga la coda eventi del browser.

## 4. Il bilancio dei 24 ms

Domanda aperta 7.1, chiusa. Mettendo insieme le misure di qui e quelle del
documento precedente, con la frequenza di quel monitor:

| segmento | ms | fonte |
|---|---|---|
| tasto -> `onData` -> WS -> server -> IPC -> write sul pty | ~0,5 | 2.2 + doc 6.5 |
| ridisegno di Claude Code | ~2-4 | non misurato, residuo |
| tmux -> pipe-pane -> `cat` -> fifo | 0,31 | 2.1 |
| IPC worker -> server | 0,05 | 2.2 |
| **`setTimeout(..., 16)` nel server** | **16,0** | 3 |
| WebSocket su localhost | ~0,5 | — |
| attesa del `requestAnimationFrame` nel client @160 Hz | 0-6,25, media 3,1 | doc 5 |
| `term.write` + layout DOM | ~3 | doc 5 (`LayoutDuration`) |
| **totale atteso** | **~23,5** | |

Mediana misurata li': **23,9 ms**. Il modello combacia entro mezzo
millisecondo, e i 16 ms sono **due terzi del totale**.

Combacia anche la coda: p90 38,3 ms. Se una pressione produce chunk sparsi nel
tempo (t=0, 5, 12, 20 ms), il debounce manda il primo gruppo a 16 e riapre una
finestra per il chunk delle 20, che parte a 36. Il glifo compare a ~36 ms.
Questo produce **jitter**, non solo ritardo: ed e' il jitter, non i 24 ms
costanti, che si percepisce come "console che non risponde".

## 5. Perche' si vede solo su quella macchina

Non perche' li' sia piu' lenta: e' piu' veloce. Il difetto e' nel termine di
paragone.

- **60 Hz qui**: un frame dura 16,7 ms. I 16 ms del server stanno dentro
  l'attesa del frame che comunque ci sarebbe. Tutto il resto del sistema
  risponde in 16,7 ms, il terminale in 24: **1,4x**, sotto la soglia.
- **160 Hz li'**: un frame dura 6,25 ms. Konsole mostra il carattere in un
  frame, e l'utente ha verificato che Claude Code in Konsole e' fluido. Il
  terminale OctoAlly ci mette 24 ms: **4x**, e su quattro frame di distanza,
  con un timer da 16 ms libero che batte contro un refresh da 6,25 ms.

Il timer e' un numero fisso ("~60fps") scritto quando le macchine erano a
60 Hz. Su un pannello a 160 Hz e' una scelta di taratura sbagliata, non un bug
di quella macchina.

Nota: questo spiega il **lag**. Non spiega i sintomi di rendering rotto, il
testo sfocato e Alt+Invio: quelli erano XWayland, sono gia' risolti dal fix
`ozone-platform-hint` (sezioni 3 e 4 del documento precedente) e aspettano solo
la ricostruzione del pacchetto.

## 6. Il fix, implementato

Non si puo' togliere il batching (il commento originale ha ragione: i chunk
di `pipe-pane` arrivano a centinaia al secondo e un messaggio WS per ciascuno
affoga la coda eventi del browser). Si sposta il bordo: **throttle leading**
invece di debounce trailing. Il primo chunk dopo la quiete parte subito; cio'
che arriva nella finestra di 16 ms si accoda e parte alla sua fine, che
riarma la finestra. Un burst continuo costa ancora un messaggio ogni 16 ms;
il tasto isolato non paga niente.

File toccati (non ancora committati):

- `server/src/services/output-batcher.ts` — nuovo, 45 righe:
  `createOutputBatcher(send, windowMs = 16)` con `push()` e `dispose()`.
- `server/src/services/output-batcher.test.ts` — nuovo, 6 test con
  `node --test` (primo chunk immediato; coalescenza nella finestra; chunk a
  finestra chiusa immediato; finestra vuota non manda niente; riarmo dopo il
  flush di coda; `dispose` scarta il pendente). Scritti prima del codice, visti
  fallire, poi verdi.
- `server/src/services/session-manager.ts` — il campo `wsPendingData`
  diventa `wsBatcher`; il `case 'output'` si riduce a
  `active.wsBatcher.push(msg.data)`; `dispose()` nei cinque punti in cui la
  sessione esce da `activeSessions` (exit, worker morto, kill, release,
  shutdown).
- `server/package.json` — script `test`; `server/tsconfig.json` — i test
  esclusi da `dist`.

`tsc` pulito, `npm run build` pulito, il test non finisce in `dist/`.

### 6.1 Misura A/B, stessa macchina, stessa sonda

Sonda headless sul server reale (`dev:isolated`, porta 42020 col codice nuovo,
42022 col codice vecchio ripristinato via `git stash`): un terminale plain
creato via REST, WebSocket attaccato, shell messa in silenzio
(`stty -echo; PS1=""`) e poi `stty echo`, cosi' ogni tasto produce
esattamente il suo eco. Sessanta tasti isolati (60 ms fra l'uno e l'altro),
cronometro dal `ws.send` dell'input al primo frame `output` ricevuto.

| codice | p50 | p90 | max | burst di 200 tasti |
|---|---|---|---|---|
| vecchio (debounce trailing 16 ms) | **17,05 ms** | 18,32 | 20,20 | 1 frame WS |
| nuovo (throttle leading) | **0,80 ms** | 1,13 | 2,77 | 2 frame WS |

Il numero vecchio e' il timer, a vista: 16 ms piu' un millimetro di trasporto.
Il burst conferma che la protezione dal flood e' rimasta (200 tasti, due
messaggi, non duecento).

Cosa questo **non** misura: la percezione a 160 Hz, il rAF del client, il
layout DOM. Sul KDE la sonda della sezione 9 del documento precedente dovrebbe
passare da mediana ~24 a ~8 ms (rAF media 3,1 + DOM ~3 + trasporto ~1) e da
p90 38 a ~12. Qui a 60 Hz non si sente: la validazione e' la'.

## 7. Procedura per l'altra console (macchina KDE)

Nell'ordine. Il fix non e' ancora committato: arriva con il prossimo commit
su `main`, quindi il primo passo e' un `git pull` dopo che e' stato fatto.

1. **Chiudere l'ipotesi tmux con una misura**, due minuti, nessuna GUI,
   nessuna sessione viva toccata:
   ```sh
   node scripts/bench-tmux-chain.mjs 200
   node scripts/bench-ipc-hop.mjs
   ```
   Atteso: p50 sotto 1 ms nel primo, sotto 0,2 ms nel secondo. Se e' cosi', la
   7.2 e la 7.3 del documento del 04/09 sono archiviate.

2. **Verificare il fix lato server, prima ancora della GUI**. Dal repo, con
   `npm run dev:isolated` acceso su :42020, girare la sonda A/B della sezione
   6.1 (sta in `scripts/` come `probe-ws-latency.mjs`):
   ```sh
   node scripts/probe-ws-latency.mjs
   ```
   Atteso: p50 sotto 2 ms. Se e' ancora ~17, il codice in esecuzione e' quello
   vecchio (build non rifatta, o server sbagliato).

3. **Ricostruire e installare il pacchetto**, che deve contenere **entrambi**
   i fix: `ozone-platform-hint` (gia' scritto il 04/09) e il throttle. Finche'
   il binario in `/opt/OctoAlly` resta quello del 25 agosto, dall'icona si
   torna su XWayland e nessuno dei due fix e' in esecuzione.
   Verifica dopo l'installazione: `devicePixelRatio` a 1,75 reale e il
   processo che mappa `libwayland-egl` (sezione 3 del documento del 04/09).

4. **Rimisurare con la sonda CDP** della sezione 9 del documento del 04/09,
   con l'utente che digita davvero: mediana attesa ~8 ms (da 23,9), p90 ~12
   (da 38,3). E poi la domanda che conta, che non e' un numero: si sente
   ancora il lag rispetto a Konsole?

5. Se il numero e' sceso ma il lag si sente ancora, il residuo e' nel client
   (rAF + DOM) e va misurato li' con `Performance.getMetrics`: non c'e' altro
   sul percorso server.

## 8. Cosa resta non provato

- **La percezione a 160 Hz.** Il fix e' misurato qui in A/B (17 -> 0,8 ms sul
  server), non provato sulla macchina dove il difetto si sente. Il numero
  finale lo da' la sonda CDP la'.
- **tmux 3.6 non l'ho misurato**: qui c'e' la 3.4. La previsione e'
  un'inferenza, va confermata con il punto 1 della sezione 7.
- **Il ridisegno di Claude Code (~2-4 ms)** e' un residuo per differenza, non
  cronometrato.
- Le misure di questa macchina sono su **X11 e senza scaling**.
