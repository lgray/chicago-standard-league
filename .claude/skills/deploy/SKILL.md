---
name: deploy
description: Deploy or update the league site on Kubernetes with the Helm chart, including the live site. Use when asked to deploy, roll out, update the live site, or install the chart on a cluster.
---

# Deploy

Deploying restarts the single pod (a few seconds of 503 because the strategy is `Recreate`). Only deploy when
the user asked for it, and say which cluster and namespace you are about to change.

## Where the cluster settings are

Values files and notes for real clusters live in `deploy/local/`, which is git-ignored on purpose: hostnames,
ingress annotations, issuer names, addresses and kubeconfig paths must not reach the repository, a commit
message, an issue or a PR. Read `deploy/local/NOTES.md` and the values file there before deploying. If the
directory is missing (fresh clone), ask the user for a values file; `deploy/example-values.yaml` shows the shape.

## Before

```sh
make test chart
kubectl config current-context       # confirm the target; set KUBECONFIG if the user names one
helm -n csl list                     # is there already a release?
```

`LEAGUE_CODE` and `ADMIN_CODE` must be in `.env` or the environment; the Makefile passes them to Helm without
echoing them. Never put them in a values file or a commit.

## Which target

- **Source mode** (`sourceConfigMap` set in the values file): `make deploy-source VALUES=<file>`.
  It uploads `package.json`, `src/*.js` and `public/*` as a ConfigMap, runs the Helm upgrade and restarts the
  pod. No image or registry involved, so it ships whatever is in the working tree — check `git status` first.
- **Image mode** (default chart values): `make deploy VALUES=<file>`. Uses
  `ghcr.io/lgray/chicago-standard-league:<chart appVersion>`; set `image.tag=main` for the latest main build.
  The package is private while the repository is, so the cluster needs `imagePullSecrets`.

`VALUES` is required; `RELEASE`, `NAMESPACE` and `SOURCE_CM` default to `csl`, `csl` and `csl-app`.
Preview without changing anything: `make -n deploy-source VALUES=<file>`, or add `--dry-run=server` to the Helm command.

## After

```sh
kubectl -n csl rollout status deploy/csl
kubectl -n csl logs deploy/csl --tail=20
curl -s -o /dev/null -w '%{http_code}\n' https://<host from the values file>/healthz   # 200
```

Then load one page that exercises what changed.

## Traps

- A new file under `src/` or `public/` is invisible in source mode until it is added to the ConfigMap `items`
  list in `chart/templates/app.yaml`.
- League data lives in the PVC, which `helm uninstall` keeps on purpose. Never delete the PVC or the database
  without an explicit request; back up first with `kubectl cp csl/<pod>:/data ./backup`.
- A 404 from the ingress controller for a freshly deployed host is usually a missing controller-specific
  annotation or DNS, not the app; the local notes say what the cluster expects.
- The chart's default `dnsConfig` (`ndots:1`) works around external lookups failing from Alpine; do not remove it.
