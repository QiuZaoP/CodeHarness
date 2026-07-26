"""Data models for repository indexing."""

from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class FileRecord:
    """Metadata and optional UTF-8 text content for one repository file."""

    path: str
    language: str | None
    size_bytes: int
    modified_at_ns: int
    content: str | None


@dataclass(frozen=True)
class ContentMatch:
    """One line containing a text-search match."""

    path: str
    line_number: int
    line: str


@dataclass(frozen=True)
class ScanIssue:
    """A recoverable error encountered while reading one repository path."""

    path: str
    message: str


@dataclass(frozen=True)
class RepositoryIndex:
    """Deterministic collection of files belonging to one scanned repository."""

    files: tuple[FileRecord, ...]

    @classmethod
    def build(cls, files: Iterable[FileRecord]) -> "RepositoryIndex":
        return cls(tuple(sorted(files, key=lambda item: item.path)))

    def search_paths(self, query: str) -> tuple[FileRecord, ...]:
        """Find indexed files whose relative paths contain ``query``."""

        from .search import search_paths

        return search_paths(self.files, query)

    def search_content(self, query: str) -> tuple[ContentMatch, ...]:
        """Find lines of indexed UTF-8 text containing ``query``."""

        from .search import search_content

        return search_content(self.files, query)


@dataclass(frozen=True)
class ScanReport:
    """The index produced by a scan and any recoverable scan issues."""

    index: RepositoryIndex
    issues: tuple[ScanIssue, ...]
