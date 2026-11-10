"""MongoStore speed-ups (in-memory change counters + read cache), checked against a tiny fake pymongo that counts round trips."""
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

CALLS = {"n": 0}


def hit():
    CALLS["n"] += 1


class Cursor(list):
    def sort(self, f, d):
        return Cursor(sorted(self, key=lambda r: (r.get(f) is None, r.get(f)), reverse=d < 0))

    def limit(self, n):
        return Cursor(self[:n])


class Coll:
    def __init__(self):
        self.d = {}

    def find(self, q=None, proj=None):
        hit()
        return Cursor(dict(v) for v in self.d.values())

    def find_one(self, q):
        hit()
        v = self.d.get(q["_id"])
        return dict(v) if v else None

    def replace_one(self, q, doc, upsert=False):
        hit()
        self.d[q["_id"]] = dict(doc, _id=q["_id"])

    def update_one(self, q, u, upsert=False):
        hit()
        v = self.d.get(q["_id"])
        if v is None:
            return types.SimpleNamespace(matched_count=0)
        v.update(u.get("$set", {}))
        return types.SimpleNamespace(matched_count=1)

    def find_one_and_update(self, q, u, upsert=False, return_document=None):
        hit()
        v = self.d.setdefault(q["_id"], {"_id": q["_id"], "v": 0})
        v["v"] = v.get("v", 0) + u["$inc"]["v"]
        return dict(v)

    def delete_one(self, q):
        hit()
        return types.SimpleNamespace(deleted_count=1 if self.d.pop(q["_id"], None) else 0)

    def create_index(self, *a, **k):
        hit()

    def estimated_document_count(self):
        return len(self.d)


class Db:
    def __init__(self):
        self.c = {}

    def __getitem__(self, n):
        return self.c.setdefault(n, Coll())

    def list_collection_names(self):
        hit()
        return list(self.c)


class Client:
    def __init__(self, uri, **kw):
        self.dbs = {}
        self.admin = types.SimpleNamespace(command=lambda *_: {"ok": 1})

    def __getitem__(self, n):
        return self.dbs.setdefault(n, Db())


fake = types.ModuleType("pymongo")
fake.MongoClient, fake.ASCENDING, fake.DESCENDING = Client, 1, -1
fake.ReturnDocument = types.SimpleNamespace(AFTER=True)
sys.modules["pymongo"] = fake

import streamlit_app as app  # noqa: E402


class MongoCache(unittest.TestCase):
    def setUp(self):
        self.s = app.MongoStore("mongodb://localhost:27017", "t")
        CALLS["n"] = 0

    def test_heartbeat_needs_no_database_round_trip(self):
        self.s.versions()
        n = CALLS["n"]
        for _ in range(50):
            self.s.versions()
        self.assertEqual(CALLS["n"], n)

    def test_write_is_visible_at_once_and_counter_moves(self):
        v0 = self.s.versions().get("cases", 0)
        app.execute(self.s, "put", {"c": "cases", "id": "a", "data": {"ts": 1, "x": 1}})
        self.assertEqual(self.s.versions()["cases"], v0 + 1)
        r = app.execute(self.s, "list", {"c": "cases", "ob": "ts", "dir": "desc", "lim": 1000})
        self.assertEqual([i["id"] for i in r["items"]], ["a"])
        self.assertEqual(r["version"], v0 + 1)
        app.execute(self.s, "patch", {"c": "cases", "id": "a", "data": {"x": 2}})
        r = app.execute(self.s, "list", {"c": "cases", "ob": "ts", "dir": "desc", "lim": 1000})
        self.assertEqual(r["items"][0]["data"]["x"], 2)
        self.assertEqual(app.execute(self.s, "get", {"c": "cases", "id": "a"})["data"]["x"], 2)
        app.execute(self.s, "delete", {"c": "cases", "id": "a"})
        self.assertEqual(app.execute(self.s, "list", {"c": "cases"})["items"], [])
        self.assertFalse(app.execute(self.s, "get", {"c": "cases", "id": "a"})["exists"])

    def test_unchanged_data_is_read_once_for_many_screens(self):
        for i in range(5):
            app.execute(self.s, "put", {"c": "cases", "id": "c%d" % i, "data": {"ts": i}})
        a = {"c": "cases", "ob": "ts", "dir": "desc", "lim": 1000}
        first = app.execute(self.s, "list", a)
        n = CALLS["n"]
        for _ in range(20):
            self.assertEqual(app.execute(self.s, "list", a), first)
            app.execute(self.s, "get", {"c": "cases", "id": "c1"})
        self.assertLessEqual(CALLS["n"] - n, 1)         # only the first single-document read
        self.assertEqual([i["id"] for i in first["items"]], ["c4", "c3", "c2", "c1", "c0"])

    def test_cached_reads_cannot_be_changed_by_a_caller(self):
        app.execute(self.s, "put", {"c": "cfg", "id": "k", "data": {"a": 1}})
        d = app.execute(self.s, "get", {"c": "cfg", "id": "k"})
        d["data"]["a"] = 99
        d["data"]["new"] = 1
        self.assertNotIn("new", app.execute(self.s, "get", {"c": "cfg", "id": "k"})["data"])
        self.assertNotIn("_updated", app.execute(self.s, "get", {"c": "cfg", "id": "k"})["data"])

    def test_change_made_by_another_server_is_picked_up(self):
        app.execute(self.s, "put", {"c": "ann", "id": "a", "data": {"ts": 1}})
        self.s.versions()
        self.s.db["ann"].d["b"] = {"_id": "b", "ts": 2}          # written behind this server's back
        self.s.meta.d["ann"]["v"] += 1
        self.s._vers_at -= app.VERS_TTL + 1                      # the memory copy is older than its time limit
        ids = [i["id"] for i in app.execute(self.s, "list", {"c": "ann", "ob": "ts", "dir": "desc"})["items"]]
        self.assertEqual(ids, ["b", "a"])

    def test_page_load_snapshot_is_reused_until_something_changes(self):
        app.execute(self.s, "put", {"c": "cases", "id": "a", "data": {"ts": 1}})
        s1 = self.s.snapshot()
        n = CALLS["n"]
        self.assertEqual(self.s.snapshot(), s1)
        self.assertEqual(CALLS["n"], n)
        app.execute(self.s, "put", {"c": "cases", "id": "b", "data": {"ts": 2}})
        s2 = self.s.snapshot()
        self.assertEqual(sorted(s2["cases"]["docs"]), ["a", "b"])
        self.assertEqual(s2["cases"]["version"], self.s.versions()["cases"])


if __name__ == "__main__":
    unittest.main()
