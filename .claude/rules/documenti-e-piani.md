# Documenti di design, spec e piani

Regola trasversale, valida su **tutti i progetti**: sta in `.claude/rules/` e non in
`~/.claude/CLAUDE.md` perché le regole di Claude devono stare in git, dentro il
repository, dove sono leggibili, versionate e revisionabili come il codice.

## Il documento non è il lavoro

Design, spec e piani di implementazione si scrivono **solo** quando il lavoro è
strutturato: una feature che tocca più file o più livelli dello stack, un refactor
ampio, una roadmap, una decisione architetturale da tramandare.

Per una modifica piccola e circoscritta — un campo, un permesso, un fix, poche
decine di righe — il documento è **burocrazia**: si presenta il design **in chat**,
si aspetta l'ok, si implementa.

## Vale anche contro le skill

Questo **prevale** sulle skill che il documento lo pretendono di default
(`brainstorming`, `writing-plans` e simili): quelle skill assumono un progetto
grosso, e la loro richiesta di produrre un file di spec **non** sopravvive a questa
regola. Resta valido il resto del metodo: capire prima, proporre alternative con i
loro compromessi, chiedere conferma prima di toccare il codice.

## Nel dubbio si chiede

Non si produce il documento "per sicurezza". Se serve, lo chiede l'utente — e
allora va scritto dove lo prevede il progetto (**qui**: `backend/docs/`, i piani in
`backend/docs/plans/`).

## Il resto del cerimoniale

Stessa logica: niente riassunti di ciò che si sta per fare, niente checklist di
processo esposte all'utente, niente ripetizione in prosa di un diff già mostrato.
