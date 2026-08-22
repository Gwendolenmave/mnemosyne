#!/usr/bin/env python3
"""Fail-closed repository privacy scanner for Mnemosyne Public.

The public rules are intentionally generic. Exact private values are supplied by
the owner from an untracked file with ``--private-pattern-file``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


SKIP_DIRS = {".git", "node_modules", ".cache", ".pytest_cache", "__pycache__"}
FORBIDDEN_DIRS = {"data", "logs", "secrets", "backups", "receipts"}
FORBIDDEN_SUFFIXES = {
    ".db", ".sqlite", ".sqlite3", ".wal", ".shm", ".pem", ".key",
    ".p12", ".pfx", ".keystore", ".jsonl", ".ndjson",
}
TEXT_SUFFIXES = {
    "", ".cjs", ".css", ".csv", ".gitignore", ".html", ".js", ".json",
    ".lock", ".md", ".mjs", ".py", ".sh", ".toml", ".ts", ".tsx",
    ".txt", ".yaml", ".yml", ".nvmrc", ".tsv",
}
GREEK_ONTOLOGY = {
    "mnemosyne", "anamnesis", "lethe", "muse", "musagetes", "calliope",
    "clio", "erato", "euterpe", "melpomene", "polyhymnia", "terpsichore",
    "thalia", "urania", "delos",
}


@dataclass(frozen=True)
class Finding:
    category: str
    path: str
    line: int
    detail: str


BUILTIN_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("secret", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),  # scan:allow secret
    ("secret", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),  # scan:allow secret
    ("secret", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,255}\b")),  # scan:allow secret
    ("secret", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,255}\b")),  # scan:allow secret
    ("secret", re.compile(r"\bsk-[A-Za-z0-9_-]{24,255}\b")),  # scan:allow secret
    ("email", re.compile(r"(?<![\w.+-])[\w.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w.-])")),  # scan:allow email
    ("home_path", re.compile(r"/(?:home|Users)/[A-Za-z0-9._-]+/")),  # scan:allow home_path
    ("home_path", re.compile(r"[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+[\\/]", re.I)),  # scan:allow home_path
    ("url_credentials", re.compile(r"https?://[^\s/:]+:[^\s/@]+@", re.I)),  # scan:allow url_credentials
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument(
        "--private-pattern-file",
        help="Untracked UTF-8 file: one literal per line, or label<TAB>literal.",
    )
    parser.add_argument("--json", action="store_true", dest="json_output")
    return parser.parse_args()


def load_private_patterns(path: str | None) -> list[tuple[str, re.Pattern[str]]]:
    if not path:
        return []
    source = Path(path).resolve()
    if not source.is_file():
        raise ValueError(f"private pattern file not found: {source}")
    patterns: list[tuple[str, re.Pattern[str]]] = []
    for number, raw in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
        value = raw.strip()
        if not value or value.startswith("#"):
            continue
        label, literal = (value.split("\t", 1) + [""])[:2] if "\t" in value else ("literal", value)
        literal = literal.strip()
        if not literal:
            raise ValueError(f"empty private literal at {source}:{number}")
        if literal.casefold() in GREEK_ONTOLOGY:
            raise ValueError(f"Greek ontology cannot be a private pattern: {literal}")
        patterns.append((f"private:{label.strip() or 'literal'}", re.compile(re.escape(literal), re.I)))
    if not patterns:
        raise ValueError(f"private pattern file contains no patterns: {source}")
    return patterns


def allow_categories(line: str) -> set[str]:
    marker = "scan:allow"
    if marker not in line:
        return set()
    tail = line.split(marker, 1)[1]
    return {token.strip().casefold() for token in re.split(r"[,\s]+", tail) if token.strip()}


def allow_file_categories(text: str) -> set[str]:
    """Return categories explicitly declared public for one whole text file."""
    marker = "scan:allow-file"
    allowed: set[str] = set()
    for line in text.splitlines():
        if marker not in line:
            continue
        tail = line.split(marker, 1)[1].split("-->", 1)[0].split("*/", 1)[0]
        allowed.update(token.strip().casefold() for token in re.split(r"[,\s]+", tail) if token.strip())
    return allowed


def display_path(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def walk_files(root: Path) -> tuple[list[Path], list[Finding]]:
    files: list[Path] = []
    findings: list[Finding] = []
    for current, dirs, names in os.walk(root, followlinks=False):
        current_path = Path(current)
        retained: list[str] = []
        for name in sorted(dirs):
            child = current_path / name
            relative = display_path(root, child)
            if child.is_symlink():
                findings.append(Finding("symlink", relative, 0, "directory symlink is forbidden"))
                continue
            if name in SKIP_DIRS:
                continue
            if name.casefold() in FORBIDDEN_DIRS:
                findings.append(Finding("forbidden_path", relative, 0, "runtime/private directory is forbidden"))
                continue
            retained.append(name)
        dirs[:] = retained
        for name in sorted(names):
            path = current_path / name
            relative = display_path(root, path)
            if path.is_symlink():
                findings.append(Finding("symlink", relative, 0, "file symlink is forbidden"))
                continue
            lower = name.casefold()
            if lower == ".env" or (lower.startswith(".env.") and lower != ".env.example"):
                findings.append(Finding("forbidden_path", relative, 0, "environment file is forbidden"))
                continue
            if any(lower.endswith(suffix) for suffix in FORBIDDEN_SUFFIXES):
                findings.append(Finding("forbidden_path", relative, 0, "private/runtime artifact suffix is forbidden"))
                continue
            files.append(path)
    return files, findings


def scan_text(
    root: Path,
    path: Path,
    patterns: Iterable[tuple[str, re.Pattern[str]]],
) -> tuple[list[Finding], int]:
    relative = display_path(root, path)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        return [Finding("read_error", relative, 0, str(exc))], 0
    if path.suffix.casefold() not in TEXT_SUFFIXES and b"\x00" in raw[:8192]:
        return [Finding("binary", relative, 0, "unreviewed binary file is forbidden")], len(raw)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return [Finding("encoding", relative, 0, "file is not valid UTF-8 text")], len(raw)
    findings: list[Finding] = []
    file_allowed = allow_file_categories(text)
    for number, line in enumerate(text.splitlines(), 1):
        allowed = allow_categories(line) | file_allowed
        for category, pattern in patterns:
            base_category = category.split(":", 1)[0].casefold()
            if category.casefold() in allowed or base_category in allowed:
                continue
            match = pattern.search(line)
            if match:
                findings.append(
                    Finding(category, relative, number, f"matched {len(match.group(0))} character(s)")
                )
    return findings, len(raw)


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"ERROR root is not a directory: {root}", file=sys.stderr)
        return 2
    try:
        private_patterns = load_private_patterns(args.private_pattern_file)
    except ValueError as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 2
    files, findings = walk_files(root)
    byte_count = 0
    patterns = (*BUILTIN_PATTERNS, *private_patterns)
    for path in files:
        file_findings, size = scan_text(root, path, patterns)
        findings.extend(file_findings)
        byte_count += size
    if not files or byte_count == 0:
        findings.append(Finding("vacuous_scan", ".", 0, "scan walked zero files or zero bytes"))
    findings.sort(key=lambda item: (item.path, item.line, item.category))
    report = {
        "root": str(root),
        "files": len(files),
        "bytes": byte_count,
        "private_patterns": len(private_patterns),
        "findings": [asdict(item) for item in findings],
        "status": "FAIL" if findings else "PASS",
    }
    if args.json_output:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        for finding in findings:
            location = f"{finding.path}:{finding.line}" if finding.line else finding.path
            print(f"{finding.category}\t{location}\t{finding.detail}")
        print(
            f"{report['status']} files={report['files']} bytes={report['bytes']} "
            f"private_patterns={report['private_patterns']} findings={len(findings)}"
        )
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
