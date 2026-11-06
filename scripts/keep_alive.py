"""Open the Streamlit app in a real browser so it counts as a visit; wake it if it is asleep."""
import os
import sys

from playwright.sync_api import sync_playwright

url = os.environ.get("APP_URL", "").strip()
if not url:
    sys.exit("APP_URL secret is not set.")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_timeout(8_000)

    wake = page.get_by_role("button", name="Yes, get this app back up!")
    if wake.count():
        print("App was asleep, waking it up.")
        wake.first.click()
        page.wait_for_timeout(45_000)
    else:
        print("App is awake, staying connected briefly.")
        page.wait_for_timeout(30_000)

    browser.close()
