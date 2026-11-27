# Temporary Cloudflare SSH Banner Probe

This probe checks whether a Cloudflare Worker can read an SSH 2.0 identification line from **one owner-approved public IPv4 address on port 22**. It never sends SSH client data, authenticates, installs software, or changes the VPS. The result is not evidence of browser SSH, host key verification, or agent installation.

## Prepare

Use the Cloudflare dashboard to avoid installing a CLI. Create a **new, uniquely named** temporary Worker, not a new version of an existing Worker. Do not add routes or custom domains. Disable preview URLs and request observability for the temporary Worker if enabled. The probe fails closed until both settings are configured.

1. Generate the single-file Worker module locally:
   ```sh
   PROBE_SOURCE=$(mktemp --suffix=.mjs)
   node tools/feasibility/ssh/render-banner-worker.mjs > "$PROBE_SOURCE"
   printf '%s\n' "$PROBE_SOURCE"
   ```
   Open the generated file in a local editor and paste **its source only** into the new Worker's editor. It contains no endpoint or credentials. The equivalent Wrangler entry point is `banner.wrangler.jsonc`, if Wrangler is already available; always use the new unique Worker name.
2. In **Settings → Variables and Secrets** for the temporary Worker, add `SSH_PROBE_IP` as the approved public IPv4 address without a port, and `PROBE_TOKEN` as a secret containing 64 lowercase hex characters. Generate a fresh value locally using `openssl rand -hex 32` in a private terminal. Do not reuse a Cloudflare API token or SSH credential. Deploy the settings for this Worker only. The endpoint requires a bodyless `POST /probe` and accepts no target in the request.

## Run once

In a private shell (not a transcript or chat), enter the `https://…workers.dev` URL without a trailing slash and the probe token when prompted. Pass the token to curl on stdin so it is not placed in the command line or shell history:

```bash
(
  read -r -p 'Temporary Worker HTTPS URL: ' PROBE_URL
  [[ "$PROBE_URL" =~ ^https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$ ]] || {
    printf '%s\n' 'Expected the exact HTTPS workers.dev URL, with no trailing slash.' >&2
    exit 1
  }
  read -r -s -p 'Temporary probe token: ' PROBE_TOKEN; printf '\n'
  [[ "$PROBE_TOKEN" =~ ^[0-9a-f]{64}$ ]] || { printf '%s\n' 'Invalid probe token format.' >&2; exit 1; }
  printf 'header = "Authorization: Bearer %s"\n' "$PROBE_TOKEN" | \
    curl -q --config - --silent --show-error --proto '=https' --max-time 12 --request POST \
      --write-out '\nHTTP %{http_code}\n' "$PROBE_URL/probe"
)
```

Do not send an authentication token to a URL you have not verified belongs to the temporary Worker. Do not share the URL, IP, token, or raw diagnostics in chat. The sanitized result is a short message and an HTTP status:

- `200`, `SSH-2.0 banner detected`: The Worker directly received an SSH 2.0 banner from the configured endpoint. This is not authenticated host identity.
- `404`: Invalid request, missing or mismatched probe token, or wrong path. No SSH connection was attempted by this script for an invalid request.
- `503`: The destination binding is missing or is not a literal IPv4 address.
- `502` or `504`: No usable banner was received; the response distinguishes a socket error, invalid or incomplete banner, and timeout. Do not widen the target scope or change the VPS firewall for this probe.

## Clean up

After recording the sanitized status, in the dashboard open **only the new temporary Worker**, verify its exact name, and delete it. Verify the temporary Worker no longer appears in the account. Remove the generated local file if no longer needed. No SSH account, key, firewall rule, or other VPS change is needed to run or undo this probe.
