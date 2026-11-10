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
  schedule, alert settings, required checklist items, profile password hashes (`config/profileHashes`) and the shared alert audio.
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

* **Cases:** Add Case asks whether you are entering an Aruba, AT&T or Foundation case, plus the day/time the case was received on the PET queue. A Foundation case is entered with its **SFDC Case ID** (that is its case ID) and its case detail has the SFDC Case ID only, no RITM. Inside the case: severity beside the Case ID, case status (FE Name, Tracking Number, Service Window, Scheduled, TR2, Resolved), multiple SFDC Case IDs, RITM number (Aruba), model number, lift required, maintenance window (start and end can be edited; every edit is written to the case history), part ordered / part delivered / CE arrival times. Closing needs all of these, then asks whether the SLA was met or missed (with the responsible party if missed). A RITM reminder pops up after closing.
* **Reports (Settings → Reports):** styled weekly Excel report, a report builder (choose, rename and reorder columns, save templates) and a dashboard with graphs.
* **Timezone and Data:** Settings → Timezone and Data sets the timezone for case times and the shift schedule (shared by everyone; a manager/coordinator changes it). Default is each device's own timezone.
* **Account names:** the same tab holds the account list. A manager/coordinator uploads an Excel or CSV file (one account name per row in the first column; a header row, blanks and duplicates are skipped; a template can be downloaded) and it replaces the previous list. The list feeds the optional **Account name** dropdown in Add Case and in Case Details (the account can be changed later and is logged). Accounts already saved on cases are kept if the list is replaced. The list is stored in the shared database as `config/accounts` (or on the device in local mode). Account Name is also available as a column in the report builder.
* **Bulk case upload (Timezone and Data → Upload cases):** a manager/coordinator uploads an Excel/CSV file; *Template* downloads `PET_Bulk_Case_Entry_Template.xlsx` with every case field plus the **case type** (Aruba / AT&T / Foundation), dropdowns and an Instructions sheet. Case type, case number (SFDC Case ID for Foundation), account name (must be in the account list) and the received time are needed per row; the rest is needed before a case can be closed. A preview lists rows with problems (skipped). **Only one reminder alert is created for the whole upload** and the new owners get **no assignment notification**.
* **Real account names:** accounts in the app/database are pseudonyms. Put the real names in Streamlit secrets as an `[ACCOUNT_REAL_NAMES]` table (`"Pseudonym" = "Real name"`, see `.streamlit/secrets.toml.example`) or as JSON in the `ACCOUNT_REAL_NAMES` variable. When an Excel report is downloaded the server swaps pseudonyms for real names (only for the accounts in that report); the screen, preview and database keep pseudonyms.
* **Same case number, several SFDC IDs:** in a bulk upload, rows that share an Aruba (or AT&T) case number are combined into one case holding all their SFDC IDs (blank fields are filled from the later rows; a different account on the same number is rejected).
* **Daily trend report (Reports → Daily trend):** created vs closed per day with pending cases at end of each day (chart + table), SFDC IDs received per day, average time to close, pending cases by age, and how long each case stayed in every bucket (average, longest, and a per-case table; the Excel timeline has one row per SFDC ID). *Download Daily Excel Report* gives three sheets (Daily trend with the chart image, Time in bucket, Case timeline) with real account names. Status changes are now timestamped (`sh` on the case); cases whose status was set earlier show their whole age in the current bucket.
* **One row per SFDC ID:** in the weekly report and the report builder (when the SFDC/HPE Case ID column is included), a case with several SFDC IDs gets one row per ID; the other columns repeat and the case count stays per case.
* **Layout:** the Settings window is wider so all tabs (including Reports and Simulation) sit on one line (they scroll sideways on a narrow screen). The case table starts with the **Account Name** column and no longer shows the revisit reason (just a Revisit badge). The weekly report lists the **AT&T Case Number** right after the account name.
* **EOS handover rebalancing:** cases handed over automatically at end of shift are flagged. When an agent is back on shift (or available again) and holds at least 2 fewer cases than someone who is carrying EOS-handed-over cases, those cases move to the returning agent (their own handed-over cases first) until the workload is even. Only handed-over cases move, productivity credit stays with the agent first assigned, and a manual transfer clears the flag.
* **Weekly report:** **Account Name** is the first column and every report view can be filtered by account.
* **Agent case counts:** the Agent Status panel shows how many cases each agent was assigned today. A case counts for the agent it was first assigned to, even if it is transferred at end of shift (EOS agents who got cases stay listed). An agent who had a shift yesterday, got no case then and none today is marked ★ Priority and gets the next case first.
* **EOD support:** staff whose name, role or shift contains "EOD" are not listed in the Agent Status panel or counted in Available/Unavailable.
* **Closing:** account name is now also required before a case can be closed.
* **Instant load:** all saved data is sent with the first page render, so the dashboard fills immediately.
* **Case ownership:** marking yourself *Unavailable* only excludes you from new assignments; your open cases stay with you. The only automatic transfer is when the owner reaches the end of shift (EOS) set in the shift schedule; managers/coordinators can still transfer a case by hand.
* **Alarms:** every reminder rings twice, a warning before the ETA (editable, default 5 min) and again at the ETA.
  Agents can press *Later* to snooze (editable, default 5 min). Only alarms that trigger while a screen is open are
  shown; nothing old is replayed after a refresh or when someone opens the app.
* **Sounds:** one sound per alert type (Settings → Alerts), used by every alert including the simulation.
  A sound stops the moment its alert is closed, acknowledged or completed. No sound is embedded in the app.
* **Simulation:** runs only on the screen that started it and writes nothing to the database.
* **Shift schedule:** the PET Team layout (names in column A, SUN–SAT across the top, a time / OFF / PTO per day).
  `templates/PET_Shift_Schedule_Template.xlsx` is the same file the *Template* button downloads.
* **Shift schedule saving:** every change (new person, name, role, each day, availability, delete, upload) is written to `config/staff` at once; a late echo of an older save can no longer overwrite a newer edit. *Export current* produces the same look as the template (dark header, orange/green shifts, pink OFF, dark-green PTO).
* **Checklist:** *Acknowledge* opens the alarm form (documentation required) for required items and for any item that has a reminder; +1 min / +5 min / +15 min / +1 hr add up on each click; the add field clears after adding.
* **Maintenance window:** enter the start first and set the end later (closing needs the end). Once a window exists, **Update maintenance window** records a new current window (as many times as needed): the original window and every earlier update are kept and shown as Original / Update 1, 2… / Current, and all of them appear in the report for RCA. **Edit maintenance window** only corrects the current window in place (typos).
* **Announcements:** there is no separate recipient picker: write `@everyone` to notify the whole team, or `@mention` specific people from the shift schedule (an announcement needs at least one of the two), tag cases, paste or upload images and GIFs (shared assets), emoji picker.
* **Sign-in:** a new sign-in starts clean; alerts queued or sent before it are not shown.
* **Dashboard:** header, "Operations Overview", stat cards (Total / Active / Due Reminders / Completed), the PET Cases table and the Agent & Agent Status panel follow the supplied design. Cases are sorted by next reminder (nearest first, no-reminder cases last) and the table has its own scroll bar. Filters for status, owner and reminder sit above the table.
* **Records:** only case updates are recorded (the Action History button was removed; `act` keeps case updates only).
* **Theme:** a shared image skin now travels inside `config/theme` itself (compressed), so other screens no longer download it separately; the base font is 14px.
* **Login page:** the app opens on this page when no profile is saved; a refresh keeps the signed-in profile (it is checked against the schedule/accounts first), and the header shows the profile in use. The team picture (a web picture and a mobile picture, with the sides filled on wide screens) is the way in. Every face is clickable. There is no close button: the dashboard can only be reached by selecting a profile or signing in (HPE email).
  * The two faces in the front are the managers: the woman is **Joerolyn Franquelli**, the man is **Jose Teves**. They are always in the shift schedule as managers and cannot be removed from it.
  * Any other face starts without a name. Clicking it asks only *Whose face is this?*: pick your name from the **shift schedule** (names already claimed are hidden) and the face becomes your profile for everyone; you are signed in straight away. Claims are stored in the `seat` collection.
  * From the next login, clicking your claimed face asks whether you want to add a password (*Not now* / *Set a password*; it asks again next time while none is set). Once a password is set, clicking that face shows a password pop-up every time before the profile opens. Password hashes stay in `config/profileHashes` (same as before).
  * *Sign in with HPE email* and *Sign up* (under the picture) are for people who are not on the shift schedule: sign up with full name, `@hpe.com` email and a password, then sign in. Accounts are stored in the `acct` collection. A name that is on the shift schedule cannot sign up; those people click their face. Members can see all cases but have no manager/coordinator rights.
  * The chosen profile is remembered on the device and changes only when another profile is selected (profile button in the header → login page).
* **Coordinators:** the old shared *Coordinator* profile is gone. A manager gives the coordinator role to a profile that already exists (a claimed face or a signed-up account) in *Settings → Profiles*; there can be several coordinators and only a manager can assign or remove them (`config/coordinators`). A coordinator keeps their own profile and gets the lead rights (add cases, edit the schedule, required checklist, reports, shared theme) and receives the coordinator alerts. The role changes on a signed-in screen as soon as the manager changes it.
* **Settings → Profiles** (manager / coordinator): list of profiles with their face, password and coordinator box; managers can also release a face, clear a profile's password or delete an account.
* **Mobile:** compact header, 2x2 tiles, stacked cases and agent panels, page scrolls normally and the case table scrolls sideways.
* **Case modal:** laid out as in the supplied design (priority / case ID / severity / status bar, owner card, Case Information + Transfer Details, Case Details, Work / Part Orders, Revisit, Checklists, Case History). The maintenance window end is optional but required to close the case. The simulation seeds a case with a start-only window and an announcement with a mention and case tag, and the Available / Unavailable toggle works for the simulated agent (restored when the simulation stops).
* **Date / time picker:** every date, time and date-time field opens a calendar with a searchable time list (type `9:30`, `930` or `9:23 AM`) and OK / Cancel / Now / Clear buttons. A maintenance window may start and end at the same moment.
* **Required checklist alerts:** in Settings > Required checklist every item has an alarm time (minutes after the case is added, with +1 min / +5 min / +15 min / +1 hr buttons that add up). The first item always keeps an alert; the others are optional. Stored in `config/requiredItems` as `{text,min}` (older plain-text items still work).
* **Theme on pop-ups:** colour themes and the image skin also apply to the pop-up modals (overlay tint, buttons, section headers, announcement colour; the image skin appears behind the pop-ups and in the case / settings headers). The default theme keeps the original pop-up look.
* **Theme (details):** Settings → Theme. Colour presets, a custom colour, an image skin (the app takes the image's colours) and
  font/size. A manager/coordinator can apply it to everyone; anyone can still use their own on their screen.

## Settings

| Variable | Meaning |
|---|---|
| `MONGODB_URI` (or `MONGO_URI`) | connection string, default `mongodb://localhost:27017` |
| `MONGODB_PASSWORD` | replaces `<db_password>` in the URI (URL-encoded for you) |
| `MONGODB_DB` (or `MONGO_DB`) | database name, default `pet_station` |
| `PET_APP_PASSWORD` | optional password asked before the app is shown |

Each app collection (`cases`, `act`, `ann`, `acks`, `mentions`, `seat`, `acct`, `config`) is a MongoDB collection of the same name.
Shared audio is in `_assets` (max 10 MB) and live-update counters in `_meta`.

## Notes

* Concurrent edits are last-write-wins per saved field (the app patches only changed fields).
* Profile passwords are salted hashes stored in `config/profileHashes`; they identify people inside the app but are
  not server-side authentication. Use `PET_APP_PASSWORD` (or SSO in front of Streamlit) to restrict access.

## Test

```bash
python -m unittest discover -s tests -v   # store, requests and sync protocol
node tests/shim_integration.js            # real app + shim + Python bridge, two simulated browsers (needs Node)
node tests/feature_checks.js              # schedule saving, export, acknowledge, reminders, maintenance window, announcements, sign-in
```
