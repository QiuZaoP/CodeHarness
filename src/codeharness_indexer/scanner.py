"""Filesystem scanning for repository file indexes."""

from __future__ import annotations

import fnmatch
import os
from pathlib import Path

from .languages import detect_language
from .models import FileRecord, RepositoryIndex, ScanIssue, ScanReport


DEFAULT_IGNORED_DIRECTORIES = frozenset(
    {".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}
)


class RepositoryScanner:
    """Build a file index from a repository directory without modifying it."""

    def __init__(self, root: str | Path, ignore_patterns: tuple[str, ...] = ()):
        self.root = Path(root).resolve()
        self.ignore_patterns = ignore_patterns

    def scan(self) -> ScanReport:
        if not self.root.is_dir():
            raise ValueError(f"Repository root is not a directory: {self.root}")

        records: list[FileRecord] = []
        issues: list[ScanIssue] = []
        for directory, directories, filenames in os.walk(self.root, topdown=True):
            directory_path = Path(directory)
            directories[:] = sorted(
                child
                for child in directories
                if child not in DEFAULT_IGNORED_DIRECTORIES
                and not self._is_ignored(directory_path / child)
            )
            for filename in sorted(filenames):
                path = directory_path / filename
                if self._is_ignored(path):
                    continue
                try:
                    stat = path.stat()
                    relative_path = self._relative_path(path)
                    content, decode_issue = self._read_text(path)
                    records.append(
                        FileRecord(
                            path=relative_path,
                            language=detect_language(relative_path),
                            size_bytes=stat.st_size,
                            modified_at_ns=stat.st_mtime_ns,
                            content=content,
                        )
                    )
                    if decode_issue is not None:
                        issues.append(ScanIssue(relative_path, decode_issue))
                except OSError as error:
                    issues.append(ScanIssue(self._relative_path(path), str(error)))
        return ScanReport(RepositoryIndex.build(records), tuple(issues))

    def _is_ignored(self, path: Path) -> bool:
        relative_path = self._relative_path(path)
        return any(
            fnmatch.fnmatchcase(relative_path, pattern)
            for pattern in self.ignore_patterns
        )

    def _relative_path(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    @staticmethod
    def _read_text(path: Path) -> tuple[str | None, str | None]:
        data = path.read_bytes()
        if b"\x00" in data:
            return None, None
        try:
            return data.decode("utf-8"), None
        except UnicodeDecodeError as error:
            return None, f"UTF-8 decode failed: {error}"
