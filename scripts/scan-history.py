#!/usr/bin/env python3
"""Scan every Git blob reachable from every local commit."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import PurePosixPath

from scan import (
    BUILTIN_PATTERNS,
    FORBIDDEN_DIRS,
    FORBIDDEN_SUFFIXES,
    allow_categories,
    allow_file_categories,
    load_private_patterns,
)


def git(*args: str, binary: bool = False) -> bytes | str:
    result = subprocess.run(
        ["git", *args],
        check=False,
        capture_output=True,
        text=not binary,
    )
    if result.returncode != 0:
        stderr = result.stderr.decode() if binary else result.stderr
        raise RuntimeError(stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout


def path_finding(path: str, mode: str) -> str | None:
    parts = PurePosixPath(path).parts
    if mode == "120000":
        return "symlink"
    if any(part.casefold() in FORBIDDEN_DIRS for part in parts[:-1]):
        return "forbidden_path"
    lower = parts[-1].casefold()
    if lower == ".env" or (lower.startswith(".env.") and lower != ".env.example"):
        return "forbidden_path"
    if any(lower.endswith(suffix) for suffix in FORBIDDEN_SUFFIXES):
        return "forbidden_path"
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-pattern-file")
    args = parser.parse_args()
    try:
        private = load_private_patterns(args.private_pattern_file)
        commits = [line for line in str(git("rev-list", "--all")).splitlines() if line]
    except (RuntimeError, ValueError) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 2
    if not commits:
        print("vacuous_history\tno reachable commits")
        return 1

    findings: list[str] = []
    seen_blobs: set[str] = set()
    scanned_bytes = 0
    patterns = (*BUILTIN_PATTERNS, *private)
    for commit in commits:
        tree = git("ls-tree", "-r", "-z", commit, binary=True)
        assert isinstance(tree, bytes)
        for record in tree.split(b"\0"):
            if not record:
                continue
            meta, raw_path = record.split(b"\t", 1)
            mode, object_type, object_id = meta.decode("ascii").split(" ")
            path = raw_path.decode("utf-8", errors="strict")
            category = path_finding(path, mode)
            if category:
                findings.append(f"{category}\t{commit[:12]}:{path}")
            if object_type != "blob" or object_id in seen_blobs:
                continue
            seen_blobs.add(object_id)
            raw = git("cat-file", "blob", object_id, binary=True)
            assert isinstance(raw, bytes)
            scanned_bytes += len(raw)
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                findings.append(f"binary_or_encoding\t{commit[:12]}:{path}")
                continue
            file_allowed = allow_file_categories(text)
            for number, line in enumerate(text.splitlines(), 1):
                allowed = allow_categories(line) | file_allowed
                for pattern_category, pattern in patterns:
                    base = pattern_category.split(":", 1)[0].casefold()
                    if pattern_category.casefold() in allowed or base in allowed:
                        continue
                    if pattern.search(line):
                        findings.append(
                            f"{pattern_category}\t{commit[:12]}:{path}:{number}"
                        )
    findings.sort()
    if not seen_blobs or scanned_bytes == 0:
        findings.append("vacuous_history\tzero blobs or bytes")
    for finding in findings:
        print(finding)
    status = "FAIL" if findings else "PASS"
    print(
        f"{status} commits={len(commits)} blobs={len(seen_blobs)} "
        f"bytes={scanned_bytes} private_patterns={len(private)} findings={len(findings)}"
    )
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
