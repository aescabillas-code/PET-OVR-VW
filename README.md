# OVR-VW PET Station: Streamlit + MongoDB + REST API

```
Browser ── Streamlit page (streamlit_app.py)
              └─ embeds web/pet_station.html  +  web/shim.js
                         │  REST (JSON, polling every 1.5 s)
                         ▼
                  FastAPI  (api/main.py)  ──►  MongoDB (database "pet_station")
```

* The HTML app is unchanged except for one line (the custom alert sound URL). `web/shim.js` gives it the
  storage it expects, but backed by the REST API, so **everything entered is saved in MongoDB**:
  cases, checklists + documentation, work/part orders, revisits, Aruba/ATT numbers, activity history,
  announcements + acknowledgements, mentions/notices, shift schedule + availability, alert settings and
  custom alerts, required checklist items, profile password hashes, and the shared alert audio (GridFS).
* Live updates between screens: each screen polls one cheap endpoint (`/api/versions`) and refetches only
  what changed.
* **Not saved on purpose:** simulation data (mock cases, alerts, mentions) and per-device preferences
  (signed-in profile, volume, device-only audio), which stay in that browser.

## Run it

```bash
cp .env.example .env            # optional
docker compose up --build
# app:      http://localhost:8501
# API docs: http://localhost:8000/docs
```

Without Docker (needs a MongoDB):

```bash
pip install -r requirements.txt
export MONGODB_URI=mongodb://localhost:27017
uvicorn api.main:app --port 8000 &
PET_API_URL=http://localhost:8000 streamlit run streamlit_app.py
# or one process:  PET_EMBED_API=1 streamlit run streamlit_app.py
```

Quick check: `curl localhost:8000/api/health` → `{"status":"ok",...}`

## REST API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | database ping |
| GET | `/api/versions` | change counter per collection |
| GET | `/api/export` | full JSON backup |
| GET | `/api/{collection}` | list: `?orderBy=ts&direction=desc&limit=100&skip=0` |
| POST | `/api/{collection}` | create (body may include `id`) |
| GET / PUT / PATCH / DELETE | `/api/{collection}/{id}` | read / replace / merge / delete |
| POST | `/api/assets` | upload a file (multipart `file`, GridFS) |
| GET | `/api/assets/{id}` | download (supports Range) |

Collections used by the app: `cases`, `act` (activity history), `ann` (announcements), `acks`, `mentions`,
`config` (`staff`, `alerts`, `requiredItems`, `profileRegistry`, `coord`). Examples:

```bash
curl "localhost:8000/api/cases?orderBy=ts&direction=desc&limit=20"
curl -X PATCH localhost:8000/api/cases/PET-2026-0001 -H 'Content-Type: application/json' -d '{"hp":true}'
curl localhost:8000/api/export > backup.json
```

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `MONGODB_URI`, `MONGODB_DB` | API | connection string (default `mongodb://localhost:27017`) and database name |
| `PET_API_TOKEN` | API + Streamlit | optional shared key sent as `X-API-Key` |
| `PET_CORS_ORIGINS` | API | allowed origins, comma separated (default `*`) |
| `PET_MAX_ASSET_MB` | API | upload limit (default 20) |
| `PET_API_URL` | Streamlit | API address **as the browser reaches it** |
| `PET_APP_PASSWORD` | Streamlit | optional password before the app is shown |
| `PET_EMBED_API` | Streamlit | `1` = run the API inside the Streamlit process |

## Deploying

* **Streamlit Community Cloud** serves only the Streamlit port. Host the API separately (Render, Railway, Fly.io,
  a VM) with MongoDB Atlas, then set `PET_API_URL` (must be **https** because the app page is https),
  `PET_CORS_ORIGINS` and, if used, `PET_API_TOKEN` in the app secrets/environment.
* **One VM / Docker host:** use the compose file and put a reverse proxy (Caddy/nginx) with HTTPS in front of
  ports 8501 and 8000.

## Security notes

* `PET_API_TOKEN` is embedded in the page, so anyone who can open the app can read it. Treat it as a light
  barrier and put `PET_APP_PASSWORD` (or your own login/SSO in front of Streamlit) first.
* The app's profile passwords are salted hashes stored in `config/profileRegistry`; they identify people
  inside the app but are not server-side authentication. Do not expose the API publicly without a token and HTTPS.
* Concurrent edits are last-write-wins per saved field (the app patches only changed fields).

## Test

`node tests/shim_integration.js` runs the real app and `shim.js` in two simulated browsers against an in-memory
copy of the API contract (a case created on one screen is saved and appears on the other).
