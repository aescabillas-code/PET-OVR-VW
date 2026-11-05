"""PET Station REST API: FastAPI + MongoDB.

Every collection the app uses (cases, act, ann, acks, mentions, config, ...) is exposed through the same
small REST surface, so the data is also available to other tools:

    GET    /api/health
    GET    /api/versions                  change counters used by the app for live updates
    GET    /api/export                    full JSON backup of every collection
    GET    /api/{collection}              list      ?orderBy=ts&direction=desc&limit=100&skip=0
    POST   /api/{collection}              create    (body may carry "id"; one is generated otherwise)
    GET    /api/{collection}/{id}         read
    PUT    /api/{collection}/{id}         create or replace
    PATCH  /api/{collection}/{id}         merge fields (404 if the document does not exist)
    DELETE /api/{collection}/{id}
    POST   /api/assets                    upload a file (stored in GridFS)
    GET    /api/assets/{id}               download it (supports HTTP Range for audio)

Interactive docs: /docs
"""
from __future__ import annotations

import hmac
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Optional

import gridfs
from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Body, Depends, FastAPI, File, Header, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pymongo import ASCENDING, DESCENDING, MongoClient, ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DB = os.getenv("MONGODB_DB", "pet_station")
API_TOKEN = os.getenv("PET_API_TOKEN", "")
CORS_ORIGINS = [o.strip() for o in os.getenv("PET_CORS_ORIGINS", "*").split(",") if o.strip()]
MAX_ASSET_BYTES = int(os.getenv("PET_MAX_ASSET_MB", "20")) * 1024 * 1024

client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
db = client[MONGODB_DB]
meta = db["_meta"]          # one counter per collection, bumped on every write (drives live updates)
fs = gridfs.GridFS(db)

COLL_RE = re.compile(r"^[A-Za-z0-9_\-]{1,100}$")
DOCID_RE = re.compile(r"^[A-Za-z0-9_.\-~:@+]{1,200}$")
FIELD_RE = re.compile(r"^[A-Za-z0-9_.]{1,100}$")
RESERVED = {"health", "versions", "export", "assets", "docs", "redoc", "openapi.json"}
_indexed: set[tuple[str, str]] = set()


# ----------------------------------------------------------------------------- helpers
def err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def check_collection(name: str) -> str:
    if not COLL_RE.match(name) or name.startswith("_") or name in RESERVED:
        raise err(400, "invalid_argument", "Invalid collection name")
    return name


def check_id(doc_id: str) -> str:
    if not DOCID_RE.match(doc_id):
        raise err(400, "invalid_argument", "Invalid document id")
    return doc_id


def now_ms() -> int:
    return int(time.time() * 1000)


def bump(collection: str) -> int:
    row = meta.find_one_and_update({"_id": collection}, {"$inc": {"v": 1}}, upsert=True, return_document=ReturnDocument.AFTER)
    return int(row["v"])


def version(collection: str) -> int:
    row = meta.find_one({"_id": collection})
    return int(row["v"]) if row else 0


def clean_body(body: dict[str, Any]) -> dict[str, Any]:
    body = {k: v for k, v in body.items() if k not in ("_id", "_updated")}
    for key in body:
        if not key or key.startswith("$"):
            raise err(400, "invalid_argument", f"Invalid field name: {key!r}")
    return body


def shape(doc: dict[str, Any], envelope: bool) -> dict[str, Any]:
    doc = dict(doc)
    doc_id = doc.pop("_id")
    updated = doc.pop("_updated", None)
    if envelope:                       # exact copy of what was stored (used by the app)
        return {"id": doc_id, "data": doc, "updated": updated}
    out: dict[str, Any] = {"id": doc_id}   # flat, friendlier for other API consumers
    out.update(doc)
    out["_updated"] = updated
    return out


def ensure_index(collection: str, field: str) -> None:
    key = (collection, field)
    if key not in _indexed:
        db[collection].create_index([(field, DESCENDING)])
        _indexed.add(key)


def auth(request: Request, x_api_key: Optional[str] = Header(default=None)) -> None:
    if not API_TOKEN:
        return
    supplied = x_api_key or request.query_params.get("key") or ""
    if not hmac.compare_digest(supplied, API_TOKEN):
        raise err(401, "unauthenticated", "Missing or invalid API key")


# ----------------------------------------------------------------------------- app
@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        for name in ("cases", "act", "ann", "mentions"):
            ensure_index(name, "ts")
    except PyMongoError:
        pass  # database not reachable yet; indexes are created lazily on first ordered query
    yield


app = FastAPI(title="PET Station API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"], allow_credentials=False)


@app.exception_handler(PyMongoError)
async def mongo_error(_: Request, exc: PyMongoError):
    return JSONResponse(status_code=503, content={"detail": {"code": "unavailable", "message": "Database unavailable"}})


@app.get("/api/health", tags=["system"])
def health():
    client.admin.command("ping")
    return {"status": "ok", "database": MONGODB_DB}


api = APIRouter(prefix="/api", dependencies=[Depends(auth)])


@api.get("/versions", tags=["system"])
def versions():
    return {row["_id"]: int(row["v"]) for row in meta.find({})}


@api.get("/export", tags=["system"])
def export_all():
    """Full backup: every collection as JSON."""
    out: dict[str, list[dict[str, Any]]] = {}
    for name in db.list_collection_names():
        if name.startswith("_") or name.startswith("fs."):
            continue
        out[name] = [shape(d, False) for d in db[name].find({})]
    return out


# ------------------------------------------------------------------ assets (declared before the generic routes)
@api.post("/assets", tags=["assets"], status_code=201)
def upload_asset(file: UploadFile = File(...)):
    data = file.file.read(MAX_ASSET_BYTES + 1)
    if len(data) > MAX_ASSET_BYTES:
        raise err(413, "too_large", f"File is larger than {MAX_ASSET_BYTES // (1024 * 1024)} MB")
    content_type = file.content_type or "application/octet-stream"
    gid = fs.put(data, filename=file.filename or "upload", contentType=content_type)
    return {"id": str(gid), "sizeBytes": len(data), "contentType": content_type, "filename": file.filename}


@api.get("/assets", tags=["assets"])
def list_assets():
    return {"assets": [{"id": str(f._id), "filename": f.filename, "sizeBytes": f.length, "contentType": f.content_type} for f in fs.find()]}


@api.get("/assets/{asset_id}", tags=["assets"])
def get_asset(asset_id: str, request: Request):
    try:
        f = fs.get(ObjectId(asset_id))
    except (InvalidId, gridfs.errors.NoFile):
        raise err(404, "not_found", "Asset not found")
    data = f.read()
    total = len(data)
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600"}
    ctype = f.content_type or "application/octet-stream"
    rng = request.headers.get("range")
    if rng:
        m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else total - 1
            else:                                   # suffix range: last N bytes
                start = max(total - int(m.group(2)), 0)
                end = total - 1
            end = min(end, total - 1)
            if start > end or start >= total:
                return Response(status_code=416, headers={"Content-Range": f"bytes */{total}"})
            headers["Content-Range"] = f"bytes {start}-{end}/{total}"
            return Response(content=data[start:end + 1], status_code=206, media_type=ctype, headers=headers)
    return Response(content=data, media_type=ctype, headers=headers)


@api.delete("/assets/{asset_id}", tags=["assets"], status_code=204)
def delete_asset(asset_id: str):
    try:
        fs.delete(ObjectId(asset_id))
    except InvalidId:
        raise err(404, "not_found", "Asset not found")
    return Response(status_code=204)


# ------------------------------------------------------------------ generic documents
@api.get("/{collection}", tags=["documents"])
def list_documents(
    collection: str,
    orderBy: Optional[str] = None,
    direction: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(1000, ge=1, le=5000),
    skip: int = Query(0, ge=0),
    envelope: bool = False,
):
    name = check_collection(collection)
    v = version(name)                      # read the counter first so a concurrent write is never missed
    cursor = db[name].find({})
    if orderBy:
        if not FIELD_RE.match(orderBy):
            raise err(400, "invalid_argument", "Invalid orderBy field")
        ensure_index(name, orderBy)
        cursor = cursor.sort(orderBy, DESCENDING if direction == "desc" else ASCENDING)
    items = [shape(d, envelope) for d in cursor.skip(skip).limit(limit)]
    return {"version": v, "count": len(items), "items": items}


@api.post("/{collection}", tags=["documents"], status_code=201)
def create_document(collection: str, body: dict[str, Any] = Body(...)):
    name = check_collection(collection)
    doc_id = check_id(str(body.get("id") or uuid.uuid4().hex))
    doc = clean_body(body)
    doc["_id"] = doc_id
    doc["_updated"] = now_ms()
    try:
        db[name].insert_one(doc)
    except DuplicateKeyError:
        raise err(409, "already_exists", "A document with this id already exists")
    return {"id": doc_id, "version": bump(name)}


@api.get("/{collection}/{doc_id}", tags=["documents"])
def read_document(collection: str, doc_id: str, envelope: bool = False):
    name, doc_id = check_collection(collection), check_id(doc_id)
    v = version(name)
    doc = db[name].find_one({"_id": doc_id})
    if envelope:                           # the app wants "exists: false" as a normal answer
        if not doc:
            return {"version": v, "id": doc_id, "exists": False, "data": None}
        s = shape(doc, True)
        return {"version": v, "id": doc_id, "exists": True, "data": s["data"], "updated": s["updated"]}
    if not doc:
        raise err(404, "not_found", "Document not found")
    return shape(doc, False)


@api.put("/{collection}/{doc_id}", tags=["documents"])
def replace_document(collection: str, doc_id: str, body: dict[str, Any] = Body(...)):
    name, doc_id = check_collection(collection), check_id(doc_id)
    doc = clean_body(body)
    doc["_updated"] = now_ms()
    db[name].replace_one({"_id": doc_id}, doc, upsert=True)
    return {"id": doc_id, "version": bump(name)}


@api.patch("/{collection}/{doc_id}", tags=["documents"])
def patch_document(collection: str, doc_id: str, body: dict[str, Any] = Body(...)):
    name, doc_id = check_collection(collection), check_id(doc_id)
    fields = clean_body(body)
    fields["_updated"] = now_ms()
    result = db[name].update_one({"_id": doc_id}, {"$set": fields})
    if result.matched_count == 0:
        raise err(404, "not_found", "Document not found")
    return {"id": doc_id, "version": bump(name)}


@api.delete("/{collection}/{doc_id}", tags=["documents"], status_code=204)
def delete_document(collection: str, doc_id: str):
    name, doc_id = check_collection(collection), check_id(doc_id)
    if db[name].delete_one({"_id": doc_id}).deleted_count:
        bump(name)
    return Response(status_code=204)


app.include_router(api)
