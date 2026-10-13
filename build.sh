#!/bin/sh
# Собирает аддон в dist/VillagerCivilizations.mcaddon
set -e
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/VillagerCivilizations.mcaddon
cd packs
zip -r -X ../dist/VillagerCivilizations.mcaddon CivilizationBP CivilizationRP >/dev/null
echo "Готово: dist/VillagerCivilizations.mcaddon"
