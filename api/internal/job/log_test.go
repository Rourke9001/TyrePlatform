package job

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"
)

// No error text reaches a failure line (NFR-PRV-007).
func TestFailureAttrsCarryNoErrorText(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want []any
	}{
		{"a database error with a constraint",
			fmt.Errorf("step probe: %w", &pgconn.PgError{Code: "23505", ConstraintName: "inspection_task_pkey",
				Message: "Key (display_name)=(Jane Doe) already exists", Detail: "Jane Doe", Hint: "ask Jane"}),
			[]any{"sqlstate", "23505", "constraint", "inspection_task_pkey"}},
		{"a database error with none",
			&pgconn.PgError{Code: "22P02", Message: `invalid input syntax for type integer: "Jane Doe"`},
			[]any{"sqlstate", "22P02"}},
		{"any other error",
			fmt.Errorf("beginning tenant transaction: %w", context.DeadlineExceeded),
			[]any{"error_type", "context.deadlineExceededError"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) { require.Equal(t, tt.want, failureAttrs(tt.err)) })
	}
}
