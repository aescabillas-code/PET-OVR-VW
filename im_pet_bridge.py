"""IM•LOGIC ⇄ PET Station bridge — a recorded message thread for every linked case.

The SAME file is used by both apps (copy it unchanged into the PET Station repo). The thread lives in the PET database,
which both apps can reach (same MongoDB account), so nothing new needs to be configured for PET:

    bridge_links  {_id: <PET case id>, im: <IM case id>, imNo, station, owner, by, ts}
    bridge_msgs   {_id, pet: <PET case id>, im: <IM case id>, from: "IM" | "PET", by, text, ts}

Operations (the browser calls them through the shim, the server runs execute()):
    bridge_link    IM links one of its cases to a PET case (also refreshes the IM station / owner shown in PET)
    bridge_send    post a message on the thread of a linked case (from = the app that sends it)
    bridge_thread  the whole thread and the link of one PET case
    bridge_feed    messages (and, with links=True, links) newer than `since`, optionally only for some PET cases

Messages are never edited or deleted: the thread is the record of the exchange. Times are server milliseconds.
"""
import copy
import fcntl
import json
import os
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional

SIDES = ("IM", "PET")
MAX_TEXT = 2000
FEED_LIMIT = 300
THREAD_LIMIT = 500


class BridgeError(Exception):
    def __init__(self, code: str, msg: str):
        super().__init__(msg)
        self.code = code


def now_ms() -> int:
    return int(time.time() * 1000)


def _s(v: Any, n: int) -> str:
    return str(v if v is not None else "").strip()[:n]


def _out(d: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not d:
        return None
    o = {k: v for k, v in d.items() if k != "_id"}
    o["id"] = str(d.get("_id"))
    return o


def execute(db: Any, op: str, a: Any, side: str) -> Dict[str, Any]:
    if side not in SIDES:
        raise BridgeError("invalid_argument", "Unknown app")
    if db is None:
        raise BridgeError("failed_precondition", "The shared PET database is not connected")
    a = a if isinstance(a, dict) else {}
    links, msgs = db["bridge_links"], db["bridge_msgs"]

    if op == "bridge_link":
        pet, im = _s(a.get("pet"), 120), _s(a.get("im"), 120)
        if not pet or not im:
            raise BridgeError("invalid_argument", "Missing case ids")
        doc = {"im": im, "imNo": _s(a.get("imNo"), 120) or im, "station": _s(a.get("station"), 40),
               "owner": _s(a.get("owner"), 120), "by": _s(a.get("by"), 120), "ts": now_ms()}
        links.update_one({"_id": pet}, {"$set": doc}, upsert=True)
        return {"ok": True, "link": dict(doc, id=pet)}

    if op == "bridge_send":
        pet, text = _s(a.get("pet"), 120), str(a.get("text") or "").replace("\r\n", "\n").strip()[:MAX_TEXT]
        if not pet:
            raise BridgeError("invalid_argument", "Missing PET case id")
        if not text:
            raise BridgeError("invalid_argument", "Write a message first")
        im = _s(a.get("im"), 120)
        if not im:
            ln = links.find_one({"_id": pet})
            im = str(ln.get("im") or "") if ln else ""
        m = {"_id": uuid.uuid4().hex, "pet": pet, "im": im, "from": side, "by": _s(a.get("by"), 120) or side,
             "text": text, "ts": now_ms()}
        msgs.insert_one(dict(m))
        return {"msg": _out(m)}

    if op == "bridge_thread":
        pet = _s(a.get("pet"), 120)
        if not pet:
            raise BridgeError("invalid_argument", "Missing PET case id")
        items = list(msgs.find({"pet": pet}).sort("ts", 1).limit(THREAD_LIMIT))
        return {"items": [_out(x) for x in items], "link": _out(links.find_one({"_id": pet})), "now": now_ms()}

    if op == "bridge_feed":
        try:
            since = int(float(a.get("since") or 0))
        except (TypeError, ValueError):
            since = 0
        q: Dict[str, Any] = {"ts": {"$gt": since}}
        pets = a.get("pets")
        if isinstance(pets, list):
            q["pet"] = {"$in": [_s(p, 120) for p in pets[:500] if p]}
        out: Dict[str, Any] = {"items": [_out(x) for x in msgs.find(q).sort("ts", 1).limit(FEED_LIMIT)], "now": now_ms()}
        if a.get("links"):
            out["links"] = [_out(x) for x in links.find({"ts": {"$gt": since}}).sort("ts", 1).limit(FEED_LIMIT)]
        return out

    raise BridgeError("invalid_argument", "Unknown bridge operation: " + str(op))


# ---------------------------------------------------------------- a tiny stand-in for tests (no MongoDB needed)
class _Cursor:
    def __init__(self, rows: List[Dict[str, Any]]):
        self.rows = rows

    def sort(self, k: str, d: int = 1) -> "_Cursor":
        self.rows.sort(key=lambda r: r.get(k) or 0, reverse=d < 0)
        return self

    def limit(self, n: int) -> "_Cursor":
        self.rows = self.rows[:n]
        return self

    def __iter__(self) -> Iterable[Dict[str, Any]]:
        return iter([copy.deepcopy(r) for r in self.rows])


def _match(doc: Dict[str, Any], q: Dict[str, Any]) -> bool:
    for k, v in q.items():
        x = doc.get(k)
        if isinstance(v, dict):
            if "$gt" in v and not (x is not None and x > v["$gt"]):
                return False
            if "$in" in v and x not in v["$in"]:
                return False
        elif x != v:
            return False
    return True


class FakeDB:
    """Mongo-like store for tests. With a file path, several processes (an IM and a PET test server) share it."""

    def __init__(self, path: Optional[str] = None):
        self.path, self.mem = path, {}

    def _load(self) -> Dict[str, Any]:
        if not self.path:
            return self.mem
        try:
            with open(self.path) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def _save(self, data: Dict[str, Any]) -> None:
        if self.path:
            with open(self.path + ".tmp", "w") as f:
                json.dump(data, f)
            os.replace(self.path + ".tmp", self.path)

    def _locked(self, fn):
        if not self.path:
            return fn(self.mem)
        with open(self.path + ".lock", "a") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            data = self._load()
            r = fn(data)
            self._save(data)
            return r

    def __getitem__(self, name: str) -> "_FakeColl":
        return _FakeColl(self, name)


class _FakeColl:
    def __init__(self, db: FakeDB, name: str):
        self.db, self.name = db, name

    def find(self, q: Optional[Dict[str, Any]] = None) -> _Cursor:
        rows = self.db._locked(lambda d: [copy.deepcopy(r) for r in d.get(self.name, {}).values() if _match(r, q or {})])
        return _Cursor(rows)

    def find_one(self, q: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        for r in self.find(q):
            return r
        return None

    def insert_one(self, doc: Dict[str, Any]) -> None:
        self.db._locked(lambda d: d.setdefault(self.name, {}).__setitem__(str(doc["_id"]), copy.deepcopy(doc)))

    def update_one(self, q: Dict[str, Any], upd: Dict[str, Any], upsert: bool = False) -> None:
        def go(d):
            rows = d.setdefault(self.name, {})
            hit = [r for r in rows.values() if _match(r, q)]
            if hit:
                hit[0].update(copy.deepcopy(upd.get("$set", {})))
            elif upsert:
                r = dict(q, **copy.deepcopy(upd.get("$set", {})))
                rows[str(r["_id"])] = r
        self.db._locked(go)
