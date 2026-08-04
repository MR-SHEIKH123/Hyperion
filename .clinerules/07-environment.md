# Environment: Windows + cmd.exe

The shell is **cmd.exe on Windows**, not bash. Each of these has already cost a
wasted turn.

## Syntax that does not work

- **No heredocs.** `<<EOF` is a syntax error. To pass a multi-line string (a
  commit message, file content), write a temp file and reference it —
  `git commit -F .git\COMMIT_MSG_TMP.txt`, then delete it.
- **`timeout /t N` fails** with "Input redirection is not supported" when run
  non-interactively. Do not use it to wait.
- **`%VAR%` does not expand on the same line it is `set`.** `set X=1& echo %X%`
  prints the literal. Use the literal value instead, or separate the commands.
- **`%ERRORLEVEL%` in a chained line expands at parse time**, before anything
  runs — so `cmd & echo %ERRORLEVEL%` always reports the *old* value and is
  meaningless. Check the tool's reported exit code instead.
- **`for /f` and `for %U in (...)` are fragile** here. Prefer explicit repeated
  commands chained with `&`.
- **`git --no-pager` goes before the subcommand**: `git --no-pager log`, never
  `git log --no-pager` (that is a fatal unrecognized-argument error).
- Piping a native command's output into `findstr` can make the chain report a
  non-zero exit even when the command itself succeeded. Run the command alone
  when its exit code matters.

## Never kill node by image name

**Do not run `taskkill /F /IM node.exe`.** It once killed nine unrelated node
processes, including the user's own work.

Kill by PID instead:

```
netstat -ano | findstr ":<port>"      # read the PID from the last column
taskkill /F /PID <pid>
```

## Paths

The project lives at `c:\Users\DELL\Documents\Hyperion`. Do not invent a username
in a path — if the working directory is unclear, check it rather than guessing.

## Clean up before committing

Delete scratch homes, log files, and temp message files, then confirm with
`git status --short` that only the intended files are staged. Never commit a
smoke-test artifact.