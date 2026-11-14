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
