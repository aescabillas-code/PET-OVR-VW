import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import streamlit_app as app  # noqa: E402


class ExecuteTests(unittest.TestCase):
    def setUp(self):
        self.s = app.MemStore()

    def test_put_get_patch_delete(self):
        app.execute(self.s, "put", {"c": "cases", "id": "A1", "data": {"hp": True, "ts": 5}})
        r = app.execute(self.s, "get", {"c": "cases", "id": "A1"})
        self.assertTrue(r["exists"]); self.assertEqual(r["data"], {"hp": True, "ts": 5}); self.assertEqual(r["version"], 1)
        app.execute(self.s, "patch", {"c": "cases", "id": "A1", "data": {"hp": False}})
        self.assertFalse(app.execute(self.s, "get", {"c": "cases", "id": "A1"})["data"]["hp"])
        app.execute(self.s, "delete", {"c": "cases", "id": "A1"})
        self.assertFalse(app.execute(self.s, "get", {"c": "cases", "id": "A1"})["exists"])

    def test_patch_missing_is_not_found(self):
        with self.assertRaises(app.ApiError) as cm:
            app.execute(self.s, "patch", {"c": "cases", "id": "nope", "data": {"x": 1}})
        self.assertEqual(cm.exception.code, "not_found")

    def test_list_order_and_limit(self):
        for i, ts in enumerate([3, 1, 2]):
            app.execute(self.s, "put", {"c": "cases", "id": f"c{i}", "data": {"ts": ts}})
        r = app.execute(self.s, "list", {"c": "cases", "ob": "ts", "dir": "desc", "lim": 2})
        self.assertEqual([x["data"]["ts"] for x in r["items"]], [3, 2])

    def test_validation(self):
        for bad in ({"c": "_meta", "id": "x", "data": {}}, {"c": "cases", "id": "a/b", "data": {}}, {"c": "cases", "id": "x", "data": {"$bad": 1}}):
            with self.assertRaises(app.ApiError):
                app.execute(self.s, "put", bad)

    def test_assets(self):
        a = app.execute(self.s, "asset_put", {"name": "a.mp3", "type": "audio/mpeg", "data": "data:audio/mpeg;base64,QUJD"})
        self.assertEqual(app.execute(self.s, "asset_get", {"id": a["id"]})["data"], "data:audio/mpeg;base64,QUJD")


class BridgeTests(unittest.TestCase):
    def test_results_are_kept_until_acknowledged_and_not_rerun(self):
        s = app.MemStore(); b = app.Bridge(s)
        msg = {"cid": "c1", "tick": 1, "reqs": [{"id": 1, "op": "put", "a": {"c": "x", "id": "d", "data": {"v": 1}}}], "ack": []}
        b.handle(msg); b.handle(dict(msg, tick=2))          # a retransmit must not apply twice
        self.assertEqual(s.version("x"), 1)
        self.assertIn("1", b.reply(msg)["res"])
        b.handle({"cid": "c1", "tick": 3, "reqs": [], "ack": [1]})
        self.assertEqual(b.reply(msg)["res"], {})

    def test_absorb_requests_rerun_when_results_appear(self):
        s = app.MemStore(); b = app.Bridge(s)
        value = {"cid": "c1", "tick": 1, "reqs": [{"id": 1, "op": "versions", "a": {}}], "ack": []}
        prev, rerun = app.absorb(b, None, value, b.reply(None))
        self.assertTrue(rerun)
        self.assertEqual(app.absorb(b, prev, value, b.reply(prev))[1], False)


class BootTests(unittest.TestCase):
    def test_first_reply_carries_all_saved_data(self):
        s = app.MemStore(); b = app.Bridge(s)
        app.execute(s, "put", {"c": "cases", "id": "A1", "data": {"ts": 1}})
        boot = b.reply(None)["boot"]
        self.assertEqual(boot["cases"]["docs"], {"A1": {"ts": 1}}); self.assertEqual(boot["cases"]["version"], 1)
        self.assertNotIn("boot", b.reply({"cid": "c1"}))


class ConfigTests(unittest.TestCase):
    def test_password_placeholder(self):
        keep = {k: os.environ.pop(k, None) for k in ("MONGO_URI", "MONGODB_URI", "MONGODB_PASSWORD", "MONGO_PASSWORD")}
        try:
            os.environ["MONGODB_URI"] = "mongodb+srv://u:<db_password>@c.mongodb.net/"
            self.assertIsNotNone(app.mongo_settings()[2])
            os.environ["MONGODB_PASSWORD"] = "p@ss:w/rd"
            uri, db, problem = app.mongo_settings()
            self.assertEqual(uri, "mongodb+srv://u:p%40ss%3Aw%2Frd@c.mongodb.net/"); self.assertIsNone(problem); self.assertEqual(db, "pet_station")
        finally:
            for k in ("MONGO_URI", "MONGODB_URI", "MONGODB_PASSWORD", "MONGO_PASSWORD"):
                os.environ.pop(k, None)
                if keep[k] is not None:
                    os.environ[k] = keep[k]


if __name__ == "__main__":
    unittest.main()
