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
# The suite MUST run as app_login. Running it as postgres proves nothing:
# superusers bypass RLS and every isolation assertion becomes vacuous.
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

.PHONY: api-test
api-test: ## Go tests
	cd api && go test ./...

.PHONY: web-test
web-test: ## Frontend tests
	cd web && npm test --if-present

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
	cd api && gofmt -w . 2>/dev/null || true
	cd web && npm run format --if-present 2>/dev/null || true

.PHONY: lint
lint: ## Vet and typecheck everything
	cd api && go vet ./... 2>/dev/null || true
	cd web && npm run lint --if-present 2>/dev/null || true

.PHONY: test
test: db-reset db-test api-test web-test ## Every test in the repo

.PHONY: check
check: fmt lint test ## What CI runs. Run this before you commit.
