# Adding the IM•LOGIC ⇄ PET message thread to PET Station

IM•LOGIC already has its side. These steps add PET's side, so both apps share **one recorded thread per linked case**.

## What it does
* When IM•LOGIC links a PET case, PET Station shows an **IM•LOGIC** card in that case: the IM•LOGIC case number, its
  station and owner, the message thread, and a box to reply.
* Messages show up on the other app within a few seconds (IM•LOGIC checks every 2–5 s; so does PET).
* Every message is kept (never edited or deleted) and is also written to the case history in both apps:
  *Message to PET* / *Message from PET* in IM•LOGIC, *Message to IM•LOGIC* / *Message from IM•LOGIC* in PET.
* A new message for a case that is not open shows a note; IM•LOGIC also shows a 💬 badge on the dashboard row.

## Where the thread is kept
In the **PET database** (the one in PET's `MONGODB_URI` / `MONGODB_DB`), collections `bridge_links` and `bridge_msgs`.
PET needs no new secrets. IM•LOGIC reaches it with its existing `PET_MONGODB_URI` / `PET_MONGODB_DB` settings. That
database user now needs **read and write** access to the PET database (it was read-only for the lookup). With the same
Atlas user for both apps this is already the case.

## Apply it to PET Station (about 2 minutes)
1. Copy the `pet_bridge` folder and `im_pet_bridge.py` from this repo next to your PET Station checkout (any place works).
2. Run, from the IM•LOGIC repo:
   ```bash
   python pet_bridge/apply_to_pet.py /path/to/pet-station
   ```
   It copies `im_pet_bridge.py` into PET and makes four small edits, each marked `IM•LOGIC bridge`:
   * `streamlit_app.py`: `execute()` sends the `bridge_*` requests to `im_pet_bridge.execute(…, "PET")` (PET's own database)
   * `web/shim.js`: `window.__bridge(op, args)` for the page
   * `web/pet_station.html`: the IM•LOGIC card (`${brCard(c)}`) in the case, and `pet_bridge.js` before the app starts
   Running it again changes nothing.
3. Commit and push PET Station; Streamlit redeploys it. Refresh open PET tabs once.

If your PET page has changed so much that the script cannot find its anchors, it stops without changing anything. Make
the same edits by hand: they are short and listed above (see `apply_to_pet.py` for the exact text).

## Keep the shared file the same in both repos
`im_pet_bridge.py` must be identical in IM•LOGIC and PET Station. When it changes, re-run `apply_to_pet.py` (it copies it).

## Test it locally without MongoDB
```bash
BRIDGE_FAKE_FILE=/tmp/br.json python tests/live_host.py . 8780 &                      # IM•LOGIC
BRIDGE_FAKE_FILE=/tmp/br.json python /path/to/pet-station/tests/live_host.py /path/to/pet-station 8781 &
node tests/live_bridge.js 8780 8781
```
