#!/usr/bin/env python3
"""Run a command in a pseudo-terminal and answer its prompts.

  pty_run.py <prompt text> <answer> [<prompt text> <answer>]... -- <command...>

Prints everything the terminal showed. Used to sign a contract at the real
prompt instead of through --yes.
"""
import os
import pty
import select
import sys
import time

args = sys.argv[1:]
split = args.index("--")
pairs = list(zip(args[:split:2], args[1:split:2]))
cmd = args[split + 1 :]

pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)

seen = b""
answered = 0
deadline = time.time() + 120
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        seen += chunk
    if answered < len(pairs) and pairs[answered][0].encode() in seen.split(b"\n")[-1]:
        time.sleep(0.3)
        os.write(fd, pairs[answered][1].encode() + b"\n")
        answered += 1

_, status = os.waitpid(pid, 0)
sys.stdout.write(seen.decode("utf-8", "replace"))
sys.exit(os.waitstatus_to_exitcode(status))
