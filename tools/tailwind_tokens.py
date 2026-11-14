"""Prints every class-like token used in web/pet_station.html (input for tools/tailwind_build.js)."""
import pathlib
import re

s = (pathlib.Path(__file__).resolve().parent.parent / "web" / "pet_station.html").read_text()
s = re.sub(r'<style id="tw-static">.*?</style>', "", s, flags=re.S)
s = re.sub(r"data:[a-z/+]+;base64,[A-Za-z0-9+/=]+", "", s)
for ch in "`\"'<>{}":
    s = s.replace(ch, " ")
ok = set()
for t in set(re.findall(r"[!-~]+", s)):
    t = t.strip(".,;()+")
    if t and len(t) <= 80 and re.match(r"^!?-?[a-zA-Z@\[][a-zA-Z0-9:\-\[\]\/#%._!&=*()'\",~>+]*$", t) and re.search(r"[a-z]", t):
        ok.add(t)
print(" ".join(sorted(ok)))
