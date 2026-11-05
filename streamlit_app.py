"""Streamlit host for the PET Station app.

The HTML app is embedded unchanged. A small client (web/shim.js) is injected so the app saves everything
through the REST API (api/main.py) into MongoDB instead of the in-browser runtime it was written for.

Environment:
  PET_API_URL        URL of the REST API *as the browser sees it*   (default http://localhost:8000)
  PET_API_TOKEN      optional shared API key (must match the API's PET_API_TOKEN)
  PET_APP_PASSWORD   optional password asked before the app is shown
  PET_EMBED_API      "1" to start the API inside this Streamlit process (needs MONGODB_URI)
  PET_API_PORT       port for the embedded API (default 8000)
  PET_FRAME_HEIGHT   fallback iframe height in px (default 1000)
"""
import hmac
import json
import os
import pathlib
import threading

import streamlit as st
import streamlit.components.v1 as components

ROOT = pathlib.Path(__file__).parent
API_URL = os.getenv("PET_API_URL", "http://localhost:8000").rstrip("/")
API_TOKEN = os.getenv("PET_API_TOKEN", "")
APP_PASSWORD = os.getenv("PET_APP_PASSWORD", "")
EMBED_API = os.getenv("PET_EMBED_API", "0") == "1"

st.set_page_config(page_title="OVR-VW PET Station", page_icon="🛠️", layout="wide", initial_sidebar_state="collapsed")
st.markdown(
    """
    <style>
      header[data-testid="stHeader"], footer, #MainMenu {display:none !important;}
      .block-container {padding:0 !important; max-width:100% !important;}
      iframe {width:100% !important; height:100vh !important; border:0 !important;}
    </style>
    """,
    unsafe_allow_html=True,
)


@st.cache_resource
def start_embedded_api() -> bool:
    """Run the FastAPI app in a background thread (one per Streamlit server process)."""
    import uvicorn
    from api.main import app

    config = uvicorn.Config(app, host="0.0.0.0", port=int(os.getenv("PET_API_PORT", "8000")), log_level="warning")
    threading.Thread(target=uvicorn.Server(config).run, daemon=True).start()
    return True


@st.cache_data
def build_page(api_url: str, token: str) -> str:
    html = (ROOT / "web" / "pet_station.html").read_text(encoding="utf-8")
    shim = (ROOT / "web" / "shim.js").read_text(encoding="utf-8")
    cfg = json.dumps({"api": api_url + "/api", "token": token}).replace("</", "<\\/")
    tag = f"<script>window.__PET_CFG={cfg};</script><script>{shim}</script>"
    return html.replace("<head>", "<head>" + tag, 1)   # after <head>, so the doctype (standards mode) is kept


if EMBED_API:
    start_embedded_api()

if APP_PASSWORD and not st.session_state.get("pet_ok"):
    st.markdown("### OVR-VW PET Station")
    pw = st.text_input("Password", type="password")
    if pw and hmac.compare_digest(pw, APP_PASSWORD):
        st.session_state["pet_ok"] = True
        st.rerun()
    elif pw:
        st.error("Incorrect password")
    st.stop()

components.html(build_page(API_URL, API_TOKEN), height=int(os.getenv("PET_FRAME_HEIGHT", "1000")), scrolling=True)
