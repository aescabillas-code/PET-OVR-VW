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


def test_answers_carry_the_page_fingerprint():
    """Nov 24: answers say which page version the server hands out, so an older open page reloads quietly when idle."""
    import streamlit_app as app
    d, build = app.frontend_info()
    assert len(build) == 12
    page = open(d + "/index.html", encoding="utf-8").read()
    assert "window.__PET_BUILD=" + '"' + build + '"' in page
    b = app.Bridge(app.MemStore()); b.build = build
    assert b.reply(None)["build"] == build


def test_checklist_is_merged_on_the_server():
    """Nov 25: two screens saving the same case's checklist at the same moment keep each other's items and alarms."""
    import streamlit_app as app
    st = app.MemStore()
    st.put("cases", "C1", {"items": [{"text": "old item"}, {"id": "a", "text": "A"}]})
    old_id = "i" + app._hstr("0|old item")
    base = [{"id": old_id, "text": "old item"}, {"id": "a", "text": "A"}]
    # screen 1 adds b (with an alarm); screen 2, which has not seen b yet, adds c and ticks A
    app.execute(st, "patch", {"c": "cases", "id": "C1", "data": {"items": base + [{"id": "b", "text": "B", "rem": {"at": 5}}], "__mb": {"items": base}}})
    app.execute(st, "patch", {"c": "cases", "id": "C1", "data": {"items": [base[0], {"id": "a", "text": "A", "done": True}, {"id": "c", "text": "C"}], "__mb": {"items": base}}})
    items = st.get("cases", "C1")["items"]
    assert [x["id"] for x in items] == [old_id, "a", "b", "c"]
    assert items[1].get("done") is True and items[2].get("rem") == {"at": 5}
    assert "__mb" not in st.get("cases", "C1")


def test_first_answer_data_is_ready_before_the_page_asks():
    """Nov 26 (faster opening): warm() reads and packs the first-answer data in the background; a page that opens then
    gets that same packed text without new reads or packing."""
    store = app.MemStore()
    store.put("cases", "C1", {"id": "C1", "owner": "Amy"})
    br = app.Bridge(store)
    br.warm()
    assert br._bootz is not None
    packed = br._bootz[1]
    calls = []
    orig = store.snapshot
    store.snapshot = lambda: (calls.append(1), orig())[1]
    r = br.reply(None)
    assert r["bootz"] == packed
    br.start_warm(every=3600)
    br.start_warm(every=3600)            # started only once
    assert br._warm_t is not None and br._warm_t.daemon
