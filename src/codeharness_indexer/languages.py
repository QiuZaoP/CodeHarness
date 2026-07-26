"""Language recognition based on common source file extensions."""

from pathlib import PurePosixPath


LANGUAGE_BY_EXTENSION = {
    ".py": "Python",
    ".js": "JavaScript",
    ".jsx": "JSX",
    ".ts": "TypeScript",
    ".tsx": "TSX",
    ".json": "JSON",
    ".md": "Markdown",
    ".java": "Java",
    ".go": "Go",
}


def detect_language(path: str) -> str | None:
    """Return the known language for a POSIX-style path, if any."""

    return LANGUAGE_BY_EXTENSION.get(PurePosixPath(path).suffix.lower())
