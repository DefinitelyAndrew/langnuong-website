#!/usr/bin/env python3
"""Check a static website for broken local references and common source errors."""

from __future__ import annotations

import argparse
import html.parser
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit


IGNORED_DIRS = {".git", ".github", "node_modules", "vendor", "dist", "build"}
SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
SCRIPT_TYPES = {
    "",
    "text/javascript",
    "application/javascript",
    "text/ecmascript",
    "application/ecmascript",
    "module",
}


class Issue:
    def __init__(self, severity: str, path: Path, line: int, message: str):
        self.severity = severity
        self.path = path.as_posix()
        self.line = line
        self.message = message

    def to_dict(self) -> dict[str, object]:
        return {
            "severity": self.severity,
            "file": self.path,
            "line": self.line,
            "message": self.message,
        }


class PageParser(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: dict[str, int] = {}
        self.duplicate_ids: list[tuple[str, int]] = []
        self.references: list[tuple[str, int, str, str]] = []
        self.inline_scripts: list[tuple[int, str, str]] = []
        self.missing_alt: list[int] = []
        self.title_count = 0
        self._script: tuple[int, str, str, list[str]] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._handle_tag(tag, attrs)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._handle_tag(tag, attrs)

    def _handle_tag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.lower(): value or "" for key, value in attrs}
        line = self.getpos()[0]

        element_id = values.get("id")
        if element_id:
            if element_id in self.ids:
                self.duplicate_ids.append((element_id, line))
            else:
                self.ids[element_id] = line

        if tag == "title":
            self.title_count += 1
        if tag == "img" and "alt" not in values:
            self.missing_alt.append(line)

        for attribute in ("href", "src", "poster"):
            reference = values.get(attribute)
            if reference:
                self.references.append((reference, line, tag, attribute))

        srcset = values.get("srcset", "")
        for candidate in srcset.split(","):
            reference = candidate.strip().split()
            if reference:
                self.references.append((reference[0], line, tag, "srcset"))

        if tag == "script":
            script_type = values.get("type", "").strip().lower().split(";", 1)[0]
            if script_type in SCRIPT_TYPES:
                self._script = (line, script_type, values.get("src", ""), [])

    def handle_data(self, data: str) -> None:
        if self._script is not None:
            self._script[3].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._script is not None:
            line, script_type, src, chunks = self._script
            if not src and "".join(chunks).strip():
                self.inline_scripts.append((line, script_type, "".join(chunks)))
            self._script = None


def source_files(root: Path, suffixes: set[str]) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.suffix.lower() in suffixes
        and not any(part in IGNORED_DIRS for part in path.relative_to(root).parts)
    )


def tracked_files(root: Path) -> set[str]:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return set()
    return set(result.stdout.splitlines())


def is_available(path: Path, root: Path, tracked: set[str]) -> bool:
    if path.is_file():
        return True
    try:
        return path.relative_to(root).as_posix() in tracked
    except ValueError:
        return False


def resolve_reference(
    reference: str, source: Path, root: Path, tracked: set[str]
) -> tuple[Path | None, str]:
    parsed = urlsplit(reference.strip())
    if parsed.scheme or parsed.netloc:
        return None, parsed.fragment

    decoded_path = unquote(parsed.path)
    if not decoded_path:
        target = source
    elif decoded_path.startswith("/"):
        target = root / decoded_path.lstrip("/")
    else:
        target = source.parent / decoded_path
    target = target.resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return target, parsed.fragment

    if target.is_dir():
        for index_name in ("index.html", "index.htm"):
            index = target / index_name
            if is_available(index, root, tracked):
                return index, parsed.fragment
    return target, parsed.fragment


def check_javascript(
    code: str, path: Path, line: int, module: bool, issues: list[Issue]
) -> None:
    result = subprocess.run(
        ["node", "--check", f"--input-type={'module' if module else 'commonjs'}"],
        input=code,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        details = (result.stderr or result.stdout).strip().splitlines()
        message = next(
            (line.strip() for line in details if "SyntaxError:" in line),
            details[0].strip() if details else "JavaScript syntax check failed",
        )
        issues.append(Issue("CRITICAL", path, line, f"JavaScript syntax error: {message}"))


def check_css(path: Path, root: Path, tracked: set[str], issues: list[Issue]) -> None:
    text = path.read_text(encoding="utf-8", errors="replace")
    clean = re.sub(r"/\*.*?\*/", lambda match: "\n" * match.group(0).count("\n"), text, flags=re.S)
    clean = re.sub(r"""(["']).*?(?<!\\)\1""", "", clean, flags=re.S)
    depth = 0
    for line_number, line in enumerate(clean.splitlines(), start=1):
        for char in line:
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth < 0:
                    issues.append(
                        Issue("HIGH", path.relative_to(root), line_number, "Unexpected closing brace in CSS")
                    )
                    depth = 0

    if depth:
        issues.append(
            Issue("HIGH", path.relative_to(root), len(clean.splitlines()), "CSS block is missing a closing brace")
        )

    url_pattern = re.compile(r"""url\(\s*(['"]?)(.*?)\1\s*\)""", re.I)
    import_pattern = re.compile(r"""@import\s+(['"])(.*?)\1""", re.I)
    references = [(match.group(2), match.start()) for match in url_pattern.finditer(text)]
    references.extend((match.group(2), match.start()) for match in import_pattern.finditer(text))
    for reference, offset in references:
        if reference.startswith("#") or reference.startswith("data:"):
            continue
        target, _ = resolve_reference(reference, path, root, tracked)
        if target is not None and not is_available(target, root, tracked):
            line = text.count("\n", 0, offset) + 1
            issues.append(
                Issue("HIGH", path.relative_to(root), line, f"Missing local CSS resource: `{reference}`")
            )


def run_audit(root: Path) -> list[Issue]:
    issues: list[Issue] = []
    tracked = tracked_files(root)
    pages: dict[Path, PageParser] = {}

    for path in source_files(root, {".html", ".htm"}):
        parser = PageParser()
        parser.feed(path.read_text(encoding="utf-8", errors="replace"))
        parser.close()
        pages[path.resolve()] = parser

        if parser.title_count == 0:
            issues.append(Issue("LOW", path.relative_to(root), 1, "Page has no `<title>` element"))
        for line in parser.missing_alt:
            issues.append(Issue("LOW", path.relative_to(root), line, "Image is missing its `alt` attribute"))
        for element_id, line in parser.duplicate_ids:
            issues.append(
                Issue("MEDIUM", path.relative_to(root), line, f"Duplicate id `{element_id}`")
            )

        for reference, line, tag, attribute in parser.references:
            target, fragment = resolve_reference(reference, path, root, tracked)
            if target is None:
                continue
            if not is_available(target, root, tracked):
                severity = "HIGH"
                label = "page" if tag == "a" and attribute == "href" else "resource"
                issues.append(
                    Issue(severity, path.relative_to(root), line, f"Missing local {label}: `{reference}`")
                )
            elif fragment and target.suffix.lower() in {".html", ".htm"}:
                target_parser = pages.get(target.resolve())
                if target_parser is None and target.is_file():
                    target_parser = PageParser()
                    target_parser.feed(target.read_text(encoding="utf-8", errors="replace"))
                    pages[target.resolve()] = target_parser
                if target_parser is not None and fragment not in target_parser.ids:
                    issues.append(
                        Issue("MEDIUM", path.relative_to(root), line, f"Missing page anchor: `{reference}`")
                    )

        for line, script_type, code in parser.inline_scripts:
            check_javascript(code, path.relative_to(root), line, script_type == "module", issues)

    for path in source_files(root, {".js", ".mjs", ".cjs"}):
        code = path.read_text(encoding="utf-8", errors="replace")
        check_javascript(code, path.relative_to(root), 1, path.suffix.lower() == ".mjs", issues)

    for path in source_files(root, {".css"}):
        check_css(path, root, tracked, issues)

    return sorted(
        issues,
        key=lambda issue: (
            SEVERITY_ORDER[issue.severity],
            issue.path,
            issue.line,
            issue.message,
        ),
    )


def main() -> int:
    argument_parser = argparse.ArgumentParser()
    argument_parser.add_argument("--root", type=Path, default=Path.cwd())
    argument_parser.add_argument("--output", type=Path, default=Path("audit-results.json"))
    args = argument_parser.parse_args()
    root = args.root.resolve()
    findings = run_audit(root)
    output = args.output if args.output.is_absolute() else root / args.output
    output.write_text(
        json.dumps([finding.to_dict() for finding in findings], indent=2) + "\n",
        encoding="utf-8",
    )

    if not findings:
        print("Check passed, no errors found.")
        return 0

    print(f"Found {len(findings)} issue(s):")
    for finding in findings:
        print(f"{finding.severity}: {finding.path}:{finding.line}: {finding.message}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
