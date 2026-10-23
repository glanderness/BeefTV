#!/usr/bin/env bash
set -euo pipefail

# The runner's Azure mirror has stalled media-package downloads. Keep Ubuntu's
# signed repositories and package versions, using the primary archive instead.
for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do
  [[ -f "$source" ]] || continue
  sudo sed -i 's|azure.archive.ubuntu.com|archive.ubuntu.com|g' "$source"
done
printf '%s\n' 'Acquire::Retries "3";' 'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' \
  | sudo tee /etc/apt/apt.conf.d/80beeftv-network >/dev/null
