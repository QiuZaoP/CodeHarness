import unittest

from codeharness_indexer import FileRecord, RepositoryIndex


class RepositoryIndexTests(unittest.TestCase):
    def test_index_keeps_records_sorted_by_relative_path(self):
        index = RepositoryIndex.build(
            [
                FileRecord("z.py", "Python", 1, 0, "z"),
                FileRecord("a.py", "Python", 1, 0, "a"),
            ]
        )

        self.assertEqual([record.path for record in index.files], ["a.py", "z.py"])

    def test_search_content_returns_one_based_line_numbers(self):
        index = RepositoryIndex.build(
            [
                FileRecord(
                    "src/app.py",
                    "Python",
                    31,
                    0,
                    "one\nNeedle here\nneedle again",
                )
            ]
        )

        matches = index.search_content("needle")

        self.assertEqual(
            [(match.path, match.line_number) for match in matches],
            [("src/app.py", 2), ("src/app.py", 3)],
        )

    def test_search_paths_is_case_insensitive_and_sorted(self):
        index = RepositoryIndex.build(
            [
                FileRecord("web/App.tsx", "TSX", 1, 0, ""),
                FileRecord("api/app.py", "Python", 1, 0, ""),
                FileRecord("api/server.py", "Python", 1, 0, ""),
            ]
        )

        self.assertEqual(
            [item.path for item in index.search_paths("APP")],
            ["api/app.py", "web/App.tsx"],
        )
