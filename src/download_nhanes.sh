#!/usr/bin/env bash
# Download NHANES demographics, body measures, and whole-body DXA (2011-2018).
# CDC serves an HTML redirect page for missing files, so every download is
# validated by SAS XPORT magic bytes rather than HTTP status.
set -u
RAW="$(dirname "$0")/../data/raw"
mkdir -p "$RAW"

is_xpt() { [ -s "$1" ] && [ "$(head -c 13 "$1" | tr -d '\0')" = "HEADER RECORD" ]; }

fetch() {  # fetch <outfile> <url...>
  local out="$1"; shift
  is_xpt "$out" && { echo "cached  $(basename "$out")"; return 0; }
  local url attempt
  for url in "$@"; do
    for attempt in 1 2 3 4 5; do
      curl -sS --connect-timeout 20 --max-time 300 -L -o "$out.part" "$url" 2>/dev/null
      if is_xpt "$out.part"; then
        mv "$out.part" "$out"
        echo "ok      $(basename "$out")  $(stat -c%s "$out") bytes"
        return 0
      fi
      sleep $((attempt * 3))
    done
  done
  rm -f "$out.part"
  echo "FAILED  $(basename "$out")"
  return 1
}

# cycle_dir:year:suffix
for spec in 2011-2012:2011:G 2013-2014:2013:H 2015-2016:2015:I 2017-2018:2017:J; do
  cyc=${spec%%:*}; rest=${spec#*:}; yr=${rest%%:*}; L=${rest##*:}
  for base in DEMO BMX DXX; do
    f="${base}_${L}"
    fetch "$RAW/${f}.XPT" \
      "https://wwwn.cdc.gov/Nchs/Nhanes/${cyc}/${f}.XPT" \
      "https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/${yr}/DataFiles/${f}.xpt" \
      "https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/${yr}/DataFiles/${f}.XPT"
  done
done
