"""Builds the download page for app.nahalkmi.ir into ./dist from template.html, the APKs and the Windows MSI.

Usage: python build.py <dir with NahalVPN-<version>-<abi>.apk files and NahalVPN-<version>.msi>
Sizes and SHA-256 values are computed from the actual files, so the page always matches what is served.
"""
import hashlib, os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1]
FA = str.maketrans("0123456789.", "۰۱۲۳۴۵۶۷۸۹٫")

apks = {}
for name in os.listdir(SRC):
    m = re.fullmatch(r"NahalVPN-(\d+\.\d+\.\d+)-(arm64-v8a|armeabi-v7a|universal)\.apk", name)
    if m:
        apks[m.group(2)] = (m.group(1), name)
versions = {v for v, _ in apks.values()}
if set(apks) != {"arm64-v8a", "armeabi-v7a", "universal"} or len(versions) != 1:
    sys.exit(f"need arm64-v8a, armeabi-v7a and universal APKs of one version, found: {sorted(apks.items())}")
version = versions.pop()
msi = f"NahalVPN-{version}.msi"
if not os.path.isfile(os.path.join(SRC, msi)):
    sys.exit(f"missing the Windows installer {msi}")

dist = os.path.join(HERE, "dist")
shutil.rmtree(dist, ignore_errors=True)
for sub in ("img", "fonts"):
    shutil.copytree(os.path.join(HERE, sub), os.path.join(dist, sub))
for page in ("guide.html", "guide-en.html", "guide.css"):
    shutil.copy(os.path.join(HERE, page), os.path.join(dist, page))
os.makedirs(os.path.join(dist, "apk"))
os.makedirs(os.path.join(dist, "win"))

html = open(os.path.join(HERE, "template.html"), encoding="utf8").read()
html = html.replace("%%VERSION_FA%%", version.translate(FA))
files = [(key, apks[abi][1], "apk") for abi, key in (("arm64-v8a", "ARM64"), ("armeabi-v7a", "ARMV7"), ("universal", "UNIVERSAL"))]
for key, name, sub in files + [("MSI", msi, "win")]:
    data = open(os.path.join(SRC, name), "rb").read()
    shutil.copy(os.path.join(SRC, name), os.path.join(dist, sub, name))
    html = (html.replace(f"%%{key}_FILE%%", name)
                .replace(f"%%{key}_SIZE_FA%%", f"{len(data) / 1_000_000:.0f}".translate(FA))
                .replace(f"%%{key}_SHA%%", hashlib.sha256(data).hexdigest()))
leftover = re.findall(r"%%\w+%%", html)
if leftover:
    sys.exit(f"unfilled placeholders: {leftover}")
open(os.path.join(dist, "index.html"), "w", encoding="utf8").write(html)
print(f"built version {version}: {sorted(os.listdir(os.path.join(dist, 'apk')) + os.listdir(os.path.join(dist, 'win')))}")
