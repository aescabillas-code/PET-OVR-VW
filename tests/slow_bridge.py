"""Test helper for slow_server.js: one Streamlit script run split in its two halves, so the test can put delays between them.

Input lines:  {"sid": "...", "op": "pre",  "value": {...}|null}  -> what main() does before the page is drawn; returns the reply
              {"sid": "...", "op": "post", "value": {...}|null}  -> what main() does after it; returns {"rerun": bool}
PET_EARLY=0 simulates a Streamlit that does not expose the browser message before the page is drawn (older two-run flow).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import streamlit_app as app  # noqa: E402

store = app.MemStore()
bridge = app.Bridge(store)
prev, last = {}, {}
EARLY = os.environ.get("PET_EARLY", "1") != "0"

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    m = json.loads(line)
    sid, value = m["sid"], m.get("value")
    if m["op"] == "pre":
        pv = prev.get(sid)
        if EARLY and isinstance(value, dict) and not (pv is not None and value.get("tick") == pv.get("tick") and value.get("cid") == pv.get("cid")):
            bridge.handle(value)
            prev[sid] = value
        last[sid] = bridge.reply(prev.get(sid))
        out = {"reply": last[sid], "reqs": len((value or {}).get("reqs") or [])}
    else:
        prev[sid], rerun = app.absorb(bridge, prev.get(sid), value, last.get(sid) or {})
        out = {"rerun": rerun}
    out["docs"] = {c: len(d) for c, d in store.docs.items()}
    print(json.dumps(out), flush=True)
