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
tx, err := pool.Begin(ctx)
if err != nil { return err }
defer tx.Rollback(ctx)

// SET LOCAL, never SET: binds to this transaction, so a pooled connection
// cannot carry this tenant's context into the next request.
if _, err := tx.Exec(ctx, "SET LOCAL app.tenant_id = $1", claims.TenantID); err != nil {
    return err
}
// ... every query on tx, never on pool ...
return tx.Commit(ctx)
```

If you find yourself querying `pool` directly inside a request, stop. That
query runs with no tenant context and returns nothing — which looks like a
data bug and is actually a missing transaction.

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
