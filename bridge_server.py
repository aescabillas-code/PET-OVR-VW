"""Test helper: the real Bridge + MemStore behind a stdin/stdout JSON-lines pipe (used by shim_integration.js).

Each input line  {"sid": "...", "value": {...}|null}  is one Streamlit script run of that browser session.
Output: {"renders": [reply, ...]} - what the component receives (a rerun adds a second render), like Streamlit would.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import streamlit_app as app  # noqa: E402

store = app.MemStore()
bridge = app.Bridge(store)
prev = {}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    m = json.loads(line)
    sid, value = m["sid"], m.get("value")
    renders = []
    for _ in range(3):                                   # run, then reruns while results are pending (as st.rerun does)
        reply = bridge.reply(prev.get(sid))
        renders.append(reply)
        prev[sid], rerun = app.absorb(bridge, prev.get(sid), value, reply)
        if not rerun:
            break
    print(json.dumps({"renders": renders, "dump": {c: sorted(d) for c, d in store.docs.items()}}), flush=True)
