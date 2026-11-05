"""OVR-VW PET Station: Streamlit + MongoDB (Atlas) in a single Python file.

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

If MongoDB cannot be reached the app still opens, shows why, and keeps data in memory only (nothing is saved).
"""
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
MAX_ASSET_CHARS = 14_000_000            # ~10 MB file as a base64 data URL (a MongoDB document holds 16 MB)

COLL_RE = re.compile(r"^[A-Za-z0-9_\-]{1,100}$")
DOCID_RE = re.compile(r"^[A-Za-z0-9_.\-~:@+]{1,200}$")
FIELD_RE = re.compile(r"^[A-Za-z0-9_.]{1,100}$")


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

    def describe(self) -> str:
        return "in-memory (NOT persistent)"

    def versions(self) -> Dict[str, int]:
        with self.lock:
            return dict(self.ver)

    def version(self, c: str) -> int:
        return self.ver.get(c, 0)

    def _bump(self, c: str) -> None:
        self.ver[c] = self.ver.get(c, 0) + 1

    def get(self, c: str, i: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            d = self.docs.get(c, {}).get(i)
            return copy.deepcopy(d) if d is not None else None

    def put(self, c: str, i: str, doc: Dict[str, Any]) -> None:
        with self.lock:
            self.docs.setdefault(c, {})[i] = dict(doc, _updated=now_ms())
            self._bump(c)

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
            self._bump(c)
            return True

    def delete(self, c: str, i: str) -> None:
        with self.lock:
            if self.docs.get(c, {}).pop(i, None) is not None:
                self._bump(c)

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


class MongoStore(MemStore):
    """MongoDB / Atlas store. One MongoDB collection per app collection, plus `_meta` (change counters) and `_assets`."""

    kind = "mongodb"

    def __init__(self, uri: str, dbname: str) -> None:
        from pymongo import MongoClient

        opts: Dict[str, Any] = {"serverSelectionTimeoutMS": 8000}
        if uri.startswith("mongodb+srv://") or "mongodb.net" in uri:
            try:                                  # Atlas needs TLS; certifi avoids CERTIFICATE_VERIFY_FAILED on some machines
                import certifi
                opts["tlsCAFile"] = certifi.where()
            except ImportError:
                pass
        self.lock = threading.RLock()
        self.uri, self.dbname = uri, dbname
        self.client = MongoClient(uri, **opts)
        self.client.admin.command("ping")         # raises if unreachable / wrong password / IP not allowed
        self.db = self.client[dbname]
        self.meta, self.c_assets = self.db["_meta"], self.db["_assets"]
        self._indexed: set = set()

    def describe(self) -> str:
        host = self.uri.split("@")[-1].split("?")[0].rstrip("/")
        return f"MongoDB · {host} · db '{self.dbname}'"

    def versions(self) -> Dict[str, int]:
        return {r["_id"]: int(r["v"]) for r in self.meta.find({})}

    def version(self, c: str) -> int:
        r = self.meta.find_one({"_id": c})
        return int(r["v"]) if r else 0

    def _bump(self, c: str) -> None:
        self.meta.update_one({"_id": c}, {"$inc": {"v": 1}}, upsert=True)

    def get(self, c, i):
        d = self.db[c].find_one({"_id": i})
        return {k: v for k, v in d.items() if k != "_id"} if d else None

    def put(self, c, i, doc):
        self.db[c].replace_one({"_id": i}, dict(doc, _updated=now_ms()), upsert=True)
        self._bump(c)

    def patch(self, c, i, fields):
        r = self.db[c].update_one({"_id": i}, {"$set": dict(fields, _updated=now_ms())})
        if r.matched_count == 0:
            return False
        self._bump(c)
        return True

    def delete(self, c, i):
        if self.db[c].delete_one({"_id": i}).deleted_count:
            self._bump(c)

    def list(self, c, order_by, desc, limit):
        from pymongo import ASCENDING, DESCENDING

        cur = self.db[c].find({})
        if order_by:
            if (c, order_by) not in self._indexed:
                self.db[c].create_index([(order_by, DESCENDING)])
                self._indexed.add((c, order_by))
            cur = cur.sort(order_by, DESCENDING if desc else ASCENDING)
        if limit:
            cur = cur.limit(limit)
        return [(d["_id"], {k: v for k, v in d.items() if k != "_id"}) for d in cur]

    def asset_put(self, name, ctype, data):
        aid = uuid.uuid4().hex
        self.c_assets.replace_one({"_id": aid}, {"_id": aid, "name": name, "type": ctype, "data": data, "_ts": now_ms()}, upsert=True)
        return {"id": aid, "filename": name, "contentType": ctype, "sizeBytes": len(data)}

    def asset_get(self, aid):
        d = self.c_assets.find_one({"_id": aid})
        return {"id": aid, "name": d["name"], "type": d["type"], "data": d["data"]} if d else None

    def asset_del(self, aid):
        self.c_assets.delete_one({"_id": aid})

    def asset_list(self):
        return [{"id": d["_id"], "filename": d.get("name"), "contentType": d.get("type"), "sizeBytes": d.get("size", 0)}
                for d in self.c_assets.find({}, {"name": 1, "type": 1})]

    def counts(self):
        return {c: self.db[c].estimated_document_count() for c in self.db.list_collection_names() if not c.startswith("_")}


def make_store() -> Tuple[MemStore, Optional[str]]:
    """Return (store, error). Falls back to MemStore when MongoDB cannot be reached."""
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
        upd = d.pop("_updated", None)
        return {"version": v, "id": i, "exists": True, "data": d, "updated": upd}
    if op == "list":
        c = _coll(a.get("c"))
        ob = a.get("ob") or None
        if ob and not FIELD_RE.match(str(ob)):
            raise ApiError("invalid_argument", "Invalid orderBy field")
        lim = max(0, min(int(a.get("lim") or 0), 5000)) or 1000
        v = store.version(c)
        rows = store.list(c, ob, a.get("dir") == "desc", lim)
        items = [{"id": i, "data": {k: x for k, x in d.items() if k != "_updated"}, "updated": d.get("_updated")} for i, d in rows]
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
    raise ApiError("invalid_argument", f"Unknown operation: {op}")


# ============================================================================= browser <-> server protocol
class Bridge:
    """Server side of the component protocol (see web/shim.js). Framework independent, so it can be tested."""

    def __init__(self, store: MemStore) -> None:
        self.store = store
        self.done: Dict[str, Dict[str, Any]] = {}       # cid -> {request id: result}, kept until the browser acknowledges
        self.seen: Dict[str, float] = {}
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
                    bucket[rid] = {"err": {"code": "unavailable", "message": "Database unavailable"}}

    def reply(self, msg: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        try:
            vers = self.store.versions()
        except Exception as ex:  # noqa: BLE001
            vers = {}
            self.err = f"{ex.__class__.__name__}: {str(ex)[:200]}"
        base = {"now": now_ms(), "ok": self.err is None, "err": self.err, "store": self.store.kind, "vers": vers}
        if not msg:
            return {**base, "synced": False, "res": {}}
        with self.lock:
            res = dict(self.done.get(str(msg.get("cid") or "?"), {}))
        return {**base, "synced": True, "res": res}


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

    st.set_page_config(page_title="OVR-VW PET Station", page_icon="🛠️", layout="wide", initial_sidebar_state="collapsed")
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

    app_password = os.environ.get("PET_APP_PASSWORD", "")
    if app_password and not st.session_state.get("pet_ok"):
        st.markdown("### OVR-VW PET Station")
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

    with st.sidebar:
        st.subheader("Storage")
        (st.success if store.kind == "mongodb" else st.error)(store.describe())
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

    prev = st.session_state.get("last_msg")
    reply = bridge.reply(prev)
    value = component(reply=reply, key="pet_station", default=None)
    prev, rerun = absorb(bridge, prev, value, reply)
    st.session_state["last_msg"] = prev
    if rerun:
        st.rerun()


if __name__ == "__main__":
    main()
