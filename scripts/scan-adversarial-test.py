#!/usr/bin/env python3
"""End-to-end adversarial checks for scripts/scan.py."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path


SCANNER = Path(__file__).with_name("scan.py")


def run(root: Path, pattern_file: Path | None = None) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(SCANNER), str(root)]
    if pattern_file:
        command.extend(["--private-pattern-file", str(pattern_file)])
    return subprocess.run(command, capture_output=True, text=True, check=False)


def require(condition: bool, message: str, result: subprocess.CompletedProcess[str] | None = None) -> None:
    if condition:
        return
    detail = ""
    if result:
        detail = f"\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    raise AssertionError(message + detail)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mnemosyne-scan-") as temp:
        base = Path(temp)

        clean = base / "clean"
        clean.mkdir()
        (clean / "ontology.md").write_text(
            "Mnemosyne Anamnesis Lethe Muse Musagetes Calliope Clio Erato "
            "Euterpe Melpomene Polyhymnia Terpsichore Thalia Urania Delos\n",
            encoding="utf-8",
        )
        result = run(clean)
        require(result.returncode == 0, "Greek ontology must pass", result)

        private_value = "owner" + "-private" + "-sentinel"
        patterns = base / "owner-patterns.txt"
        patterns.write_text(f"principal\t{private_value}\n", encoding="utf-8")
        (clean / "leak.txt").write_text(private_value + "\n", encoding="utf-8")
        result = run(clean, patterns)
        require(result.returncode == 1 and "private:principal" in result.stdout, "private literal must fail", result)

        (clean / "leak.txt").write_text(private_value + " # scan:allow email\n", encoding="utf-8")
        result = run(clean, patterns)
        require(result.returncode == 1 and "private:principal" in result.stdout, "unrelated exemption must not hide leak", result)

        (clean / "leak.txt").write_text(
            "<!-- scan:allow-file private:principal -->\n" + private_value + "\n",
            encoding="utf-8",
        )
        result = run(clean, patterns)
        require(result.returncode == 0, "explicit file-level public category must pass", result)

        (clean / "leak.txt").unlink()
        secret = "sk-" + "A" * 32
        (clean / "secret.txt").write_text(secret + "\n", encoding="utf-8")
        result = run(clean)
        require(result.returncode == 1 and "secret" in result.stdout, "credential-shaped value must fail", result)

        (clean / "secret.txt").unlink()
        forbidden = clean / "data"
        forbidden.mkdir()
        (forbidden / "memory.txt").write_text("synthetic\n", encoding="utf-8")
        result = run(clean)
        require(result.returncode == 1 and "forbidden_path" in result.stdout, "private directory must fail", result)

        empty = base / "empty"
        empty.mkdir()
        result = run(empty)
        require(result.returncode == 1 and "vacuous_scan" in result.stdout, "empty scan must fail", result)

        if hasattr(os, "symlink"):
            target = base / "target.txt"
            target.write_text("synthetic\n", encoding="utf-8")
            symlink_root = base / "symlink"
            symlink_root.mkdir()
            try:
                os.symlink(target, symlink_root / "alias.txt")
            except OSError:
                pass
            else:
                result = run(symlink_root)
                require(result.returncode == 1 and "symlink" in result.stdout, "symlink must fail", result)

    print("PASS adversarial scanner cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
