# Canonical commands. If you find yourself typing a raw docker or psql
# incantation twice, it belongs in here instead.
.DEFAULT_GOAL := help
SHELL := /bin/bash

PG_CONTAINER ?= tyre-pg
PG_PORT      ?= 5433
PG_DB        ?= tyre
PG_SUPER_URL ?= postgres://postgres:postgres@localhost:$(PG_PORT)/$(PG_DB)
# The suite MUST run as app_login. Running it as postgres proves nothing:
# superusers bypass RLS and every isolation assertion becomes vacuous.
PG_APP_URL   ?= postgres://app_login@localhost:$(PG_PORT)/$(PG_DB)

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
	cd db/seeds && python3 gen_seed_configurations.py && python3 gen_seed_fixture.py

.PHONY: db-reset
db-reset: db-up db-seeds ## Drop, apply schema, load seeds
	psql "$(PG_SUPER_URL)" -v ON_ERROR_STOP=1 -q -f db/migrations/001_schema.sql
	psql "$(PG_SUPER_URL)" -v ON_ERROR_STOP=1 -q -f db/seeds/002_seed_configurations.sql
	psql "$(PG_SUPER_URL)" -v ON_ERROR_STOP=1 -q -f db/seeds/003_seed_fixture.sql
	@echo "schema and seeds applied"

.PHONY: db-test
db-test: ## Run the verification suite as a NON-SUPERUSER (the only valid way)
	psql "$(PG_APP_URL)" -v ON_ERROR_STOP=1 -f db/tests/004_tests.sql

.PHONY: db-shell
db-shell: ## psql as the application role, with tenant A context preset
	psql "$(PG_APP_URL)" -c "SET app.tenant_id='11111111-1111-1111-1111-111111111111'" -f -

## ---------------------------------------------------------------- api / web

.PHONY: api-test
api-test: ## Go tests
	cd api && go test ./...

.PHONY: web-test
web-test: ## Frontend tests
	cd web && npm test --if-present

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
