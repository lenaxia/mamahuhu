# Self-hosting Mamahuhu

Stack: the app (Hono server + React PWA, sqlite in `/data`) plus the
recommended OCR sidecar (FastAPI + rapidocr). You bring your own key for any
OpenAI-compatible gateway (OpenAI, LiteLLM, OpenRouter, ...).

## Quickstart (Docker Compose)

```sh
cd deploy
cp .env.example .env      # then edit: set OPENAI_API_KEY (+ OPENAI_API_BASE)
docker compose up -d      # first run builds the OCR sidecar (~1GB)
```

Open http://localhost:8787. The OCR sidecar has no published ports; the app
reaches it on the compose network (prewired `OCR_*` env — don't touch).

To run from source instead of the released image, comment `image:` in
docker-compose.yml and uncomment `build:` (run `docker compose build`).

## First login — how auth works

Mamahuhu has **no local username/password login or signup**. Two modes:

- **Default (no `TRUST_PROXY_HEADERS`)**: no auth at all. Every visitor is
  silently the same user — `DEV_USER`, default `dad` — created on first
  request. There is nothing to set up: open the app and you're in. Fine for
  localhost / Tailscale; **never expose this mode to the internet**.
- **Forward-auth (`TRUST_PROXY_HEADERS=1`)**: put a forward-auth proxy
  (Authelia / Authentik / traefik) in front. It injects `AUTH_HEADER`
  (default `x-remote-user`) + `AUTH_NAME_HEADER`; the app auto-creates a user
  per header value. Uncomment the three vars in `.env` and configure your
  proxy to inject them.

## Kubernetes

Flux HelmReleases using the same `bjw-s/app-template` chart (5.2.1) that
production runs: `kubernetes/helmrelease-app.yaml` (app + ingress + PVC) and
`kubernetes/helmrelease-ocr.yaml` (OCR sidecar — same namespace, no ingress).
Both expect the bjw-s HelmRepository in `flux-system`; an inline
HelmRepository example is commented at the top of the app file.

Create the secret first, then apply both:

```sh
kubectl -n mamahuhu create secret generic mamahuhu \
  --from-literal=OPENAI_API_BASE=https://api.openai.com/v1 \
  --from-literal=OPENAI_API_KEY=sk-...
kubectl apply -f kubernetes/helmrelease-ocr.yaml -f kubernetes/helmrelease-app.yaml
```

Not on Flux? Pull `spec.values` from each file into a `values.yaml` and
`helm upgrade --install mamahuhu bjw-s/app-template --version 5.2.1 -f values.yaml`
(the chart is public at https://bjw-s.github.io/helm-charts/). Port-forward
alternative: `kubectl -n mamahuhu port-forward svc/mamahuhu 8787`.

## Data & backups

Everything lives in `DATA_DIR` (`./data` on compose, the PVC on k8s):
sqlite DB (`app.db`), photos, audio cache. `docker compose down` keeps it;
back up the directory/volume — the DB is the whole app state. Single-writer
sqlite: keep `replicas: 1`.

## Images

- App: `ghcr.io/lenaxia/mamahuhu` — tags track releases (currently `0.11.11`).
- OCR: `ghcr.io/lenaxia/mamahuhu-ocr` — published as `latest`/commit-sha only
  (no release tags); compose builds it from `Dockerfile.ocr` by default.
