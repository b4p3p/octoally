#!/usr/bin/env bash
#
# Scan for committed secrets / credentials — OctoAlly is a public repo.
# Used by the pre-commit hook (.githooks/pre-commit) and CI
# (.github/workflows/secret-scan.yml).
#
#   scripts/secret-scan.sh staged   # scan staged changes (default; pre-commit)
#   scripts/secret-scan.sh tree      # scan all currently tracked files
#
# Prefers `gitleaks` when installed (comprehensive ruleset); otherwise falls
# back to a dependency-free regex scan covering common credential formats.
# Exits non-zero if a potential secret is found.

set -uo pipefail

MODE="${1:-staged}"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 0

# --- Prefer gitleaks (best ruleset, fewest false positives) ---------------
if command -v gitleaks >/dev/null 2>&1; then
  if [ "$MODE" = "tree" ]; then
    gitleaks detect --no-banner --redact -v
  else
    gitleaks protect --staged --no-banner --redact -v
  fi
  exit $?
fi

# --- Dependency-free fallback: high-confidence regex patterns -------------
PATTERNS=(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'         # RSA/EC/OpenSSH/PGP private keys
  'AKIA[0-9A-Z]{16}'                            # AWS access key id
  'ASIA[0-9A-Z]{16}'                            # AWS temporary access key id
  'sk-ant-[A-Za-z0-9_-]{20,}'                   # Anthropic API key
  'sk-(proj-)?[A-Za-z0-9]{20,}'                 # OpenAI API key
  'gh[pousr]_[0-9A-Za-z]{36,}'                  # GitHub token
  'github_pat_[0-9A-Za-z_]{40,}'               # GitHub fine-grained PAT
  'glpat-[0-9A-Za-z_-]{20}'                     # GitLab PAT
  'AIza[0-9A-Za-z_-]{35}'                       # Google API key
  'xox[baprs]-[0-9A-Za-z-]{10,}'                # Slack token
)

# Files that legitimately contain pattern-like strings or are noise.
EXCLUDE_RE='(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|^docs/screenshots/|scripts/secret-scan\.sh$'

FOUND=0

# Block committing a real .env file (templates .env.example/.sample/.template are fine).
if [ "$MODE" = "staged" ]; then
  ENV_FILES="$(git diff --cached --name-only --diff-filter=AM 2>/dev/null \
    | grep -E '(^|/)\.env($|\.)' | grep -vE '\.(example|sample|template)$' || true)"
  if [ -n "$ENV_FILES" ]; then
    echo "✗ Refusing to commit a real .env file:"
    echo "$ENV_FILES" | sed 's/^/    /'
    echo "  Keep real secrets out of git; commit a .env.example template instead."
    FOUND=1
  fi
fi

if [ "$MODE" = "tree" ]; then
  FILES="$(git ls-files)"
  getcontent() { cat "$1" 2>/dev/null; }
else
  FILES="$(git diff --cached --name-only --diff-filter=AM 2>/dev/null)"
  getcontent() { git show ":$1" 2>/dev/null; }
fi

while IFS= read -r f; do
  [ -z "$f" ] && continue
  printf '%s\n' "$f" | grep -qE "$EXCLUDE_RE" && continue
  content="$(getcontent "$f")" || continue
  [ -z "$content" ] && continue
  for p in "${PATTERNS[@]}"; do
    if printf '%s' "$content" | grep -qIE -e "$p"; then
      echo "✗ Possible secret in: $f"
      FOUND=1
    fi
  done
done <<< "$FILES"

if [ "$FOUND" -ne 0 ]; then
  echo
  echo "Commit blocked: a potential secret/credential was detected."
  echo "Review with:  git diff --cached"
  echo "False positive? Bypass intentionally with:  git commit --no-verify"
  exit 1
fi

echo "secret-scan: clean (no secrets detected)."
exit 0
