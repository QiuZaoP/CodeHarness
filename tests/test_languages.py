import unittest

from codeharness_indexer.languages import detect_language


class LanguageDetectionTests(unittest.TestCase):
    def test_recognizes_initial_target_languages(self):
        self.assertEqual(detect_language("src/main.py"), "Python")
        self.assertEqual(detect_language("web/App.tsx"), "TSX")
        self.assertEqual(detect_language("README.md"), "Markdown")

    def test_returns_none_for_unknown_extensions(self):
        self.assertIsNone(detect_language("archive.custom"))
