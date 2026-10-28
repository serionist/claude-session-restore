#!/bin/sh
# By hand, on macOS or Linux: a real session cut off in a folder with a hostile name, restored by this clone's
# plugin into a real terminal, then checked. docs/testing-by-hand.md walks through it.
#
#   tools/try-restore.sh setup   makes the folder and prints the steps
#   tools/try-restore.sh check   says whether the session was restored there, and that nothing in its name ran
#   tools/try-restore.sh clean   removes the folder and the session's record
#
# The folder's name holds what a shell, tmux or AppleScript would run if the plugin let it: $(...), `...`, #(...), ;.
# Each would create a file named session-restore-pwned in the folder or in $HOME; `check` looks for it.

set -eu

config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
records="$config/session-restore/sessions"
base="$HOME/session-restore-try"
folder="$base/R&D it's \$(touch session-restore-pwned) \`touch session-restore-pwned\` #(touch session-restore-pwned); 100%"
clone=$(cd "$(dirname "$0")/.." && pwd)

# A word single-quoted for a POSIX shell, as the plugin quotes it.
q() {
  printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"
}

# The record of the newest session started in the folder, if any.
record_of_folder() {
  [ -d "$records" ] || return 0
  # Record files are named by session id, so their names hold no spaces.
  for name in $(ls -t "$records" 2>/dev/null); do
    case "$name" in *.json) ;; *) continue ;; esac
    if grep -qF "\"cwd\": \"$folder\"" "$records/$name" 2>/dev/null; then
      echo "$records/$name"
      return 0
    fi
  done
}

case "${1:-}" in
  setup)
    mkdir -p "$folder"
    cat <<EOF
The folder is ready:
  $folder

1. Turn the installed plugin off, so only this clone's runs:
     claude plugin disable session-restore@session-restore
2. In a terminal, start a session in the folder with this clone's plugin, and send it one prompt:
     cd $(q "$folder") && claude --plugin-dir $(q "$clone/plugin")
3. Cut it off: close that terminal window (not /exit, which counts as leaving on purpose).
4. In another terminal, start a session in the test's own folder, with the same plugin:
     cd $(q "$base") && claude --plugin-dir $(q "$clone/plugin")
   Press Restore all on the band (or type /restore all).
5. A new window should open in the folder, the first session's conversation in it. Leave it open over 30 seconds.
6. Back here: tools/try-restore.sh check
EOF
    ;;
  check)
    status=0
    rec=$(record_of_folder)
    if [ -z "$rec" ]; then
      echo "FAIL: no session record for the folder in $records; did step 2 send a prompt?"
      exit 1
    fi
    echo "record: $rec"
    if grep -q '"status": "restored"' "$rec"; then
      echo "ok: the session is marked restored"
    elif grep -q '"status": "open"' "$rec"; then
      echo "ok: the session is open again (the restored window has synced it)"
    else
      echo "FAIL: the session is $(grep -o '"status": "[a-z]*"' "$rec")"
      status=1
    fi
    id=$(basename "$rec" .json)
    script="$config/session-restore/launch/$id.sh"
    if [ -f "$script" ]; then echo "ok: the window ran $script"; else echo "note: no script at $script (printed commands?)"; fi
    # Where a command in the name would have run: the restored window (the folder, or $HOME where Terminal starts),
    # the restoring session (step 4 starts it in $base), a tmux or job server (/tmp). Never deeper into $HOME, whose
    # Desktop and Documents macOS guards with a prompt.
    pwned=$(find "$base" -name session-restore-pwned 2>/dev/null | head -1)
    for f in "$HOME/session-restore-pwned" "/tmp/session-restore-pwned"; do
      if [ -z "$pwned" ] && [ -e "$f" ]; then pwned=$f; fi
    done
    if [ -n "$pwned" ]; then
      echo "FAIL: $pwned exists: part of the folder's name ran as a command"
      status=1
    else
      echo "ok: nothing in the folder's name ran"
    fi
    if command -v pgrep >/dev/null 2>&1 && pgrep -f -- "--resume $id" >/dev/null 2>&1; then
      echo "ok: a claude is running with --resume $id"
    else
      echo "note: no claude with --resume $id is running now (closed already?)"
    fi
    exit "$status"
    ;;
  clean)
    rec=$(record_of_folder)
    if [ -n "$rec" ]; then rm -f "$rec" "$config/session-restore/launch/$(basename "$rec" .json).sh"; fi
    rm -rf "$base"
    echo "removed $base and the session's record. Turn the installed plugin back on:"
    echo "  claude plugin enable session-restore@session-restore"
    ;;
  *)
    echo "usage: tools/try-restore.sh setup | check | clean" >&2
    exit 2
    ;;
esac
