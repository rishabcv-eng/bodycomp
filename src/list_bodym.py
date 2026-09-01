"""Enumerate the public BodyM S3 bucket and summarise it by prefix."""
import urllib.request, urllib.parse, xml.etree.ElementTree as ET, json, collections
from pathlib import Path

BUCKET = "https://amazon-bodym.s3.amazonaws.com/"
NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
keys, token = [], None
while True:
    q = {"list-type": "2", "max-keys": "1000"}
    if token:
        q["continuation-token"] = token
    with urllib.request.urlopen(BUCKET + "?" + urllib.parse.urlencode(q), timeout=90) as r:
        root = ET.fromstring(r.read())
    for c in root.findall("s3:Contents", NS):
        keys.append((c.find("s3:Key", NS).text, int(c.find("s3:Size", NS).text)))
    t = root.find("s3:NextContinuationToken", NS)
    if root.find("s3:IsTruncated", NS).text != "true" or t is None:
        break
    token = t.text
    print(f"  ...{len(keys)} keys", end="\r")

out = Path("data/raw/bodym_keys.json")
out.write_text(json.dumps(keys))

agg = collections.defaultdict(lambda: [0, 0])
for k, s in keys:
    p = "/".join(k.split("/")[:2]) if "/" in k and not k.endswith(".csv") else k
    agg[p][0] += 1
    agg[p][1] += s

print(f"\ntotal {len(keys)} objects, {sum(s for _, s in keys)/1e6:.0f} MB\n")
for p, (n, s) in sorted(agg.items()):
    print(f"  {p:<28} {n:>6} files  {s/1e6:>8.1f} MB")
