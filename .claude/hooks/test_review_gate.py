#!/usr/bin/env python3
"""Tests for review-gate.py: which review reports `approve` records.

Stdlib only. Run it as a script, from anywhere:

    python3 .claude/hooks/test_review_gate.py

Not through `python3 -m unittest`: that caches this module under __pycache__/, and in
a repository that does not ignore it, the untracked .pyc changes the fingerprint an
approval is bound to — running the tests would void the approval they back.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True  # the hook module loaded below must not leave a .pyc

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "review-gate.py")
_spec = importlib.util.spec_from_file_location("review_gate", HOOK)
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)


def problems(report):
    return gate.read_verdict(report)[1]


class ReadVerdictTest(unittest.TestCase):
    def assert_approves(self, *reports):
        for report in reports:
            with self.subTest(report=report):
                self.assertEqual(problems(report), [])

    def assert_refuses(self, *reports):
        for report in reports:
            with self.subTest(report=report):
                self.assertNotEqual(problems(report), [])

    def test_approve_in_any_case_and_markup(self):
        self.assert_approves(
            "Verdict: APPROVE",
            "Verdict: Approve",
            "verdict: approve",
            "Verdict: APPROVED",
            "**Verdict:** APPROVE",
            "**Verdict: APPROVE.**",
            "**Verdict**: APPROVE",
            "_Verdict_: APPROVE",
            "`Verdict`: APPROVE",
            "Verdict : APPROVE",
            "## Verdict: APPROVE",
            "- Verdict: `APPROVE`",
            "+ Verdict: APPROVE",
            "__Verdict:__ APPROVE",
            "`Verdict: APPROVE`",
            "\tVerdict: APPROVE",
            "> Verdict: ✅ APPROVE",
        )

    def test_approve_with_commentary_after_punctuation(self):
        self.assert_approves(
            "Verdict: APPROVE — no P0 or P1 outstanding.",
            "Verdict: APPROVE, no P0–P2",
            "Verdict: APPROVE - no P0",
            "Verdict: APPROVE -- no P0",
            "Verdict: APPROVE (after round 3)",
            # Only the exact outcome phrases refuse; requested changes are just words.
            "Verdict: APPROVE — all requested changes are in",
        )

    def test_request_changes_in_any_spelling(self):
        self.assert_refuses(
            "Verdict: REQUEST CHANGES",
            "Verdict: REQUEST_CHANGES",
            "Verdict: request-changes",
            "Verdict: RequestChanges",
            "Verdict: CHANGES REQUESTED",
            "**Verdict:** REQUEST_CHANGES — P1 in the migration",
        )

    def test_needs_discussion_in_any_spelling(self):
        self.assert_refuses(
            "Verdict: NEEDS DISCUSSION",
            "Verdict: NEEDS_DISCUSSION",
            "Verdict: needs-discussion",
        )

    def test_empty_verdict(self):
        self.assert_refuses("Verdict:", "Verdict:   ", "**Verdict:**", "Verdict: —")

    def test_unknown_word(self):
        self.assert_refuses(
            "Verdict: LGTM",
            "Verdict: safe to commit",
            "Verdict: P0 empty, P1 empty",
            "Verdict: APPROVE with nits",
            "Verdict: APPROVE_WITH_NITS",
            "Verdict: APPROVE-ish",
            "Verdict: APPROVE 3 P2s remain",  # a comment follows punctuation, not a digit
            "Verdict: NOT APPROVE",
            "Verdict: DO NOT APPROVE",
            "Verdict: НЕ APPROVE",  # a word in another script is a word, not markup
            "Verdict: APP" + chr(0x200B) + "ROVE",  # an invisible character splits the word
        )

    def test_approve_that_also_names_another_outcome(self):
        self.assert_refuses(
            "Verdict: APPROVE | REQUEST CHANGES | NEEDS DISCUSSION",  # the template, pasted
            "Verdict: APPROVE / REQUEST_CHANGES",
            "Verdict: APPROVE / NEEDS_DISCUSSION",
            "Verdict: APPROVE, once the REQUEST_CHANGES items land",
            # In any case: the old substring check refused these, and so must this one.
            "Verdict: Approve | Request Changes | Needs Discussion",
            "Verdict: APPROVE, but request changes on the P1 before merge",
            "Verdict: APPROVE | RequestChanges",
            "Verdict: APPROVE | NeedsDiscussion",
        )

    def test_no_verdict_line(self):
        self.assert_refuses(
            "",
            "Looks fine to me.",
            "Final verdict: APPROVE",  # the verdict opens its line; mid-line is prose
            "## Verdict\n\nAPPROVE",
        )

    def test_struck_out_verdict_is_retracted(self):
        self.assert_refuses(
            "~~Verdict: APPROVE~~",
            "Verdict: ~~APPROVE~~",
            "Verdict: **~~APPROVE~~**",
            "Verdict: ~~APPROVE~~ BLOCK — P0 in the migration",
        )
        self.assert_approves("Verdict: APPROVE — ~~P1~~ fixed in round 2")

    def test_every_verdict_line_must_approve(self):
        self.assert_refuses(
            "Verdict: APPROVE\n\n## Round 2\nVerdict: REQUEST_CHANGES",
            "Verdict: REQUEST CHANGES\n\n## Round 2\nVerdict: APPROVE",
        )
        self.assert_approves("Verdict: APPROVE\n\n## Round 2\nVerdict: APPROVE")

    def test_prose_is_not_read(self):
        # The old check took the first `verdict:` anywhere, so prose outranked the verdict.
        self.assert_refuses(
            "The previous verdict: APPROVE, on another diff.\nVerdict: REQUEST_CHANGES")
        # Prose, quoted examples and code are not verdicts, whatever they say.
        self.assert_approves(
            "Advice, never a verdict: nothing here changes whether it arms.\nVerdict: APPROVE",
            "The old hook recorded `Verdict: REQUEST_CHANGES`.\nVerdict: APPROVE",
            "    verdict := armDecision(basis)\nVerdict: APPROVE",
            "`Verdict::Armed` is the enum.\nVerdict: APPROVE",
        )

    def test_refusal_names_the_line(self):
        self.assertEqual(problems("Checked.\n\nVerdict: REQUEST_CHANGES\n"),
                         ["line 3: 'REQUEST_CHANGES'"])


class FindCommitTest(unittest.TestCase):
    """Which command lines the hook reads as a commit, and into which repository."""

    REPO = "/work/repo"

    def found(self, cmd):
        hit = gate.find_commit(cmd, "/")
        return None if hit is None or hit is gate.UNRESOLVABLE else hit[0]

    def test_apostrophe_in_a_heredoc_body_does_not_hide_the_commit(self):
        # The exact shape that let an unreviewed commit through: an apostrophe in
        # the message opened a quote that swallowed the `git commit` after it.
        cmd = (f"cd {self.REPO} && git add -A && cat > m.txt <<'EOF'\n"
               "fix(ui): x\n\nThe dashboard's toast moves into an effect.\nEOF\n"
               "git commit -F m.txt 2>&1 | tail -30")
        self.assertEqual(self.found(cmd), self.REPO)

    def test_every_heredoc_spelling(self):
        for opener, closer in (("<<EOF", "EOF"), ("<< 'EOF'", "EOF"), ('<<"END"', "END"),
                               ("<<-EOF", "\tEOF")):
            with self.subTest(opener=opener):
                cmd = (f"cd {self.REPO} && cat > m.txt {opener}\nit's\n{closer}\n"
                       "git commit -F m.txt")
                self.assertEqual(self.found(cmd), self.REPO)

    def test_a_heredoc_body_is_scanned_as_a_script(self):
        # `bash <<'EOF'` runs its body. A body that only looks like one (a commit
        # message with a `git commit` line) costs an extra refusal — the cheap side.
        for cmd in (f"cd {self.REPO} && bash <<'EOF'\ngit add -A\ngit commit -m wip\nEOF",
                    f"sh <<EOF\ncd {self.REPO} && git commit -m wip\nEOF",
                    f"cat <<EOF | bash\ncd {self.REPO}; git commit -m x\nEOF",
                    f"cd {self.REPO} && bash -s <<'S'\nset -e\ngit commit -m \"it's\"\nS"):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.found(cmd), self.REPO)

    def test_a_delimiter_is_the_whole_word(self):
        # Read as `EOF`, `<<EOF-MSG` skipped to the next heredoc's `EOF` line and
        # swallowed the commit between them.
        cmd = (f"cd {self.REPO}\ncat > a <<EOF-MSG\nx\nEOF-MSG\ngit commit -F a\n"
               "cat > b <<EOF\ny\nEOF")
        self.assertEqual(self.found(cmd), self.REPO)

    def test_a_backslashed_delimiter(self):
        cmd = (f"cd {self.REPO}\ncat > a <<\\EOF\ndon't\nEOF\ngit commit -F a\n"
               "cat > b <<\\EOF\nit's\nEOF")
        self.assertEqual(self.found(cmd), self.REPO)

    def test_a_here_string_is_not_a_heredoc(self):
        cmd = f"cd {self.REPO}\nfor f in a; do\n  grep -q a <<<done\n  git commit -m x\ndone"
        self.assertEqual(self.found(cmd), self.REPO)

    def test_a_relative_cd_after_an_unknown_one_does_not_crash(self):
        # A TypeError here is a silent allow: the hook fails open.
        self.assertIs(gate.find_commit('cd "$REPO"; cd sub && git commit -m x', "/"),
                      gate.UNRESOLVABLE)

    def test_the_line_own_commit_comes_before_one_in_its_message(self):
        # A refusal names the first hit; it should name the repository committed to.
        cmd = (f"cd {self.REPO} && cat > m <<'EOF'\nsee `git -C /work/other commit`\nEOF\n"
               "git commit -F m")
        self.assertEqual([h[0] for h in gate.find_commits(cmd, "/")],
                         [self.REPO, "/work/other"])

    def test_a_shift_is_not_a_heredoc(self):
        # No line closes it, so nothing after it may be swallowed.
        cmd = f"echo $((a << b))\ncd {self.REPO} && git commit -m x"
        self.assertEqual(self.found(cmd), self.REPO)

    def test_an_unclosed_quote_is_read_again_without_quotes(self):
        cmd = f"echo it's && cd {self.REPO} && git commit -m x"
        self.assertEqual(self.found(cmd), self.REPO)

    def test_quoted_separators_still_do_not_split(self):
        self.assertIsNone(gate.find_commit("echo 'a && git commit -m x'", self.REPO))


class ApproveEndToEnd(unittest.TestCase):
    """The defect lives where `approve` writes the approvals file and the commit hook
    reads it, so these run the real script against a scratch repository."""

    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="review-gate-test-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        # GIT_DIR and friends outrank `git -C`, and a user's git config is not under test.
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                        PYTHONDONTWRITEBYTECODE="1",
                        # Identity for the commits `commit` makes; none of these redirect.
                        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
                        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid")
        subprocess.run(["git", "init", "-q", self.repo], env=self.env, check=True,
                       capture_output=True)
        with open(os.path.join(self.repo, "main.go"), "w") as f:
            f.write("package main\n")

    def run_gate(self, *args, stdin=None):
        return subprocess.run([sys.executable, HOOK, *args], input=stdin, env=self.env,
                              cwd=self.repo, capture_output=True, text=True, timeout=60)

    def fingerprint(self, which="fingerprint"):
        """The current fingerprint as `status` prints it (`fingerprint` / `amend basis`)."""
        out = self.run_gate("status", "--repo", self.repo).stdout
        return next(l.split(":", 1)[1].split()[0] for l in out.splitlines()
                    if l.startswith(which + ":"))

    def report_text(self, verdict_line, fingerprint=None):
        fp = self.fingerprint() if fingerprint is None else fingerprint
        return ("Read the whole diff and ran the tests; findings below.\n" * 5
                + (f"\nFingerprint: {fp}\n" if fp else "") + "\n" + verdict_line + "\n")

    def approve(self, verdict_line, fingerprint=None):
        state = os.path.join(self.repo, ".git", "review-gate")
        os.makedirs(state, exist_ok=True)
        with open(os.path.join(state, "REPORT.md"), "w", encoding="utf-8") as f:
            f.write(self.report_text(verdict_line, fingerprint))
        return self.run_gate("approve", "--repo", self.repo)

    def commit_is_allowed(self, command="git commit -m change"):
        payload = json.dumps({"tool_name": "Bash", "cwd": self.repo,
                              "tool_input": {"command": command}})
        p = self.run_gate(stdin=payload)
        # An internal error allows too — that would be a vacuous pass, not an approval.
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn("failing open", p.stderr)
        if not p.stdout.strip():
            return True
        decision = json.loads(p.stdout)["hookSpecificOutput"]["permissionDecision"]
        self.assertEqual(decision, "deny")
        return False

    def test_non_approving_verdict_records_nothing(self):
        for line in ("Verdict: REQUEST_CHANGES", "Verdict: NEEDS_DISCUSSION",
                     "Verdict:", "Verdict: LGTM"):
            with self.subTest(line=line):
                p = self.approve(line)
                self.assertNotEqual(p.returncode, 0, p.stdout)
                self.assertIn("does not approve", p.stderr)
                self.assertFalse(self.commit_is_allowed())

    def test_approve_records_and_lets_the_commit_through(self):
        self.assertFalse(self.commit_is_allowed())
        p = self.approve("Verdict: APPROVE")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(self.commit_is_allowed())

    def test_a_report_names_the_change_set_it_reviewed(self):
        p = self.approve("Verdict: APPROVE", fingerprint="")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("does not say which change set", p.stderr)
        # The author reads this; handing them the value would approve unreviewed edits.
        self.assertNotIn(self.fingerprint(), p.stderr)
        self.assertFalse(self.commit_is_allowed())

    def test_every_quoted_fingerprint_must_be_current(self):
        stale = "0123456789abcdef"
        p = self.approve(f"Fingerprint: {stale}\nVerdict: APPROVE")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("changed after the review", p.stderr)
        self.assertFalse(self.commit_is_allowed())

    def test_an_edit_after_the_review_voids_the_report(self):
        # APPROVE with nits, the nits fixed, then recorded: the fixes were never reviewed.
        reviewed = self.fingerprint()
        with open(os.path.join(self.repo, "main.go"), "a") as f:
            f.write("// a nit fixed after the review\n")
        for record in (lambda: self.approve("Verdict: APPROVE", reviewed),
                       lambda: self.run_gate("commit", "--repo", self.repo, "--report",
                                             self.outside_report("Verdict: APPROVE", reviewed),
                                             "--", "-q", "-m", "x")):
            p = record()
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("changed after the review", p.stderr)
        self.assertFalse(self.commit_is_allowed())
        self.assertEqual(self.commits(), 0)

    def test_commit_amend_wants_the_amend_fingerprint(self):
        subprocess.run(["git", "-C", self.repo, "add", "-A"], env=self.env, check=True)
        subprocess.run(["git", "-C", self.repo, "commit", "-q", "-m", "first"], env=self.env,
                       check=True)
        with open(os.path.join(self.repo, "main.go"), "a") as f:
            f.write("// amended\n")
        subprocess.run(["git", "-C", self.repo, "add", "-A"], env=self.env, check=True)
        plain = self.outside_report("Verdict: APPROVE", self.fingerprint())
        p = self.run_gate("commit", "--repo", self.repo, "--report", plain,
                          "--", "-q", "--amend", "-m", "x")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("this commit is --amend", p.stderr)
        amend = self.outside_report("Verdict: APPROVE", self.fingerprint("amend basis"))
        p = self.run_gate("commit", "--repo", self.repo, "--report", amend,
                          "--", "-q", "--amend", "-m", "x")
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_a_commit_named_in_the_message_does_not_stand_in_for_the_real_one(self):
        # The first "commit" met used to decide: one in the message, read as a dry
        # run or as another repository, let the real, unreviewed one through.
        other = tempfile.mkdtemp(prefix="review-gate-other-")
        self.addCleanup(shutil.rmtree, other, True)
        subprocess.run(["git", "init", "-q", other], env=self.env, check=True,
                       capture_output=True)
        for command in (
            "cat > m <<'EOF'\nfix(gate): x\n\ngit commit --dry-run needs no review.\nEOF\n"
            "git commit -F m",
            "git commit -m \"$(cat <<'EOF'\nfeat: `git commit --dry-run` passes\nEOF\n)\"",
            f"cat > m <<'EOF'\nfix: run `git -C {other} commit` there\nEOF\ngit commit -F m",
        ):
            with self.subTest(command=command):
                self.assertFalse(self.commit_is_allowed(command))
        self.assertTrue(self.commit_is_allowed("git commit --dry-run -m x"))


    # ---- `--report PATH` and `commit`

    def outside_report(self, verdict_line, fingerprint=None):
        d = tempfile.mkdtemp(prefix="review-gate-report-")
        self.addCleanup(shutil.rmtree, d, True)
        path = os.path.join(d, "review.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(self.report_text(verdict_line, fingerprint))
        return path

    def commits(self):
        p = subprocess.run(["git", "-C", self.repo, "rev-list", "--all", "--count"],
                           env=self.env, capture_output=True, text=True)
        return int(p.stdout.strip() or 0)

    def test_report_from_outside_the_worktree_approves_and_stays(self):
        report = self.outside_report("Verdict: APPROVE")
        p = self.run_gate("approve", "--repo", self.repo, "--report", report)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(self.commit_is_allowed())
        self.assertFalse(os.path.exists(report), "one review, one change set: consumed")

    def test_a_report_does_not_approve_a_later_change_set(self):
        report = self.outside_report("Verdict: APPROVE")
        backup = report + ".keep"
        shutil.copyfile(report, backup)
        self.assertEqual(self.run_gate("approve", "--repo", self.repo, "--report", report).returncode, 0)
        with open(os.path.join(self.repo, "main.go"), "a") as f:
            f.write("// edited after the review\n")
        self.assertFalse(self.commit_is_allowed())
        p = self.run_gate("approve", "--repo", self.repo, "--report", report)
        self.assertNotEqual(p.returncode, 0, "the consumed report is gone")
        self.assertFalse(self.commit_is_allowed())

    def test_report_inside_the_worktree_is_refused(self):
        report = os.path.join(self.repo, "review.md")
        with open(report, "w", encoding="utf-8") as f:
            f.write("Read the whole diff and ran the tests.\n" * 8 + "Verdict: APPROVE\n")
        p = self.run_gate("approve", "--repo", self.repo, "--report", report)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("inside the worktree", p.stderr)
        self.assertFalse(self.commit_is_allowed())

    def test_commit_approves_and_commits_in_one_call(self):
        subprocess.run(["git", "-C", self.repo, "add", "-A"], env=self.env, check=True)
        report = self.outside_report("Verdict: APPROVE")
        p = self.run_gate("commit", "--repo", self.repo, "--report", report,
                          "--", "-q", "-m", "feat: change")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.commits(), 1)

    def test_commit_without_an_approving_review_commits_nothing(self):
        subprocess.run(["git", "-C", self.repo, "add", "-A"], env=self.env, check=True)
        for extra in ([], ["--report", self.outside_report("Verdict: REQUEST_CHANGES")]):
            with self.subTest(extra=extra):
                p = self.run_gate("commit", "--repo", self.repo, *extra, "--", "-m", "x")
                self.assertNotEqual(p.returncode, 0)
                self.assertEqual(self.commits(), 0)

    def test_commit_after_a_separate_approve_needs_no_report(self):
        subprocess.run(["git", "-C", self.repo, "add", "-A"], env=self.env, check=True)
        self.assertEqual(self.approve("Verdict: APPROVE").returncode, 0)
        p = self.run_gate("commit", "--repo", self.repo, "--", "-q", "-m", "x")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.commits(), 1)

    def test_commit_skips_review_only_where_the_hook_does(self):
        subprocess.run(["git", "-C", self.repo, "add", "-A"], env=self.env, check=True)
        # A dry run commits nothing; the last of --dry-run/--no-dry-run is what git obeys.
        p = self.run_gate("commit", "--repo", self.repo, "--", "--dry-run", "--no-dry-run", "-m", "x")
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.commits(), 0)
        self.assertFalse(gate.is_dry_run(["--no-dry-run", "--dry-run"]), "negation anywhere: review")
        self.assertFalse(gate.is_dry_run(["--dry-run", "--no-dry", "-m", "x"]))
        self.assertFalse(gate.is_dry_run(["--dry-run", "--no-dry-run", "-m", "--dry-run"]))
        self.assertTrue(gate.is_dry_run(["--dry-run", "-m", "x"]))
        self.assertFalse(gate.is_dry_run(["--dry-run", "--no-dry-run"]))
        self.assertFalse(gate.is_dry_run(["--pathspec-from-file", "--dry-run"]))

    def test_commit_resolves_paths_from_the_callers_directory(self):
        sub = os.path.join(self.repo, "pkg")
        os.makedirs(sub)
        with open(os.path.join(sub, "a.go"), "w") as f:
            f.write("package pkg\n")
        subprocess.run(["git", "-C", self.repo, "add", "-A"], env=self.env, check=True)
        report = self.outside_report("Verdict: APPROVE")
        p = self.run_gate("commit", "--repo", sub, "--report", report, "--", "-q", "-m", "x", "a.go")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.commits(), 1)

    def test_commit_needs_the_separator(self):
        p = self.run_gate("commit", "--repo", self.repo, "-m", "x")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("usage", p.stderr)
        self.assertEqual(self.commits(), 0)

    def test_the_hook_lets_the_commit_subcommand_through(self):
        # The subcommand enforces the review itself; the hook must not also demand
        # an approval before it, or the one-call flow could never run.
        cmd = f'python3 "{HOOK}" commit --report /tmp/r.md -- -m "fix: x"'
        self.assertIsNone(gate.find_commit(cmd, self.repo))


if __name__ == "__main__":
    unittest.main()
