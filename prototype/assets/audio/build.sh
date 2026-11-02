#!/usr/bin/env bash
# Rebuilds sfx/ and music/ from the original downloads, so every change made to a file is on record.
# Usage: build.sh <kenney-sci-fi-sounds/Audio> <kenney-interface-sounds/Audio> <music sources dir>
# The music directory holds the files named in CREDITS.md; two were renamed on copying (see the notes there).
# Needs ffmpeg with libopus.
set -euo pipefail
SCIFI=$1 IFACE=$2 MUSIC=$3
OUT=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT/sfx" "$OUT/music"

# sfx <name> <source> <seconds kept|0 for all> <fade out seconds>
# Mono, silence at the start removed, cut to length, brought to the same average level (-18 dB RMS) with a limiter
# above it so the loudest peak stays under -3 dBFS. Opus at 32 kbit/s.
sfx() {
  local name=$1 src=$2 keep=$3 fade=$4
  local cut=$keep
  if [ "$keep" = 0 ]; then cut=1000; fi
  local trim="silenceremove=start_periods=1:start_threshold=-50dB,asetpts=PTS-STARTPTS"
  local mean
  mean=$(ffmpeg -hide_banner -nostats -i "$src" -t "$cut" -ac 1 -af "${trim},volumedetect" -f null - 2>&1 |
    awk -F': ' '/mean_volume/ {sub(/ dB/, "", $2); print $2}')
  local gain
  gain=$(awk -v m="$mean" 'BEGIN { printf "%.1f", -18 - m }')
  local len
  len=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src")
  local end
  end=$(awk -v l="$len" -v k="$keep" 'BEGIN { print (k > 0 && k < l) ? k : l }')
  local fadeStart
  fadeStart=$(awk -v e="$end" -v f="$fade" 'BEGIN { printf "%.3f", e - f }')
  ffmpeg -hide_banner -loglevel error -y -i "$src" -t "$cut" -ac 1 \
    -af "${trim},volume=${gain}dB,alimiter=limit=0.7:attack=1:release=20:level=disabled,afade=t=out:st=${fadeStart}:d=${fade}" \
    -c:a libopus -b:a 32k "$OUT/sfx/$name.ogg"
}

# music <name> <source> <fade in/out seconds>
# Stereo, brought to -20 LUFS (integrated) with true peak under -2 dBFS, 2 s fades at both ends. Opus at 56 kbit/s.
music() {
  local name=$1 src=$2 fade=$3
  local len
  len=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src")
  local fadeStart
  fadeStart=$(awk -v l="$len" -v f="$fade" 'BEGIN { printf "%.3f", l - f }')
  ffmpeg -hide_banner -loglevel error -y -i "$src" -ac 2 -ar 48000 \
    -af "loudnorm=I=-20:TP=-2:LRA=11,afade=t=in:d=${fade},afade=t=out:st=${fadeStart}:d=${fade}" \
    -c:a libopus -b:a 56k "$OUT/music/$name.ogg"
}

sfx fire-1 "$SCIFI/laserSmall_000.ogg" 0 0.03
sfx fire-2 "$SCIFI/laserSmall_001.ogg" 0 0.03
sfx fire-3 "$SCIFI/laserSmall_002.ogg" 0 0.03
sfx hit-1 "$SCIFI/impactMetal_001.ogg" 0.3 0.12
sfx hit-2 "$SCIFI/impactMetal_002.ogg" 0.3 0.12
sfx hurt "$SCIFI/impactMetal_004.ogg" 0.38 0.1
sfx absorb "$SCIFI/forceField_000.ogg" 0 0.2
sfx spawn "$SCIFI/forceField_004.ogg" 0 0.2
sfx explode-1 "$SCIFI/explosionCrunch_000.ogg" 0 0.2
sfx explode-2 "$SCIFI/explosionCrunch_001.ogg" 0 0.3
sfx destroyed "$SCIFI/lowFrequency_explosion_000.ogg" 1.6 0.5
sfx rail "$SCIFI/laserLarge_000.ogg" 0 0.1
sfx boost "$SCIFI/thrusterFire_000.ogg" 0.8 0.35
sfx pickup "$IFACE/confirmation_002.ogg" 0 0.1
sfx overheat "$IFACE/error_003.ogg" 0 0.1
sfx tick "$IFACE/pluck_001.ogg" 0 0.03
sfx go "$IFACE/confirmation_004.ogg" 0 0.1
sfx round-end "$IFACE/select_006.ogg" 0 0.5
sfx click "$IFACE/click_001.ogg" 0 0.02
sfx toggle "$IFACE/toggle_001.ogg" 0 0.03
sfx replay-in "$IFACE/minimize_004.ogg" 0 0.1
sfx replay-out "$IFACE/maximize_004.ogg" 0 0.1

music final-hour "$MUSIC/Final-Hour-isaiah658.ogg" 2
music robotic "$MUSIC/robotic-battlefield.ogg" 2
music shooter "$MUSIC/8bit-spaceshooter.mp3" 2
music level-3 "$MUSIC/junkala-level-3.wav" 2
music level-1 "$MUSIC/junkala-level-1.wav" 2
