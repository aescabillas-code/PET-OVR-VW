"""Realtime speed: a browser that holds a recent copy gets only the documents that changed, not the whole collection."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import streamlit_app as app  # noqa: E402


class Delta(unittest.TestCase):
    def setUp(self):
        self.s = app.MemStore()
        for i in range(50):
            self.s.put("cases", f"c{i}", {"ts": i, "owner": "A"})
        self.b = app.Bridge(self.s)

    def test_only_changed_documents_are_sent(self):
        v = self.s.version("cases")
        self.b.handle({"cid": "B", "tick": 1, "have": {"cases": v}})
        self.s.patch("cases", "c7", {"owner": "Z"})
        self.s.delete("cases", "c9")
        r = self.b.reply({"cid": "B", "tick": 1})
        self.assertIn("delta", r)
        self.assertNotIn("cases", r.get("fresh", {}))
        d = r["delta"]["cases"]
        self.assertEqual(d["from"], v)
        self.assertEqual(d["version"], v + 2)
        self.assertEqual(set(d["docs"]), {"c7", "c9"})
        self.assertEqual(d["docs"]["c7"]["owner"], "Z")
        self.assertIsNone(d["docs"]["c9"])

    def test_unknown_history_falls_back_to_the_whole_collection(self):
        self.b.handle({"cid": "B", "tick": 1, "have": {"cases": 1}})
        self.s.changes["cases"].clear()          # e.g. after a restart: the server no longer knows what changed
        self.s.put("cases", "new", {"ts": 99})
        r = self.b.reply({"cid": "B", "tick": 1})
        self.assertIn("cases", r.get("fresh", {}))
        self.assertEqual(len(r["fresh"]["cases"]["docs"]), 51)

    def test_up_to_date_browser_gets_nothing_extra(self):
        v = self.s.version("cases")
        self.b.handle({"cid": "B", "tick": 1, "have": {"cases": v}})
        r = self.b.reply({"cid": "B", "tick": 1})
        self.assertNotIn("delta", r)
        self.assertNotIn("fresh", r)


if __name__ == "__main__":
    unittest.main()


class HistoryAndFirstLoad(unittest.TestCase):
    def test_one_case_history_by_filter(self):
        s = app.MemStore()
        for i in range(30):
            s.put("act", f"a{i}", {"ts": i, "case": "C1" if i % 3 == 0 else "C2", "action": "x"})
        r = app.execute(s, "list", {"c": "act", "ob": "ts", "dir": "desc", "w": [["case", "==", "C1"]]})
        self.assertEqual(r["count"], 10)
        self.assertTrue(all(it["data"]["case"] == "C1" for it in r["items"]))
        r = app.execute(s, "list", {"c": "act", "w": [["ts", ">=", 25]]})
        self.assertEqual(r["count"], 5)

    def test_bad_filter_is_refused(self):
        s = app.MemStore()
        with self.assertRaises(app.ApiError):
            app.execute(s, "list", {"c": "act", "w": [["case", "$where", "x"]]})

    def test_first_load_sends_only_the_newest_activity(self):
        s = app.MemStore()
        for i in range(1500):
            s.put("act", f"a{i}", {"ts": i})
        snap = s.snapshot()["act"]
        self.assertEqual(len(snap["docs"]), 1000)
        self.assertEqual(snap["top"], {"ob": "ts", "n": 1000})
        self.assertIn("a1499", snap["docs"])
        self.assertNotIn("a0", snap["docs"])


class FastOpening(unittest.TestCase):
    def test_login_pictures_are_separate_cached_files_and_styles_are_prebuilt(self):
        import pathlib
        d = pathlib.Path(app.build_frontend())
        page = (d / "index.html").read_text(encoding="utf-8")
        self.assertTrue((d / "landing-img.webp").exists() and (d / "landing-img-m.webp").exists())
        self.assertNotIn('id="landing-img" alt="PAT, Partner Engagement Team" draggable="false" src="data:', page)
        self.assertLess(len(page), 800_000)
        self.assertNotIn("cdn.tailwindcss.com", page)          # styles are pre-built, nothing compiles in the browser
        self.assertIn('<style id="tw-static">', page)
        self.assertNotIn('xlsx.full.min.js"></script>', page)  # Excel tools load only when needed
