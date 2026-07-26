import tempfile
import unittest
from pathlib import Path

from codeharness_indexer.scanner import RepositoryScanner


class RepositoryScannerTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def write(self, relative_path: str, content: str) -> None:
        path = self.root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_scan_excludes_default_and_custom_ignored_paths(self):
        self.write("src/app.py", "print('ready')")
        self.write("node_modules/pkg.js", "ignored")
        self.write("generated/output.py", "ignored")

        report = RepositoryScanner(
            self.root, ignore_patterns=("generated/**",)
        ).scan()

        self.assertEqual([item.path for item in report.index.files], ["src/app.py"])
        self.assertEqual(report.index.files[0].language, "Python")
        self.assertEqual(report.index.files[0].content, "print('ready')")

    def test_scan_keeps_binary_and_invalid_utf8_files_without_content(self):
        (self.root / "image.bin").write_bytes(b"\x00\x01\x02")
        (self.root / "legacy.txt").write_bytes(b"\xff\xfe")

        report = RepositoryScanner(self.root).scan()

        self.assertEqual([item.path for item in report.index.files], ["image.bin", "legacy.txt"])
        self.assertEqual([item.content for item in report.index.files], [None, None])
        self.assertEqual([issue.path for issue in report.issues], ["legacy.txt"])
