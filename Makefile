# Canonical commands. If you find yourself typing a raw docker or psql
# incantation twice, it belongs in here instead.
.DEFAULT_GOAL := help
SHELL := /bin/bash

PG_CONTAINER ?= tyre-pg
PG_PORT      ?= 5433
PG_DB        ?= tyre

# psql runs inside the container (no host psql on Windows); override
# PSQL_SUPER/PSQL_APP for a host client. The suite MUST run as app_login:
# superusers bypass RLS (000001_init.up.sql DEPLOYMENT NOTE). The one
# exception is db-test-privileged, which stages rather than tests.
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
	@# ON_ERROR_STOP because these are two statements on one connection: without
	@# it a cancelled DROP SCHEMA still runs the DROP TABLE, and the next
	@# `migrate up` re-creates schema_migrations dirty at version 1.
	echo "DROP SCHEMA IF EXISTS app CASCADE; DROP TABLE IF EXISTS public.schema_migrations;" | $(PSQL_SUPER) -v ON_ERROR_STOP=1 -q
	$(MIGRATE) up
	$(PSQL_SUPER) -v ON_ERROR_STOP=1 -q < db/seeds/002_seed_configurations.sql
	$(PSQL_SUPER) -v ON_ERROR_STOP=1 -q < db/seeds/003_seed_fixture.sql
	@echo "migrations and seeds applied"

# Opt-in, never part of db-reset, db-test, test or check: the suite stays
# defined on the pinned fixture. Loads Sandbox Fleet for the dashboard
# read-path measurement (TYRE-247, B7 spec B7.1.5); BAC and Second Fleet
# rows never change. One transaction for the whole load, so run nothing
# else against the database until it returns (docs/lessons.md, 2026-09-16).
.PHONY: db-volume
db-volume: db-up ## Load the Sandbox Fleet volume tenant (TYRE-247); db-reset restores the pinned state
	cd db/seeds && $(PYTHON) gen_seed_volume.py
	@# set -e, not bare semicolons: a failed load followed by a successful
	@# echo exits 0 and make reports a load that never happened.
	@set -e; start=$$(date +%s); \
	$(PSQL_SUPER) -v ON_ERROR_STOP=1 -q < db/seeds/006_seed_volume.sql; \
	echo "volume loaded in $$(( $$(date +%s) - start ))s; the database is now off the pinned state, make db-reset restores it"
	@# autoanalyze is asynchronous, so a measurement run straight after the
	@# load can plan on pre-load statistics. ANALYZE makes the plan db-explain
	@# prints a function of the data, not of how long autovacuum happened to
	@# have been awake.
	$(PSQL_SUPER) -v ON_ERROR_STOP=1 -qc "ANALYZE;"

# Runs as app_login, not postgres: the plan must carry the RLS predicate the
# API's connection will carry. Run it cold (container just restarted) and
# again warm; the 500 ms budget applies to the warm run (B7 spec U26).
.PHONY: db-explain
db-explain: ## EXPLAIN (ANALYZE, BUFFERS) the dashboard read path over the volume tenant (TYRE-247)
	$(PSQL_APP) -v ON_ERROR_STOP=1 < db/perf/dashboard.sql

.PHONY: db-test
db-test: ## Run the verification suite as a NON-SUPERUSER (the only valid way)
	$(PSQL_APP) -v ON_ERROR_STOP=1 < db/tests/004_tests.sql

# The one target that runs as postgres. It proves nothing about RLS and is
# never a substitute for db-test; what it stages and why is the header of
# db/tests/005_privileged.sql (TYRE-38, B7 spec U12).
.PHONY: db-test-privileged
db-test-privileged: ## Negative controls that need a superuser to STAGE (db/tests/005_privileged.sql)
	$(PSQL_SUPER) -v ON_ERROR_STOP=1 < db/tests/005_privileged.sql

.PHONY: db-shell
db-shell: ## Interactive psql as the application role
	docker exec -it $(PG_CONTAINER) psql -U app_login -d $(PG_DB)

## ---------------------------------------------------------------- api / web

# Go runs in docker (no host toolchain on Windows), joined to the compose
# network so integration tests reach tyre-pg. app_login's password here is
# local-only; CI sets its own and staging's lives in Key Vault.
GO_IMAGE ?= golang:1.24-alpine
GO_RUN   = MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(CURDIR)/api:/app" -w /app -v tyre-gomodcache:/go/pkg/mod
GO_DOCKER = $(GO_RUN) --network tyreplatform_default \
  -e TEST_DATABASE_URL="postgres://app_login:dev@tyre-pg:5432/tyre?sslmode=disable" \
  -e TEST_ADMIN_DATABASE_URL="postgres://postgres:postgres@tyre-pg:5432/tyre?sslmode=disable" \
  $(GO_IMAGE)

# No -race locally: the race detector needs cgo and a C toolchain, which
# golang:*-alpine does not carry. CI's ubuntu runner adds `-race`, so a data
# race is the one failure a green `make check` can still hand to CI.
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

.PHONY: web-bundle
web-bundle: ## The capture route's JavaScript budget (TYRE-238, ADR-0015)
	cd web && npm run build && npm run bundle:check

# Not in `make test`: needs a live stack (make api-run, make db-reset) and
# CI runs it as its own job (TYRE-65). Reseed is mandatory: FR-INS-038
# refuses a second inspection of the same unit in the configured window, so
# a stale seed fails the first spec for an unrelated reason. db-reset is a
# recipe line, not a prerequisite, so the API reachability check runs first.
# webkit as well as chromium: the ios project is iPhone 14 (WebKit); android
# is Chromium emulation, no extra download.
.PHONY: e2e
e2e: ## Browser smoke tests (reseeds first; needs `make api-run` running)
	@curl -s -o /dev/null http://localhost:8080/api/me \
	  || { echo "API not reachable on :8080. Run 'make api-run' first"; exit 1; }
	$(MAKE) db-reset
	cd web && npx playwright install chromium webkit && npm run e2e

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

# Every line must be able to fail the target (TYRE-49): a gate that
# swallows its exit code reports success it did not earn. Same set and
# order as CI, so a green make lint means a green CI lint. staticcheck is
# pinned via api/go.mod's tool directive; v0.6.1 is the last release under
# go 1.24, so a Renovate bump past it needs the toolchain moved first, not
# the linter unpinned.
#
# The money gate runs its self-test first so a run that finds nothing has
# proven it could have (rule 2, TYRE-36). Its web half is an ESLint rule and
# rides `npm run lint` above.
.PHONY: lint
lint: ## Format check, vet, staticcheck, eslint, tsc, comment standard, money paths
	$(GO_RUN) $(GO_IMAGE) sh -c 'test -z "$$(gofmt -l .)" || { gofmt -l .; echo "run make fmt"; exit 1; }'
	$(GO_RUN) $(GO_IMAGE) go vet ./...
	$(GO_RUN) $(GO_IMAGE) go tool staticcheck ./...
	cd web && npm run format:check && npm run lint && npm run typecheck
	node scripts/check-comment-style.mjs
	node scripts/check-money-types.mjs --self-test
	node scripts/check-money-types.mjs
	$(MAKE) web-bundle

.PHONY: test
test: db-reset db-test db-test-privileged api-test web-test ## Every test in the repo

.PHONY: check
check: fmt lint test ## What CI runs. Run this before you commit.
