"""Nov 20: the app's frame is always drawn, so Streamlit never replaces it with an error box (white screen + reload)."""
import datetime
import json
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import tests.test_mongo_cache  # noqa: F401,E402  (installs the fake pymongo used by the other tests)
import streamlit_app as app  # noqa: E402


class FakeSt:
    def __init__(self):
        self.session_state = {}

    def rerun(self, scope=None):
        raise RuntimeError("RerunData")


class Frame(unittest.TestCase):
    def test_reply_is_always_valid_json(self):
        r = {"a": float("nan"), "b": [1, float("inf")], "c": datetime.datetime(2026, 11, 20, 1, 2, 3), "d": {1: "x"}, "e": b"x"}
        out = app.json_safe(r)
        json.dumps(out, allow_nan=False)
        self.assertIsNone(out["a"])
        self.assertEqual(out["b"], [1, None])
        self.assertIsInstance(out["c"], int)
        ok = {"x": 1, "y": [1, 2]}
        self.assertIs(app.json_safe(ok), ok)          # valid answers pass through untouched

    def test_frame_drawn_even_if_drawing_fails_once(self):
        s = app.MemStore()
        b = app.Bridge(s)
        calls = []

        def component(reply=None, key=None, default=None):
            calls.append(reply)
            if len(calls) == 1:
                raise ValueError("cannot draw")
            return None
        st = FakeSt()
        app._bridge_run(st, component, b)
        self.assertEqual(len(calls), 2)               # drawn again with a plain answer instead of an error box
        self.assertTrue(calls[1]["ok"])

    def test_answer_with_bad_values_still_draws(self):
        s = app.MemStore()
        b = app.Bridge(s)
        app.execute(s, "put", {"c": "cases", "id": "N1", "data": {"ts": 1, "x": float("nan")}})
        got = []

        def component(reply=None, key=None, default=None):
            json.dumps(reply, allow_nan=False)        # Streamlit needs valid JSON
            got.append(reply)
            return None
        app._bridge_run(FakeSt(), component, b)
        self.assertEqual(len(got), 1)


if __name__ == "__main__":
    unittest.main()
