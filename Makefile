# Canonical commands. If you find yourself typing a raw docker or psql
# incantation twice, it belongs in here instead.
.DEFAULT_GOAL := help
SHELL := /bin/bash

PG_CONTAINER ?= tyre-pg
PG_PORT      ?= 5433
PG_DB        ?= tyre

# psql runs inside the container: the database is the only machine-independent
# place it is guaranteed to exist (this repo is developed on Windows without a
# host psql). Override PSQL_SUPER/PSQL_APP to use a host client instead.
# The suite MUST run as app_login: superusers bypass RLS (DEPLOYMENT NOTE at
# the end of db/migrations/000001_init.up.sql).
PSQL_SUPER ?= docker exec -i $(PG_CONTAINER) psql -U postgres -d $(PG_DB)
PSQL_APP   ?= docker exec -i $(PG_CONTAINER) psql -U app_login -d $(PG_DB)

# migrate runs on the compose network so the same invocation works on any OS.
# MSYS_NO_PATHCONV stops Git Bash rewriting /migrations into a Windows path;
# it is inert everywhere else.
MIGRATE ?= MSYS_NO_PATHCONV=1 docker compose run --rm migrate \
             -path=/migrations \
             -database "postgres://postgres:postgres@postgres:5432/$(PG_DB)?sslmode=disable"

# python3 on stock Windows is a Microsoft Store stub that opens a browser.
PYTHON ?= $(shell python3 -c "print()" >/dev/null 2>&1 && echo python3 || echo python)

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

## ---------------------------------------------------------------- database

.PHONY: db-up
db-up: ## Start Postgres 16 in docker
	docker compose up -d postgres
	@until docker exec $(PG_CONTAINER) pg_isready -U postgres -q; do sleep 0.5; done
	@echo "postgres ready on $(PG_PORT)"

.PHONY: db-down
db-down: ## Stop and remove the database container
	docker compose down -v

.PHONY: db-seeds
db-seeds: ## Regenerate the machine-generated seed SQL
	cd db/seeds && $(PYTHON) gen_seed_configurations.py && $(PYTHON) gen_seed_fixture.py

.PHONY: db-migrate
db-migrate: db-up ## Apply pending migrations (golang-migrate, versioned in schema_migrations)
	$(MIGRATE) up

.PHONY: db-reset
db-reset: db-up db-seeds ## Drop everything, re-run all migrations, load seeds
	echo "DROP SCHEMA IF EXISTS app CASCADE; DROP TABLE IF EXISTS public.schema_migrations;" | $(PSQL_SUPER) -q
	$(MIGRATE) up
	$(PSQL_SUPER) -v ON_ERROR_STOP=1 -q < db/seeds/002_seed_configurations.sql
	$(PSQL_SUPER) -v ON_ERROR_STOP=1 -q < db/seeds/003_seed_fixture.sql
	@echo "migrations and seeds applied"

.PHONY: db-test
db-test: ## Run the verification suite as a NON-SUPERUSER (the only valid way)
	$(PSQL_APP) -v ON_ERROR_STOP=1 < db/tests/004_tests.sql

.PHONY: db-shell
db-shell: ## Interactive psql as the application role
	docker exec -it $(PG_CONTAINER) psql -U app_login -d $(PG_DB)

## ---------------------------------------------------------------- api / web

# Go runs in docker: this repo is developed on Windows without a host Go
# toolchain. The container joins the compose network so the integration tests
# can reach tyre-pg; the module cache volume makes repeat runs fast. The
# app_login password is local-only (CI sets its own; staging's lives in
# Key Vault).
GO_IMAGE ?= golang:1.24-alpine
GO_RUN   = MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(CURDIR)/api:/app" -w /app -v tyre-gomodcache:/go/pkg/mod
GO_DOCKER = $(GO_RUN) --network tyreplatform_default \
  -e TEST_DATABASE_URL="postgres://app_login:dev@tyre-pg:5432/tyre?sslmode=disable" \
  -e TEST_ADMIN_DATABASE_URL="postgres://postgres:postgres@tyre-pg:5432/tyre?sslmode=disable" \
  $(GO_IMAGE)

.PHONY: api-test
api-test: ## Go tests (docker; needs db-up for the integration tests)
	echo "ALTER ROLE app_login PASSWORD 'dev';" | $(PSQL_SUPER) -q
	$(GO_DOCKER) go test ./...

# --env-file keeps the credentials out of the Makefile and out of git; the
# file's own comments say what belongs in it. Module cache volume means the
# first run compiles and later runs start in seconds.
.PHONY: api-run
api-run: ## Run the API locally on :8080 (needs db-up and a .env file)
	echo "ALTER ROLE app_login PASSWORD 'dev';" | $(PSQL_SUPER) -q
	$(GO_RUN) --network tyreplatform_default --env-file .env -p 8080:8080 \
	  $(GO_IMAGE) go run ./cmd/api

.PHONY: web-test
web-test: ## Frontend tests
	cd web && npm test

# Deliberately NOT in `make check`: it queries the npm registry for every
# locked package, so it needs network and must not turn an offline `make
# check` red. CI runs it on every PR, which is where a regenerated lockfile
# actually arrives.
.PHONY: deps-age
deps-age: ## Assert nothing in the web lockfile is younger than the .npmrc window
	node scripts/check-release-age.mjs

## ---------------------------------------------------------------- aggregate

.PHONY: fmt
fmt: ## Format everything
	$(GO_RUN) $(GO_IMAGE) gofmt -w .
	cd web && npm run format

# Every line here must be able to fail the target. A gate that swallows its
# own exit code reports success it did not earn, and the docs then promise a
# check that never ran (TYRE-49).
#
# This is deliberately the same set CI runs, in the same order, so a green
# `make lint` means a green CI lint — the reason to run it before committing.
# `fmt` writes; `lint` only reads, which is why both formatters appear here in
# check mode: `make check` runs fmt first, so locally they are always clean,
# and on CI they are the drift detector.
#
# staticcheck comes from the `tool` directive in api/go.mod, so it is pinned
# and checksummed like any other dependency. v0.6.1 is the last release that
# builds under go 1.24; a Renovate bump past it will fail until the toolchain
# moves, and moving the toolchain is the fix, not unpinning the linter.
.PHONY: lint
lint: ## Format check, vet, staticcheck, eslint, tsc, comment standard
	$(GO_RUN) $(GO_IMAGE) sh -c 'test -z "$$(gofmt -l .)" || { gofmt -l .; echo "run make fmt"; exit 1; }'
	$(GO_RUN) $(GO_IMAGE) go vet ./...
	$(GO_RUN) $(GO_IMAGE) go tool staticcheck ./...
	cd web && npm run format:check && npm run lint && npm run typecheck
	node scripts/check-comment-style.mjs

.PHONY: test
test: db-reset db-test api-test web-test ## Every test in the repo

.PHONY: check
check: fmt lint test ## What CI runs. Run this before you commit.
