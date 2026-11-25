#!/usr/bin/env python3
"""Parity guard (XEN-716): stop "Base only" from creeping back.

Pay links take USDC and USDT on Base, Ethereum, BNB Chain, Monad and Tron
(XEN-678/708). Surfaces must name a payment's coin, network and explorer
from the networks registry, not hard-code Base. This check fails a change
that ADDS, outside the allowlist:

  - a basescan.org URL,
  - the words "USDC on Base",
  - the Base USDC contract address, or
  - a USDC_ADDRESS-style constant (USDC_ADDRESS = ..., USDC_BASE_ADDRESS: str = ...).

Only added lines are checked, so what is already on main passes. The
allowlist (allowlist.txt next to this file, one glob per line) names the
parts that are Base-only by design: x402 agent payments, bot gating, permit
subscriptions, signed link params, Coinbase cash-out, XenPay, the chain
registry. A single line elsewhere can opt out with a trailing comment
containing `parity-guard: allow <reason>`.

Usage (CI sets these): PARITY_BASE=<sha> [PARITY_HEAD=<sha>] python3 check.py
Standard library only.
"""
from __future__ import annotations

import fnmatch
import os
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ALLOW_MARK = "parity-guard: allow"

PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("basescan.org link", re.compile(r"basescan\.org", re.IGNORECASE)),
    ('"USDC on Base"', re.compile(r"USDC\s+on\s+Base\b", re.IGNORECASE)),
    ("Base USDC contract address", re.compile(r"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", re.IGNORECASE)),
    (
        "USDC_ADDRESS-style constant",
        re.compile(r"\b[A-Z0-9_]*USDC[A-Z0-9_]*_ADDRESS\b\s*(?::[^=\n]*)?=(?!=)"),
    ),
]

HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def load_allowlist() -> list[str]:
    path = HERE / "allowlist.txt"
    if not path.exists():
        return []
    globs = []
    for raw in path.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            globs.append(line)
    return globs


def allowed(path: str, globs: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, g) for g in globs)


def added_lines(base: str, head: str):
    """Yield (path, line_no, text) for every line the change adds."""
    out = subprocess.run(
        ["git", "diff", "--unified=0", "--no-color", "--no-ext-diff", "-M", base, head],
        check=True,
        capture_output=True,
        text=True,
        errors="replace",
    ).stdout
    path = None
    line_no = 0
    for line in out.splitlines():
        if line.startswith("+++ "):
            target = line[4:]
            path = None if target == "/dev/null" else target[2:] if target.startswith("b/") else target
            continue
        if line.startswith("--- ") or line.startswith("diff --git") or line.startswith("index "):
            continue
        m = HUNK.match(line)
        if m:
            line_no = int(m.group(1))
            continue
        if path is None:
            continue
        if line.startswith("+"):
            yield path, line_no, line[1:]
            line_no += 1
        elif not line.startswith("-") and not line.startswith("\\"):
            line_no += 1


def main() -> int:
    base = os.environ.get("PARITY_BASE", "").strip()
    head = os.environ.get("PARITY_HEAD", "HEAD").strip() or "HEAD"
    if not base or set(base) == {"0"}:
        print("parity guard: no base commit to compare against; nothing to check.")
        return 0
    globs = load_allowlist()
    findings = []
    for path, line_no, text in added_lines(base, head):
        if allowed(path, globs) or ALLOW_MARK in text:
            continue
        for name, pattern in PATTERNS:
            if pattern.search(text):
                findings.append((path, line_no, name, text.strip()))
    if not findings:
        print("parity guard: no new hard-coded Base / USDC-on-Base outside the allowlist.")
        return 0
    for path, line_no, name, text in findings:
        msg = (
            f"{name} added outside the Base-only allowlist. Name the payment's coin, "
            "network and explorer from the networks registry (GET /v1/networks), or, if this "
            "part is Base-only by design, add it to .github/parity-guard/allowlist.txt or end "
            "the line with a `parity-guard: allow <reason>` comment."
        )
        print(f"::error file={path},line={line_no}::{msg}")
        print(f"  {path}:{line_no}: {text[:160]}")
    print(f"parity guard: {len(findings)} finding(s). See XEN-716 and this repo's CLAUDE.md.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
