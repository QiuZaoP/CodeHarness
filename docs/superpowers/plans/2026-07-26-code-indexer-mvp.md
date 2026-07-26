# Code Indexer MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the role-3 MVP that scans a local source repository, produces a searchable file index, and reports recoverable scan issues.

**Architecture:** A dependency-free Python package separates immutable index data models from filesystem scanning and query operations. `RepositoryScanner` converts a directory into `RepositoryIndex`; `RepositoryIndex` owns deterministic file-name and text queries, so AST/symbol/semantic index fields can be added later without changing the scanning contract.

**Tech Stack:** Python 3.11+ standard library, `unittest`, `src/` package layout.

---

## File structure

- Create: `pyproject.toml` — package metadata and unittest discovery command.
- Create: `src/codeharness_indexer/__init__.py` — supported public API.
- Create: `src/codeharness_indexer/models.py` — immutable records for files, matches, issues, report, and index.
- Create: `src/codeharness_indexer/languages.py` — extension-to-language resolver.
- Create: `src/codeharness_indexer/scanner.py` — ignore policy and recursive filesystem scanner.
- Create: `src/codeharness_indexer/search.py` — index construction and deterministic queries.
- Create: `tests/test_languages.py` — resolver specifications.
- Create: `tests/test_scanner.py` — scan, ignore, binary, decoding, and failure specifications.
- Create: `tests/test_search.py` — path/name/content query specifications.

### Task 1: Create the package boundary and file records

**Files:**
- Create: `pyproject.toml`
- Create: `src/codeharness_indexer/__init__.py`
- Create: `src/codeharness_indexer/models.py`
- Test: `tests/test_search.py`

- [ ] **Step 1: Write the failing public-API test**

```python
from codeharness_indexer import FileRecord, RepositoryIndex

def test_index_keeps_records_sorted_by_relative_path():
    index = RepositoryIndex.build([
        FileRecord("z.py", "Python", 1, 0, "z"),
        FileRecord("a.py", "Python", 1, 0, "a"),
    ])
    assert [record.path for record in index.files] == ["a.py", "z.py"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m unittest tests.test_search.RepositoryIndexTests.test_index_keeps_records_sorted_by_relative_path -v`

Expected: FAIL because `codeharness_indexer` does not exist.

- [ ] **Step 3: Implement the minimal records and sorted index factory**

```python
@dataclass(frozen=True)
class FileRecord:
    path: str
    language: str | None
    size_bytes: int
    modified_at_ns: int
    content: str | None

@dataclass(frozen=True)
class RepositoryIndex:
    files: tuple[FileRecord, ...]

    @classmethod
    def build(cls, files: Iterable[FileRecord]) -> "RepositoryIndex":
        return cls(tuple(sorted(files, key=lambda item: item.path)))
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `python -m unittest tests.test_search.RepositoryIndexTests.test_index_keeps_records_sorted_by_relative_path -v`

Expected: PASS.

### Task 2: Implement language recognition

**Files:**
- Create: `src/codeharness_indexer/languages.py`
- Test: `tests/test_languages.py`

- [ ] **Step 1: Write the failing resolver tests**

```python
def test_recognizes_initial_target_languages():
    assert detect_language("src/main.py") == "Python"
    assert detect_language("web/App.tsx") == "TSX"
    assert detect_language("README.md") == "Markdown"

def test_returns_none_for_unknown_extensions():
    assert detect_language("archive.custom") is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m unittest tests.test_languages -v`

Expected: FAIL because `detect_language` is unavailable.

- [ ] **Step 3: Implement the extension table and resolver**

```python
LANGUAGE_BY_EXTENSION = {
    ".py": "Python", ".js": "JavaScript", ".jsx": "JSX",
    ".ts": "TypeScript", ".tsx": "TSX", ".json": "JSON",
    ".md": "Markdown", ".java": "Java", ".go": "Go",
}

def detect_language(path: str) -> str | None:
    return LANGUAGE_BY_EXTENSION.get(PurePosixPath(path).suffix.lower())
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `python -m unittest tests.test_languages -v`

Expected: PASS.

### Task 3: Implement safe scanning and ignore policy

**Files:**
- Create: `src/codeharness_indexer/scanner.py`
- Modify: `src/codeharness_indexer/models.py`
- Test: `tests/test_scanner.py`

- [ ] **Step 1: Write failing scanner tests for default ignores, custom rules, and text records**

```python
def test_scan_excludes_default_and_custom_ignored_paths(self):
    self.write("src/app.py", "print('ready')")
    self.write("node_modules/pkg.js", "ignored")
    self.write("generated/output.py", "ignored")
    report = RepositoryScanner(self.root, ignore_patterns=("generated/**",)).scan()
    self.assertEqual([item.path for item in report.index.files], ["src/app.py"])
```

- [ ] **Step 2: Run scanner tests to verify they fail**

Run: `python -m unittest tests.test_scanner -v`

Expected: FAIL because `RepositoryScanner` is unavailable.

- [ ] **Step 3: Implement recursive scanner with default directory ignores**

```python
DEFAULT_IGNORED_DIRECTORIES = frozenset({".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"})

class RepositoryScanner:
    def scan(self) -> ScanReport:
        records, issues = [], []
        for path in self._iter_files():
            try:
                content = self._read_text_or_none(path)
                stat = path.stat()
                records.append(FileRecord(self._relative_path(path), detect_language(str(path)), stat.st_size, stat.st_mtime_ns, content))
            except OSError as error:
                issues.append(ScanIssue(self._relative_path(path), str(error)))
        return ScanReport(RepositoryIndex.build(records), tuple(issues))
```

- [ ] **Step 4: Add failing tests for binary and invalid UTF-8 fallback**

```python
def test_scan_keeps_binary_files_without_searchable_content(self):
    (self.root / "image.bin").write_bytes(b"\x00\x01\x02")
    report = RepositoryScanner(self.root).scan()
    self.assertIsNone(report.index.files[0].content)
```

- [ ] **Step 5: Run the scanner tests to verify the fallback tests fail**

Run: `python -m unittest tests.test_scanner -v`

Expected: FAIL until binary detection and decode-error handling are implemented.

- [ ] **Step 6: Implement binary detection and decode fallback**

```python
def _read_text_or_none(self, path: Path) -> str | None:
    data = path.read_bytes()
    if b"\x00" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None
```

- [ ] **Step 7: Run the focused scanner tests to verify they pass**

Run: `python -m unittest tests.test_scanner -v`

Expected: PASS.

### Task 4: Implement filename and content searches

**Files:**
- Modify: `src/codeharness_indexer/models.py`
- Create: `src/codeharness_indexer/search.py`
- Test: `tests/test_search.py`

- [ ] **Step 1: Write failing search tests**

```python
def test_search_content_returns_one_based_line_numbers():
    index = RepositoryIndex.build([FileRecord("src/app.py", "Python", 20, 0, "one\nNeedle here\nneedle again")])
    matches = index.search_content("needle")
    assert [(match.path, match.line_number) for match in matches] == [("src/app.py", 2), ("src/app.py", 3)]

def test_search_paths_is_case_insensitive_and_sorted():
    index = RepositoryIndex.build([...])
    assert [item.path for item in index.search_paths("APP")] == ["api/app.py", "web/App.tsx"]
```

- [ ] **Step 2: Run the search tests to verify they fail**

Run: `python -m unittest tests.test_search -v`

Expected: FAIL because query methods are unavailable.

- [ ] **Step 3: Implement case-insensitive path and content queries**

```python
def search_paths(self, query: str) -> tuple[FileRecord, ...]:
    needle = query.casefold()
    return tuple(item for item in self.files if needle in item.path.casefold())

def search_content(self, query: str) -> tuple[ContentMatch, ...]:
    needle = query.casefold()
    return tuple(
        ContentMatch(record.path, number, line)
        for record in self.files if record.content is not None
        for number, line in enumerate(record.content.splitlines(), start=1)
        if needle in line.casefold()
    )
```

- [ ] **Step 4: Run focused search tests to verify they pass**

Run: `python -m unittest tests.test_search -v`

Expected: PASS.

### Task 5: Verify the whole MVP and document the public contract

**Files:**
- Modify: `README.md`
- Test: `tests/test_languages.py`, `tests/test_scanner.py`, `tests/test_search.py`

- [ ] **Step 1: Add a short role-3 usage example to README**

```python
from codeharness_indexer import RepositoryScanner

report = RepositoryScanner("./my-repository").scan()
for match in report.index.search_content("TODO"):
    print(match.path, match.line_number)
```

- [ ] **Step 2: Run the full test suite**

Run: `python -m unittest discover -s tests -v`

Expected: PASS with zero failures.

- [ ] **Step 3: Run a syntax check over source and tests**

Run: `python -m compileall -q src tests`

Expected: exit code 0 and no output.

- [ ] **Step 4: Inspect the final diff and scope**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only role-3 files, tests, README, and plan artifacts changed.
