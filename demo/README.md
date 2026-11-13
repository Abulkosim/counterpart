# Demo video

The demo video is drawn from a recording of one real run. Nothing in it is typed by hand.

```sh
cd demo && npm install
node capture.mjs     # runs the whole story, writes out/tape.json and viewer screenshots
node render.mjs      # draws out/counterpart-demo.mp4 from the tape (1080p, 30 fps)
node render.mjs --stills 30,90   # PNG frames at those seconds, to look at before a full render
```

`capture.mjs` starts a relay and two daemons, pairs Alice and Bob, and then:

1. Bob's Claude Code session asks Alice's front desk a question through the MCP tools.
2. Bob's side sends a message that tries to take over the front desk.
3. Bob proposes a contract. Alice signs at the real terminal prompt (driven through a pseudo-terminal by `pty_run.py`). Bob signs.
4. Alice's worker proposes the patch. She applies it and runs her tests. If the tests fail, the patch is thrown away and the worker is asked again; the tape records how many tries it took.
5. `cpart pr` opens a pull request in a new private GitHub repository, the verify workflow runs, and Alice sends Bob evidence.
6. One byte of the signed schema changes. The workflow fails and Bob's side shows the mismatch.

It uses real models and creates a private repository named `counterpart-demo-<date>` under your GitHub account each time. Delete those when you are done.

`video.html` is the video as a web page: every frame is a function of time. `render.mjs` steps it and pipes screenshots to ffmpeg. Terminal output in the video is taken from the tape, with long output cut down to the lines that matter. The hostile-contract scene uses `hostile.txt`, the output of `./scripts/demo-work.sh hostile` from a separate run.
