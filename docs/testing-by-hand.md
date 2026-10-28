# Testing by hand

What no test reaches: a real window opening in a real terminal, and a real session resumed in it. CI runs every script
the plugin generates, in Windows PowerShell and PowerShell 7 on Windows and in `sh` on Linux and macOS, but its
runners have no desktop. Run this before a release that changes how a restore opens, on each system it changes.

## macOS and Linux

From a clone of this repo, on the branch or the `main` to test (`git pull`). A merged change reaches installs only
with a release, so the test loads the plugin from the clone.

```
tools/try-restore.sh setup
```

It makes a folder whose name holds what a shell, tmux or AppleScript would run if the plugin let it, and prints the
steps: turn the installed plugin off, start a session in that folder with the clone's plugin, cut it off by closing
its window, restore it from another session. Then:

```
tools/try-restore.sh check
tools/try-restore.sh clean
```

`check` says whether the session was restored, that nothing in the folder's name ran, and whether a claude runs with
its `--resume`. `clean` removes the folder and the record, and says how to turn the installed plugin back on.

Each row is one run of the steps; the restoring session (step 4) runs where the row says.

| System | Restoring session in | Expect |
|---|---|---|
| macOS | Terminal.app | a Terminal window, the session in it. The first time, macOS may ask to let the app that runs claude control Terminal: allow it |
| macOS | iTerm2 | an iTerm2 window |
| macOS | tmux, in any terminal | a new tmux window |
| Linux, GNOME | the desktop's terminal | a window of the first installed of `x-terminal-emulator`, `gnome-terminal`, `ptyxis` |
| Linux | tmux | a new tmux window |
| Linux | any, with `/config` > `terminal` set to `xterm` (install it first) | an xterm window, which runs in the foreground: the plugin must start it apart |
| either | an SSH session into the machine | no window: the commands printed, with "this session runs over SSH" |

For each, also:

- Leave the restored window open for more than 30 seconds: it must stay, and its claude with it.
- Linux: the restored session got its flags back. `ps -o args= -p "$(pgrep -f -- '--resume <id>')"` shows the
  `--plugin-dir` the first session started with.
- macOS: the restored session comes back without its flags (`ps` can't tell where an argument with a space ends).

## Windows

The same steps by hand, in PowerShell, with a folder such as `R&D it's $(calc) 100%`: start a session there with
`claude --plugin-dir <clone>\plugin`, close its window, restore from another session. A Windows Terminal window named
`claude-restore` opens with the session; no calculator starts.

## Recording it

Say in the PR's "Tested by", or in a comment on its issue, which rows ran, on which system and Claude Code version,
and what failed.
