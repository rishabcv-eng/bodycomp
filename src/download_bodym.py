"""Parallel download of BodyM silhouette masks from the public S3 bucket.

~18k small PNGs. CDC/S3 DNS in this environment is intermittent, so every
fetch retries with backoff and already-present files are skipped, making the
script resumable.
"""
import json, urllib.request, threading, queue, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "bodym"
BUCKET = "https://amazon-bodym.s3.amazonaws.com/"
WORKERS = 24

keys = json.loads((ROOT / "data" / "raw" / "bodym_keys.json").read_text())
todo = []
for key, size in keys:
    if not key.endswith(".png"):
        continue
    dest = RAW / key
    if dest.exists() and dest.stat().st_size == size:
        continue
    todo.append((key, dest))

print(f"{len(todo)} masks to fetch ({len(keys)} objects in bucket)")
for d in {t[1].parent for t in todo}:
    d.mkdir(parents=True, exist_ok=True)

q = queue.Queue()
for t in todo:
    q.put(t)
done = failed = 0
lock = threading.Lock()


def worker():
    global done, failed
    while True:
        try:
            key, dest = q.get_nowait()
        except queue.Empty:
            return
        for attempt in range(5):
            try:
                with urllib.request.urlopen(BUCKET + key, timeout=45) as r:
                    data = r.read()
                dest.write_bytes(data)
                with lock:
                    done += 1
                break
            except Exception:
                time.sleep(1.5 * (attempt + 1))
        else:
            with lock:
                failed += 1
        q.task_done()


threads = [threading.Thread(target=worker, daemon=True) for _ in range(WORKERS)]
[t.start() for t in threads]
start = time.time()
while any(t.is_alive() for t in threads):
    time.sleep(5)
    with lock:
        d, f = done, failed
    el = time.time() - start
    rate = d / el if el else 0
    print(f"  {d}/{len(todo)} ok, {f} failed, {rate:.0f}/s, {el:.0f}s elapsed", flush=True)
[t.join() for t in threads]
print(f"\ndone: {done} downloaded, {failed} failed")
