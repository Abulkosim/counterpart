# Helpers for the guard scripts. Source after smoke-lib.sh.

# Run a command on a pseudo-terminal and answer its passphrase prompt, the way
# a person at a keyboard would. Prints what the terminal showed and exits as
# the command did.
on_terminal() {
  local answer=$1; shift
  PTY_ANSWER=$answer python3 -I -c '
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
out, sent, end = b"", False, time.time() + 90
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if not r:
        continue
    try:
        d = os.read(fd, 4096)
    except OSError:
        break
    if not d:
        break
    out += d
    low = out.lower()
    if not sent and (b"passphrase: " in low or b"to go on: " in low):
        time.sleep(0.2)
        os.write(fd, os.environ["PTY_ANSWER"].encode() + b"\r")
        sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf-8", "replace"))
sys.exit(os.waitstatus_to_exitcode(status))
' "$@"
}
