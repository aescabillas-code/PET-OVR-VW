"""PAT (PET Automation Tool): Streamlit + MongoDB (Atlas) in a single Python file.

The HTML app (web/pet_station.html) runs inside a bidirectional Streamlit component. Everything entered in it is
sent to this process, written to MongoDB, and pushed to every other open screen. There is no separate API server.

    pip install -r requirements.txt
    cp .env.example .env            # set MONGODB_PASSWORD
    streamlit run streamlit_app.py

Environment (or .env, or Streamlit secrets):
  MONGO_URI / MONGODB_URI        connection string, e.g. mongodb+srv://user:<db_password>@cluster.mongodb.net/
  MONGODB_PASSWORD               replaces <db_password> in the URI (URL-encoded for you)
  MONGO_DB / MONGODB_DB          database name (default "pet_station")
  PET_APP_PASSWORD               optional password asked before the app is shown

If MongoDB drops out the app keeps running and reconnects by itself; the browser keeps unsaved changes and resends them.
Only a configuration problem (wrong password, bad URI) falls back to memory only (nothing is saved).
"""
import base64
import collections
import copy
import hmac
import os
import pathlib
import re
import tempfile
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote_plus

ROOT = pathlib.Path(__file__).resolve().parent
SECRET_KEYS = ("MONGO_URI", "MONGODB_URI", "MONGODB_PASSWORD", "MONGO_PASSWORD", "MONGO_DB", "MONGODB_DB", "PET_APP_PASSWORD")
BOOT_LIMIT = 3000                       # documents per collection sent with the first render
VERS_TTL = 2.0                          # seconds the change counters are served from memory before MongoDB is asked again
READ_CACHE_MAX = 400                    # cached read results (each is dropped as soon as its collection changes)
PUSH_MAX_DOCS = 1500                    # a changed collection up to this size is sent along with the change signal
CHANGE_LOG = 2000                       # recent changes remembered per collection: browsers get only the changed documents
MAX_ASSET_CHARS = 14_000_000            # ~10 MB file as a base64 data URL (a MongoDB document holds 16 MB)
# Connection resilience: a dropped or briefly unreachable MongoDB connection is retried quietly instead of failing.
RETRY_BUDGET = 6.0                      # seconds one database call keeps retrying a dropped connection before reporting it
PROBE_GAP = 2.0                         # while MongoDB is unreachable, at most one reconnect attempt per this many seconds
KEEPALIVE_EVERY = 25.0                  # seconds between the background pings that keep the connection warm and detect outages
TRANSIENT_NAMES = {"AutoReconnect", "NetworkTimeout", "ConnectionFailure", "ServerSelectionTimeoutError", "NotPrimaryError",
                   "NotMasterError", "WaitQueueTimeoutError", "ExecutionTimeout", "WTimeoutError", "ConnectionResetError",
                   "ConnectionRefusedError", "BrokenPipeError", "TimeoutError", "socket.timeout"}
TRANSIENT_CODES = {6, 7, 89, 91, 189, 262, 9001, 10107, 11600, 11602, 13435, 13436, 50, 64}


def is_transient(ex: BaseException) -> bool:
    """True for errors that mean "the connection dropped / the server is switching over": safe to retry."""
    if any(c.__name__ in TRANSIENT_NAMES for c in type(ex).__mro__):
        return True
    try:
        if ex.has_error_label("RetryableWriteError") or ex.has_error_label("TransientTransactionError"):  # type: ignore[attr-defined]
            return True
    except Exception:  # noqa: BLE001
        pass
    code = getattr(ex, "code", None)
    return isinstance(code, int) and code in TRANSIENT_CODES


class DbDown(Exception):
    """MongoDB is unreachable right now; the browser keeps the change and sends it again."""

COLL_RE = re.compile(r"^[A-Za-z0-9_\-]{1,100}$")
DOCID_RE = re.compile(r"^[A-Za-z0-9_.\-~:@+]{1,200}$")
FIELD_RE = re.compile(r"^[A-Za-z0-9_.]{1,100}$")


# Pseudonym -> real account name. The app and the database only ever hold pseudonyms; the real names come from
# Streamlit secrets (ACCOUNT_REAL_NAMES, a table or a JSON string) or the environment, and are handed to the browser
# only for the accounts in a report that is being extracted.
REAL_NAMES: Dict[str, str] = {}


def _acct_key(v: Any) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip().lower()


def load_real_names(raw: Any) -> Dict[str, str]:
    """Accept a mapping, a JSON object string, or lines of `pseudonym = real name` / `pseudonym,real name`."""
    import json

    if raw is None or raw == "":
        return {}
    if isinstance(raw, str):
        txt = raw.strip()
        try:
            raw = json.loads(txt)
        except ValueError:
            raw = {}
            for line in txt.splitlines():
                m = re.split(r"\s*[=,\t]\s*", line.strip(), maxsplit=1)
                if len(m) == 2 and m[0] and m[1]:
                    raw[m[0]] = m[1]
    try:
        items = dict(raw).items()
    except (TypeError, ValueError):
        return {}
    return {_acct_key(k): str(v).strip() for k, v in items if _acct_key(k) and str(v).strip()}


def real_names_for(names: Any) -> Dict[str, Any]:
    names = [str(n) for n in names][:2000] if isinstance(names, list) else []
    out, missing = {}, []
    for n in names:
        r = REAL_NAMES.get(_acct_key(n))
        if r:
            out[n] = r
        else:
            missing.append(n)
    return {"configured": bool(REAL_NAMES), "map": out, "missing": missing}


# Downloadable templates live in the repo (templates/). The Template button reads the file from here every time,
# so replacing the file on GitHub and redeploying is all that is needed to change the template.
TEMPLATE_FILES = {"shift": "PET_Shift_Schedule_Template.xlsx"}


def read_template(name: Any) -> Dict[str, Any]:
    fn = TEMPLATE_FILES.get(str(name or "shift"))
    if not fn:
        return {"missing": True}
    p = pathlib.Path(__file__).resolve().parent / "templates" / fn
    try:
        return {"name": fn, "b64": base64.b64encode(p.read_bytes()).decode("ascii")}
    except OSError:
        return {"missing": True}


def now_ms() -> int:
    return int(time.time() * 1000)


# ============================================================================= configuration
def load_env_file() -> None:
    """Read ROOT/.env (KEY=VALUE lines) without overriding variables that are already set."""
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
        return
    except ImportError:
        pass
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip() if not line.lstrip().startswith("#") else ""
            if "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def mongo_settings() -> Tuple[str, str, Optional[str]]:
    """Return (uri, database, problem). `<db_password>` in the URI is filled from MONGODB_PASSWORD."""
    def env(*names: str) -> str:
        for n in names:
            v = os.environ.get(n, "").strip()
            if v:
                return v
        return ""

    uri = env("MONGO_URI", "MONGODB_URI") or "mongodb://localhost:27017"
    db = env("MONGO_DB", "MONGODB_DB") or "pet_station"
    problem = None
    if "<db_password>" in uri:
        pw = env("MONGODB_PASSWORD", "MONGO_PASSWORD")
        if pw:
            uri = uri.replace("<db_password>", quote_plus(pw))
        else:
            problem = "MONGODB_PASSWORD is not set: the connection string still contains <db_password>."
    return uri, db, problem


# ============================================================================= storage
class MemStore:
    """Process-local store (lost on restart). Used only when MongoDB cannot be reached."""

    kind = "memory"

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.docs: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.ver: Dict[str, int] = {}
        self.assets: Dict[str, Dict[str, Any]] = {}
        self.changes: Dict[str, Any] = {}        # collection -> deque of (version, document id): what each change touched

    def _log_change(self, c: str, v: int, i: Optional[str]) -> None:
        dq = self.changes.get(c)
        if dq is None:
            dq = self.changes[c] = collections.deque(maxlen=CHANGE_LOG)
        dq.append((int(v), i))

    def changed_since(self, c: str, v: int, cur: int) -> Optional[List[str]]:
        """Ids of the documents changed after version v up to cur, or None if that is not fully known (send it all)."""
        if cur <= v:
            return []
        dq = self.changes.get(c)
        if not dq:
            return None
        with self.lock:
            items = [x for x in list(dq) if v < x[0] <= cur]
        got = {x[0] for x in items}
        if any(n not in got for n in range(v + 1, cur + 1)) or any(x[1] is None for x in items):
            return None
        return list(dict.fromkeys(x[1] for x in items))

    def describe(self) -> str:
        return "in-memory (NOT persistent)"

    def versions(self) -> Dict[str, int]:
        with self.lock:
            return dict(self.ver)

    def version(self, c: str) -> int:
        return self.ver.get(c, 0)

    def _bump(self, c: str, i: Optional[str] = None) -> None:
        self.ver[c] = self.ver.get(c, 0) + 1
        self._log_change(c, self.ver[c], i)

    def get(self, c: str, i: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            d = self.docs.get(c, {}).get(i)
            return copy.deepcopy(d) if d is not None else None

    def put(self, c: str, i: str, doc: Dict[str, Any]) -> None:
        with self.lock:
            self.docs.setdefault(c, {})[i] = dict(doc, _updated=now_ms())
            self._bump(c, i)

    def patch(self, c: str, i: str, fields: Dict[str, Any]) -> bool:
        with self.lock:
            d = self.docs.get(c, {}).get(i)
            if d is None:
                return False
            for k, v in fields.items():          # dotted keys are paths, like MongoDB $set
                t = d
                keys = k.split(".")
                for p in keys[:-1]:
                    if not isinstance(t.get(p), dict):
                        t[p] = {}
                    t = t[p]
                t[keys[-1]] = v
            d["_updated"] = now_ms()
            self._bump(c, i)
            return True

    def delete(self, c: str, i: str) -> None:
        with self.lock:
            if self.docs.get(c, {}).pop(i, None) is not None:
                self._bump(c, i)

    def list(self, c: str, order_by: Optional[str], desc: bool, limit: int) -> List[Tuple[str, Dict[str, Any]]]:
        with self.lock:
            rows = [(i, copy.deepcopy(d)) for i, d in self.docs.get(c, {}).items()]
        if order_by:
            def key(r):
                v = r[1].get(order_by)
                return (v is None, v if isinstance(v, (int, float)) else str(v))
            try:
                rows.sort(key=key, reverse=desc)
            except TypeError:
                rows.sort(key=lambda r: str(r[1].get(order_by)), reverse=desc)
        return rows[:limit] if limit else rows

    def asset_put(self, name: str, ctype: str, data: str) -> Dict[str, Any]:
        with self.lock:
            aid = uuid.uuid4().hex
            self.assets[aid] = {"name": name, "type": ctype, "data": data}
            return {"id": aid, "filename": name, "contentType": ctype, "sizeBytes": len(data)}

    def asset_get(self, aid: str) -> Optional[Dict[str, Any]]:
        a = self.assets.get(aid)
        return dict(a, id=aid) if a else None

    def asset_del(self, aid: str) -> None:
        with self.lock:
            self.assets.pop(aid, None)

    def asset_list(self) -> List[Dict[str, Any]]:
        return [{"id": k, "filename": v["name"], "contentType": v["type"], "sizeBytes": len(v["data"])} for k, v in self.assets.items()]

    def counts(self) -> Dict[str, int]:
        return {c: len(d) for c, d in self.docs.items()}

    def snapshot(self) -> Dict[str, Any]:
        """Everything saved so far, sent with the first page render so the dashboard fills instantly."""
        with self.lock:
            return {c: {"version": self.version(c), "docs": {i: {k: v for k, v in d.items() if k != "_updated"} for i, d in docs.items()}}
                    for c, docs in self.docs.items()}


    def snapshot_one(self, c: str) -> Dict[str, Any]:
        """One collection, in the same shape as snapshot(): sent to browsers that hold an older version of it."""
        with self.lock:
            docs = self.docs.get(c, {})
            return {"version": self.version(c), "docs": {i: {k: v for k, v in d.items() if k != "_updated"} for i, d in docs.items()}}


class MongoStore(MemStore):
    """MongoDB / Atlas store. One MongoDB collection per app collection, plus `_meta` (change counters) and `_assets`."""

    kind = "mongodb"

    def __init__(self, uri: str, dbname: str) -> None:
        from pymongo import MongoClient

        # Connection hardening: automatic retry of reads/writes after a dropped connection, idle sockets recycled before
        # Atlas closes them, bounded timeouts so nothing hangs, a small always-open pool so the first call never waits.
        opts: Dict[str, Any] = {}
        defaults = {"serverSelectionTimeoutMS": 5000, "connectTimeoutMS": 8000, "socketTimeoutMS": 30000,
                    "maxIdleTimeMS": 60000, "retryWrites": True, "retryReads": True, "maxPoolSize": 20, "minPoolSize": 1,
                    "heartbeatFrequencyMS": 10000, "waitQueueTimeoutMS": 10000, "appname": "pet-station"}
        low = uri.lower()
        for k, v in defaults.items():                # options written in the connection string win
            if k.lower() + "=" not in low:
                opts[k] = v
        if uri.startswith("mongodb+srv://") or "mongodb.net" in uri:
            try:                                  # Atlas needs TLS; certifi avoids CERTIFICATE_VERIFY_FAILED on some machines
                import certifi
                opts["tlsCAFile"] = certifi.where()
            except ImportError:
                pass
        self.lock = threading.RLock()
        self.uri, self.dbname = uri, dbname
        self.client = MongoClient(uri, **opts)
        self.down_since: Optional[float] = None   # set while MongoDB is unreachable; cleared by the first success
        self.last_error: Optional[str] = None
        self._probe_at = 0.0
        self.recovered = 0                        # number of times the connection came back by itself
        self.db = self.client[dbname]
        self.meta, self.c_assets = self.db["_meta"], self.db["_assets"]
        self._indexed: set = set()
        # Speed: the change counters and the last read of each collection are kept in memory, so the quiet check every
        # browser makes about once a second and a re-read of unchanged data never wait for MongoDB. Every write made
        # through this app updates the counters at once; they are also re-read from MongoDB every VERS_TTL seconds.
        self._vers: Optional[Dict[str, int]] = None
        self._vers_at = 0.0
        self._reads: Dict[Any, Tuple[int, Any]] = {}
        self._snap: Optional[Tuple[Any, Any]] = None
        self.changes: Dict[str, Any] = {}        # collection -> recent (version, document id) changes made through this app
        self._first_ping()
        self._keepalive = threading.Thread(target=self._keepalive_loop, name="pet-mongo-keepalive", daemon=True)
        self._keepalive.start()

    # ---------------------------------------------------------------- connection resilience
    def _first_ping(self) -> None:
        """Check the connection at start. A wrong password raises (nothing to retry); a network problem does not:
        the store starts in "reconnecting" mode and recovers by itself as soon as MongoDB answers."""
        for delay in (0.0, 0.5, 1.5):
            if delay:
                time.sleep(delay)
            try:
                self.client.admin.command("ping")
                self._ok()
                return
            except Exception as ex:  # noqa: BLE001
                if not is_transient(ex):
                    raise
                self._fail(ex)

    def _ok(self) -> None:
        if self.down_since is not None:
            self.recovered += 1
            with self.lock:                        # data may have changed while we could not see it: re-read everything
                self._vers_at = 0.0
                self._reads.clear()
                self._snap = None
        self.down_since, self.last_error = None, None

    def _fail(self, ex: BaseException) -> None:
        if self.down_since is None:
            self.down_since = time.monotonic()
        self.last_error = f"{ex.__class__.__name__}: {str(ex)[:160]}"

    def _run(self, fn):
        """Run one database call. A dropped connection is retried with a short back-off (all writes here are
        idempotent: replace/$set/delete by id). While MongoDB is down, calls fail fast (one probe every PROBE_GAP s)
        so the page never stalls; the browser keeps unsaved changes and sends them again."""
        now = time.monotonic()
        if self.down_since is not None:
            if now - self._probe_at < PROBE_GAP:
                raise DbDown(self.last_error or "MongoDB unreachable")
            self._probe_at = now
            budget = 0.0                           # a single attempt while down
        else:
            budget = RETRY_BUDGET
        t0, delay = now, 0.15
        while True:
            try:
                out = fn()
                self._ok()
                return out
            except Exception as ex:  # noqa: BLE001
                if not is_transient(ex):
                    raise
                self._fail(ex)
                if time.monotonic() - t0 + delay > budget:
                    self._probe_at = time.monotonic()
                    raise DbDown(self.last_error or "MongoDB unreachable") from ex
                time.sleep(delay)
                delay = min(delay * 2, 1.5)

    def _keepalive_loop(self) -> None:
        while True:
            time.sleep(KEEPALIVE_EVERY if self.down_since is None else PROBE_GAP)
            try:
                self.client.admin.command("ping")
                self._ok()
            except Exception as ex:  # noqa: BLE001
                if is_transient(ex):
                    self._fail(ex)

    def problem(self) -> Optional[str]:
        if self.down_since is None:
            return None
        return ("MongoDB is not answering right now — reconnecting automatically. Changes are kept in the browser and "
                f"saved as soon as the connection is back. ({self.last_error or ''})")

    def describe(self) -> str:
        host = self.uri.split("@")[-1].split("?")[0].rstrip("/")
        return f"MongoDB · {host} · db '{self.dbname}'"

    def versions(self) -> Dict[str, int]:
        with self.lock:
            if self._vers is not None and time.monotonic() - self._vers_at < VERS_TTL:
                return dict(self._vers)
        try:
            fresh = self._run(lambda: {r["_id"]: int(r["v"]) for r in self.meta.find({})})
        except DbDown:
            with self.lock:                        # keep serving the last known counters: nothing on screen flickers
                if self._vers is not None:
                    self._vers_at = time.monotonic() - VERS_TTL + PROBE_GAP
                    return dict(self._vers)
            raise
        with self.lock:
            cur = self._vers or {}
            for k, v in cur.items():                # a counter never goes backwards (a write may have finished meanwhile)
                if v > fresh.get(k, 0):
                    fresh[k] = v
            self._vers, self._vers_at = fresh, time.monotonic()
            return dict(fresh)

    def version(self, c: str) -> int:
        return int(self.versions().get(c, 0))

    def _bump(self, c: str, i: Optional[str] = None) -> None:
        from pymongo import ReturnDocument

        r = self._run(lambda: self.meta.find_one_and_update({"_id": c}, {"$inc": {"v": 1}}, upsert=True,
                                                            return_document=ReturnDocument.AFTER))
        with self.lock:
            if self._vers is not None:
                nv = int(r["v"]) if r and "v" in r else self._vers.get(c, 0) + 1
                self._vers[c] = max(nv, self._vers.get(c, 0) + 1)
            if r and "v" in r:
                self._log_change(c, int(r["v"]), i)
            for k in [k for k in self._reads if k[1] == c]:
                self._reads.pop(k, None)
            self._snap = None

    def _cached(self, key, load):
        """Result of `load()` for one collection, reused until that collection's change counter moves."""
        v = self.version(key[1])
        with self.lock:
            hit = self._reads.get(key)
            if hit is not None and hit[0] == v:
                return hit[1]
        val = self._run(load)
        with self.lock:
            if len(self._reads) >= READ_CACHE_MAX:
                self._reads.clear()
            if int((self._vers or {}).get(key[1], 0)) == v:      # not changed while reading: safe to keep
                self._reads[key] = (v, val)
        return val

    def get(self, c, i):
        def load():
            d = self.db[c].find_one({"_id": i})
            return {k: v for k, v in d.items() if k != "_id"} if d else None
        d = self._cached(("get", c, i), load)
        return dict(d) if d is not None else None

    def put(self, c, i, doc):
        self._run(lambda: self.db[c].replace_one({"_id": i}, dict(doc, _updated=now_ms()), upsert=True))
        self._bump(c, i)

    def patch(self, c, i, fields):
        r = self._run(lambda: self.db[c].update_one({"_id": i}, {"$set": dict(fields, _updated=now_ms())}))
        if r.matched_count == 0:
            return False
        self._bump(c, i)
        return True

    def delete(self, c, i):
        if self._run(lambda: self.db[c].delete_one({"_id": i})).deleted_count:
            self._bump(c, i)

    def list(self, c, order_by, desc, limit):
        from pymongo import ASCENDING, DESCENDING

        def load():
            cur = self.db[c].find({})
            if order_by:
                if (c, order_by) not in self._indexed:
                    self.db[c].create_index([(order_by, DESCENDING)])
                    self._indexed.add((c, order_by))
                cur = cur.sort(order_by, DESCENDING if desc else ASCENDING)
            if limit:
                cur = cur.limit(limit)
            return [(d["_id"], {k: v for k, v in d.items() if k != "_id"}) for d in cur]
        return [*self._cached(("list", c, order_by, bool(desc), int(limit or 0)), load)]

    def asset_put(self, name, ctype, data):
        aid = uuid.uuid4().hex
        self._run(lambda: self.c_assets.replace_one({"_id": aid}, {"_id": aid, "name": name, "type": ctype, "data": data,
                                                                   "_ts": now_ms()}, upsert=True))
        return {"id": aid, "filename": name, "contentType": ctype, "sizeBytes": len(data)}

    def asset_get(self, aid):
        d = self._run(lambda: self.c_assets.find_one({"_id": aid}))
        return {"id": aid, "name": d["name"], "type": d["type"], "data": d["data"]} if d else None

    def asset_del(self, aid):
        self._run(lambda: self.c_assets.delete_one({"_id": aid}))

    def asset_list(self):
        return self._run(lambda: [{"id": d["_id"], "filename": d.get("name"), "contentType": d.get("type"),
                                   "sizeBytes": d.get("size", 0)} for d in self.c_assets.find({}, {"name": 1, "type": 1})])

    def counts(self):
        return self._run(lambda: {c: self.db[c].estimated_document_count() for c in self.db.list_collection_names()
                                  if not c.startswith("_")})

    def snapshot_one(self, c: str) -> Dict[str, Any]:
        v = self.version(c)

        def load():
            docs = {d["_id"]: {k: x for k, x in d.items() if k not in ("_id", "_updated")} for d in self.db[c].find({}).limit(PUSH_MAX_DOCS + 1)}
            return docs
        docs = self._cached(("snap", c), load)
        return {"version": v, "docs": dict(docs)}

    def snapshot(self):
        vers = self.versions()                      # versions first: a newer document only causes one extra refresh
        key = tuple(sorted(vers.items()))
        with self.lock:
            if self._snap is not None and self._snap[0] == key:
                return self._snap[1]                # nothing changed since the last page load: no database round trips
        def load():
            out = {}
            for name in self.db.list_collection_names():
                if name.startswith("_"):
                    continue
                docs = {d["_id"]: {k: v for k, v in d.items() if k not in ("_id", "_updated")}
                        for d in self.db[name].find({}).limit(BOOT_LIMIT)}
                out[name] = {"version": int(vers.get(name, 0)), "docs": docs}
                if len(docs) >= BOOT_LIMIT:
                    out[name]["partial"] = True     # too big to mirror: the browser asks the server for this one
            return out
        out = self._run(load)
        with self.lock:
            if tuple(sorted((self._vers or {}).items())) == key:
                self._snap = (key, out)
        return out


def make_store() -> Tuple[MemStore, Optional[str]]:
    """Return (store, error). A network problem does not fall back to memory any more: MongoStore starts in
    "reconnecting" mode and recovers by itself. Only a configuration problem (wrong password, bad connection string,
    pymongo missing) falls back to MemStore."""
    uri, dbname, problem = mongo_settings()
    if problem:
        return MemStore(), problem + " Data will NOT be saved."
    try:
        return MongoStore(uri, dbname), None
    except Exception as ex:  # noqa: BLE001
        msg = f"{ex.__class__.__name__}: {str(ex)}"
        for secret in {os.environ.get("MONGODB_PASSWORD", ""), os.environ.get("MONGO_PASSWORD", "")} - {""}:
            msg = msg.replace(secret, "***").replace(quote_plus(secret), "***")
        return MemStore(), (f"MongoDB not reachable ({msg[:200]}). Check the password and that your IP address is allowed in "
                            "Atlas > Network Access. Data will NOT be saved.")


# ============================================================================= request execution
class ApiError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


def _coll(name: Any) -> str:
    if not isinstance(name, str) or not COLL_RE.match(name) or name.startswith("_"):
        raise ApiError("invalid_argument", "Invalid collection name")
    return name


def _id(doc_id: Any) -> str:
    if not isinstance(doc_id, str) or not DOCID_RE.match(doc_id):
        raise ApiError("invalid_argument", "Invalid document id")
    return doc_id


def _body(data: Any) -> Dict[str, Any]:
    if not isinstance(data, dict):
        raise ApiError("invalid_argument", "Body must be an object")
    out = {k: v for k, v in data.items() if k not in ("_id", "_updated")}
    for k in out:
        if not k or k.startswith("$"):
            raise ApiError("invalid_argument", f"Invalid field name: {k!r}")
    return out


def execute(store: MemStore, op: str, a: Dict[str, Any]) -> Any:
    """Run one request from the browser. Same semantics as the original REST API."""
    a = a or {}
    if op == "versions":
        return store.versions()
    if op == "get":
        c, i = _coll(a.get("c")), _id(a.get("id"))
        v = store.version(c)
        d = store.get(c, i)
        if d is None:
            return {"version": v, "id": i, "exists": False, "data": None}
        d.pop("_updated", None)
        return {"version": v, "id": i, "exists": True, "data": d}
    if op == "list":
        c = _coll(a.get("c"))
        ob = a.get("ob") or None
        if ob and not FIELD_RE.match(str(ob)):
            raise ApiError("invalid_argument", "Invalid orderBy field")
        lim = max(0, min(int(a.get("lim") or 0), 5000)) or 1000
        v = store.version(c)
        rows = store.list(c, ob, a.get("dir") == "desc", lim)
        items = [{"id": i, "data": {k: x for k, x in d.items() if k != "_updated"}} for i, d in rows]
        return {"version": v, "count": len(items), "items": items}
    if op == "put":
        c, i = _coll(a.get("c")), _id(a.get("id"))
        store.put(c, i, _body(a.get("data")))
        return {"id": i, "version": store.version(c)}
    if op == "patch":
        c, i = _coll(a.get("c")), _id(a.get("id"))
        if not store.patch(c, i, _body(a.get("data"))):
            raise ApiError("not_found", "Document not found")
        return {"id": i, "version": store.version(c)}
    if op == "delete":
        c, i = _coll(a.get("c")), _id(a.get("id"))
        store.delete(c, i)
        return {"id": i}
    if op == "asset_put":
        data = a.get("data")
        if not isinstance(data, str) or not data:
            raise ApiError("invalid_argument", "Missing file data")
        if len(data) > MAX_ASSET_CHARS:
            raise ApiError("too_large", "File is larger than 10 MB")
        return store.asset_put(str(a.get("name") or "upload")[:200], str(a.get("type") or "application/octet-stream")[:100], data)
    if op == "asset_get":
        d = store.asset_get(str(a.get("id") or ""))
        if not d:
            raise ApiError("not_found", "Asset not found")
        return d
    if op == "asset_del":
        store.asset_del(str(a.get("id") or ""))
        return {"ok": True}
    if op == "asset_list":
        return {"assets": store.asset_list()}
    if op == "real_names":
        return real_names_for(a.get("names"))
    if op == "template":
        return read_template(a.get("name"))
    raise ApiError("invalid_argument", f"Unknown operation: {op}")


# ============================================================================= browser <-> server protocol
class Bridge:
    """Server side of the component protocol (see web/shim.js). Framework independent, so it can be tested."""

    def __init__(self, store: MemStore) -> None:
        self.store = store
        self.done: Dict[str, Dict[str, Any]] = {}       # cid -> {request id: result}, kept until the browser acknowledges
        self.seen: Dict[str, float] = {}
        self.have: Dict[str, Dict[str, int]] = {}       # cid -> {collection: version the browser holds}
        self.err: Optional[str] = None
        self.lock = threading.Lock()

    def handle(self, msg: Dict[str, Any]) -> None:
        cid = str(msg.get("cid") or "?")
        with self.lock:
            now = time.time()
            self.seen[cid] = now
            for old in [k for k, t in self.seen.items() if now - t > 900]:      # forget browsers that went away
                self.seen.pop(old, None)
                self.done.pop(old, None)
                self.have.pop(old, None)
            have = msg.get("have")
            if isinstance(have, dict):
                self.have[cid] = {str(k)[:80]: int(v) for k, v in list(have.items())[:60] if isinstance(v, (int, float))}
            bucket = self.done.setdefault(cid, {})
            for rid in msg.get("ack") or []:
                bucket.pop(str(rid), None)
            for r in msg.get("reqs") or []:
                rid = str(r.get("id"))
                if rid in bucket:
                    continue
                try:
                    bucket[rid] = {"ok": execute(self.store, str(r.get("op")), r.get("a") or {})}
                    self.err = None
                except ApiError as ex:
                    bucket[rid] = {"err": {"code": ex.code, "message": ex.message}}
                except Exception as ex:  # noqa: BLE001  database errors: report to the browser, keep going
                    self.err = f"{ex.__class__.__name__}: {str(ex)[:200]}"
                    retry = isinstance(ex, DbDown) or is_transient(ex)
                    bucket[rid] = {"err": {"code": "unavailable", "message": "Database unavailable", "retry": retry}}

    def reply(self, msg: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        vers: Optional[Dict[str, int]]
        try:
            vers = self.store.versions()
        except Exception as ex:  # noqa: BLE001  None: the browser keeps the counters it has (no refresh storm)
            vers = None
            self.err = f"{ex.__class__.__name__}: {str(ex)[:200]}"
        down = getattr(self.store, "down_since", None) is not None
        if not down and isinstance(self.err, str) and ("DbDown" in self.err or "AutoReconnect" in self.err):
            self.err = None                        # the connection is back: clear the old notice
        base = {"now": now_ms(), "ok": self.err is None and not down, "err": self.err, "store": self.store.kind,
                "vers": vers, "down": down}
        if not msg:
            boot = None
            try:
                boot = self.store.snapshot()
            except Exception as ex:  # noqa: BLE001  the browser then simply asks for data the normal way
                self.err = f"{ex.__class__.__name__}: {str(ex)[:200]}"
            return {**base, "synced": False, "res": {}, "boot": boot}
        cid = str(msg.get("cid") or "?")
        with self.lock:
            res = dict(self.done.get(cid, {}))
            have = dict(self.have.get(cid) or {})
        out = {**base, "synced": True, "res": res}
        # Speed: a collection that changed since the browser last read it is sent right here, so the browser does not
        # have to ask for it (one round trip less before another person's change shows up on screen).
        # Faster still: when the server knows exactly which documents changed since the browser's copy, only those are
        # sent ("delta": one case instead of the whole collection). Otherwise the whole collection, as before.
        fresh: Dict[str, Any] = {}
        delta: Dict[str, Any] = {}
        for c, v in (vers or {}).items():
            if c in have and int(have[c]) != int(v) and not str(c).startswith("_"):
                hv, cv = int(have[c]), int(v)
                ids = None
                if 0 < hv < cv and hasattr(self.store, "changed_since"):
                    try:
                        ids = self.store.changed_since(c, hv, cv)
                    except Exception:  # noqa: BLE001
                        ids = None
                if ids is not None and len(ids) <= 200:
                    try:
                        docs = {}
                        for i in ids:
                            d = self.store.get(c, i)
                            docs[i] = {k: x for k, x in d.items() if k != "_updated"} if d is not None else None
                        delta[c] = {"from": hv, "version": cv, "docs": docs}
                        continue
                    except Exception:  # noqa: BLE001  fall back to the whole collection
                        pass
                try:
                    one = self.store.snapshot_one(c)
                except Exception:  # noqa: BLE001  the browser then asks for it the normal way
                    continue
                if len(one["docs"]) <= PUSH_MAX_DOCS:
                    fresh[c] = one
        if fresh:
            out["fresh"] = fresh
        if delta:
            out["delta"] = delta
        return out


def absorb(bridge: Bridge, prev: Optional[Dict[str, Any]], value: Optional[Dict[str, Any]],
           reply: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], bool]:
    """Process the component value of one script run. Returns (new prev, rerun needed to deliver results)."""
    if value is None or (prev is not None and value.get("tick") == prev.get("tick") and value.get("cid") == prev.get("cid")):
        return prev, False
    bridge.handle(value)
    fresh = bridge.reply(value)
    strip = lambda r: {k: v for k, v in r.items() if k != "now"}  # noqa: E731
    return value, strip(fresh) != strip(reply)


# ============================================================================= Streamlit UI
def build_frontend() -> str:
    """Write the component page (the app HTML with the shim injected) and return its directory."""
    html = (ROOT / "web" / "pet_station.html").read_text(encoding="utf-8")
    shim = (ROOT / "web" / "shim.js").read_text(encoding="utf-8")
    page = html.replace("<head>", "<head><script>" + shim.replace("</script", "<\\/script") + "</script>", 1)
    d = pathlib.Path(tempfile.gettempdir()) / "pet_station_component"
    d.mkdir(parents=True, exist_ok=True)
    f = d / "index.html"
    if not f.exists() or f.read_text(encoding="utf-8") != page:
        f.write_text(page, encoding="utf-8")
    return str(d)


def main() -> None:
    import streamlit as st
    import streamlit.components.v1 as components

    st.set_page_config(page_title="PAT (PET Automation Tool)", page_icon="🛠️", layout="wide", initial_sidebar_state="collapsed")
    st.markdown("""<style>
      #MainMenu, header[data-testid="stHeader"], footer {visibility: hidden; height: 0;}
      .block-container {padding: 0 !important; max-width: 100% !important;}
      iframe {border: 0;}
      /* the page re-runs quietly in the background: never dim it or show the "running" indicator */
      [data-stale="true"], .stale-element, div[data-testid="stAppViewContainer"] * {transition: none !important;}
      [data-stale="true"], .stale-element {opacity: 1 !important;}
      [data-testid="stStatusWidget"], [data-testid="stToolbar"], [data-testid="stDecoration"] {display: none !important;}
    </style>""", unsafe_allow_html=True)

    load_env_file()
    try:                                  # Streamlit secrets (Community Cloud: App settings > Secrets) -> environment
        for k in SECRET_KEYS:
            if not os.environ.get(k) and k in st.secrets:
                os.environ[k] = str(st.secrets[k])
    except Exception:  # noqa: BLE001  no secrets file
        pass

    global REAL_NAMES
    try:
        raw_names = st.secrets["ACCOUNT_REAL_NAMES"] if "ACCOUNT_REAL_NAMES" in st.secrets else os.environ.get("ACCOUNT_REAL_NAMES", "")
    except Exception:  # noqa: BLE001
        raw_names = os.environ.get("ACCOUNT_REAL_NAMES", "")
    REAL_NAMES = load_real_names(raw_names)

    app_password = os.environ.get("PET_APP_PASSWORD", "")
    if app_password and not st.session_state.get("pet_ok"):
        st.markdown("### PAT (PET Automation Tool)")
        pw = st.text_input("Password", type="password")
        if pw and hmac.compare_digest(pw, app_password):
            st.session_state["pet_ok"] = True
            st.rerun()
        elif pw:
            st.error("Incorrect password")
        st.stop()

    @st.cache_resource(show_spinner="Connecting to MongoDB…")
    def boot():
        store, err = make_store()
        return store, Bridge(store), err

    store, bridge, store_err = boot()
    live_problem = store.problem() if hasattr(store, "problem") else None

    with st.sidebar:
        st.subheader("Storage")
        (st.success if store.kind == "mongodb" and not live_problem else st.error)(store.describe())
        if live_problem:
            st.info(live_problem)
        if store_err:
            st.warning(store_err)
            if st.button("Retry connection"):
                boot.clear()
                st.rerun()
        if st.button("Show document counts"):        # not on every run: each count is a database round trip
            try:
                st.caption(f"Documents: {store.counts()}")
            except Exception as ex:  # noqa: BLE001
                st.caption(f"Could not count: {ex.__class__.__name__}")

    if store_err:
        st.error(store_err)

    component = components.declare_component("pet_station", path=st.cache_resource(build_frontend)())

    # Speed: the browser talks to the server about once a second. Inside a fragment, each of those messages re-runs only
    # this small part of the page (not the whole script, sidebar and styles), so answers come back faster and nothing on the
    # page is redrawn. Older Streamlit versions without fragments simply run the whole script, exactly as before.
    frag = getattr(st, "fragment", None) or getattr(st, "experimental_fragment", None)
    if frag is not None:
        frag(lambda: _bridge_run(st, component, bridge))()
    else:
        _bridge_run(st, component, bridge)


def _bridge_run(st, component, bridge: "Bridge", in_fragment: bool = True) -> None:
    prev = st.session_state.get("last_msg")
    # Speed: the message the browser just sent is already in the session state when this run starts. Handling it before
    # the page is drawn puts the answer into this same run (one run per request instead of two). If it is not there,
    # the lines below still handle it exactly as before.
    try:
        early = st.session_state.get("pet_station")
        if isinstance(early, dict) and early.get("cid") and early.get("tick") is not None:
            if not (prev is not None and early.get("tick") == prev.get("tick") and early.get("cid") == prev.get("cid")):
                bridge.handle(early)
                prev = early
                st.session_state["last_msg"] = prev
    except Exception:  # noqa: BLE001
        pass
    reply = bridge.reply(prev)
    value = component(reply=reply, key="pet_station", default=None)
    prev, rerun = absorb(bridge, prev, value, reply)
    st.session_state["last_msg"] = prev
    if rerun:
        try:
            st.rerun(scope="fragment")         # only this part again (Streamlit 1.37+)
        except Exception as ex:  # noqa: BLE001  older Streamlit, or not inside a fragment: the whole page, as before
            if ex.__class__.__name__ in ("RerunException", "StopException") or "Rerun" in ex.__class__.__name__:
                raise
            st.rerun()


if __name__ == "__main__":
    main()
