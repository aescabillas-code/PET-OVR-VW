"""MongoDB connection resilience: dropped connections are retried, an outage never loses a change, recovery is automatic."""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import test_mongo_cache as fake  # noqa: E402  installs the fake pymongo
app = fake.app


class AutoReconnect(Exception):
    pass


class OperationFailure(Exception):
    def __init__(self, msg, code=None):
        super().__init__(msg)
        self.code = code


class Reconnect(unittest.TestCase):
    def setUp(self):
        self.saved = (app.RETRY_BUDGET, app.PROBE_GAP)
        app.RETRY_BUDGET, app.PROBE_GAP = 1.0, 0.05
        self.s = app.MongoStore("mongodb://localhost:27017", "t")
        self.coll = self.s.db["cases"]
        self.orig = self.coll.replace_one

    def tearDown(self):
        app.RETRY_BUDGET, app.PROBE_GAP = self.saved
        self.coll.replace_one = self.orig

    def flaky(self, fails, exc=AutoReconnect):
        left = {"n": fails}

        def f(*a, **k):
            if left["n"] != 0:
                left["n"] -= 1
                raise exc("connection reset by peer")
            return self.orig(*a, **k)
        self.coll.replace_one = f

    def test_dropped_connection_is_retried_quietly(self):
        self.flaky(2)
        app.execute(self.s, "put", {"c": "cases", "id": "a", "data": {"ts": 1}})
        self.assertTrue(app.execute(self.s, "get", {"c": "cases", "id": "a"})["exists"])
        self.assertIsNone(self.s.down_since)
        self.assertIsNone(self.s.problem())

    def test_outage_reports_retryable_then_recovers_without_restart(self):
        app.execute(self.s, "put", {"c": "cases", "id": "x", "data": {"ts": 0}})
        vers_before = self.s.versions()
        self.flaky(-1)                                   # down until further notice
        b = app.Bridge(self.s)
        t0 = time.monotonic()
        b.handle({"cid": "c1", "tick": 1, "reqs": [{"id": 1, "op": "put", "a": {"c": "cases", "id": "a", "data": {"ts": 1}}}]})
        self.assertLess(time.monotonic() - t0, 3)       # never hangs the page
        r = b.reply({"cid": "c1", "tick": 1})
        self.assertEqual(r["res"]["1"]["err"]["code"], "unavailable")
        self.assertTrue(r["res"]["1"]["err"]["retry"])  # the browser keeps the change and sends it again
        self.assertTrue(r["down"])
        self.assertIsNotNone(self.s.problem())
        self.s._vers_at -= app.VERS_TTL + 1
        self.assertEqual(self.s.versions(), vers_before)  # last known counters: nothing on screen flickers
        t1 = time.monotonic()
        with self.assertRaises(app.DbDown):              # while down, calls fail fast
            self.s.put("cases", "a", {"ts": 1})
        self.assertLess(time.monotonic() - t1, 0.5)
        self.coll.replace_one = self.orig               # connection is back
        time.sleep(app.PROBE_GAP + 0.01)
        b.handle({"cid": "c1", "tick": 2, "ack": [1], "reqs": [{"id": 2, "op": "put", "a": {"c": "cases", "id": "a", "data": {"ts": 1}}}]})
        r = b.reply({"cid": "c1", "tick": 2})
        self.assertIn("ok", r["res"]["2"])
        self.assertFalse(r["down"])
        self.assertTrue(r["ok"])
        self.assertTrue(app.execute(self.s, "get", {"c": "cases", "id": "a"})["exists"])
        self.assertGreaterEqual(self.s.recovered, 1)

    def test_real_errors_are_not_retried(self):
        self.flaky(1, exc=lambda m: OperationFailure("bad value", code=2))
        with self.assertRaises(OperationFailure):
            self.s.put("cases", "a", {"ts": 1})
        self.assertIsNone(self.s.down_since)

    def test_transient_detection(self):
        self.assertTrue(app.is_transient(AutoReconnect("x")))
        self.assertTrue(app.is_transient(OperationFailure("stepdown", code=189)))
        self.assertFalse(app.is_transient(OperationFailure("auth failed", code=18)))
        self.assertFalse(app.is_transient(ValueError("x")))


if __name__ == "__main__":
    unittest.main()
