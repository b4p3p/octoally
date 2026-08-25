# ANALISI 2026-08-25 — gli agent di default costano contesto globale

Stato: **fatto** (2026-08-25). Il fix è implementato e verificato; le
sezioni sotto restano come analisi del problema. Cosa è stato fatto davvero,
e le due deviazioni dal piano, sono in fondo: «Come è stato implementato».

---

## Il problema

OctoAlly installa 36 definizioni di agent in `~/.claude/agents/`, che è una
cartella **globale**, non di progetto. Claude Code inietta nome, descrizione
e lista tool di ogni agent che trova lì nel prompt di **ogni sessione su
quella macchina** — comprese tutte le sessioni che con OctoAlly non
c'entrano niente.

Misurato il 2026-08-25 sui 36 file installati:

```
frontmatter totale: 21.556 caratteri  ≈ 5.400 token per sessione, sempre
corpo completo:    259.772 caratteri  (caricato solo se l'agent parte davvero)
```

Sono ~5.400 token pagati a ogni sessione, su ogni progetto, anche da chi il
bottone "Launch Agent" non lo apre mai. Per un utente che non usa la feature
il ritorno è esattamente zero.

Il costo non è visibile da nessun comando diagnostico: `claude plugin list`
non mostra gli agent, e nessun `/doctor` segnala la cartella. Si scopre solo
guardando `~/.claude/agents/` a mano, il che rende il problema difficile da
attribuire a OctoAlly quando lo si incontra.

## Perché è un difetto e non una scelta

Il principio violato è quello che vale per le skill globali: **una feature
che si usa da un punto solo non deve costare a tutti i punti**. Gli agent
servono al picker della dashboard; il prezzo lo paga ogni sessione di Claude
Code sulla macchina, dashboard o no.

Da notare: le definizioni sono ferme al commit che le ha introdotte
(`57e10cf`, 2026-04-08) e non sono più state riviste. Dichiarano tool MCP
(`mcp__magic__*`, `mcp__sequential-thinking__*`, `mcp__playwright__*`) che su
una macchina qualunque non esistono, e hanno il modello inchiodato nel
frontmatter (31 `sonnet`, 5 `haiku`). Quindi il contesto speso è anche in
buona parte sbagliato, non solo inutile.

## Com'è fatto adesso

Installazione — `server/src/data/default-agents.ts`:

- `AGENTS_DIR` = `~/.claude/agents`
- `MARKER_FILE` = `~/.claude/agents/.octoally-installed`
- `getBundledAgents()` legge i `.md` da `dist/data/agents/` (o
  `src/data/agents/` in dev). I 36 file sono versionati in
  `server/src/data/agents/`.
- `installDefaultAgents(force = false)`:
  - esce subito se `!force && existsSync(MARKER_FILE)`
  - non sovrascrive un file esistente (`if (existsSync(dest))
    skipped.push(...)`)

Chiamata da tre punti:

| Punto | Quando | force |
|---|---|---|
| `index.ts` (~riga 101) | avvio del server | no |
| `routes/projects.ts` (~riga 698) | aggiunta di un progetto | no |
| `routes/projects.ts` (~riga 874) | pulizia `ruflo` | **sì** |

## Attenzione: i consumatori sono tre, non uno

È il punto in cui un fix ingenuo rompe qualcosa. `~/.claude/agents/<name>.md`
viene letto da tre percorsi distinti, tutti in
`server/src/services/pty-worker.ts` → `buildAgentCommand()`:

1. **Claude, modo normale** — `claude --agent '<name>'`. È il CLI a
   risolvere il nome dalla cartella. Non passa dal nostro codice.
2. **Codex** — `buildCodexAgentPrompt()`. Codex non ha `--agent`, quindi
   OctoAlly **legge il `.md` e ne costruisce un prompt persona**.
3. **Claude in modo `inheritMcp`** — salta `--agent` per tenere l'MCP
   completo dell'utente, e riusa `buildCodexAgentPrompt()`. Quindi legge
   anche lui il file.

La ricerca del file è in `findAgentMdPath()` (~riga 331), in quest'ordine:

```
<projectPath>/.claude/agents/<name>.md
~/.claude/agents/<name>.md
```

Togliere l'installazione globale senza toccare (2) e (3) li manda in
fallback silenzioso: `buildCodexAgentPrompt()` non fallisce, restituisce il
generico `"You are a ${agentType} agent."` e la persona sparisce senza
errori.

## Il fix proposto

Gli agent restano nel bundle, dove già sono. Nessuno scrive più in
`~/.claude/agents/`. Al lancio si passa **solo l'agent richiesto**.

Claude Code accetta le definizioni inline:

```
--agents <json>   JSON object defining custom agents
                  (es. '{"reviewer": {"description": "...", "prompt": "..."}}')
```

In pratica:

- **`findAgentMdPath()`**: aggiungere il bundle come sorgente, mantenendo la
  precedenza a progetto e home (chi ha personalizzato un agent non deve
  perderlo):

  ```
  <projectPath>/.claude/agents/<name>.md     ← invariato, vince
  ~/.claude/agents/<name>.md                 ← invariato, retrocompatibilità
  <bundle>/data/agents/<name>.md             ← nuovo fallback
  ```

  Con questo, i percorsi Codex e `inheritMcp` continuano a funzionare senza
  altre modifiche: leggono dal bundle quando la cartella globale è vuota.

- **`buildAgentCommand()`, ramo Claude normale**: sostituire
  `--agent '<name>'` con `--agents '<json>'` costruito dal `.md` risolto,
  più `--agent '<name>'` per selezionarlo. Serve convertire il frontmatter
  YAML nella forma che `--agents` si aspetta (almeno `description` e
  `prompt`; verificare come mappare `tools` e `model`, e cosa succede se si
  omettono). Attenzione al quoting: il comando passa già per `bash -c` con
  escape manuale degli apici, e un JSON inline è molto più fragile di un
  nome — valutare se passarlo via file temporaneo o variabile d'ambiente
  invece che sulla riga di comando.

- **Rimuovere `installDefaultAgents()`** e le sue tre chiamate. Il marker
  `.octoally-installed` diventa inutile.

- **Migrazione** per chi ha già i 36 file installati: non basta smettere di
  installarli, restano lì a costare. Serve una pulizia esplicita — un'azione
  nella dashboard, o un passo nel `ruflo` cleanup che già esiste — che
  cancelli i `.md` **corrispondenti al bundle e non modificati** (confronto
  byte a byte), lasciando stare quelli che l'utente ha personalizzato o
  aggiunto lui.

## Verifica

Dopo il fix:

1. `ls ~/.claude/agents/` vuota su un'installazione pulita, e nessun file
   ricreato dopo un riavvio del server o l'aggiunta di un progetto.
2. Lancio di un agent Claude dalla dashboard: la persona è quella giusta
   (non il generico "You are a X agent").
3. Lancio dello stesso agent con **Codex**: idem — è il percorso che si
   rompe per primo e in silenzio.
4. Lancio con **inherit-MCP** attivo: idem.
5. Un agent personalizzato in `<progetto>/.claude/agents/<name>.md` continua
   a vincere sul bundle.
6. In una sessione Claude Code qualunque, `/context` non mostra più i 36
   agent.

## Nota sullo stato della macchina di sviluppo (2026-08-25)

Su questa postazione i 36 `.md` sono stati **cancellati a mano** da
`~/.claude/agents/`, lasciando il marker `.octoally-installed`. Con il codice
attuale questo è stabile: la guardia sul marker impedisce la reinstallazione
all'avvio del server e all'aggiunta di un progetto. L'unico percorso che li
rimette è la pulizia `ruflo` (`force = true`), che è un'azione esplicita.

Quindi se durante il lavoro la cartella risulta vuota, **non è un bug**: è
questo. Per ripristinarli, il bundle è intatto in `server/src/data/agents/`
(36 file, versionati).

> Non vale più: la nota descriveva lo stato *prima* del fix. Il marker è
> stato consumato dalla verifica della migrazione, e `~/.claude/agents/` su
> questa macchina ora è vuota davvero, senza marker.

---

## Come è stato implementato

`server/src/data/default-agents.ts` → `bundled-agents.ts`. Non scrive più
niente in `~/.claude/agents/`: espone il bundle in lettura
(`getBundledAgents`, `findBundledAgentPath`, `findAgentMdIn`) e la migrazione
`cleanupInstalledAgents()`, che cancella dalla cartella globale solo i file
**identici byte a byte** al bundle e solo se c'è il marker
`.octoally-installed` (la prova che ce li abbiamo messi noi). Quello che
l'utente ha modificato o aggiunto resta. Gira all'avvio del server e nella
pulizia `ruflo`, al posto delle vecchie installazioni; il marker viene
rimosso, quindi è one-shot.

In `pty-worker.ts` la ricerca è ora `resolveAgentMd()`, che restituisce anche
la **provenienza** (progetto / home / bundle), nell'ordine di precedenza
previsto. Il ramo Claude normale usa la provenienza per decidere:

- agent del **bundle** → `--agents '<json>' --agent '<name>'`, con il JSON
  costruito dal `.md` (`description`, `prompt` = corpo del file, più `tools`
  e `model` se dichiarati);
- agent dell'**utente** (progetto o home) → si continua a passare solo
  `--agent '<name>'` e a lasciar risolvere il CLI. Così lo YAML di un file
  scritto a mano non passa dal nostro parser semplificato e non viene
  degradato.

Sul `model`: si mappa tal quale, perché `--model` della dashboard vince
comunque sul campo dell'agent (verificato: `--model sonnet` con
`model: haiku` nel JSON esegue sonnet). Comportamento identico a prima.

Il quoting non è stato un problema: il comando arriva al PTY come `argv` di
`shell -i -c`, e il JSON è una riga sola con gli apici singoli già escapati
dal codice esistente. L'agent più grosso produce ~11 KB di riga di comando,
molto sotto il limite. Niente file temporaneo, niente variabile d'ambiente.

### Due cose che il piano non prevedeva

1. **Il picker sarebbe rimasto vuoto.** La rotta
   `GET /projects/:id/ruflo-agents` (`routes/projects.ts`) elencava gli agent
   leggendo *solo* `~/.claude/agents/` e `<progetto>/.claude/agents/`.
   Smettere di installare senza toccarla avrebbe svuotato la lista di
   "Launch Agent". Ora la rotta aggiunge il bundle come terza sorgente
   (categoria `bundled`). Nell'occasione è stato corretto anche l'ordine di
   scansione: il dedup tiene il **primo** match, ma si scandiva prima
   `global` e poi `project`, quindi il globale vinceva sul locale — il
   contrario di quanto dichiarava il commento. Ora: progetto, home, bundle.

2. **Il nome dell'agent non è il nome del file.** Quattro file dichiarano nel
   frontmatter un `name` diverso dal filename (`code-reviewer.md` →
   `code-reviewer-pro`, `architect-review.md` → `architect-reviewer`,
   `electorn-pro.md` → `electron-pro`, `postgres-pro.md` →
   `postgresql-pglite-pro`). Il picker passa il `name`, ma
   `findAgentMdPath()` cercava `<name>.md`: per questi quattro non trovava
   niente e Codex/inherit-MCP cadevano in silenzio sul generico "You are a X
   agent" — un bug che c'era già prima. La risoluzione ora prova il filename
   e poi scansiona la cartella confrontando il `name` del frontmatter, come
   fa Claude Code.

### Verifica eseguita

Tutto in `dev:isolated` (:42020), lanciando le sessioni davvero e leggendo
l'`argv` che arriva al CLI (CLI finto che scrive i suoi argomenti su file),
con `~/.claude/agents/` vuota:

1. Claude, agent del bundle → `--agents` con JSON valido (chiave
   `code-reviewer-pro`, prompt 10.151 byte, 11 tool, model haiku) + `--agent`.
   Provato anche dal vivo con `claude --print`: la persona è quella giusta.
2. Claude, agent sovrascritto nel progetto → solo `--agent python-pro`,
   nessun `--agents`.
3. Codex, agent del bundle → persona `code-reviewer-pro` completa (uno dei
   quattro con nome diverso dal file: prima non funzionava).
4. Codex, agent del progetto → persona del file di progetto.
5. Inherit-MCP, agent del bundle → persona `electron-pro` completa.
6. Migrazione: ricostruita la situazione pre-fix (36 file installati, uno
   modificato a mano, uno estraneo aggiunto) → rimossi 35, tenuti
   `python-pro.md` (modificato) e `my-own.md` (dell'utente), marker
   cancellato, seconda esecuzione no-op.
7. Avvio del server e aggiunta di un progetto non ricreano nessun file in
   `~/.claude/agents/`.
8. Picker: 37 agent (35 `bundled` + 1 `global` + 1 `project`), con
   `python-pro` preso dalla versione di progetto.
9. `tsc --noEmit` pulito e `npm run build` ok: `dist/data/agents/` contiene i
   36 `.md` e la risoluzione dal bundle funziona anche dal `dist`.
