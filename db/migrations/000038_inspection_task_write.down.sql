-- Reverses 000038: drops the task write, the audit trigger, the factored
-- predicate and overdue views, and restores app.v_capture_vehicle (000022)
-- and app.v_my_inspection_task (000014) to their previous bodies. The audit
-- rows the trigger wrote stay — a migration that deleted them would be
-- destroying facts, not changing a schema (rule 3, CR-004), the reasoning
-- 000035's and 000037's down migrations carry.
DROP FUNCTION app.create_inspection_task(uuid, uuid, date);
DROP TRIGGER inspection_task_audited ON app.inspection_task;

DROP VIEW app.v_my_inspection_task;
DROP VIEW app.v_inspection_task;
CREATE VIEW app.v_my_inspection_task WITH (security_invoker = true) AS
SELECT it.*,
       (it.state = 'OPEN' AND it.due_at < now()) AS overdue
  FROM app.inspection_task it
 WHERE it.assigned_user_id = app.current_actor_id()
   AND it.state IN ('OPEN','ESCALATED');

DROP FUNCTION app.user_can_capture(uuid, uuid);
CREATE OR REPLACE VIEW app.v_capture_vehicle WITH (security_invoker = true) AS
SELECT dv.tenant_id, dv.vehicle_id
  FROM app.v_driver_vehicle dv
UNION
SELECT cm.tenant_id, cm.vehicle_id
  FROM app.v_driver_vehicle dv
  JOIN app.combination c
    ON c.motive_vehicle_id = dv.vehicle_id AND c.effective_to IS NULL
  JOIN app.combination_member cm ON cm.combination_id = c.id;
DROP VIEW app.v_user_capture_vehicle;
