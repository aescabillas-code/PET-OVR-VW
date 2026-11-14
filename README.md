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
If MongoDB drops out or is briefly unreachable, the app keeps working and reconnects by itself (see *Connection
resilience* below); nothing typed is lost. Only a configuration problem (wrong password, bad connection string) makes it
fall back to memory only (nothing is saved); fix the setting and press **Retry connection**.

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
* **Balancing at sign-in only:** when an agent signs in mid-shift and holds at least 2 fewer cases than the busiest agent on shift, cases move to them until the counts are within 1. It happens once, at sign-in; an agent who later has fewer cases because they completed some is not topped up. Untouched cases (newest first) move before worked ones, cases with a due reminder or a manual transfer are never moved. Balanced cases raise no new-case alert.
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
  The *Template* button downloads `templates/PET_Shift_Schedule_Template.xlsx` from the repo (the server reads the file on every download): to change the template, replace that file on GitHub and redeploy. A built-in copy is only used if the repo file cannot be reached.
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

## Welcome page

After a sign-in (not after a refresh, which still opens straight on the dashboard) a welcome page greets the owner of the
profile. It uses the shared theme / skin that was uploaded for everyone and shows the face the person selected on the
team picture as their profile picture (initials if no face was selected). It lists what was missed while away:

* unread **mentions and case notices** (with a "Got it" button), **announcements** not yet acknowledged (opens the normal
  announcement pop-up), cases **assigned or handed over** since the last visit, **reminders due**, **high-priority** open cases;
* **Your day**: open cases, reminders due, high priority, cases today, today's shift and the "first in line" priority;
* managers / coordinators also get a **Team snapshot**.

Items that arrived after the last visit carry a NEW tag; the page updates live while it is open. "Last seen" is kept on the
device every 30 s and in the shared data (`seen` collection, one small document per person) every 5 min.

## Shift rules, availability and case table

- **Auto sign-out:** an agent who forgot to sign out is signed out automatically 20 minutes after their end of shift (EOS). Managers and coordinators are not affected.
- **Hand-over at EOS:** when an agent reaches EOS all their open cases are handed over at once to the agents on shift by the schedule (not within 30 min of their own EOS, not unavailable), evenly by workload. Off-shift agents never receive cases. If nobody is on shift, the cases wait for the first agent to start.
- **Manual hand-over and the queue:** an agent within 60 min of EOS can hand over all open cases; they go evenly to the agents on shift now. If nobody else is on shift the cases leave the agent and wait under the owner **Queue**, and go to the next available agent on shift automatically. New cases go to an agent on shift, or one whose shift starts within the hour; otherwise to the Queue.
- **Canceled status:** part ordered, part delivered and CE arrival times are greyed out and not required to close. **Cabling/HOD** tick box: part ordered and part delivered are not required.
- **New case entries:** a newly added case shows in bold with a blinking red **New** beside the case number and sits at the top of the case table (newest first), followed by cases ordered by the closest reminder. It turns regular once its owner opens it.
- **No new cases near EOS:** an agent within 30 minutes of EOS is not assigned new cases. If nobody else is on shift, the case goes to the next agent to start.
- **Unavailable reason:** switching to Unavailable asks for a reason (Break, Lunch, Coaching, Admin, Other; Other takes a short note). The reason shows in Agent Status and in Settings.
- **Case table:** 100 cases per page with Previous / Next. The search box still searches every case, on any page.
- **Welcome page:** also lists cases assigned back or handed over to you; cases with a reminder are highlighted (red when due, amber when upcoming).
- **Maintenance windows:** besides Update and Edit, a case has **Add new maintenance window**. There is no limit; the newest window is the current one and every earlier window is kept (listed as Original, Update n, Window n in the case and in reports).
- **Hand over before EOS:** an agent within 60 minutes of EOS (or up to 2 hours after) sees a banner to hand all open cases to the agent scheduled to be available next (two clicks to confirm). The receiver gets one summary notice.
- **Alerts are shown once:** reminders, announcements and mentions that were already shown or acknowledged are remembered on the device and are not replayed after reopening. Acknowledgements and face claims also stay put while the server is still saving them.
- **Live counts:** "Cases today" in Agent Status updates in real time; changed data is pushed with the reply instead of a second fetch.

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

## Speed and live updates

* The browser checks for changes about once a second and sends one message at a time, so a slow connection cannot
  cut a save off. Saves go out at once and are answered in the same run.
* The server keeps the change counters and the last read of each collection in memory: the once-a-second check and a
  re-read of unchanged data do not wait for MongoDB. Every write updates them immediately (counters are also re-read
  from MongoDB every 2 seconds).
* The dashboard only rewrites a panel when its content changed, and a hand-over of many cases redraws once.
* Checklist / revisit documentation keeps its line breaks and paragraph spacing (saved, shown and exported).
* After updating `streamlit_app.py` or `web/shim.js`: **Reboot app** in Streamlit and hard-refresh the browser.

## Test

```bash
python -m unittest discover -s tests -v   # store, requests and sync protocol
node tests/shim_integration.js            # real app + shim + Python bridge, two simulated browsers (needs Node)
node tests/feature_checks.js              # schedule saving, export, acknowledge, reminders, maintenance window, announcements, sign-in
node tests/slow_server.js                 # saves and live updates against a slow, Streamlit-like server (DB_MS=250 for slower)
# optional, needs Playwright + Chromium: two real browser screens against the real bridge
python tests/live_host.py . 8765 &  node tests/live_browser.js 8765
```

## Login page, seasonal design and sign-in timeout

- **Team picture:** new web and mobile pictures. June John Cruz (Vendor Management) stands at the back and has his own fixed face with the same access as a manager. Every earlier face id is kept, so faces that were already claimed stay claimed.
- **Login page (DIY):** Settings → Theme → Login page (DIY), for managers only. Upload a web picture (and, optionally, a mobile picture), drag a box over each face or object, and either fix it to a profile or leave it for an agent to claim. Saved in `config/landing`, with the pictures in the asset store, so no code change is needed. Boxes moved from the current picture keep their claims. "Use the built-in team picture" switches back.
- **Seasonal theme & effects:** Settings → Theme → Seasonal theme & effects (changed by managers only; everyone else sees it read-only). Managers choose Christmas, New Year, Valentine's or Halloween and the yearly dates (default Christmas, Nov 1 to Dec 31). The design shows only between those dates and disappears on its own afterwards. Christmas adds string lights on the header, falling snow, a Santa hat on the logo, candy-cane trim on the panels, a tree with the agents' names on gifts and a countdown on the welcome page, a waving Santa in announcements, and Santa's sleigh pulled by elves across the cases table every 10 minutes. Each extra can be switched off; anyone can hide the effects on their own screen. Saved in `config/season`.
- **Sign in again after 8 hours idle:** after more than 8 hours without any click, key press or scroll, the app signs the person out (or does not restore the saved sign-in when it reopens), so the welcome page shows what changed when they sign in again.
- **Profile button:** the switch-profile button was removed from the header; Log out does the same.
- **Seasonal login picture:** in Seasonal theme & effects a manager can add a login picture for the season (same editor, starting from the current faces so claims carry over). It replaces the login page only while the season is showing and the everyday picture comes back by itself when it ends.
- **Fairy lights:** blinking fairy lights hang along the top of the cases table, the Agent Status panel, the login picture and the welcome page's Christmas card (on top of the string lights on the header). Can be switched off.
- **Naughty-list Santa:** while the Due Reminders tile blinks, about once a minute Santa pops up above the tile, waves, and then a bubble says "Ho ho ho! You are being naughty!" (or a similar line). Can be switched off.
- **No switch-profile button:** the header keeps only Log out, which does the same.
- **3D-style characters:** Santa and the reindeer pulling the sleigh are drawn with soft shading, highlights and shadows (the lead reindeer has a glowing red nose and the reindeer gallop).
- **Naughty List bubble:** Santa's bubble now says they are being naughty and are on his Naughty List (three rotating lines).
- **Light and smooth:** every seasonal animation uses only transform and opacity (no layout or repaint work), the sleigh moves with transform, settings are kept in memory instead of being re-read every second, and nothing seasonal reads or writes the database except when a manager saves. Measured at 60 fps with all effects on and 60 cases, with no long tasks.
- **Santa stays until the tile is clicked:** naughty-list Santa now stays above the blinking Due Reminders tile. When the tile is clicked (or the reminders are done) and the blinking stops, his bubble changes to a Nice List message ("you're back on my Nice List!") and he leaves after a few seconds.
- **Christmas corner:** the tree with the agents' names on the gifts and the countdown to Christmas now sit at the bottom of the Agent Status panel (instead of the dancing Santa, which was removed, and instead of the welcome page).
- **Gift announcement:** in the Christmas season an announcement opens like a present: the gift shakes, the lid pops off with confetti, Santa springs out like a jack-in-the-box, and then the announcement card pops in.
- **Sleigh every 10 minutes:** Santa and his sleigh cross the cases table every 10 minutes (and once about 20 seconds after the dashboard opens).
- **Elves in the case and alert windows:** in the case window one elf sits on the header (the title makes room for him), one scribbles on a notepad in the Case Details header, and one drags gift sacks along the bottom. In alert pop-ups (reminders, mentions, announcements, availability) lights hang along the top of the card, an elf sits on its top edge, one writes beside the card and one drags the sacks underneath, but only where there is empty space, so no field, text or button is covered.
- **More lights:** blinking lights also run along the tiles row, the case window header and section headers (with room made for them), and the welcome page cards.
- **Countdown greeting:** "Merry Christmas from the Partner Engagement Team and Vendor Management Team!"
- **Login picture fills the screen:** on any screen shape (and for any uploaded picture) the space around the picture is filled by stretching and softening its own outer edge, so there are no empty bands and nothing is cropped (every face stays clickable). At Christmas the edges also get leafy vines with poinsettias and holly berries, plus poinsettia bouquets in the corners.
- **New team picture (web and mobile):** adds Jeff Bote (Vendor Management Team - Manager, the man in the middle doing the hand sign) and Arianne Escabillas (Vendor Management Team - Developer, standing on the right), both with full manager access. June John Cruz is now Vendor Management Team - Auditor with the same access. Everyone else keeps their face id, so claimed faces stay claimed.
- **Vendor Management Team and the schedule:** June John Cruz, Jeff Bote and Arianne Escabillas are left out of the Shift Schedule table and its Excel export (they never take cases).
- **"New" clears on the owner's click:** the first time the case owner opens a new case it turns regular at once; the click is also remembered on that screen, so a slow save or an older copy from the database cannot bring the bold "New" back.
- **Cases table height:** on wide screens the cases table is exactly as tall as the Agent Status panel beside it (Christmas corner included, at least 560 px) and scrolls inside.
- **One Arianne profile:** "Arianne May Escabillas" and "Arianne Escabillas" are the same person and are merged into Arianne Escabillas (Vendor Management Team - Developer, full access, fixed face on the right of the picture, not on the shift schedule). Anything saved under the old name follows automatically: the signed-in profile, her password, and her open cases (handed to the agents on shift, or the queue if nobody is on shift). A face she had claimed earlier is freed for someone else.

## Hand-over and balancing rules (applied from the rules checklist, Nov 12)

- **Online agent** = on shift by the schedule, Available, and not within 30 minutes of their own EOS. Managers and the Vendor Management Team never receive cases. Unavailable agents get no new cases and no hand-overs.
- **New cases** go to an online agent (priority first, then fewest cases). Nobody online: the case waits and goes to the first agent who is online. It is no longer given to someone whose shift has not started.
- **End of shift:** the leaving agent's open cases are divided equally between the agents online (round robin). Nobody online: they stay with the leaving agent and go to the first agent who starts or becomes available. A case handed over by hand stays with its new owner until that owner's next EOS.
- **Hand-over by hand** (banner from 60 minutes before EOS, two clicks): divided equally between the agents online. Nobody online: the cases stay with the owner, marked "Hand-over requested", and go out automatically as soon as someone is online. There is no separate queue for hand-overs any more.
- **Balancing at sign-in:** every agent online gets an equal share of the open cases; excess is clawed back from the busiest agents. Cases that were the new agent's before go back first, then untouched cases, then worked ones (newest first). Cases with a reminder due can be moved; cases a person transferred by hand to their owner are not.
- **Productivity:** every agent who handled a case gets one count, on the day it was assigned to them.

## Connection resilience and smoothness (Nov 12)

* **Hardened MongoDB connection:** automatic retry of reads and writes after a dropped connection (`retryWrites`,
  `retryReads`), idle sockets recycled after 60 s before Atlas closes them, bounded timeouts (nothing can hang the page),
  a small always-open connection pool, and a background ping every 25 s that keeps the connection warm and notices an outage
  early. Options written in your connection string still win.
* **Quiet retries on the server:** a call that hits a dropped connection or an Atlas primary switch-over is retried with a
  short back-off (up to 6 s). Real errors (bad data, wrong password) are not retried.
* **No more silent "memory only" mode on a network blip:** if MongoDB is unreachable at start or later, the app stays on
  MongoDB in "reconnecting" mode and recovers by itself as soon as MongoDB answers — no reboot or "Retry connection" needed.
  While it is down, calls fail fast (one reconnect attempt every 2 s) so the page never freezes, and the last known data
  keeps showing.
* **Saves are never dropped:** in the browser, a save that could not be completed is kept and sent again automatically
  (back-off up to 8 s, for up to 15 minutes). It is also kept in the browser's storage, so even if the page is reloaded or
  closed during an outage, the next page sends it (only changes less than 10 minutes old, so newer data is never
  overwritten). A small amber badge "Reconnecting to the database — your changes are kept and will save automatically"
  appears only while this is happening; the "Could not save" pop-up no longer shows for a temporary disconnection.
* **Smoothness check (60 cases, all Christmas effects on):** 60 fps steady, no long tasks; a full dashboard redraw takes
  about 1.3 ms and the once-a-second seasonal/upkeep work about 0.3 ms.
* `.streamlit/config.toml` turns off Streamlit's file watcher and usage stats (less background work on the server).
* Tests: `tests/test_reconnect.py` (server retries, outage, automatic recovery) and `tests/shim_reconnect.js` (browser keeps
  and resends saves, replay after a reload).


## Round robin for new cases and handover/new counts (Nov 13)

* **New cases are assigned round robin.** Each new case (Add Case, bulk upload, or a case that waited in the Queue) goes to
  the agent on shift and available whose last new case is the oldest; an agent who has not had one yet goes first. So
  everyone on shift takes a turn before anyone gets a second new case, no matter how many cases they already hold. Ties go
  to the ★ priority agent, then the order of the shift schedule. Off-shift, unavailable, near-EOS agents and the Vendor
  Management Team are skipped. Hand-overs and balancing do not change whose turn it is (stored per case as `rr`).
* **Agent Status → Cases today** now shows two counts: **↪ handover** (cases handed to the agent today by end of shift,
  manual hand-over or balancing) and then **new** (new cases received today). On a phone the two counts stack.

## Vendor Management titles and New Year season (Nov 13)

* The name/role chip between the gear and Log out now shows the Vendor Management title: **Auditor · June John Cruz**,
  **Developer · Arianne Escabillas** (the same person as Arianne May Escabillas), **Manager · Jeff Bote**. Hover shows the
  full title. The welcome page and the Profiles list use the same titles.
* June John Cruz (Auditor) has the same access as a manager. Arianne (Developer) has every manager permission, plus
  developer-only protection: only she can clear her password, release her face or delete her profile.
* A Vendor Management member still signed in from an older agent sign-in is upgraded to manager access automatically.
* **Countdown:** from Christmas Day the countdown below Agent Status counts down to New Year.
* **New Year (Dec 31 – Jan 7, follows Christmas automatically; "Then New Year" option in Seasonal theme & effects):**
  fireworks (a short show every 3 minutes, a bigger one at midnight), a flashing "Happy New Year 2027!" banner above the
  tiles (New Year's Eve: "2027 is almost here!"), a big "Happy New Year" flash with fireworks once a day when the dashboard
  opens, gold confetti, a gold header garland, and a navy/gold corner with a clock, champagne, balloons with the agents'
  names and the countdown (then "Happy New Year 2027!"). Christmas-only decorations (Santa, elves, sleigh, fairy lights)
  end when New Year starts. Managers can also pick New Year as its own season with its own options. Fireworks pause in a
  hidden tab and while a case or Settings is open; nothing blocks clicks. Measured: 60 fps during fireworks.

## Catch-up balancing (Nov 13)

* An agent who has not received any hand-over since signing in — because they were Unavailable, their shift had not started
  yet, they were close to end of shift, or the data was still loading — now gets their equal share of open cases from the
  other agents online as soon as they can take cases (Available, on shift). The same rules as sign-in balancing apply
  (their own former cases first, manual hand-overs stay put).
* It is checked every 30 seconds in the agent's own browser and happens once per sign-in: it stops as soon as the agent has
  received a hand-over, or if they already hold an equal share (nobody is given cases just because).
* Fix (Nov 13): agents tagged as **coordinator** were skipped by sign-in and catch-up balancing. They now get hand-over
  cases like every other agent. The shared "Coordinator" sign-in, managers and the Vendor Management Team are still never
  given cases.

## No shared Coordinator sign-in (Nov 13)

* The leftover shared "Coordinator" identity is removed. A coordinator is an agent tagged as coordinator in Profiles: they
  sign in with their own face/name, act and are logged under their own name (no more "Coordinator" in case history,
  announcements or acknowledgements), see "My Cases" as their own, and keep the coordinator extras (see all cases,
  monitoring alerts, settings a coordinator may use).
* Coordinators receive cases like every agent: new cases by round robin and hand-overs (end of shift, manual hand-over,
  sign-in and catch-up balancing).
* Announcements no longer list a separate "Coordinator" recipient.

## Coordinator access (Nov 13)

* An agent tagged as coordinator has manager access except three things that stay manager-only: changing other people's
  role (the Coordinator tick), the seasonal theme, and the login page / login profile faces (DIY).
* Release face, Clear password and Delete member account in Profiles are for managers and the Vendor Management Team only
  (changed Nov 13). Coordinators keep everything else they had (all cases, Reports, Required checklist, schedule, timezone,
  uploads, alerts, monitoring) and still receive new and hand-over cases.

## Hand-over round limits (Nov 13)

* Every hand-over (EOS, hand-over by hand, cases waiting for an available agent, balancing) is dealt **one case at a time**
  to the agent online with the fewest hand-over cases this shift, up to the **round limit**: 15 per agent in round 1; when
  every agent online has 15, the limit becomes 25, then 35, and so on, until every case is assigned.
* What counts toward the limit: hand-over cases received since the start of the agent's shift that are still theirs, open
  or closed. Closing cases quickly does not bring more cases; a case moved away by balancing stops counting for the giver.
* **New cases are not counted**: they are dealt round robin on top of the hand-over limit, and never moved by balancing.
* An agent who was Unavailable, signed in late or whose shift starts later is filled up to the round in progress as soon as
  they can take cases (checked every 30 s, again each time they come back from Unavailable), from the agents with the most
  hand-over cases, never leaving a giver below the receiver. Own former cases go back first, then untouched ones; cases
  handed over by hand to someone stay with them.
* Agent Status shows the round in progress, e.g. "Hand-over round 2 · up to 25 each".
* Fix found by simulation (Nov 13): catch-up stopped when the agent with the most hand-over cases had already closed all of
  them. That agent is now skipped and cases come from the next agent who has open ones.

## Hand-over and balancing rule conflict check (Nov 13)

Audit of every place that assigns cases, plus `tests/rules_conflict_check.js`: random shifts, statuses, EOS, new cases,
closures and catch-ups run through the real app code, and every assignment is checked against the rules (never managers;
nothing left off shift or in the Queue while someone is online; only online agents receive; fewest hand-overs first / round
robin for new cases; a giver never ends below the receiver; running again moves nothing; new cases never moved by balancing;
round limit respected). 0 violations; the checker was verified by deliberately breaking the rules (it caught every break).

Conflicts found and fixed:
* Other assignment paths (a person removed from the schedule, an owner missing from an uploaded schedule, the "at EOS it will
  go to…" preview) still picked the agent with the fewest cases in total, set the owner silently and did not count it as a
  hand-over. They now follow the hand-over rule (fewest hand-over cases this shift), are logged, and count toward the limit.
* Agent Status "handover" showed cases received today (calendar day, including ones moved away) while the round limit used
  this shift's count. It now shows the same count the round limit uses.
* Every open screen ran the automatic EOS hand-over each second, so two screens could hand the same case to two agents in
  the same second. Now one screen at a time does it (20-second lease in the database; another screen takes over if it closes).
* The EOS banner still said cases are "divided equally"; it now describes the round limits. Unused old equal-split code removed.

Known by design (not conflicts): a coordinator's manual transfer can go above the round limit and is never moved by
balancing; cases of an agent who is Unavailable stay with them; cases are counted one each, whatever the severity.

## Hand-over formula, worked-only productivity and checklist attribution (Nov 13, evening)

* **Hand-over formula (replaces the 15/+10 round limits):** total hand-over cases ÷ available agents.
  * A batch (end of shift, hand-over by hand, cases waiting for an available agent) is split equally between the agents
    online: 100 cases ÷ 4 agents = 25 each. All agents leaving at the same time form one batch.
  * Each time another agent becomes available (signs in on shift, starts their shift, comes back from Unavailable), the open
    hand-over cases are divided by one more agent: 100 ÷ 5 = 20, so the new agent gets 5 from each. A giver never drops below
    the receiver; givers with no open hand-over case are skipped.
  * New cases (round robin) are not part of the total; they come on top.
  * The formula works in the background only: Case History shows a plain line ("… reached end of shift (EOS): case handed over
    to …", "… became available: hand-over case moved from …") and Agent Status shows only each agent's counts — hand-over
    cases counted as their productivity, then new cases received.
* **Productivity / Agent Status "handover":** a hand-over case counts only for an agent who updated it — added information
  (any case detail), added, completed or acknowledged a checklist item, set a reminder, added a work order, tagged a revisit
  or closed it. A new case still counts for the agent who received it.
* Every piece of information added in the case window is written to Case History (checked for every field and button).
* **Checklist items** show who added them and who completed / acknowledged them, with the time ("Added by Kenjie · 7:41 PM ·
  Completed by Karen · 7:41 PM"); older items take this from the case history; template items show "Added by System".

## Checklist applied (Nov 13, 8:45 PM)

* Dropped "balancing runs once per sign-in": the catch-up check now repeats every 30 seconds until the agent actually holds
  their share (a first check that found nothing movable no longer ends it). Once they hold it (or are within one case, or
  nobody has 2+ more), it rests until they next become available, so closing cases later does not pull in more.
* Dropped "agents involved in a move get a pop-up": automatic hand-overs and balancing moves no longer show a pop-up; the
  line in Case History stays. A manager or coordinator who transfers a case by hand still sees their own confirmation.
* All other 38 rules kept as they are.

## Naughty-list Santa stays until every due reminder is cleared (Nov 13)

* Santa pops up on the Due Reminders tile as soon as a case reaches its due time and stays there until **all** due reminders
  are cleared — clicking the tile (which stops the blinking) no longer sends him away.
* Each time a case reaches due he names its owner(s): "Ho ho ho! 🎅 Karen Sabile, you have been listed on my Naughty List 📜 —
  a case reached its due time!" (several owners are named together: "A, B and C").
* When an owner's due reminders are cleared: "✨ Kenjie Locsin is off the Naughty List — due reminders cleared! 🎁" (green).
  Between announcements his bubble shows the current list: "📜 Naughty List: … — clear the due reminders to get back on the
  Nice List!"
* When nobody is left: "… everyone is on the Nice List! 🎁" and he leaves.
* Light: the list of owners is collected in the dashboard's existing once-a-second pass (no extra scan) and the bubble is
  redrawn only when the list changes. Measured with 60 cases, Santa, sleigh, fairy lights, snow and the Christmas corner:
  58–60 fps, no long tasks.
* Update (Nov 13, 9 PM): each owner is listed once with the number of due cases beside the name ("Kenjie Locsin 10x"); another
  due case for the same owner only raises the count ("Kenjie Locsin 11x — another due case added to your count…"). An owner
  who was cleared off the list earlier today and comes back: "😄 Looks like we have someone who enjoys the Naughty List —
  Kenjie Locsin 1x is back on it!"
* The bubble never covers anything important: Santa stands on the part of the Due tile's top edge with no text, and the
  bubble tries beside him (right / left), level with his feet and above his head, keeping the spot that touches no text,
  button or tile number. If every spot would cover something, the message is shown in a strip right under the tiles (it takes
  its own space). On phones Santa and his message always sit in that strip.
* Placement is worked out only when the text or the tile position changes. Measured: 58–60 fps with all effects, no long tasks.
