"""Changed collections are sent along with the change signal, only to browsers that hold an older version."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import streamlit_app as app  # noqa: E402


class Push(unittest.TestCase):
    def setUp(self):
        self.s = app.MemStore()
        self.b = app.Bridge(self.s)

    def msg(self, cid, tick, have, reqs=None):
        return {"cid": cid, "tick": tick, "reqs": reqs or [], "ack": [], "have": have}

    def test_older_browser_receives_the_changed_collection(self):
        app.execute(self.s, "put", {"c": "cases", "id": "a", "data": {"ts": 1, "x": 1}})
        v = self.s.versions()["cases"]
        m = self.msg("c1", 1, {"cases": v - 1, "act": 0})
        self.b.handle(m)
        r = self.b.reply(m)
        self.assertIn("cases", r["fresh"])
        self.assertEqual(r["fresh"]["cases"]["version"], v)
        self.assertEqual(sorted(r["fresh"]["cases"]["docs"]), ["a"])
        self.assertNotIn("_updated", r["fresh"]["cases"]["docs"]["a"])

    def test_up_to_date_browser_gets_nothing_extra(self):
        app.execute(self.s, "put", {"c": "cases", "id": "a", "data": {"ts": 1}})
        v = self.s.versions()["cases"]
        m = self.msg("c2", 1, {"cases": v})
        self.b.handle(m)
        self.assertNotIn("fresh", self.b.reply(m))

    def test_collections_the_browser_does_not_watch_are_not_sent(self):
        app.execute(self.s, "put", {"c": "seen", "id": "u", "data": {"ts": 1}})
        m = self.msg("c3", 1, {"cases": 0})
        self.b.handle(m)
        self.assertNotIn("fresh", self.b.reply(m))

    def test_first_render_still_uses_boot_and_bad_input_is_ignored(self):
        r = self.b.reply(None)
        self.assertNotIn("fresh", r)
        m = self.msg("c4", 1, {"cases": "x", "ann": None})
        m["have"] = "junk"
        self.b.handle(m)
        self.assertNotIn("fresh", self.b.reply(m))

    def test_a_forgotten_browser_is_dropped(self):
        m = self.msg("c5", 1, {"cases": 0})
        self.b.handle(m)
        self.b.seen["c5"] -= 10_000
        self.b.handle(self.msg("c6", 1, {}))
        self.assertNotIn("c5", self.b.have)


if __name__ == "__main__":
    unittest.main()
