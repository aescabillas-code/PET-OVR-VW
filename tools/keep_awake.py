"""Keep the Streamlit Cloud app awake (run by .github/workflows/keep_awake.yml).

A plain web request (curl) is not enough any more: a sleeping Streamlit Cloud app answers with a "This app has gone to
sleep" page whose "Yes, get this app back up!" button must be clicked in a real browser. This opens the app in a
headless browser, clicks that button when it is there, and waits until the app itself has loaded.

Usage:  python tools/keep_awake.py https://your-app.streamlit.app
        (or set the APP_URL environment variable)
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

WAKE_TEXT = "get this app back up"


def visit(url: str) -> bool:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=90_000)
            page.wait_for_timeout(5_000)
            wake = page.get_by_role("button", name=WAKE_TEXT)
            if wake.count():
                print("App was asleep: clicking the wake-up button")
                wake.first.click()
                page.wait_for_timeout(5_000)
            # The app is up once its page (or the iframe Streamlit Cloud wraps it in) is there and the sleep button is gone.
            deadline = time.time() + 180
            while time.time() < deadline:
                if page.get_by_role("button", name=WAKE_TEXT).count():
                    page.get_by_role("button", name=WAKE_TEXT).first.click()
                up = page.locator("iframe[title='streamlitApp'], [data-testid='stApp'], .stApp").count() > 0
                if up:
                    page.wait_for_timeout(10_000)       # let the app finish its first run
                    print("App is awake:", page.title() or url)
                    return True
                page.wait_for_timeout(5_000)
            print("The app did not finish loading in time")
            return False
        except Exception as ex:  # noqa: BLE001
            print("Visit failed:", ex.__class__.__name__, str(ex)[:300])
            return False
        finally:
            browser.close()


def main() -> int:
    url = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("APP_URL", "")).strip()
    if not url:
        print("Set the APP_URL repository secret (Settings > Secrets and variables > Actions) to the app's address")
        return 2
    for attempt in range(1, 4):                         # a cold start can take a few minutes: try three times
        print(f"Attempt {attempt}: {url}")
        if visit(url):
            return 0
        time.sleep(30)
    return 1


if __name__ == "__main__":
    sys.exit(main())
