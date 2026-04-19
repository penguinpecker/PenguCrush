#!/usr/bin/env bash
# Compress assets into public/assets_compressed/ (parallel tree).
# Preserves file extensions so HTML/CSS/JS references don't need updating.
set -eo pipefail

SRC=public/assets
DST=public/assets_compressed
mkdir -p "$DST"

# Max widths per top-level category — images never render larger on any screen.
max_width_for() {
  case "$1" in
    map) echo 3000 ;;
    board) echo 1920 ;;
    ui) echo 2048 ;;
    hud) echo 1920 ;;
    blockers) echo 2048 ;;
    loading) echo 1920 ;;
    boosters) echo 1024 ;;
    tiles) echo 1024 ;;
    *) echo 2048 ;;
  esac
}

process_png() {
  local src="$1" dst="$2" cat="$3"
  mkdir -p "$(dirname "$dst")"
  local max_w; max_w=$(max_width_for "$cat")
  local src_w
  src_w=$(sips -g pixelWidth "$src" 2>/dev/null | awk '/pixelWidth/ {print $2}')
  local tmp="/tmp/.comp_$$_$(basename "$src")"
  if [[ -n "$src_w" && "$src_w" -gt "$max_w" ]]; then
    sips -Z "$max_w" "$src" --out "$tmp" >/dev/null
  else
    cp "$src" "$tmp"
  fi
  # Lossy palette quantize, preserve alpha; tight quality range still looks identical
  if pngquant --quality=72-92 --speed 1 --strip --force --output "$dst" "$tmp" 2>/dev/null; then
    :
  else
    # pngquant refused (rare: >8bit alpha retained); fall back to resize-only
    cp "$tmp" "$dst"
  fi
  oxipng -o 4 --strip all --quiet "$dst" 2>/dev/null || true
  rm -f "$tmp"
}

process_jpg() {
  local src="$1" dst="$2" cat="$3"
  mkdir -p "$(dirname "$dst")"
  local max_w; max_w=$(max_width_for "$cat")
  # sips can resize+recompress JPG in one pass
  sips -Z "$max_w" -s formatOptions 85 "$src" --out "$dst" >/dev/null
}

process_webp() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  # Re-encode existing webp at q=85 (usually already compressed; neutral op)
  cwebp -q 85 -mt -quiet "$src" -o "$dst" || cp "$src" "$dst"
}

process_mp4() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  # H.264 CRF 26, tune=animation, cap at 1280px wide, keep aspect.
  # -nostdin so ffmpeg doesn't eat the outer while-loop's stdin.
  ffmpeg -y -nostdin -loglevel error -i "$src" \
    -vf "scale='min(1280,iw)':-2" \
    -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p \
    -tune animation -movflags +faststart \
    -c:a aac -b:a 96k -ac 2 \
    "$dst" </dev/null
}

process_glb() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  # Optimize geometry + textures. Draco geometry + WebP textures, resize to 1024.
  gltf-transform optimize "$src" "$dst" \
    --compress draco \
    --texture-compress webp \
    --texture-size 1024 \
    --simplify false 2>/dev/null || cp "$src" "$dst"
}

category_of() {
  # Top folder under assets/
  local rel="${1#"${SRC}/"}"
  echo "${rel%%/*}"
}

count_total=0
count_done=0
while IFS= read -r -d '' f; do ((count_total++)) || true; done < <(find "$SRC" -type f -print0)
echo "Found $count_total files."

while IFS= read -r -d '' f; do
  ((count_done++)) || true
  rel="${f#"${SRC}/"}"
  dst="$DST/$rel"
  cat=$(category_of "$f")
  ext="${f##*.}"
  ext=$(echo "$ext" | tr '[:upper:]' '[:lower:]')
  case "$ext" in
    png) process_png "$f" "$dst" "$cat" ;;
    jpg|jpeg) process_jpg "$f" "$dst" "$cat" ;;
    webp) process_webp "$f" "$dst" ;;
    mp4|webm) process_mp4 "$f" "$dst" ;;
    glb) process_glb "$f" "$dst" ;;
    *) mkdir -p "$(dirname "$dst")"; cp "$f" "$dst" ;;
  esac
  printf '[%d/%d] %s\n' "$count_done" "$count_total" "$rel"
done < <(find "$SRC" -type f -print0)

echo
echo "Done."
du -sh "$SRC" "$DST"
