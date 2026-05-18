#!/bin/bash
# Self-host mayorpratt.com images locally to remove third-party dependency.
# Run from landing-pages/ directory:  bash scripts/download-assets.sh

set -e

DIR="assets/img"
mkdir -p "$DIR"

echo "Downloading 10 images from mayorpratt.com..."

# Logos
curl -fsSL "https://mayorpratt.com/wp-content/themes/pratt-theme/assets/images/logo.webp" -o "$DIR/logo.webp"
curl -fsSL "https://mayorpratt.com/wp-content/themes/pratt-theme/assets/images/logo-footer.webp" -o "$DIR/logo-footer.webp"

# Open Graph image (used by all 3 pages)
curl -fsSL "https://mayorpratt.com/wp-content/uploads/2026/01/OG-2.png" -o "$DIR/og-image.png"

# Hero images
curl -fsSL "https://mayorpratt.com/wp-content/uploads/2026/01/hero-scaled-e1769214639508.webp" -o "$DIR/hero.webp"
curl -fsSL "https://mayorpratt.com/wp-content/uploads/2026/01/Brandon-02771_Web-JPeg-e1769322375554.webp" -o "$DIR/brandon-hero.webp"

# Section backgrounds
curl -fsSL "https://mayorpratt.com/wp-content/themes/pratt-theme/assets/images/signup-bg.webp" -o "$DIR/signup-bg.webp"
curl -fsSL "https://mayorpratt.com/wp-content/themes/pratt-theme/assets/images/about-spencer-4.webp" -o "$DIR/about-spencer.webp"

# Issues images
curl -fsSL "https://mayorpratt.com/wp-content/themes/pratt-theme/assets/images/issues-city.webp" -o "$DIR/issues-city.webp"
curl -fsSL "https://mayorpratt.com/wp-content/themes/pratt-theme/assets/images/issues-firefighter.jpg" -o "$DIR/issues-firefighter.jpg"
curl -fsSL "https://mayorpratt.com/wp-content/themes/pratt-theme/assets/images/issues-homelessness.webp" -o "$DIR/issues-homelessness.webp"

echo ""
echo "Downloaded files:"
ls -lah "$DIR/"
echo ""
echo "Total size:"
du -sh "$DIR/"
echo ""
echo "Done. Now run: git add assets/ && git commit -m 'perf: self-host images' && git push"
