"""Deterministic query functions for repository indexes."""

from .models import ContentMatch, FileRecord


def search_paths(files: tuple[FileRecord, ...], query: str) -> tuple[FileRecord, ...]:
    """Return path matches in the input index's stable path order."""

    needle = query.casefold()
    return tuple(item for item in files if needle in item.path.casefold())


def search_content(
    files: tuple[FileRecord, ...], query: str
) -> tuple[ContentMatch, ...]:
    """Return case-insensitive line matches in stable path and line order."""

    needle = query.casefold()
    return tuple(
        ContentMatch(record.path, line_number, line)
        for record in files
        if record.content is not None
        for line_number, line in enumerate(record.content.splitlines(), start=1)
        if needle in line.casefold()
    )
