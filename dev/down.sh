#!/usr/bin/env bash
# Stop the development stack and delete its data: the containers, the broker's
# log and the tokens up.sh wrote. up.sh starts from nothing again.
set -euo pipefail
cd "$(dirname "$0")"
source ./engine.sh

"${compose[@]}" down --volumes --remove-orphans
rm -rf state
echo "The development stack is down."
