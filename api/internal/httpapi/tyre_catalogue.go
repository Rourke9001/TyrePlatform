package httpapi

import (
	"context"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

type catalogueEntryJSON struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

// brandId is null for a pattern no brand owns; appliesTo is NEW, RETREAD or
// BOTH (FR-CFG-004), and the receive form offers only the first and last.
type cataloguePatternJSON struct {
	ID        uuid.UUID  `json:"id"`
	Name      string     `json:"name"`
	BrandID   *uuid.UUID `json:"brandId"`
	AppliesTo string     `json:"appliesTo"`
}

type tyreCatalogueJSON struct {
	Sizes    []catalogueEntryJSON   `json:"sizes"`
	Brands   []catalogueEntryJSON   `json:"brands"`
	Patterns []cataloguePatternJSON `json:"patterns"`
}

// listTyreCatalogue serves the receive form's pickers from the tenant's own
// register (FR-CFG-001..004).
func listTyreCatalogue(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		// Initialised, not nil: an empty list is [], never null.
		out := tyreCatalogueJSON{
			Sizes:    []catalogueEntryJSON{},
			Brands:   []catalogueEntryJSON{},
			Patterns: []cataloguePatternJSON{},
		}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			// Who may read the catalogue is the receive spec's Q2.
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			var err error
			// Active rows only, in every list (the receive spec's Q4, owner,
			// 12 Oct 2026, over FR-CFG-007's deactivation).
			if out.Sizes, err = loadCatalogueEntries(ctx, tx, "sizes",
				// Length then name, as loadExceptions orders position codes
				// (NFR-USE-012), is natural only among codes of one shape, so
				// every consumer re-sorts by name.
				`SELECT id, name FROM app.tyre_size WHERE active ORDER BY length(name), name`); err != nil {
				return err
			}
			if out.Brands, err = loadCatalogueEntries(ctx, tx, "brands",
				`SELECT id, name FROM app.tyre_brand WHERE active ORDER BY length(name), name`); err != nil {
				return err
			}
			out.Patterns, err = loadCataloguePatterns(ctx, tx)
			return err
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

func loadCatalogueEntries(ctx context.Context, tx pgx.Tx, what, sql string) ([]catalogueEntryJSON, error) {
	rows, err := tx.Query(ctx, sql)
	if err != nil {
		return nil, fmt.Errorf("listing tyre %s: %w", what, err)
	}
	defer rows.Close()
	out := []catalogueEntryJSON{}
	for rows.Next() {
		var e catalogueEntryJSON
		if err := rows.Scan(&e.ID, &e.Name); err != nil {
			return nil, fmt.Errorf("scanning tyre %s: %w", what, err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func loadCataloguePatterns(ctx context.Context, tx pgx.Tx) ([]cataloguePatternJSON, error) {
	rows, err := tx.Query(ctx, `
		SELECT p.id, p.name, p.brand_id, p.applies_to
		  FROM app.tyre_pattern p
		 WHERE p.active
		   -- app.receive_tyres refuses a pattern whose brand is deactivated.
		   AND (p.brand_id IS NULL
		        OR EXISTS (SELECT 1 FROM app.tyre_brand b WHERE b.id = p.brand_id AND b.active))
		 ORDER BY length(p.name), p.name`)
	if err != nil {
		return nil, fmt.Errorf("listing tyre patterns: %w", err)
	}
	defer rows.Close()
	out := []cataloguePatternJSON{}
	for rows.Next() {
		var p cataloguePatternJSON
		if err := rows.Scan(&p.ID, &p.Name, &p.BrandID, &p.AppliesTo); err != nil {
			return nil, fmt.Errorf("scanning tyre pattern: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
