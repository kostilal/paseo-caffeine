#!/usr/bin/env python3
"""Commit gate: block `git commit` until the change set has been reviewed.

**Every branch is gated.** The rule used to be "only `master` /
`main`, because merging there autodeploys to production" — and the reasoning was
sound about deploys and wrong about reviews. What reaches master is whatever the
feature branch already contains; by then the review is an audit of work nobody
looked at while it was being written, and a batch too large to read properly.
Reviewing each commit is what makes the review small enough to be real.

`master` / `main` keep one distinction, and it is only about wording: merging there
autodeploys without a test gate, so the refusal says so.

Modes:
  (no args)   PreToolUse hook. Reads the hook JSON on stdin; stays silent to allow,
              prints a deny decision to block.
  approve     Record a review for the current change set of a repository. Only a
              report whose verdict is an explicit APPROVE is recorded. The report is
              the per-worktree REPORT.md, or any file named with `--report PATH`
              outside the worktree. Either is consumed: one review, one change set.
  commit      `commit [--repo R] [--report PATH] -- <git commit args>`: approve (if
              the change set is not approved yet) and commit, in one call. Refuses
              exactly where the hook would; it only saves the separate `approve`
              call, which the hook cannot let share a command line with the commit.
  status      Show the current fingerprint and whether it is approved.

The approval is bound to a fingerprint of everything that could land in a commit —
the index, the unstaged worktree delta, and untracked files — so touching anything
after a review invalidates that review.

Fails open: any internal error allows the commit and warns on stderr. A broken gate
must not brick the workflow. False positives (an extra gate) are cheap; false
negatives (an unreviewed commit) are the failure we actually care about.
The verdict fails the other way, closed: `approve` records only what it can read as
APPROVE, so a spelling it has never seen refuses instead of passing.

Tests: python3 .claude/hooks/test_review_gate.py
"""

import hashlib
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import time

STATE_DIR = "review-gate"
REPORT_NAME = "REPORT.md"
MIN_REPORT_CHARS = 200
# The only verdicts `approve` records. Anything else refuses, an unknown word included.
APPROVING_VERDICTS = {"APPROVE", "APPROVED"}
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
READ_CHUNK = 1 << 20

# Branches whose merge autodeploys to production without a test gate. Every branch
# is gated now, so this set no longer decides WHETHER to gate — only how loudly the
# refusal puts it.
AUTODEPLOY_BRANCHES = {"master", "main"}

# Deliberately narrow. `.txt` is NOT here: requirements.txt is a supply-chain file.
DOC_ONLY_SUFFIXES = (".md",)
DOC_ONLY_NAMES = ("LICENSE",)
# …but these .md files ARE the operating rules, so they are never exempt:
# an agent must not be able to rewrite its own gate unreviewed.
POLICY_FILES = ("AGENTS.md", "CLAUDE.md")
POLICY_DIRS = ("docs/agents/",)

# Env assignments that redirect where a commit actually lands. The gate's own git
# calls do not inherit them, so it cannot reason about such a commit at all.
REDIRECTING_ENV = ("GIT_DIR=", "GIT_WORK_TREE=", "GIT_INDEX_FILE=", "GIT_COMMON_DIR=")

# Commands that run another command as their argument tail.
WRAPPERS = {
    "env", "time", "nohup", "command", "nice", "ionice", "stdbuf",
    "xargs", "sudo", "doas", "setsid", "timeout", "builtin", "exec",
}
# Wrappers whose first positional argument is theirs, not the wrapped command's.
WRAPPER_OPERAND = {"timeout"}
# git subcommands that can never be an alias, so the alias lookup can be skipped.
# That lookup costs two subprocesses, and this hook runs on every git command.
GIT_BUILTINS = {
    "status", "diff", "log", "add", "push", "pull", "fetch", "checkout", "switch",
    "branch", "merge", "rebase", "reset", "restore", "show", "stash", "tag",
    "remote", "config", "rev-parse", "ls-files", "clone", "init", "worktree",
    "cherry-pick", "describe", "blame", "grep", "clean", "apply", "bisect",
}
# Shells whose `-c STRING` argument holds a nested command line.
SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
SEGMENT_SPLIT = re.compile(r"(?:\|\||&&|[;\n|&])")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*=")

# git global options that consume a following argument when given in space form.
GIT_GLOBAL_WITH_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--exec-path",
                       "--namespace", "--super-prefix", "--config-env"}


def sh(args, cwd=None):
    """Run a command, returning raw bytes. Never decodes — diffs are not always UTF-8."""
    p = subprocess.run(args, cwd=cwd, capture_output=True, timeout=60)
    return p.stdout


def sh_text(args, cwd=None):
    return sh(args, cwd).decode("utf-8", "replace")


def git_ok(root, *args):
    p = subprocess.run(["git", "-C", root, *args], capture_output=True, timeout=30)
    return p.returncode == 0


# --------------------------------------------------------------- command parsing


# `<<WORD`, `<<-WORD`, `<<\WORD`, `<<'WORD'`, `<<"WORD"`. The whole shell word, not
# a prefix of it: reading `<<EOF-MSG` as `EOF` skipped on to a later heredoc's `EOF`
# line and swallowed the commit in between. The lookarounds keep a here-string
# (`<<<word`) out, whichever of its `<` the scan stands on.
HEREDOC = re.compile(
    r"(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]+)'|\"([^\"\n]+)\"|\\?([^\s;&|<>()'\"\\]+))")


class HeredocBody(str):
    """A heredoc body, kept apart from the line that owns it.

    Its quotes must not leak into that line — an apostrophe in a commit message
    written through `cat <<'EOF'` once opened a quote that swallowed the
    `git commit` after it, and the gate let an unreviewed commit through without a
    word. But the body is not merely data: `bash <<'EOF'` and `cat <<EOF | sh`
    run it. So it is scanned on its own, as a script. A commit message with a line
    that reads like `git commit` costs an extra refusal; that is the cheap side.
    """


def heredoc_end(cmd, start, word, strip_tabs):
    """(index past the closing line, body) for a heredoc body starting at `start`.

    None when no line closes it. A real heredoc always has one; `$((a << b))` does
    not, and treating that as a heredoc would swallow the rest of the command.
    """
    i = start
    while i < len(cmd):
        j = cmd.find("\n", i)
        line = cmd[i:] if j < 0 else cmd[i:j]
        if (line.lstrip("\t") if strip_tabs else line) == word:
            return (len(cmd) if j < 0 else j + 1), cmd[start:i]
        if j < 0:
            return None
        i = j + 1
    return None


def scan_segments(cmd, honour_quotes=True):
    """Split a command line into segments; return (segments, quote_left_open).

    Separators inside quotes do not split. Backslash escapes only inside double
    quotes — POSIX single quotes are literal, so `echo 'C:\\'` must not desync the
    quote state and swallow the rest of the line. Heredoc bodies come out as
    HeredocBody segments, right after the line that opened them.
    """
    out, buf, quote, i = [], [], None, 0
    pending = []  # heredocs whose bodies start after the next unquoted newline
    while i < len(cmd):
        ch = cmd[i]
        if quote == '"' and ch == "\\" and i + 1 < len(cmd):
            buf.append(ch)
            buf.append(cmd[i + 1])
            i += 2
            continue
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
        elif ch in "'\"" and honour_quotes:
            quote = ch
            buf.append(ch)
        elif HEREDOC.match(cmd, i):
            m = HEREDOC.match(cmd, i)
            # `<<E"O"F` is one word to the shell; its terminator is not knowable
            # from a prefix, so it is left unparsed rather than guessed.
            if m.end() < len(cmd) and cmd[m.end()] in "'\"\\":
                buf.append(ch)
                i += 1
                continue
            pending.append((m.group(2) or m.group(3) or m.group(4), bool(m.group(1))))
            buf.append(m.group(0))
            i = m.end()
            continue
        elif SEGMENT_SPLIT.match(cmd, i):
            m = SEGMENT_SPLIT.match(cmd, i)
            out.append("".join(buf))
            buf = []
            i = m.end()
            if ch == "\n":
                while pending:
                    word, strip_tabs = pending.pop(0)
                    closed = heredoc_end(cmd, i, word, strip_tabs)
                    if closed is not None:
                        i, body = closed
                        out.append(HeredocBody(body))
            continue
        else:
            buf.append(ch)
        i += 1
    out.append("".join(buf))
    segments = [s if isinstance(s, HeredocBody) else s.strip() for s in out if s.strip()]
    return segments, quote is not None


def substitutions(cmd):
    """Command lines nested inside $( … ) or backticks."""
    found, i = [], 0
    while i < len(cmd):
        if cmd.startswith("$(", i):
            depth, j = 1, i + 2
            while j < len(cmd) and depth:
                if cmd[j] == "(":
                    depth += 1
                elif cmd[j] == ")":
                    depth -= 1
                j += 1
            found.append(cmd[i + 2: j - 1])
            i = j
        elif cmd[i] == "`":
            j = cmd.find("`", i + 1)
            if j < 0:
                break
            found.append(cmd[i + 1: j])
            i = j + 1
        else:
            i += 1
    return found


def tokenize(segment):
    segment = segment.lstrip("({ \t")  # subshell / group opener binds to the next word
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        try:
            return shlex.split(segment, posix=False)
        except ValueError:
            return segment.split()


def has_redirecting_env(tokens):
    return any(t.startswith(REDIRECTING_ENV) for t in tokens if ASSIGNMENT.match(t))


def strip_prefixes(tokens):
    """Drop leading VAR=value assignments and wrapper commands (env, xargs, sudo…)."""
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        base = os.path.basename(tok)
        if ASSIGNMENT.match(tok):
            i += 1
        elif base in WRAPPERS:
            i += 1
            # skip that wrapper's own flags (e.g. `sudo -u me`, `xargs -0 -n1`)
            while i < len(tokens) and tokens[i].startswith("-"):
                i += 2 if tokens[i] in ("-u", "-n", "-I", "-P", "--user") else 1
            # …and its positional operand, where it takes one (`timeout 30 git …`)
            if base in WRAPPER_OPERAND and i < len(tokens):
                i += 1
        else:
            break
    return tokens[i:]


def parse_git(tokens):
    """Return (subcommand, sub_args, dir_chain, worktree) for a git call, else None.

    dir_chain collects every -C, which git applies cumulatively. `--work-tree` /
    `--git-dir` retarget the repository entirely and must be honoured, not dropped,
    or the gate inspects one repository while the commit lands in another.
    """
    tokens = strip_prefixes(tokens)
    if not tokens or os.path.basename(tokens[0]) != "git":
        return None
    i, dirs, worktree = 1, [], None
    while i < len(tokens):
        tok = tokens[i]
        nxt = tokens[i + 1] if i + 1 < len(tokens) else None
        if tok == "-C" and nxt is not None:
            dirs.append(nxt)
            i += 2
        elif tok in ("--work-tree", "--git-dir") and nxt is not None:
            worktree = nxt if tok == "--work-tree" else os.path.dirname(nxt) or nxt
            i += 2
        elif tok.startswith(("--work-tree=", "--git-dir=")):
            value = tok.split("=", 1)[1]
            worktree = value if tok.startswith("--work-tree=") else (os.path.dirname(value) or value)
            i += 1
        elif tok.startswith("--") and "=" in tok:
            i += 1
        elif tok in GIT_GLOBAL_WITH_ARG:
            i += 2
        elif tok.startswith("-"):
            i += 1
        else:
            return tok, tokens[i + 1:], dirs, worktree
    return None


SHELL_C_FLAG = re.compile(r"^-[A-Za-z]*c$")


def nested_shell_command(tokens):
    """`bash -c "git commit …"` — return the inner command line, if any.

    Matches combined short flags too: `bash -lc`, `sh -xc`, `bash -ec`.
    """
    tokens = strip_prefixes(tokens)
    if not tokens or os.path.basename(tokens[0]) not in SHELLS:
        return None
    for i, tok in enumerate(tokens[1:], 1):
        if SHELL_C_FLAG.match(tok) and i + 1 < len(tokens):
            return tokens[i + 1]
    return None


def resolve_dir(base, chain):
    """Apply a chain of directory hops. Unexpandable shell syntax aborts the chain.

    An unknown base (after `cd "$T"`) stays unknown through a relative hop and is
    replaced by an absolute one. Joining onto it raised a TypeError, and the hook
    fails open: `cd "$REPO"; cd sub && git commit` went through ungated.
    """
    cur = base
    for d in chain:
        d = os.path.expanduser(d)
        if "$" in d or "*" in d:
            return None
        if os.path.isabs(d):
            cur = d
        elif cur is not None:
            cur = os.path.join(cur, d)
    return cur


UNRESOLVABLE = object()


def find_commits(cmd, cwd, depth=0):
    """Every `git commit` a command line could run, tracking `cd` across segments.

    Returns a list of (repo_dir, sub_args) and UNRESOLVABLE entries. Handles
    `cd a; cd ../b && git commit`, subshells, wrappers, nested `sh -c`, heredoc
    bodies, command substitution, cumulative -C, and --git-dir/--work-tree.

    All of them, not the first: the first one met is not necessarily the one that
    runs. A commit message that mentions `git commit --dry-run` puts a "commit"
    in a heredoc body ahead of the real one, and deciding on it alone read the
    whole command as a dry run and let an unreviewed commit through.
    """
    if depth > 3:
        return []
    segments, quote_left_open = scan_segments(cmd)
    found = _find_in_segments(segments, cwd, depth)
    if found or not quote_left_open:
        return found
    # A quote that never closes means the line was misread — bash would have
    # refused it, or something here (a heredoc spelling not recognised above) is
    # data that looks like a quote. Read it again with quotes as plain characters:
    # an extra refusal is cheap, a commit that slips past the gate is not. The
    # directory this pass arrives at is best effort — quoted text now reads as
    # commands, `cd` included — but it only runs where the first pass saw no commit
    # at all, so it can only turn a silent allow into a check.
    return _find_in_segments(scan_segments(cmd, honour_quotes=False)[0], cwd, depth)


def find_commit(cmd, cwd, depth=0):
    """The first of find_commits, or None. The hook itself decides on all of them."""
    found = find_commits(cmd, cwd, depth)
    return found[0] if found else None


def _find_in_segments(segments, cwd, depth):
    # Commits on the line itself come first, those inside a heredoc body or a
    # substitution after: a refusal names the first commit that needs review, and
    # one merely mentioned in a commit message should not be the one it names.
    cur, found, nested = cwd, [], []
    for segment in segments:
        if isinstance(segment, HeredocBody):
            nested += find_commits(segment, cur, depth + 1)
            continue
        for inner in substitutions(segment):
            nested += find_commits(inner, cur, depth + 1)

        tokens = tokenize(segment)
        if not tokens:
            continue

        inner = nested_shell_command(tokens)
        if inner:
            nested += find_commits(inner, cur, depth + 1)
            continue

        bare = strip_prefixes(tokens)
        if bare and bare[0] in ("cd", "pushd"):
            # An unresolvable hop (`cd "$T"`) must not silently leave `cur` pointing
            # at the previous directory — that gates the wrong repository.
            cur = resolve_dir(cur, [bare[1]]) if len(bare) > 1 else None
            continue

        parsed = parse_git(tokens)
        if not parsed:
            continue
        sub, sub_args, dirs, worktree = parsed

        if has_redirecting_env(tokens):
            found.append(UNRESOLVABLE)
            continue

        base_dir = resolve_dir(cur, [worktree]) if worktree else cur
        repo_dir = resolve_dir(base_dir, dirs) if base_dir else None
        if repo_dir is None:
            if is_commit_subcommand(cwd, sub):
                found.append(UNRESOLVABLE)
            continue
        if is_commit_subcommand(repo_dir, sub):
            found.append((repo_dir, sub_args))
    return found + nested


def is_commit_subcommand(repo_dir, sub, depth=0):
    if sub == "commit":
        return True
    if sub in GIT_BUILTINS or depth > 2:
        return False  # cannot be an alias; skip the two subprocesses
    root = repo_root(repo_dir)
    if not root:
        return False
    expansion = sh_text(["git", "-C", root, "config", "--get", f"alias.{sub}"]).strip()
    if not expansion:
        return False
    if expansion.startswith("!"):
        # A `!`-alias is a shell command — `alias.cm = !git commit`. Re-parse it.
        return find_commit(expansion[1:], root, depth + 1) is not None
    first = expansion.split()
    return bool(first) and first[0] == "commit"


def is_dry_run(sub_args):
    """A real `--dry-run` and nothing that could negate it.

    git takes the last of `--dry-run` / `--no-dry-run` and accepts any unambiguous
    abbreviation (`--no-dry`, `--no-d`), so any token that could be one of those
    counts as a negation — even when it is really a message: an extra review is
    cheap, an unreviewed commit is not.
    """
    return has_flag(sub_args, "--dry-run") and not any(
        tok.startswith("--no-d") for tok in sub_args)


def has_flag(sub_args, *names):
    """Check the commit's OWN flags, never the whole command line.

    `git commit -m "add --dry-run support"` must not read as a dry run, so values
    of option-taking flags are skipped.
    """
    takes_value = {"-m", "--message", "-F", "--file", "-c", "--reedit-message",
                   "-C", "--reuse-message", "--author", "--date", "-t", "--template",
                   "--cleanup", "-S", "--gpg-sign", "--fixup", "--squash", "--trailer",
                   "--pathspec-from-file"}
    i = 0
    while i < len(sub_args):
        tok = sub_args[i]
        if tok == "--":
            break
        if tok in names:
            return True
        if "=" in tok and tok.split("=", 1)[0] in names:
            return True
        i += 2 if tok in takes_value else 1
    return False


# ------------------------------------------------------------------- repo state


def repo_root(start):
    if not start or not os.path.isdir(start):
        return None
    p = subprocess.run(["git", "-C", start, "rev-parse", "--show-toplevel"],
                       capture_output=True, timeout=30)
    root = p.stdout.decode("utf-8", "replace").strip()
    return root or None


def _git_path(root, which):
    out = sh_text(["git", "-C", root, "rev-parse", "--path-format=absolute", which]).strip()
    if not out:  # older git without --path-format
        out = sh_text(["git", "-C", root, "rev-parse", which]).strip()
        if out and not os.path.isabs(out):
            out = os.path.join(root, out)
    return out or os.path.join(root, ".git")


def shared_dir(root, create=True):
    """Approvals live under the *common* git dir — content-addressed, so sharing is fine,
    and it is the only location that exists in a linked worktree (.git is a file there)."""
    d = os.path.join(_git_path(root, "--git-common-dir"), STATE_DIR)
    if create:
        os.makedirs(d, exist_ok=True)
    return d


def state_dir(root, create=True):
    """The report is per-worktree. Parallel worktree agents each review their own code;
    a shared REPORT.md would let one worktree's review approve another's changes."""
    d = os.path.join(_git_path(root, "--git-dir"), STATE_DIR)
    if create:
        os.makedirs(d, exist_ok=True)
    return d


def current_branch(root):
    """`symbolic-ref` first: it resolves the branch name even on an unborn HEAD, where
    `rev-parse --abbrev-ref` returns nothing and would leave an initial commit ungated."""
    name = sh_text(["git", "-C", root, "symbolic-ref", "--short", "-q", "HEAD"]).strip()
    if name:
        return name
    return sh_text(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"]).strip()


def head_exists(root):
    return git_ok(root, "rev-parse", "--verify", "HEAD")


def has_parent(root):
    return git_ok(root, "rev-parse", "--verify", "HEAD~1")


def sequence_in_progress(root):
    """True while git is part-way through a rebase / merge / cherry-pick / revert.

    Read from the repository's own git dir rather than assumed to be `.git`, so a
    worktree or a submodule answers for itself.

    A bisect is deliberately NOT on this list. A conflict stop can legitimately be
    carried on by a commit the caller makes by hand, and that is the one thing the
    carve-out in run_hook buys. Not every stop is a conflict — `rebase-apply` is
    `git am`, and an `edit` / `break` stop needs no commit at all — and each of these
    sequences also has its own `--continue`, which makes the commit itself. A bisect
    has no such commit anywhere in its flow:
    `BISECT_LOG` is written by `git bisect start` and lives until
    `git bisect reset`, so listing it would switch the gate off for a whole bisect
    session and buy nothing in return. How long each of these markers lives
    varies, and that is the carve-out's cost rather than its justification — the
    note in run_hook spells it out.
    """
    gd = sh_text(["git", "-C", root, "rev-parse", "--absolute-git-dir"]).strip()
    if not gd:
        return False
    markers = ("rebase-merge", "rebase-apply", "MERGE_HEAD",
               "CHERRY_PICK_HEAD", "REVERT_HEAD")
    return any(os.path.exists(os.path.join(gd, m)) for m in markers)


def changed_paths(root):
    """Every path git considers changed — staged, unstaged, or untracked. NUL-safe."""
    raw = sh(["git", "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"])
    paths, fields = [], raw.split(b"\0")
    i = 0
    while i < len(fields):
        entry = fields[i]
        if len(entry) > 3:
            code = entry[:2]
            paths.append(entry[3:].decode("utf-8", "replace"))
            if b"R" in code or b"C" in code:  # rename/copy: next field is the source
                i += 1
        i += 1
    return sorted(set(paths))


def untracked_files(root):
    raw = sh(["git", "-C", root, "ls-files", "--others", "--exclude-standard", "-z"])
    return sorted(f.decode("utf-8", "replace") for f in raw.split(b"\0") if f)


def fingerprint(root, base):
    """Hash everything that could end up in a commit.

    Covers the index (what `git commit` actually writes), the unstaged worktree
    delta (what `-a` or a later `git add` would pull in), and untracked content.
    Reviewing one and committing another is the bypass this closes.
    """
    # No `--binary`: the `index <old>..<new>` blob SHAs already discriminate binary
    # content exactly, at constant memory. `--binary` would pipe whole files twice.
    h = hashlib.sha256()
    h.update(b"index\0")
    h.update(sh(["git", "-C", root, "diff", "--cached", base]))
    h.update(b"worktree\0")
    h.update(sh(["git", "-C", root, "diff"]))
    h.update(b"untracked\0")
    for rel in untracked_files(root):
        h.update(b"\0" + rel.encode("utf-8", "replace") + b"\0")
        path = os.path.join(root, rel)
        try:
            st = os.lstat(path)
            if stat.S_ISLNK(st.st_mode):
                h.update(b"symlink:" + os.readlink(path).encode("utf-8", "replace"))
                continue
            if not stat.S_ISREG(st.st_mode):
                h.update(b"nonregular")  # never read a FIFO/device: it can block forever
                continue
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(READ_CHUNK)
                    if not chunk:
                        break
                    h.update(chunk)
        except OSError as exc:
            h.update(f"unreadable:{exc.errno}".encode())
    return h.hexdigest()[:16]


def bases(root):
    """(normal base, amend base). Unborn HEAD diffs against the empty tree."""
    if not head_exists(root):
        return EMPTY_TREE, EMPTY_TREE
    return "HEAD", ("HEAD~1" if has_parent(root) else EMPTY_TREE)


def fingerprints(root):
    normal, amend = bases(root)
    return fingerprint(root, normal), fingerprint(root, amend)


def approved_set(root):
    path = os.path.join(shared_dir(root, create=False), "approved")
    if not os.path.exists(path):
        return set()
    out = set()
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            tok = line.split("\t")[0].strip()
            if tok:
                out.add(tok)
    return out


def is_doc_only(paths):
    """Prose-only change sets skip the gate — but never the files that ARE the rules."""
    if not paths:
        return False
    for p in paths:
        name = os.path.basename(p)
        if name in POLICY_FILES or any(d in p for d in POLICY_DIRS):
            return False
        if name in DOC_ONLY_NAMES or p.lower().endswith(DOC_ONLY_SUFFIXES):
            continue
        return False
    return True


# --------------------------------------------------------------------- the hook


def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def run_hook():
    data = json.load(sys.stdin)
    if data.get("tool_name") != "Bash":
        return
    cmd = data.get("tool_input", {}).get("command", "") or ""
    cwd = data.get("cwd") or os.getcwd()

    script = os.path.abspath(__file__)
    # Every commit the line could run is checked, and any one refusal refuses: a
    # dry run or another repository named in a commit message must not stand in
    # for the commit that actually runs.
    # An error checking one commit must not wave through another that would be
    # refused, so it only fails open once every commit has had its turn.
    error = None
    for found in find_commits(cmd, cwd):
        try:
            reason = refusal(found, cwd, script)
        except Exception as exc:
            error = error or exc
            continue
        if reason:
            deny(reason)
            return
    if error:
        raise error


def refusal(found, cwd, script):
    """Why this commit may not run yet, or None when it may."""
    # An unresolvable target (`git -C "$d" commit` in a loop, GIT_INDEX_FILE, a `cd`
    # through a variable) falls back to the session's cwd — which is a guess, and the
    # guess is usually a different repository than the one being committed to.
    #
    # That guess was harmless while only master was gated: the fallback repo was
    # almost never on master, so the command proceeded. Gating every branch turned it
    # into a refusal that names the wrong repository, and — worse — into a refusal
    # an approval recorded HERE would lift for a commit over THERE, with nobody
    # having reviewed that repository's changes.
    #
    # So a guessed target keeps the old, narrow rule: refuse only when the fallback
    # is on a branch whose merge deploys. Everywhere else the command proceeds. We
    # cannot gate a repository we could not identify, and pretending otherwise buys
    # a false refusal and a real hole.
    unresolved = found is UNRESOLVABLE
    if unresolved:
        repo_dir, sub_args = cwd, []
    else:
        repo_dir, sub_args = found

    if is_dry_run(sub_args):
        return None
    root = repo_root(repo_dir)
    if not root:
        return None  # not a git repo; nothing to gate

    branch = current_branch(root)
    if unresolved and branch not in AUTODEPLOY_BRANCHES:
        return None

    # A rebase, merge, cherry-pick or revert that stopped on a conflict is finished
    # by hand with a commit. What the sequence brings in was reviewed before it
    # started — the conflict resolution itself was not, it did not exist yet — and
    # `git rebase --continue` finishes the same stop without ever reaching this
    # hook, so gating the `git commit` spelling of it buys a daily false refusal on
    # every conflict and no safety at all.
    #
    # Be honest about the shape of this hole rather than overstating the carve-out:
    # a merge / cherry-pick / revert marker clears on the concluding commit, so at
    # most one commit slips through — though nothing bounds what else was staged
    # into it. A stopped rebase is weaker still: `rebase-merge` survives the commits
    # made under it and stays until the rebase finishes or is aborted, so any number
    # of unrelated commits made in that window pass ungated.
    # Gating the `git commit` spelling would close none of this: `--continue` is
    # ungated, and it accounts for exactly one commit — the extra ones in the window
    # are bounded by nothing. Closing it needs a pre-commit git hook, not a reader
    # of command lines.
    if sequence_in_progress(root):
        return None

    is_amend = has_flag(sub_args, "--amend")
    paths = changed_paths(root)
    if not paths:
        return None  # nothing to review (e.g. `--amend` for a message only)
    if is_doc_only(paths):
        return None

    fp, fp_amend = fingerprints(root)
    want = fp_amend if is_amend else fp
    if want in approved_set(root):
        return None

    # Every path below is read-only: a filesystem error while *formatting the refusal*
    # would be caught by the fail-open handler and silently turn this DENY into ALLOW.
    report = os.path.join(state_dir(root, create=False), REPORT_NAME)
    base = bases(root)[1] if is_amend else bases(root)[0]
    why = (
        "Merging here autodeploys to production without a test gate, so an unreviewed\n"
        "commit is an unreviewed prod."
        if branch in AUTODEPLOY_BRANCHES else
        "Every commit is reviewed, on every branch — a review that waits for the merge\n"
        "is an audit of a batch nobody read while it was being written."
    )
    return (
        f"BLOCKED: this change set on `{branch}` has no recorded review.\n"
        f"Repository: {root}\n"
        f"Change set: {len(paths)} file(s), fingerprint {want}\n\n"
        f"{why}\n\n"
        "Required order — do NOT self-approve without actually reviewing:\n"
        "  1. Run the build / linters / tests for this repository.\n"
        f"  2. Review the diff (`git -C {root} diff {base}`) for correctness, security,\n"
        "     performance and data integrity. Prefer an independent reviewer subagent\n"
        "     over self-inspection.\n"
        f"  3. Write the findings to {report} (or to a file OUTSIDE the worktree, passed\n"
        f"     as `--report PATH`). It names what it reviewed on a line `Fingerprint: {want}`;\n"
        "     edit anything after the review and that no longer matches. The outcome goes on\n"
        "     a line that opens with `Verdict:` and then APPROVE, REQUEST CHANGES or NEEDS\n"
        "     DISCUSSION, any comment after punctuation. Only APPROVE is recorded, and every\n"
        "     such line has to say it.\n"
        "  4. Fix every P0/P1 finding, then re-review.\n"
        f"  5. Record it and commit in one call:\n"
        f"       python3 {script} commit --repo {root} [--report PATH] -- <git commit args>\n"
        f"     or record only:  python3 {script} approve --repo {root} [--report PATH]\n\n"
        "The approval covers the index, the worktree and untracked files — changing any\n"
        "of them afterwards invalidates it.\n"
        "There is no unguarded branch to move the work to: this applies everywhere.\n"
        'If the user explicitly waived the review, use `approve --waive --reason "<their words>"`.'
    )


# ------------------------------------------------------------------ the verdict

# A line that opens with `Verdict:` once indentation and Markdown markup (quote,
# heading, bullet, emphasis, code span) are skipped — but not `::` or `:=`, which are
# code (`Verdict::Armed`, `verdict := decide()`). Strikethrough is not markup here:
# a struck-out verdict is a retracted one.
# `Fingerprint: 1a2b…` — the change set a report reviewed, as `status` prints it.
FINGERPRINT_LINE = re.compile(r"^[ \t>#*_`+-]*fingerprint[ *_`]*:[ \t*_`]*([0-9a-f]{16})\b",
                              re.I | re.M)
VERDICT_LINE = re.compile(r"[ \t>#*_`+-]*verdict[ *_`]*:(?![:=])(.*)", re.I)
# Another documented outcome named after the head, in any case and with any separator
# or none: the template pasted whole, `APPROVE, but request changes on the P1`,
# `APPROVE | RequestChanges`. Only the two phrases count, so "all requested changes
# are in" does not.
OTHER_OUTCOME = re.compile(r"REQUEST ?CHANGES|NEEDS ?DISCUSSION", re.I)


def verdict_head(value):
    """The words a verdict opens with, normalised: `**Request_Changes**.` -> REQUEST CHANGES.

    A word is a run of letters or digits in any script; words join across spaces,
    `_` and `-`. The head ends at the first other character, so `APPROVE — nits`
    reads as APPROVE, while `APPROVE with nits`, `APPROVE 3 P2s` and `НЕ APPROVE`
    read as every word they contain. A head struck out with `~~` is retracted, as a
    struck-out line is, and reads as none.
    """
    v = re.sub(r"(?<=\s)-+(?=\s)", ",", value)  # a spaced hyphen is a dash, not a joiner
    lead = re.match(r"[\W_]*", v).group(0)      # leading markup, punctuation, emoji
    if "~" in lead:
        return ""
    m = re.match(r"[^\W_]+(?:[\s_-]+[^\W_]+)*", v[len(lead):])
    return re.sub(r"[\s_-]+", " ", m.group(0)).upper() if m else ""


def read_verdict(text):
    """(verdict, problems) for a review report. It approves only if problems is empty.

    Every line that opens with `Verdict:` is a verdict, and each has to say APPROVE,
    with any comment after punctuation. Another outcome, an unknown word and an empty
    value all refuse: what the gate cannot read as an approval is not one. The old
    check refused only on the substring "request changes", so REQUEST_CHANGES and
    NEEDS DISCUSSION recorded approvals, and it took the first `verdict:` anywhere,
    so a sentence could stand in for the verdict.

    Prose is not read, on purpose: a `verdict:` mid-sentence counts for nothing either
    way — this codebase has a domain value called a verdict — so a report whose prose
    contradicts its `Verdict:` line is judged by the line. The comment after the
    punctuation is read for one thing only: naming REQUEST CHANGES or NEEDS
    DISCUSSION, in any case or spelling, refuses. Nothing else in it is parsed, so
    `APPROVE, once the P1 is fixed` records — a conditional approval is the
    reviewer's to avoid, not the gate's to detect.
    """
    fields, problems = [], []
    for line_no, line in enumerate(text.split("\n"), 1):
        m = VERDICT_LINE.match(line)
        if not m:
            continue
        value = m.group(1).strip()
        fields.append(value)
        names_other = OTHER_OUTCOME.search(re.sub(r"[\W_]+", " ", value))
        if names_other or verdict_head(value) not in APPROVING_VERDICTS:
            problems.append(f"line {line_no}: {value!r}")
    if not fields:
        problems.append("no line opens with `Verdict:`")
    return (fields[0] if fields else None), problems


# ------------------------------------------------------------------ subcommands


def parse_gate_args(argv, allow_waive):
    """`--repo`, `--report`, and for `approve` the waiver pair."""
    opts = {"repo": os.getcwd(), "report": None, "reason": "", "waive": False}
    i = 0
    while i < len(argv):
        if argv[i] == "--repo" and i + 1 < len(argv):
            opts["repo"], i = argv[i + 1], i + 2
        elif argv[i] == "--report" and i + 1 < len(argv):
            opts["report"], i = argv[i + 1], i + 2
        elif allow_waive and argv[i] == "--reason" and i + 1 < len(argv):
            opts["reason"], i = argv[i + 1], i + 2
        elif allow_waive and argv[i] == "--waive":
            opts["waive"], i = True, i + 1
        else:
            sys.exit(f"review-gate: unknown argument {argv[i]!r}")
    return opts


def _inside(path, directory):
    directory = os.path.realpath(directory)
    return os.path.commonpath([path, directory]) == directory


def review_verdict(root, report_arg, accepted, other=(), other_hint=""):
    """(verdict, report_path) from a report that approves, or exit with why not.

    A report named with `--report` must live outside the worktree: an untracked
    report inside it is part of the fingerprint it approves — and of the commit.
    The git directory is fine (the default REPORT.md lives there).

    The report names the change set it reviewed, and that has to be one of
    `accepted`. Without it an approval bound whatever was on disk when `approve`
    ran: review, APPROVE with nits, fix the nits, record — and the fixes went in
    unreviewed, against the rule that editing after a review voids it.
    """
    if report_arg:
        report = os.path.realpath(os.path.expanduser(report_arg))
        in_git_dir = any(_inside(report, _git_path(root, w))
                         for w in ("--git-dir", "--git-common-dir"))
        if _inside(report, root) and not in_git_dir:
            sys.exit(f"review-gate: {report} is inside the worktree {root}.\n"
                     "An untracked report changes the fingerprint it approves and would be "
                     "committed with the code; write it outside the worktree.")
    else:
        report = os.path.join(state_dir(root), REPORT_NAME)
    if not os.path.exists(report):
        sys.exit(f"review-gate: no review report at {report}\n"
                 "Write the review findings there first.")
    text = open(report, encoding="utf-8", errors="replace").read()
    if len(text.strip()) < MIN_REPORT_CHARS:
        sys.exit(f"review-gate: {report} is only {len(text.strip())} chars; "
                 "that is not a review.\nRecord what you checked and what you found.")
    verdict, problems = read_verdict(text)
    if problems:
        sys.exit(f"review-gate: {report} does not approve:\n  "
                 + "\n  ".join(problems)
                 + "\nEvery line that opens with `Verdict:` has to say APPROVE. A comment "
                 "may follow after\npunctuation (`Verdict: APPROVE — two nits below`) "
                 "but must not name REQUEST CHANGES\nor NEEDS DISCUSSION. If the review "
                 "did not approve, fix the findings and re-review;\ndo not edit its "
                 "verdict.")
    # The current value is deliberately not printed here: whoever reads a refusal
    # is the author, and pasting it would approve exactly the edits nobody reviewed.
    # The reviewer takes it from the deny text or `status`, when the review starts.
    quoted = {m.lower() for m in FINGERPRINT_LINE.findall(text)}
    if not quoted:
        sys.exit(f"review-gate: {report} does not say which change set it reviewed.\n"
                 "The reviewer quotes it on a line `Fingerprint: <value>`, taken from the "
                 "refusal or\nfrom `status` when the review starts — not added afterwards.")
    stale = quoted - set(accepted)
    if stale:
        # Every quoted one, as every `Verdict:` line has to approve: a report that
        # also names an older change set is a report about that one too.
        if stale <= set(other):
            sys.exit(f"review-gate: {report} quotes the fingerprint of the other basis: "
                     f"{other_hint}.")
        sys.exit(f"review-gate: {report} reviewed {', '.join(sorted(stale))}, which is not "
                 "the change set now.\nIt changed after the review: review what changed, "
                 "then quote the fingerprint that review saw.")
    return verdict, report


def record_approval(root, verdict, report=None, fps=None):
    """Bind `verdict` to the fingerprints; archive the report beside them.

    `fps` are the ones the report was checked against. Recomputing them here would
    approve whatever was written in between.
    """
    fp, fp_amend = fps or fingerprints(root)
    if report and os.path.exists(report):
        # Consumed, wherever it came from: a review approves ONE change set. Left in
        # place, the same file would approve every later fingerprint too — the
        # forgetful re-use this gate exists to catch. Moved BEFORE the approval is
        # written: a move that fails then records nothing, instead of leaving an
        # approval behind next to a report that can approve again.
        shutil.move(report, os.path.join(state_dir(root), f"report-{fp}.md"))
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    with open(os.path.join(shared_dir(root), "approved"), "a", encoding="utf-8") as f:
        for value in dict.fromkeys((fp, fp_amend)):
            f.write(f"{value}\t{stamp}\t{verdict}\n")
    return fp


def cmd_approve(argv):
    opts = parse_gate_args(argv, allow_waive=True)
    root = repo_root(opts["repo"])
    if not root:
        sys.exit(f"review-gate: {opts['repo']} is not inside a git repository")

    if opts["waive"]:
        if not opts["reason"]:
            sys.exit("review-gate: --waive requires --reason with the user's own words")
        verdict, report, fps = f"WAIVED BY USER: {opts['reason']}", None, None
    else:
        fps = fingerprints(root)
        verdict, report = review_verdict(root, opts["report"], set(fps))
    fp = record_approval(root, verdict, report, fps)
    print(f"review-gate: approved {fp} in {root} — {verdict}")


def cmd_commit(argv):
    """Approve if needed, then `git commit` — the same decision the hook makes.

    No waiver here on purpose: a waiver is the user's words, recorded by a
    separate, deliberate `approve --waive`.
    """
    if "--" not in argv:
        sys.exit("review-gate: usage: commit [--repo R] [--report PATH] -- <git commit args>")
    split = argv.index("--")
    opts = parse_gate_args(argv[:split], allow_waive=False)
    git_args = argv[split + 1:]
    root = repo_root(opts["repo"])
    if not root:
        sys.exit(f"review-gate: {opts['repo']} is not inside a git repository")

    paths = changed_paths(root)
    # A dry run is NOT exempted here, unlike in the hook: a dry run commits
    # nothing, so requiring the review costs nothing, and every flag spelling git
    # accepts stops mattering.
    needs_review = paths and not is_doc_only(paths) and not sequence_in_progress(root)
    if needs_review:
        fp, fp_amend = fingerprints(root)
        want = fp_amend if has_flag(git_args, "--amend") else fp
        if want not in approved_set(root):
            amend = want == fp_amend and fp_amend != fp
            verdict, report = review_verdict(
                root, opts["report"], {want}, other={fp, fp_amend} - {want},
                other_hint=("this commit is --amend; quote the `amend basis` line of `status`"
                            if amend else
                            "this commit is not --amend; quote the `fingerprint` line of `status`"))
            record_approval(root, verdict, report, (fp, fp_amend))
            print(f"review-gate: approved {want} in {root} — {verdict}", file=sys.stderr)
    # From the caller's directory, not the root: relative pathspecs and `-F FILE`
    # mean what they would have meant to a plain `git commit` typed there.
    sys.exit(subprocess.run(["git", "commit", *git_args], cwd=opts["repo"]).returncode)


def cmd_status(argv):
    repo = argv[argv.index("--repo") + 1] if "--repo" in argv else os.getcwd()
    root = repo_root(repo)
    if not root:
        sys.exit(f"review-gate: {repo} is not inside a git repository")
    fp, fp_amend = fingerprints(root)
    ok = approved_set(root)
    paths = changed_paths(root)
    branch = current_branch(root)
    print(f"repo:        {root}")
    print(f"branch:      {branch}  gated=True"
          + ("  (autodeploys to production)" if branch in AUTODEPLOY_BRANCHES else ""))
    print(f"report:      {os.path.join(state_dir(root, create=False), REPORT_NAME)}")
    print(f"approvals:   {os.path.join(shared_dir(root, create=False), 'approved')}")
    print(f"changed:     {len(paths)} file(s)")
    print(f"fingerprint: {fp}  approved={fp in ok}")
    print(f"amend basis: {fp_amend}  approved={fp_amend in ok}")
    if paths and is_doc_only(paths):
        print("note:        docs-only change set — the gate does not apply")
    if sequence_in_progress(root):
        print("note:        rebase/merge/cherry-pick/revert in progress — "
              "the gate does not apply until it ends")


def main():
    argv = sys.argv[1:]
    if not argv:
        try:
            run_hook()
        except Exception as exc:  # never brick the session on a gate bug
            print(f"review-gate: failing open ({exc!r})", file=sys.stderr)
        return
    if argv[0] == "approve":
        cmd_approve(argv[1:])
    elif argv[0] == "commit":
        cmd_commit(argv[1:])
    elif argv[0] == "status":
        cmd_status(argv[1:])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
