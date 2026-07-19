import tempfile
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

import server


class VisibleContentTests(unittest.TestCase):
    def test_ignores_scripts_styles_and_hidden_content(self):
        source = """
        <html><head><title>Hidden title</title><style>.x{}</style></head>
        <body><main><h1>公開情報</h1><script>dynamic()</script>
        <div hidden>秘密</div><p>本文 です</p></main></body></html>
        """
        result = server.normalize_html(source, "https://example.com/")
        self.assertIn("公開情報", result)
        self.assertIn("本文 です", result)
        self.assertNotIn("dynamic", result)
        self.assertNotIn("秘密", result)
        self.assertNotIn("Hidden title", result)

    def test_image_urls_are_included_without_query_noise(self):
        source = '<main><img src="/photo.jpg?v=123" alt="研究写真"></main>'
        result = server.normalize_html(source, "https://example.com/news/")
        self.assertIn("[画像] 研究写真 https://example.com/photo.jpg", result)
        self.assertNotIn("v=123", result)

    def test_diff_summary_reports_additions_and_removals(self):
        result = server.diff_summary("古い文章\n共通", "新しい文章\n共通")
        self.assertIn("追加: 新しい文章", result)
        self.assertIn("削除: 古い文章", result)


class LocalApiSecurityTests(unittest.TestCase):
    def handler(self, origin: str):
        handler = server.PageWatchHandler.__new__(server.PageWatchHandler)
        handler.server = SimpleNamespace(allowed_origins={"https://owner.github.io"})
        handler.headers = Message()
        handler.headers["Origin"] = origin
        return handler

    def test_allows_only_configured_pages_origin(self):
        allowed = self.handler("https://owner.github.io").cors_headers()
        self.assertEqual(allowed["Access-Control-Allow-Origin"], "https://owner.github.io")
        self.assertEqual(allowed["Access-Control-Allow-Private-Network"], "true")
        self.assertEqual(self.handler("https://attacker.example").cors_headers(), {})


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.original_data = server.DATA_DIR
        self.original_db = server.DB_PATH
        self.original_settings = server.SETTINGS_PATH
        self.temp = tempfile.TemporaryDirectory()
        data = Path(self.temp.name)
        server.DATA_DIR = data
        server.DB_PATH = data / "test.db"
        server.SETTINGS_PATH = data / "settings.json"

    def tearDown(self):
        server.DATA_DIR = self.original_data
        server.DB_PATH = self.original_db
        server.SETTINGS_PATH = self.original_settings
        self.temp.cleanup()

    def test_database_seeds_example_site(self):
        server.init_database()
        sites = server.site_rows()
        self.assertEqual(len(sites), 1)
        self.assertEqual(sites[0]["name"], "Fukazawa Group")

    def test_password_is_not_returned_by_public_settings(self):
        saved = server.save_settings({"smtp_password": "secret", "email_to": "me@example.com"})
        self.assertEqual(saved["smtp_password"], "")
        self.assertTrue(saved["smtp_password_set"])

    def test_check_site_creates_baseline_then_detects_change(self):
        server.init_database()
        site_id = server.site_rows()[0]["id"]
        original_fetch = server.fetch_site
        server.save_settings({"desktop_notifications": False, "email_enabled": False})
        try:
            server.fetch_site = lambda _site: (
                "<html><body><h1>最初の内容</h1></body></html>",
                {"etag": "first", "last_modified": ""},
            )
            baseline = server.check_site(site_id)
            self.assertEqual(baseline["status"], "baseline")

            server.fetch_site = lambda _site: (
                "<html><body><h1>更新後の内容</h1></body></html>",
                {"etag": "second", "last_modified": ""},
            )
            changed = server.check_site(site_id)
            self.assertTrue(changed["changed"])
            self.assertIn("追加: 更新後の内容", changed["summary"])
            self.assertEqual(server.site_rows()[0]["status"], "changed")
        finally:
            server.fetch_site = original_fetch


if __name__ == "__main__":
    unittest.main()
