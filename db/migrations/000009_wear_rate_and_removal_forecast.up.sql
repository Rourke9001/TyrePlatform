-- ============================================================================
--  Wear rate and removal forecast (TYRE-35)
--  Implements: FR-ANL-001..007, BR-ANL-001/002/004; data layer for
--  FR-RPT-028 and the per-position columns of FR-RPT-031.
--  Exists only because the odometer is captured at inspection (SRS §4.11).
-- ============================================================================

-- Every reading of a fitted tyre with the odometer of the capture it belongs
-- to. The odometer is the inspection's, so a towed unit's tyres are measured
-- against the distance the combination ran while they were on it — exact
-- while a link stays behind one motive unit, and the closest available figure
-- when it does not (OI-26).
CREATE VIEW app.v_tyre_reading_odometer WITH (security_invoker = true) AS
SELECT r.tenant_id,
       r.tyre_id,
       r.governing_tread_mm,
       i.submitted_at,
       i.odometer
  FROM app.reading r
  JOIN app.inspection i ON i.id = r.inspection_id
 WHERE i.state <> 'VOIDED'
   AND r.governing_tread_mm IS NOT NULL;

-- FR-ANL-001/002/003 over BR-ANL-001. The pair is the LATEST reading and the
-- most recent reading at least the configured distance behind it — BR-ANL-001
-- says "the most recent pair separated by at least the configured minimum",
-- so the walk goes back until one qualifies. Reading it as "the last two,
-- which must qualify" would silence the rate for any fleet inspecting more
-- often than it drives 1,000km, which is the outcome FR-ANL-002 exists to
-- avoid.
--
-- wear_rate_status carries the reason wherever the rate is NULL (FR-ANL-003):
-- a blank cell and a zero read identically on a dashboard and only one of them
-- is true. The three absences BR-ANL-004 names are distinguished, because
-- they call for different actions — inspect again, drive further, or nothing
-- at all.
CREATE VIEW app.v_tyre_wear_rate WITH (security_invoker = true) AS
SELECT ft.tenant_id,
       ft.tyre_id,
       ft.branded_number,
       ft.vehicle_id,
       ft.fleet_number,
       ft.depot_name,
       ft.position_code,
       ft.is_spare,
       lr.submitted_at        AS later_read_at,
       lr.odometer            AS later_odometer,
       lr.governing_tread_mm  AS later_tread_mm,
       er.submitted_at        AS earlier_read_at,
       er.odometer            AS earlier_odometer,
       er.governing_tread_mm  AS earlier_tread_mm,
       (lr.odometer - er.odometer) AS distance_km,
       ((lr.submitted_at AT TIME ZONE 'UTC')::date
        - (er.submitted_at AT TIME ZONE 'UTC')::date) AS days_between,
       cfg.min_km AS min_distance_km,
       CASE WHEN er.odometer IS NOT NULL AND NOT fit.moved
            THEN app.wear_rate_mm_per_1000km(er.governing_tread_mm, lr.governing_tread_mm,
                                             er.odometer, lr.odometer) END
         AS wear_rate_mm_per_1000km,
       CASE WHEN cfg.min_km IS NULL          THEN 'NO_MIN_DISTANCE_POLICY'
            WHEN prev.odometer IS NULL       THEN 'INSUFFICIENT_READINGS'
            WHEN er.odometer IS NULL         THEN 'BELOW_MIN_DISTANCE'
            WHEN fit.moved                   THEN 'FITMENT_BETWEEN'
            ELSE 'MEASURED' END AS wear_rate_status
  FROM app.v_fitted_tread ft
  LEFT JOIN LATERAL (
       SELECT ro.governing_tread_mm, ro.submitted_at, ro.odometer
         FROM app.v_tyre_reading_odometer ro
        WHERE ro.tyre_id = ft.tyre_id
        ORDER BY ro.submitted_at DESC
        LIMIT 1) lr ON true
  LEFT JOIN LATERAL (
       SELECT (c.value #>> '{}')::bigint AS min_km
         FROM app.configuration c
        WHERE c.tenant_id = ft.tenant_id
          AND c.key = 'wear_rate_min_distance_km'
          AND c.effective_from < ((now() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC'
        ORDER BY c.effective_from DESC
        LIMIT 1) cfg ON true
  -- any earlier reading at all: what separates "inspect again" from "drive
  -- further", which is the difference between the first two BR-ANL-004 cases
  LEFT JOIN LATERAL (
       SELECT ro.odometer
         FROM app.v_tyre_reading_odometer ro
        WHERE ro.tyre_id = ft.tyre_id
          AND ro.submitted_at < lr.submitted_at
        ORDER BY ro.submitted_at DESC
        LIMIT 1) prev ON true
  LEFT JOIN LATERAL (
       SELECT ro.governing_tread_mm, ro.submitted_at, ro.odometer
         FROM app.v_tyre_reading_odometer ro
        WHERE ro.tyre_id = ft.tyre_id
          AND ro.submitted_at < lr.submitted_at
          AND ro.odometer <= lr.odometer - cfg.min_km
        ORDER BY ro.submitted_at DESC
        LIMIT 1) er ON true
  -- BR-ANL-004: a tyre fitted or removed inside the window was on a different
  -- position for part of it, so the two depths are not one wear history.
  CROSS JOIN LATERAL (
       SELECT EXISTS (SELECT 1 FROM app.fitment f
                       WHERE f.tyre_id = ft.tyre_id
                         AND ((f.fitted_at  > er.submitted_at AND f.fitted_at  <= lr.submitted_at)
                           OR (f.removed_at > er.submitted_at AND f.removed_at <= lr.submitted_at)))
         AS moved) fit;

-- FR-ANL-004/005 over BR-ANL-002. The threshold is resolved from each row's
-- OWN tenant rather than from the session, matching tyre_valuation_asof: the
-- two then read one configuration key and a policy change moves the valuation
-- and the forecast together or neither. Resolving it once per query would be
-- correct under RLS — every visible row is the session tenant's — and wrong
-- the moment anything reads this view unbound, which is exactly what a
-- SECURITY DEFINER routine does (TYRE-33 has one).
--
-- The 90-day mean daily distance is anchored to the tyre's own latest reading
-- rather than to now(): a projection that shifts because the suite ran on a
-- different day is not reproducible, and BR-ANL-002's window is a property of
-- the measurement, not of when someone looks at it. It is resolved from the
-- readings, never from inspection.vehicle_id — a combination inspection
-- carries the motive unit there, so resolving that way loses every towed unit
-- (FR-INS-061).
CREATE VIEW app.v_removal_forecast WITH (security_invoker = true) AS
SELECT wr.tenant_id,
       wr.tyre_id,
       wr.branded_number,
       wr.vehicle_id,
       wr.fleet_number,
       wr.depot_name,
       wr.position_code,
       wr.is_spare,
       wr.later_tread_mm AS current_tread_mm,
       wr.later_read_at,
       thr.mm AS removal_threshold_mm,
       wr.wear_rate_mm_per_1000km,
       wr.wear_rate_status,
       dd.mean_daily_km,
       proj.remaining_km AS projected_remaining_km,
       -- FR-ANL-005. Every projection floors, so a tyre reaches the threshold
       -- no later than the figure given: a forecast that runs late is worth
       -- less than one that runs early, and the three columns agree with each
       -- other only if they round the same way.
       --
       -- Zero remaining distance is zero days at any speed, which is what
       -- keeps a tyre already past the threshold in the horizon list on a
       -- fleet whose distance history cannot be derived yet — the first day
       -- of any rollout, when no vehicle has a second capture. NULLIF guards
       -- the parked-vehicle case: two captures at the same odometer make the
       -- mean zero, and 0/0 raises rather than returning NULL.
       CASE WHEN proj.remaining_km = 0 THEN 0
            ELSE floor(proj.remaining_km / NULLIF(dd.mean_daily_km, 0))::int
       END AS projected_remaining_days,
       ((wr.later_read_at AT TIME ZONE 'UTC')::date
        + CASE WHEN proj.remaining_km = 0 THEN 0
               ELSE floor(proj.remaining_km / NULLIF(dd.mean_daily_km, 0))::int
          END) AS projected_removal_date,
       (wr.later_odometer + proj.remaining_km)::bigint AS projected_removal_odometer,
       CASE WHEN thr.mm IS NULL                     THEN 'NO_THRESHOLD_POLICY'
            WHEN wr.later_tread_mm IS NULL          THEN wr.wear_rate_status
            WHEN wr.later_tread_mm <= thr.mm        THEN 'AT_OR_BELOW_THRESHOLD'
            WHEN wr.wear_rate_mm_per_1000km IS NULL THEN wr.wear_rate_status
            WHEN wr.wear_rate_mm_per_1000km <= 0    THEN 'NO_MEASURABLE_WEAR'
            ELSE 'FORECAST' END AS forecast_status
  FROM app.v_tyre_wear_rate wr
  CROSS JOIN LATERAL (SELECT app.removal_threshold_mm_for(wr.tenant_id, now()) AS mm) thr
  LEFT JOIN LATERAL (
       SELECT round((max(x.odometer) - min(x.odometer))::numeric
                  / NULLIF((max(x.submitted_at) AT TIME ZONE 'UTC')::date
                         - (min(x.submitted_at) AT TIME ZONE 'UTC')::date, 0), 2)
                AS mean_daily_km
         FROM (SELECT DISTINCT i.id, i.odometer, i.submitted_at
                 FROM app.reading r
                 JOIN app.inspection i ON i.id = r.inspection_id
                WHERE r.vehicle_id = wr.vehicle_id
                  AND i.state <> 'VOIDED'
                  AND i.submitted_at <= wr.later_read_at
                  AND i.submitted_at > wr.later_read_at - interval '90 days') x) dd ON true
  -- A tyre already at or below the threshold reached it no later than its last
  -- reading: zero remaining, not a negative projection and not a NULL. It has
  -- to appear in every horizon a manager asks for, and that is the one place
  -- an omission does damage.
  CROSS JOIN LATERAL (
       SELECT CASE WHEN thr.mm IS NULL OR wr.later_tread_mm IS NULL THEN NULL
                   WHEN wr.later_tread_mm <= thr.mm THEN 0::numeric
                   WHEN wr.wear_rate_mm_per_1000km > 0
                   THEN floor((wr.later_tread_mm - thr.mm) / wr.wear_rate_mm_per_1000km * 1000)
              END AS remaining_km) proj;

-- FR-ANL-007, the data layer for FR-RPT-028. The from-date is explicit rather
-- than now(), matching app.tyre_valuation_asof(): a report generated as at a
-- date has to be reproducible on any later day.
CREATE FUNCTION app.removal_forecast_within(p_from date, p_horizon_days int)
RETURNS SETOF app.v_removal_forecast
LANGUAGE sql STABLE AS $$
  SELECT * FROM app.v_removal_forecast
   WHERE projected_removal_date IS NOT NULL
     AND projected_removal_date <= p_from + p_horizon_days
$$;
