# PAT (PET Automation Tool): Streamlit + MongoDB Atlas (single Python file)

```
Browser ── Streamlit page ── component (web/pet_station.html + web/shim.js)
                │  requests ride on the Streamlit connection (about once a second, instantly on a save)
                ▼
        streamlit_app.py  ──►  MongoDB Atlas (database "pet_station")
```

* `streamlit_app.py` holds everything on the Python side: Atlas connection, storage, sync protocol and the page.
  There is no separate API server and the browser never talks to MongoDB, so it works on Streamlit Community Cloud.
* The HTML app is PAT (PET Automation Tool). `web/shim.js` gives it the storage it expects, backed by MongoDB: cases, checklists and
  documentation, orders, revisits, activity history, announcements and acknowledgements, mentions/notices, shift
  schedule, alert settings, required checklist items, profile password hashes and the shared alert audio.
* Live updates: every reply carries a change counter per collection; a screen refetches only what changed.
* Not saved on purpose: simulation data and per-device preferences (signed-in profile, volume, device-only audio).

## Run

```bash
pip install -r requirements.txt
cp .env.example .env          # set MONGODB_PASSWORD to your Atlas database user's password
streamlit run streamlit_app.py
```

In Atlas, open **Network Access** and allow your IP address (use `0.0.0.0/0` while testing; on Streamlit Community Cloud
you need that, since its IP changes).

The sidebar shows the storage status. The app itself stays quiet when saving works; a small badge at the bottom-left appears only if MongoDB is not connected or a storage error occurs.
If MongoDB cannot be reached the app still opens, shows the reason, and keeps data in memory only (nothing is saved);
fix the setting and press **Retry connection**.

**Streamlit Community Cloud:** App settings → Secrets, same values as `.streamlit/secrets.toml.example`.
Never commit `.env` or `secrets.toml`.

## What's in the app

* **Cases:** Add Case asks whether you are entering an Aruba or an AT&T case number, plus the day/time the case was received on the PET queue. Inside the case: severity beside the Case ID, case status (FE Name, Tracking Number, Service Window, Scheduled TR2, Resolved), multiple SFDC Case IDs, RITM number (Aruba), model number, lift required, maintenance window (original kept, updates listed), part ordered / part delivered / CE arrival times. Closing needs all of these, then asks whether the SLA was met or missed (with the responsible party if missed). A RITM reminder pops up after closing.
* **Reports (Settings → Reports):** styled weekly Excel report, a report builder (choose, rename and reorder columns, save templates) and a dashboard with graphs.
* **Instant load:** all saved data is sent with the first page render, so the dashboard fills immediately.
* **Alarms:** every reminder rings twice, a warning before the ETA (editable, default 5 min) and again at the ETA.
  Agents can press *Later* to snooze (editable, default 5 min). Only alarms that trigger while a screen is open are
  shown; nothing old is replayed after a refresh or when someone opens the app.
* **Sounds:** one sound per alert type (Settings → Alerts), used by every alert including the simulation.
  A sound stops the moment its alert is closed, acknowledged or completed. No sound is embedded in the app.
* **Simulation:** runs only on the screen that started it and writes nothing to the database.
* **Shift schedule:** the PET Team layout (names in column A, SUN–SAT across the top, a time / OFF / PTO per day).
  `templates/PET_Shift_Schedule_Template.xlsx` is the same file the *Template* button downloads.
* **Theme:** Settings → Theme. Colour presets, a custom colour, an image skin (the app takes the image's colours) and
  font/size. A manager/coordinator can apply it to everyone; anyone can still use their own on their screen.

## Settings

| Variable | Meaning |
|---|---|
| `MONGODB_URI` (or `MONGO_URI`) | connection string, default `mongodb://localhost:27017` |
| `MONGODB_PASSWORD` | replaces `<db_password>` in the URI (URL-encoded for you) |
| `MONGODB_DB` (or `MONGO_DB`) | database name, default `pet_station` |
| `PET_APP_PASSWORD` | optional password asked before the app is shown |

Each app collection (`cases`, `act`, `ann`, `acks`, `mentions`, `config`) is a MongoDB collection of the same name.
Shared audio is in `_assets` (max 10 MB) and live-update counters in `_meta`.

## Notes

* Concurrent edits are last-write-wins per saved field (the app patches only changed fields).
* Profile passwords are salted hashes stored in `config/profileRegistry`; they identify people inside the app but are
  not server-side authentication. Use `PET_APP_PASSWORD` (or SSO in front of Streamlit) to restrict access.

## Test

```bash
python -m unittest discover -s tests -v   # store, requests and sync protocol
node tests/shim_integration.js            # real app + shim + Python bridge, two simulated browsers (needs Node)
```
