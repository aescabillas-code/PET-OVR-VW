"""Live test host: serves the built component page and runs the real Bridge (in-memory store) like Streamlit would."""
import json, os, sys, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
ROOT = sys.argv[1]; sys.path.insert(0, ROOT)
import streamlit_app as app
store = app.MemStore(); bridge = app.Bridge(store); prev, last = {}, {}
EARLY = os.environ.get("PET_EARLY", "1") != "0"; DELAY = float(os.environ.get("DELAY", "0.05")); L = threading.Lock()
PAGE = open(os.path.join(app.build_frontend(), "index.html"), encoding="utf-8").read()
HOST = """<!doctype html><html><body style="margin:0"><iframe id="f" src="/app" style="border:0;width:100vw;height:100vh"></iframe><script>
const sid='s'+Math.random().toString(36).slice(2),f=document.getElementById('f');let latest,seen,running=false,cut=false;window.RUNS=0;window.CUTS=0;
const post=(p,b)=>fetch(p,{method:'POST',body:JSON.stringify(b)}).then(r=>r.json());
async function loop(){if(running)return;running=true;for(;;){const value=latest;seen=value;cut=false;window.RUNS++;
 const pre=await post('/pre',{sid,value});if(cut){window.CUTS++;continue}
 f.contentWindow.postMessage({type:'streamlit:render',args:{reply:pre.reply}},'*');
 const po=await post('/post',{sid,value});if(po.rerun||latest!==seen)continue;break}running=false}
addEventListener('message',e=>{const m=e.data;if(!m||!m.isStreamlitMessage)return;if(m.type==='streamlit:componentReady')loop();else if(m.type==='streamlit:setComponentValue'){latest=m.value;if(running)cut=true;loop()}});
</script></body></html>"""
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, body, ct):
        b = body.encode("utf-8"); self.send_response(200); self.send_header("Content-Type", ct); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self._send(PAGE if self.path.startswith("/app") else HOST, "text/html; charset=utf-8")
    def do_POST(self):
        m = json.loads(self.rfile.read(int(self.headers["Content-Length"]))); sid, value = m["sid"], m.get("value")
        time.sleep(DELAY)
        with L:
            if self.path == "/pre":
                pv = prev.get(sid)
                if EARLY and isinstance(value, dict) and not (pv is not None and value.get("tick") == pv.get("tick") and value.get("cid") == pv.get("cid")):
                    bridge.handle(value); prev[sid] = value
                last[sid] = bridge.reply(prev.get(sid)); out = {"reply": last[sid]}
            else:
                prev[sid], rerun = app.absorb(bridge, prev.get(sid), value, last.get(sid) or {}); out = {"rerun": rerun}
        self._send(json.dumps(out), "application/json")
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), H).serve_forever()
