# api/

Go. Deliberately thin — auth, tenant context, transport, sync reconciliation.
Business rules belong in `db/`.

## Stack

`net/http` + `chi` + `pgx`. **No ORM, no web framework.** The ORM ban is not
taste: RLS needs `SET LOCAL app.tenant_id` bound to the same transaction as the
queries, and an ORM's connection pooling actively hides which connection a
query lands on. That is the one bug in this product that is existential.

## The pattern every handler follows

```go
err := s.InTenantTx(ctx, claims.TenantID, func(tx pgx.Tx) error {
    // ... every query on tx, never on pool ...
    return nil
})
```

`internal/store.InTenantTx` owns the dance — a per-request transaction with
the tenant bound via transaction-local `set_config` — and its doc comment is
the canonical statement of why it is shaped that way. Do not re-implement it
in a handler.

If you find yourself querying `pool` directly inside a request, stop. That
query runs with no tenant context and returns nothing — which looks like a
data bug and is actually a missing transaction.

## The dev header resolver

The dev resolver now supplies a **user** as well as a tenant. Locally, anyone
who can send a header is anyone, in any tenant, so the capability gate is
decorative in development — it is a development convenience with the blast
radius of an authentication bypass. The `CONTAINER_APP_NAME` veto in
`devHeaderEnabled` is the whole safety story; ADR-0011 records why.

## Money over the wire

Postgres `numeric` → Go `decimal.Decimal` → JSON **string**. Never a JSON
number: most parsers decode that to an IEEE double, and the acceptance gate is
cent-exactness. `"1218.78"`, not `1218.78`.

## Conventions

- `context.Context` first parameter, always.
- Errors are values. `fmt.Errorf("fetching vehicle %s: %w", id, err)`. No panic
  in request handling.
- Accept interfaces, return structs. Define interfaces where they are consumed.
- Table-driven tests. Integration tests hit a real Postgres, never a mock — a
  mocked database cannot fail an RLS policy, which is the thing worth testing.
- Handlers stay dumb. If a handler is making a business decision about tyres,
  that decision belongs in SQL.
