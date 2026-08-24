-- ============================================================================
--  Actor scope predicates: depot and task (TYRE-56)
--  Implements: FR-AUT-004/006/008 read side, FR-DSH-012 (SRS v1.4 §4.3, §4.14)
-- ============================================================================

-- The depots the acting user is scoped to (FR-AUT-004). Everything below
-- composes this rather than joining user_depot again, so "which depots am I"
-- has exactly one definition. An unset actor matches no rows, failing closed
-- the same way the tenant context does (FR-TEN-004).
CREATE VIEW app.v_actor_depot WITH (security_invoker = true) AS
SELECT ud.tenant_id,
       ud.depot_id
  FROM app.user_depot ud
 WHERE ud.user_id = app.current_actor_id();

-- FR-AUT-006/008: the units within the acting user's depots. Home depot is
-- the unit's base, not where it happens to be standing — a trailer on the
-- road still belongs to the depot that maintains it.
CREATE VIEW app.v_depot_vehicle WITH (security_invoker = true) AS
SELECT v.*
  FROM app.vehicle v
  JOIN app.v_actor_depot d ON d.depot_id = v.home_depot_id;

-- FR-AUT-006: the tyres within the acting user's depots. A tyre is in a depot
-- two ways and the requirement means both — sitting there (in stock, back
-- from the retreader, awaiting cost), or fitted to a unit based there.
-- Scoping on current_depot_id alone would hide every fitted tyre from the
-- technician who maintains it.
CREATE VIEW app.v_depot_tyre WITH (security_invoker = true) AS
SELECT DISTINCT t.*
  FROM app.tyre t
  LEFT JOIN app.fitment f ON f.tyre_id = t.id AND f.removed_at IS NULL
  LEFT JOIN app.vehicle v ON v.id = f.vehicle_id
 WHERE t.current_depot_id IN (SELECT depot_id FROM app.v_actor_depot)
    OR v.home_depot_id    IN (SELECT depot_id FROM app.v_actor_depot);

-- FR-DSH-012: the acting driver's outstanding work. Overdue is not a state —
-- app.task_state has no such value, deliberately — it is an OPEN task past
-- its due date, computed here so no client ever invents the rule.
CREATE VIEW app.v_my_inspection_task WITH (security_invoker = true) AS
SELECT it.*,
       (it.state = 'OPEN' AND it.due_at < now()) AS overdue
  FROM app.inspection_task it
 WHERE it.assigned_user_id = app.current_actor_id()
   AND it.state IN ('OPEN','ESCALATED');
