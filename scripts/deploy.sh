#!/usr/bin/env bash
# Operator-only deploy, never invoked by CI. No tracing: env contains secrets.
set -euo pipefail

fail() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

main() {
  local target="${1:-}" ref="${2:-origin/main}" root name port existing
  case "$target" in
    dev) port=3006 ;;
    prod) port=7006 ;;
    *) fail "Usage: bash scripts/deploy.sh <dev|prod> [git-ref]" ;;
  esac
  [[ $# -le 2 && "$ref" != -* ]] || fail "Invalid arguments"
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  name="${target}-events"
  [[ "$root" == "$HOME/$target/events" ]] || fail "Run only from ~/$target/events (standalone checkout)"
  cd "$root"
  for tool in git node pnpm pm2 curl; do
    command -v "$tool" >/dev/null || fail "Missing tool: $tool"
  done
  [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ]] || fail "Node 22+ required"
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "Tracked files must be clean"
  [[ -f .env.local ]] || fail "Missing .env.local; see docs/ENVIRONMENTS.md"

  # Never print pm2's full process list: it can contain credentials.
  # Fail closed on invalid output, rather than silently overlooking a stale cwd.
  existing="$(pm2 jlist | node -e '
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const processes = JSON.parse(input);
        const matches = processes.filter(p => p.name === process.argv[1]);
        if (matches.length > 1) process.exit(1);
        const app = matches[0];
        if (app) {
          const env = app.pm2_env;
          if (env.pm_cwd !== process.argv[2] ||
              env.pm_exec_path !== process.argv[2] + "/node_modules/next/dist/bin/next") process.exit(1);
          process.stdout.write("present");
        }
      } catch { process.exit(1); }
    });
  ' "$name" "$root")" || fail "Invalid/stale pm2 definition; operator must verify, then pm2 delete $name && pm2 save at approved cutover"

  # File is authoritative; never inherit a DATABASE_URL or kernel URL.
  local variable
  while IFS= read -r variable; do unset "$variable"; done < <(
    node --input-type=module -e 'import { ENV_NAMES } from "./scripts/check-env.mjs"; console.log(ENV_NAMES.join("\n"));'
  )
  git fetch --tags --prune origin
  git checkout --detach "$ref"
  node scripts/check-env.mjs "$target"
  pnpm install --frozen-lockfile
  node --env-file=.env.local node_modules/next/dist/bin/next build
  node --env-file=.env.local scripts/migrate-baseline.mjs
  node --env-file=.env.local node_modules/drizzle-kit/bin.cjs migrate

  # Only after validation/build/baseline succeed. First claim happens in the browser.
  if [[ "$existing" == "present" ]]; then
    pm2 restart ecosystem.config.cjs --only "$name" --update-env
  else
    pm2 start ecosystem.config.cjs --only "$name"
  fi
  pm2 save
  local attempt
  for ((attempt=1; attempt<=30; attempt++)); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$port/events/api/health" | \
      node -e 'let s=""; process.stdin.on("data", c=>{s+=c;}); process.stdin.on("end",()=>{try{const r=JSON.parse(s);process.exit(r.status==="ok"&&r.service==="imajin-events"?0:1);}catch{process.exit(1);}})'; then
      printf 'Healthy: %s. If unclaimed, open /events/claim and use the operator approval code.\n' "$name"
      return 0
    fi
    sleep 2
  done
  fail "Health check failed; inspect locally without sharing credentials. Do not proceed to prod."
}

# Whole body parsed before checkout replaces this file.
main "$@"
