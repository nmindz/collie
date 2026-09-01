#!/usr/bin/env bash
# Bootstrap shim for Collie. Its ONLY job: make sure `bin/collie` exists, then hand it the argv.
#
# Every verb — start/stop/restart/build/serve/unserve/status/url/qr/version/update/_apply-update/
# _exec-bridge/uninstall/push-keys/push-test/logs and the pack verbs — is implemented ONCE, in `cli/`, and
# compiled into `bin/collie` (M6/01). Nothing about a systemd unit, a launchd agent, `tailscale
# serve` or a git checkout lives here any more; if you are about to add such a thing, it belongs in
# `cli/`.
#
# Why the plugin's actions still name this script instead of the binary: `herdr-plugin.toml`'s
# `command` strings are FROZEN. On Herdr <0.8.0 a managed install invokes the action set cached at
# install time, so the path in that cache must keep working (ADR 0006) — and README recipes and
# muscle memory spell every verb `collie-ctl.sh <verb>`. Delegating keeps all three true, and gives
# a checkout with no binary yet ONE legible path to getting one.
#
# `update` runs through here like any other verb, and nothing here has to survive it: the shim
# bootstraps (if needed) and `exec`s the binary, whose `cmdUpdate` advances the checkout and then
# re-execs `bun cli/main.ts _apply-update` FROM THE FETCHED SOURCE (cli/update.ts) — so the code that
# rebuilds is always the code that was just pulled, and this file is out of the picture by then.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COLLIE_BIN="${PLUGIN_ROOT}/bin/collie"

# Bun installed by a version manager (mise), for hosts where that is the ONLY Bun.
#
# mise keeps its tools under `installs/<tool>/<version>/bin` — a path nothing can guess, so the fixed
# list below can never find them. A host whose only Bun comes from mise therefore could not build the
# binary AT ALL: the bootstrap below reports "bun is not installed" and every Herdr action that runs
# through it (`[[build]]` on install, `update`) dies right there, on a box where `bun` works fine in
# the operator's own shell.
#
# So ask mise — but find mise the same way we have to find Bun, because the environments this matters
# in (Herdr actions, launchd) have not sourced the profile line that puts `~/.local/bin` on PATH
# either.
#
# Two things this deliberately does NOT do:
#   - It does not accept a non-absolute `command -v mise`. `mise activate` installs a shell FUNCTION
#     named `mise`, so the trap documented for `bun` below applies verbatim.
#   - It does not take the shim's existence as proof. mise's config is directory-scoped, so a shim
#     can sit on disk for a tool this directory does not provide; `mise which` is the question that
#     actually answers "is there a Bun here", and it declines HERE rather than at exec time, halfway
#     through a build.
#
# The shims dir is PREFERRED over the concrete path mise prints, because the version is baked into
# that path (`…/installs/bun/1.3.14/bin/bun`) and whatever we resolve is exported on PATH below for
# every child of a long `build` or `update` — a version-pinned directory there goes stale the moment
# the operator runs `mise up bun`. A shim is a stable name that re-resolves on every exec, and it
# needs neither mise on PATH nor an activated shell.
resolve_mise_bun() {
  local mise="" candidate resolved shim
  candidate="$(command -v mise 2>/dev/null || true)"
  case "$candidate" in
    /*) mise="$candidate" ;;
  esac
  if [ -z "$mise" ]; then
    for candidate in \
      "${HOME}/.local/bin/mise" \
      /opt/homebrew/bin/mise \
      /usr/local/bin/mise; do
      if [ -x "$candidate" ]; then
        mise="$candidate"
        break
      fi
    done
  fi
  [ -n "$mise" ] || return 0
  # stderr is dropped: mise writes an unrelated "new version available" WARN there on every call.
  resolved="$("$mise" which bun 2>/dev/null || true)"
  [ -n "$resolved" ] || return 0
  shim="${MISE_DATA_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/mise}/shims/bun"
  if [ -x "$shim" ]; then
    printf '%s' "$shim"
  else
    printf '%s' "$resolved"
  fi
  return 0
}

# Find Bun on PATH, then via a version manager, then in the usual install locations.
#
# This survived the port because it is the BOOTSTRAP's job, not the CLI's: Bun is what compiles the
# binary, so it has to be found before there is a binary to do the finding. Herdr spawns plugin
# actions with a minimal environment — no login shell, so nothing has sourced the line `bun` puts in
# your profile and `~/.bun/bin` is simply absent from PATH. `update` therefore pulled the new commit
# and then failed its build, leaving the checkout AHEAD of the web/dist being served while every
# version string reported the new release — unnoticed across four invocations.
#
# Order is deliberate: PATH first, because an activated shell has already answered the question; then
# $BUN_INSTALL, because it is the operator's explicit override; then a declared version manager; and
# only then the guess-list — a mise-managed Bun is the one the operator actually uses, so it has to
# outrank a stale `~/.bun` left behind by an old curl install.
#
# An empty result is still fine: the caller below reports it and exits.
resolve_bun() {
  local candidate
  if candidate="$(command -v bun 2>/dev/null)"; then
    printf '%s' "$candidate"
    return 0
  fi
  if [ -n "${BUN_INSTALL:-}" ] && [ -x "${BUN_INSTALL}/bin/bun" ]; then
    printf '%s' "${BUN_INSTALL}/bin/bun"
    return 0
  fi
  candidate="$(resolve_mise_bun)"
  if [ -n "$candidate" ]; then
    printf '%s' "$candidate"
    return 0
  fi
  for candidate in \
    "${HOME}/.bun/bin/bun" \
    "${HOME}/.local/bin/bun" \
    /usr/local/bin/bun \
    /opt/homebrew/bin/bun \
    /usr/bin/bun; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 0
}
BUN="$(resolve_bun)"
# Put it on PATH too, not just in $BUN: `collie build` spawns children that expect to find `bun`
# themselves.
#
# ABSOLUTE paths only. `command -v` reports a shell function or alias as a bare word, so a `bun()`
# in whatever sourced us would resolve to `bun`, whose dirname is `.`, and we would prepend the CWD
# to the PATH every later lookup uses.
case "$BUN" in
  /*)
    BUN_DIR="$(dirname "$BUN")"
    case ":${PATH}:" in
      *":${BUN_DIR}:"*) ;;
      *) PATH="${BUN_DIR}:${PATH}"; export PATH ;;
    esac
    ;;
esac

# Sourced (by scripts/collie-ctl.test.sh) rather than run: define the functions and stop before the
# bootstrap, so a test can exercise resolution without executing anything.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

# The bootstrap. A checkout can legitimately arrive with no binary: `herdr plugin link` never runs
# `[[build]]`, and a fresh clone has an empty `bin/` (the 95 MB artifact is built, never committed).
# Build it from SOURCE with Bun — `cli/main.ts` imports nothing outside the checkout and `node:*`, so
# it runs before `bun install` has ever been run here, and `collie build` then installs both trees,
# typechecks, compiles the binary and builds the PWA, swapping both artifacts in last.
if [ ! -x "$COLLIE_BIN" ]; then
  if [ -z "$BUN" ]; then
    echo "error: no collie binary at ${COLLIE_BIN}, and bun is not installed to build one." >&2
    echo "       Install Bun from https://bun.sh and re-run, or:" >&2
    echo "       herdr plugin action invoke update --plugin herdr.collie" >&2
    exit 1
  fi
  echo "first run — building the collie binary…" >&2
  if ! ( cd "$PLUGIN_ROOT" && "$BUN" run cli/main.ts build ); then
    echo "error: could not build ${COLLIE_BIN}. Fix the build and re-run, or:" >&2
    echo "       herdr plugin action invoke update --plugin herdr.collie" >&2
    exit 1
  fi
  if [ ! -x "$COLLIE_BIN" ]; then
    echo "error: the build reported success but left no binary at ${COLLIE_BIN}." >&2
    exit 1
  fi
fi

# Full argv passthrough, and the environment flows through untouched — COLLIE_INSTANCE,
# COLLIE_PLUGIN_ROOT, SKIP_VERSION_CHECK, SKIP_TYPECHECK and Herdr's injected HERDR_* are all read
# by the CLI itself. `exec` so the binary inherits this pid: nothing here should outlive it, least
# of all under a supervisor watching the pid it spawned.
exec "$COLLIE_BIN" "$@"
