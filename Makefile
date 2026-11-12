.DEFAULT_GOAL := help
.PHONY: help run seed test lint chart image smoke deploy deploy-source

# LEAGUE_CODE / ADMIN_CODE come from .env (git-ignored) or the environment.
-include .env
export

PREK      ?= uvx prek
IMAGE     ?= chicago-standard-league:dev
RELEASE   ?= csl
NAMESPACE ?= csl
SOURCE_CM ?= csl-app
SOURCES   := package.json $(wildcard src/*.js public/*)

help: ## List targets
	@awk -F ':.*## ' '/^[a-z-]+:.*## /{printf "%-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

run: ## Serve on http://localhost:8080
	node src/server.js

seed: ## Fill an empty database with demo data
	node seed.js

test: ## Unit tests
	node --test

lint: ## Pre-commit hooks on all files (whitespace, YAML, workflow lint)
	$(PREK) run --all-files

chart: ## Lint the chart and render it with the example values
	helm lint chart -f deploy/example-values.yaml --set leagueCode=x --set adminCode=x
	helm template $(RELEASE) chart -f deploy/example-values.yaml --set leagueCode=x --set adminCode=x > /dev/null

image: ## Build the container image as $(IMAGE)
	docker build -t $(IMAGE) .

smoke: ## Start $(IMAGE) and check that it serves pages
	docker run -d --rm --name csl-smoke -p 127.0.0.1:18080:8080 -e LEAGUE_CODE=smoke -e ADMIN_CODE=smoke $(IMAGE)
	curl -fsS --retry 10 --retry-all-errors --retry-delay 1 http://127.0.0.1:18080/healthz http://127.0.0.1:18080/ http://127.0.0.1:18080/report > /dev/null; \
	  status=$$?; docker rm -f csl-smoke > /dev/null; exit $$status

deploy: ## helm upgrade --install into the current kube context; needs VALUES=<your values file>
	@test -n "$(VALUES)" || { echo "set VALUES=<values file>, e.g. a copy of deploy/example-values.yaml"; exit 1; }
	helm upgrade --install $(RELEASE) chart -n $(NAMESPACE) --create-namespace -f $(VALUES) \
	  --set-string leagueCode="$$LEAGUE_CODE" --set-string adminCode="$$ADMIN_CODE"

deploy-source: ## Ship the working tree to a sourceConfigMap deployment (no image needed), then deploy
	kubectl create namespace $(NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
	kubectl -n $(NAMESPACE) create configmap $(SOURCE_CM) $(SOURCES:%=--from-file=%) --dry-run=client -o yaml | kubectl apply -f -
	$(MAKE) deploy
	kubectl -n $(NAMESPACE) rollout restart deploy/$(RELEASE)
	kubectl -n $(NAMESPACE) rollout status deploy/$(RELEASE)
