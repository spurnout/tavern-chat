#!/usr/bin/env bash
set -euo pipefail
CERTS_DIR="$(dirname "$0")/certs"
mkdir -p "$CERTS_DIR"
cd "$CERTS_DIR"

if [[ -f ca.crt ]]; then
  echo "certs/ already initialized; delete the dir to regenerate."
  exit 0
fi

openssl req -x509 -newkey rsa:4096 -sha256 -nodes -days 365 \
  -keyout ca.key -out ca.crt -subj "/CN=Tavern Federation Testbed CA"

for HOST in a.tavern.local b.tavern.local; do
  PREFIX="${HOST%.tavern.local}"
  openssl req -newkey rsa:2048 -nodes -keyout "${PREFIX}.key" \
    -out "${PREFIX}.csr" -subj "/CN=${HOST}"
  openssl x509 -req -in "${PREFIX}.csr" -CA ca.crt -CAkey ca.key \
    -CAcreateserial -out "${PREFIX}.crt" -days 365 -sha256 \
    -extfile <(printf "subjectAltName=DNS:${HOST}")
done

echo "Generated certs in $CERTS_DIR."
echo
echo "Export these env vars before \`docker compose up\` (32 raw bytes base64 each):"
echo "  export TAVERN_DATA_KEY_A=\"$(openssl rand -base64 32)\""
echo "  export TAVERN_DATA_KEY_B=\"$(openssl rand -base64 32)\""
