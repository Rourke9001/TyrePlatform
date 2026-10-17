import json
from seed_policy import (
    RETREAD_THRESHOLD_MM,
    WARNING_THRESHOLD_MM,
    MAX_RETREADS,
    CLASS_THRESHOLDS,
    TARGET_KPA,
    PRESSURE_TOLERANCE_PCT,
    CONFIG_DEFAULTS,
)
from tenant_library import library_lines

TENANTS = [
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    "33333333-3333-3333-3333-333333333333",
]


def baseline_lines(tid):
    L = []
    L.append(f"SET LOCAL app.tenant_id = '{tid}';")
    L.append("-- policy values (CR-005: never hard-coded). effective_from is a fixed")
    L.append(
        "-- backdate, not load time: as-at valuation (FR-VAL-020/021) resolves the"
    )
    L.append("-- policy effective at the requested date, so policy must predate every")
    L.append(
        "-- seeded reading or historical dates would value as 'no policy configured'."
    )
    for k, v in CONFIG_DEFAULTS:
        L.append(
            f"INSERT INTO app.configuration (tenant_id,key,value,effective_from) VALUES ('{tid}','{k}','{json.dumps(v)}'::jsonb,'2024-01-01T00:00:00Z');"
        )
    L.append("")
    L.append("-- CHG-111: threshold_policy is the one threshold source; no")
    L.append("-- removal_threshold_mm / warning_threshold_mm config key may exist.")
    L.append(
        "-- The 4.0mm pull point and the cap are cited from seed_policy.py (CFL-012)."
    )
    L.append("-- A tenant's FIRST policy rows carry the sentinel -infinity (SRS §5.1,")
    L.append(
        "-- errata E1): the baseline asserts no date before which it did not apply,"
    )
    L.append("-- so as-at valuation for any historical date, including the 2021 survey")
    L.append("-- rows, resolves to it rather than to 'no policy configured'. This is")
    L.append("-- the baseline FR-CFG-051 applies prospectively from, not a retroactive")
    L.append(
        "-- change under it. Every deliberate change thereafter is a new dated row."
    )
    L.append(
        "INSERT INTO app.threshold_policy (id,tenant_id,retread_threshold_mm,warning_threshold_mm,max_retreads,effective_from)"
    )
    L.append(
        f"  VALUES (md5('{tid}thrpol-default')::uuid,'{tid}',{RETREAD_THRESHOLD_MM},{WARNING_THRESHOLD_MM},{MAX_RETREADS},'-infinity');"
    )
    L.append(
        "-- CHG-038: retreads are not fitted to steer axles. Fleet practice, not a"
    )
    L.append(
        "-- legal claim (CHG-107 tracks the sign-off question). A seeded row, so the"
    )
    L.append("-- rule is data the resolver can reach, not a comment. Part of the same")
    L.append("-- baseline as the default row, so it carries the same sentinel.")
    steer_permitted = str(CLASS_THRESHOLDS["STEER"]["retreads_permitted"]).lower()
    L.append(
        "INSERT INTO app.threshold_policy (id,tenant_id,axle_class,retread_threshold_mm,warning_threshold_mm,max_retreads,retreads_permitted,effective_from)"
    )
    L.append(
        f"  VALUES (md5('{tid}thrpol-steer')::uuid,'{tid}','STEER',{RETREAD_THRESHOLD_MM},{WARNING_THRESHOLD_MM},{MAX_RETREADS},{steer_permitted},'-infinity');"
    )
    L.append("")
    L.append(
        "-- CHG-112/CHG-034: target_pressure is the one pressure-target source; no"
    )
    L.append("-- target_pressure_kpa / inflation_bands / pressure_deviation_margin_pct")
    L.append("-- config key may exist. The warn/critical tolerances (10/20% each side)")
    L.append("-- place the FR-CFG-016 band edges at 80/90/110/120% of target. No SPARE")
    L.append("-- row on purpose (FR-CFG-013, errata E1): a spare's pressure is")
    L.append(
        "-- unclassifiable, never silently compliant. TAG does carry a row: unlike"
    )
    L.append(
        "-- a spare it is a running road-contact position, and without a target its"
    )
    L.append(
        "-- readings would be unclassifiable and FR-INS-031a's capture-time warning"
    )
    L.append(
        "-- silently disabled, latent until the first tag-axle trailer, then live."
    )
    pcts = ",".join(f"{v}" for v in PRESSURE_TOLERANCE_PCT.values())
    for cls, kpa in TARGET_KPA.items():
        L.append(
            "INSERT INTO app.target_pressure (id,tenant_id,axle_class,target_kpa,warn_under_pct,critical_under_pct,warn_over_pct,critical_over_pct,effective_from)"
        )
        L.append(
            f"  VALUES (md5('{tid}tgtp-{cls}')::uuid,'{tid}','{cls}',{kpa},{pcts},'2024-01-01T00:00:00Z');"
        )
    L.append("")
    L.extend(library_lines(tid))
    return L


def main():
    L = [
        "-- Seed: axle configuration library (unit types per CHG-070..073) + policy seeds",
        "-- Generated from the same model as the spec reference; do not hand-edit.",
        "SET search_path = app, public;",
        "",
    ]
    L.append("-- Three tenants. Isolation must hold at n=2 (SRS Appendix H); the third")
    L.append("-- carries no acceptance data and exists so exploratory test data has a")
    L.append(
        "-- home that is not the pilot tenant. BAC's rows reproduce Appendix E and"
    )
    L.append("-- Appendix J to the cent, so anything typed into BAC during the POC has")
    L.append("-- to be found and unpicked before go-live. The sandbox is that cleanup")
    L.append("-- avoided rather than deferred.")
    L.append("-- D12: BAC and Sandbox run the platform-issued mark (the pilot's stated")
    L.append(
        "-- posture); Second Fleet stays FREE so the isolation control also proves"
    )
    L.append("-- the FREE branch, not only GENERATED.")
    L.append(
        "INSERT INTO app.tenant (id,name,subdomain,state,display_code_policy) VALUES"
    )
    L.append(
        "  ('11111111-1111-1111-1111-111111111111','BAC Transport','bac','ACTIVE','GENERATED'),"
    )
    L.append(
        "  ('22222222-2222-2222-2222-222222222222','Second Fleet (isolation control)','other','ACTIVE','FREE'),"
    )
    L.append(
        "  ('33333333-3333-3333-3333-333333333333','Sandbox Fleet','sandbox','ACTIVE','GENERATED');"
    )
    L.append("")
    L.append(
        "-- Counters exist only for GENERATED tenants; a FREE tenant never mints one."
    )
    L.append("INSERT INTO app.display_code_counter (tenant_id,prefix) VALUES")
    L.append("  ('11111111-1111-1111-1111-111111111111','BAC'),")
    L.append("  ('33333333-3333-3333-3333-333333333333','SBX');")
    L.append("")
    for tid in TENANTS:
        L.extend(baseline_lines(tid))
    open("002_seed_configurations.sql", "w").write("\n".join(L) + "\n")
    print("seed written")


if __name__ == "__main__":
    main()
