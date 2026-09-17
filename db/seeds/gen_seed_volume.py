# Seed: a volume tenant for the dashboard read-path measurement (TYRE-247,
# B7 spec section B7.1.5). Sandbox Fleet only: BAC's rows are the acceptance
# fixture and Second Fleet is the isolation control, and neither may move.
# Test data, not a condition assessment of any vehicle. Loaded by
# `make db-volume` alone; `make db-reset` never reads this file, so the
# verification suite stays defined on the pinned fixture.
#
# Deterministic on purpose: the anchor date is fixed, every id is the md5 of
# a stable key, and every drawn number comes from random.Random(247), so the
# file is the same bytes on every run and CI hashes it beside the other two.
#
# The estate is simulated first and emitted second. A replaced tyre's fitment
# is inserted already closed, so the load never takes the UPDATE path that
# fitment_written_once (000032) bounds, and every inspection is written in
# the same transaction as its readings, which is what reading_sealed (000040,
# TY020) requires.
import datetime as dt
import random
from seed_policy import RETREAD_THRESHOLD_MM, TARGET_KPA

T3 = "33333333-3333-3333-3333-333333333333"
DRIVER = "md5('sbdriver1')::uuid"
DEPOT = "md5('sbdepot1')::uuid"
RIGS = 20
FORTNIGHTS = 52
END = dt.date(2026, 9, 1)
NEW_TREAD_MM = 25.0
KM_PER_FORTNIGHT = 2500
POSITIONS = ['OUTER', 'CENTRE', 'INNER']
# CHG-010, 22 Aug 2026, is the date outer/centre/inner became the stated
# convention. This estate's history runs back 24 months, so a capture is
# orientation_known only from that date (CHG-011): the anatomy is written to
# position either way, and an earlier row counts toward min and average tread
# while staying out of directional wear diagnosis. The final fortnight is the
# only one after it, and it is the capture every latest-per-unit read
# resolves to, so the directional path has rows where the dashboard looks.
CONVENTION_FROM = dt.date(2026, 8, 22)
# Own position codes per unit type, with the axle class the library gives
# them (gen_seed_configurations.build): HORSE_6X4 is steer 1 and 2, drive 3
# to 10; TRAILER_2AXLE is trailer 1 to 8; 'S' is the default spare (CHG-031).
HORSE = [(str(i), 'STEER' if i <= 2 else 'DRIVE') for i in range(1, 11)] + [('S', 'SPARE')]
TRAILER = [(str(i), 'TRAILER') for i in range(1, 9)] + [('S', 'SPARE')]
# mm per fortnight, drawn per position inside these bands. Rates are test
# data; the depth that ends a fitment is the seeded policy value imported
# above, so a tenant whose policy moves gets an estate that moves with it.
WEAR = {'STEER': (0.15, 0.30), 'DRIVE': (0.25, 0.50), 'TRAILER': (0.20, 0.40), 'SPARE': (0.0, 0.02)}
# Groove offsets above the governing depth (outer, centre, inner). The 4mm
# entry crosses width_spread_warn_mm so FR-EXC-035 has rows to find. Every
# tuple holds a zero, so the governing depth stays the MIN (CR-011).
OFFSETS = [(0, 0, 0), (1, 0, 0), (0, 0, 1), (1, 1, 0), (2, 0, 0), (0, 0, 2), (4, 0, 0)]
OFFSET_WEIGHTS = [40, 15, 15, 10, 8, 8, 4]
UNDER_INFLATED_SHARE = 0.04

rng = random.Random(247)


def ts(d, hh, mm):
    return f"{d.isoformat()}T{hh:02}:{mm:02}:00Z"


def n1(x):
    return f"{x:.1f}"


def sqlnull(x):
    return 'NULL' if x is None else str(x)


units = []  # (key, rig, sequence, fleet_number, registration, configuration code, unit_kind, positions)
for r in range(1, RIGS + 1):
    units.append((f"sbvol-h{r}", r, 1, f"SBX-H{r:02}", f"SBXH{r:02}GP", 'HORSE_6X4', 'HORSE', HORSE))
    units.append((f"sbvol-t{r}a", r, 2, f"SBX-T{2*r-1:02}", f"SBXT{2*r-1:02}GP", 'TRAILER_2AXLE', 'TRAILER', TRAILER))
    units.append((f"sbvol-t{r}b", r, 3, f"SBX-T{2*r:02}", f"SBXT{2*r:02}GP", 'TRAILER_2AXLE', 'TRAILER', TRAILER))

dates = [END - dt.timedelta(days=14 * (FORTNIGHTS - 1 - k)) for k in range(FORTNIGHTS)]
FIRST_FIT = dates[0] - dt.timedelta(days=1)

odo = {u[0]: 100000 + u[1] * 1000 for u in units if u[6] == 'HORSE'}
tyres = []
fitments = []
inspections = []
state = {}
serial = 0


# The start fitments sit at 06:00 the day before the first inspection. A
# replacement closes at 06:00 on the inspection day, after the 05:45 reading
# that found the depth, and the fresh tyre is fitted at 07:00, so no as-at
# join ever sees two tyres on one position (BR-VEH-003, FR-FIT-016).
def new_tyre(unit, code, fitted_on, fitted_hh, fitted_odo, fitted_mm):
    global serial
    serial += 1
    key = f"sbvol-ty{serial}"
    t = dict(key=key, removed=False,
             price=rng.choice(['4319.91', '3899.00', '4650.50']),
             casing=rng.choice(['1500.00', '1837.50', '2100.00']),
             purchased=(fitted_on - dt.timedelta(days=15)).isoformat())
    tyres.append(t)
    f = dict(tyre=t, unit=unit, code=code, fitted=fitted_on, fitted_hh=fitted_hh, fitted_odo=fitted_odo,
             fitted_mm=fitted_mm, removed=None, removed_odo=None, removed_mm=None)
    fitments.append(f)
    return key, f


for ukey, r, seq, fleet, reg, cfg, kind, codes in units:
    for code, cls in codes:
        lo, hi = WEAR[cls]
        start = float(rng.randint(12, 25))
        key, f = new_tyre(ukey, code, FIRST_FIT, 6, odo.get(ukey), start)
        state[(ukey, code)] = dict(cls=cls, mm=start, rate=rng.uniform(lo, hi),
                                   offs=rng.choices(OFFSETS, weights=OFFSET_WEIGHTS)[0], tyre=key, fit=f)

for k, d in enumerate(dates):
    for r in range(1, RIGS + 1):
        horse = f"sbvol-h{r}"
        if k > 0:
            odo[horse] += KM_PER_FORTNIGHT
        rows = []
        for ukey, rr, seq, fleet, reg, cfg, kind, codes in units:
            if rr != r:
                continue
            for code, cls in codes:
                s = state[(ukey, code)]
                if k > 0:
                    s['mm'] = max(0.0, s['mm'] - s['rate'])
                gov = round(s['mm'])
                # The offset opens only as the tyre wears: a groove is never
                # deeper than the tyre was new, so on a freshly fitted tyre it
                # clips to nothing and reaches its full width once the tyre has
                # worn that far. Nothing in the schema catches the alternative,
                # since tread_mm's CHECK is 0 to 35 (000001, DR-007).
                mm = [min(gov + o, NEW_TREAD_MM) for o in s['offs']]
                target = TARGET_KPA.get(cls, TARGET_KPA['TRAILER'])
                if rng.random() < UNDER_INFLATED_SHARE:
                    kpa = int(target * (1 - rng.uniform(0.12, 0.25)))
                else:
                    kpa = int(target + rng.gauss(0, 15))
                rows.append((ukey, code, s['tyre'], kpa, mm))
                if cls != 'SPARE' and gov <= RETREAD_THRESHOLD_MM:
                    this_odo = odo[horse] if kind == 'HORSE' else None
                    s['fit'].update(removed=d, removed_odo=this_odo, removed_mm=float(gov))
                    s['fit']['tyre']['removed'] = True
                    lo, hi = WEAR[cls]
                    key, f = new_tyre(ukey, code, d, 7, this_odo, NEW_TREAD_MM)
                    s.update(mm=NEW_TREAD_MM, rate=rng.uniform(lo, hi), tyre=key, fit=f)
        inspections.append((r, k, d, odo[horse], rows))

L = ["-- Seed: volume tenant for the dashboard read-path measurement (TYRE-247).",
     "-- Sandbox Fleet only. Test data, not a condition assessment of any vehicle.",
     "-- Generated by gen_seed_volume.py; loaded by `make db-volume`, never by db-reset.",
     "SET search_path = app, public;",
     f"SET app.tenant_id = '{T3}';",
     "BEGIN;", ""]
# tyre_size, tyre_brand and tyre_pattern are tenant-scoped (000001), so the
# volume tenant carries its own rows rather than borrowing BAC's.
L.append(f"INSERT INTO app.tyre_size (id,tenant_id,name,construction) VALUES (md5('sbvol-sz1')::uuid,'{T3}','315/80R22.5','RADIAL');")
L.append(f"INSERT INTO app.tyre_brand (id,tenant_id,name) VALUES (md5('sbvol-br1')::uuid,'{T3}','Sandbox Brand');")
L.append(f"INSERT INTO app.tyre_pattern (id,tenant_id,name,brand_id) VALUES (md5('sbvol-pt1')::uuid,'{T3}','SBX1',md5('sbvol-br1')::uuid);")
L.append("")
L.append("-- Trailers carry no odometer (CFL-003): current_odometer and every")
L.append("-- fitment odometer on them is NULL, as the fixture's link trailers are.")
for ukey, r, seq, fleet, reg, cfg, kind, codes in units:
    cur = odo[ukey] if kind == 'HORSE' else None
    L.append("INSERT INTO app.vehicle (id,tenant_id,fleet_number,registration,configuration_id,unit_kind,body_type,home_depot_id,current_odometer,status)")
    L.append(f"  VALUES (md5('{ukey}')::uuid,'{T3}','{fleet}','{reg}',md5('{T3}{cfg}')::uuid,'{kind}','Flat deck',{DEPOT},{sqlnull(cur)},'ACTIVE');")
L.append("")
for r in range(1, RIGS + 1):
    L.append(f"INSERT INTO app.combination (id,tenant_id,motive_vehicle_id,effective_from) VALUES (md5('sbvol-comb{r}')::uuid,'{T3}',md5('sbvol-h{r}')::uuid,'{ts(FIRST_FIT, 6, 0)}');")
    for ukey, rr, seq, fleet, reg, cfg, kind, codes in units:
        if rr == r:
            label = 'Horse' if seq == 1 else ('Link A' if seq == 2 else 'Link B')
            L.append(f"INSERT INTO app.combination_member (tenant_id,combination_id,vehicle_id,sequence,descriptor) VALUES ('{T3}',md5('sbvol-comb{r}')::uuid,md5('{ukey}')::uuid,{seq},'{label}');")
L.append("")
L.append("-- Position ids are generated at library load, so readings and fitments")
L.append("-- resolve them through this map by unit and own code (BR-VEH-003).")
L.append("CREATE TEMP TABLE sbvol_pos ON COMMIT DROP AS")
L.append("  SELECT v.id AS vehicle_id, p.code, p.id AS position_id")
L.append("    FROM app.vehicle v JOIN app.position p ON p.configuration_id = v.configuration_id")
L.append(f"   WHERE v.tenant_id = '{T3}' AND v.fleet_number LIKE 'SBX-%';")
L.append("")
L.append("-- rand_per_mm is derived by app.rand_per_mm from price, new tread and the")
L.append("-- seeded threshold (BR-VAL-002): the file states inputs, never the answer.")
for t in tyres:
    state_ = 'REMOVED' if t['removed'] else 'FITTED'
    L.append(f"INSERT INTO app.tyre (id,tenant_id,display_code,size_id,brand_id,pattern_id,status,purchase_date,received_date,purchase_price,cost_source,new_tread_mm,rand_per_mm,casing_value,state)")
    L.append(f"  VALUES (md5('{t['key']}')::uuid,'{T3}','{t['key'].upper()}',md5('sbvol-sz1')::uuid,md5('sbvol-br1')::uuid,md5('sbvol-pt1')::uuid,'NEW','{t['purchased']}','{t['purchased']}',{t['price']},'INVOICE',{n1(NEW_TREAD_MM)},app.rand_per_mm({t['price']},{n1(NEW_TREAD_MM)},{n1(RETREAD_THRESHOLD_MM)}),{t['casing']},'{state_}');")
L.append("")
L.append("-- A replaced tyre's fitment is inserted closed (removed_at, removed tread,")
L.append("-- reason from the tenant's removal_reasons list; removed_odometer on a")
L.append("-- horse), and its tyre row above already carries REMOVED: the load holds")
L.append("-- no UPDATE at all. fitment_written_once (000032) bounds the UPDATE path;")
L.append("-- a row written whole never takes it.")
for f in fitments:
    tkey = f['tyre']['key']
    fitted_at = ts(f['fitted'], f['fitted_hh'], 0)
    if f['removed'] is None:
        L.append("INSERT INTO app.fitment (tenant_id,tyre_id,vehicle_id,position_id,fitted_at,fitted_odometer,fitted_tread_mm)")
        L.append(f"  SELECT '{T3}',md5('{tkey}')::uuid,md5('{f['unit']}')::uuid,p.position_id,'{fitted_at}',{sqlnull(f['fitted_odo'])},{n1(f['fitted_mm'])}")
    else:
        removed_at = ts(f['removed'], 6, 0)
        L.append("INSERT INTO app.fitment (tenant_id,tyre_id,vehicle_id,position_id,fitted_at,fitted_odometer,fitted_tread_mm,removed_at,removed_odometer,removed_tread_mm,removal_reason)")
        L.append(f"  SELECT '{T3}',md5('{tkey}')::uuid,md5('{f['unit']}')::uuid,p.position_id,'{fitted_at}',{sqlnull(f['fitted_odo'])},{n1(f['fitted_mm'])},'{removed_at}',{sqlnull(f['removed_odo'])},{n1(f['removed_mm'])},'worn_to_threshold'")
    L.append(f"    FROM sbvol_pos p WHERE p.vehicle_id = md5('{f['unit']}')::uuid AND p.code = '{f['code']}';")
L.append("")
L.append("-- Each reading's lowest measurement is emitted first: reading_measurement_governs")
L.append("-- (000001) recomputes MIN per row and reading_snapshots_governing_change (000006)")
L.append("-- reconciles a snapshot per change, so the load order, not the data, keeps that")
L.append("-- to one reconcile per reading. The ordinal check (000046) runs once per statement.")
for r, k, d, horse_odo, rows in inspections:
    ikey = f"sbvol-insp{r}-{k}"
    L.append("INSERT INTO app.inspection (id,tenant_id,vehicle_id,combination_id,user_id,client_uuid,started_at,submitted_at,odometer,device_id,app_version,duration_seconds)")
    L.append(f"  VALUES (md5('{ikey}')::uuid,'{T3}',md5('sbvol-h{r}')::uuid,md5('sbvol-comb{r}')::uuid,{DRIVER},md5('sbvol-cli{r}-{k}')::uuid,'{ts(d, 5, 38)}','{ts(d, 5, 45)}',{horse_odo},'seed-volume','0.0.0-volume',420);")
    vals = []
    for seq_i, (ukey, code, tyre, kpa, mm) in enumerate(rows):
        vals.append(f"(md5('sbvol-rd{r}-{k}-{ukey}-{code}')::uuid,md5('{ukey}')::uuid,'{code}',md5('{tyre}')::uuid,{kpa})")
    L.append("INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)")
    L.append(f"  SELECT x.id,'{T3}',md5('{ikey}')::uuid,x.vehicle_id,p.position_id,x.tyre_id,x.kpa")
    L.append("    FROM (VALUES " + ",".join(vals) + ") AS x(id,vehicle_id,code,tyre_id,kpa)")
    L.append("    JOIN sbvol_pos p ON p.vehicle_id = x.vehicle_id AND p.code = x.code;")
    mvals = []
    known = 'true' if d >= CONVENTION_FROM else 'false'
    for ukey, code, tyre, kpa, mm in rows:
        rd = f"md5('sbvol-rd{r}-{k}-{ukey}-{code}')::uuid"
        for i in sorted(range(3), key=lambda i: (mm[i], i)):
            mvals.append(f"('{T3}',{rd},{i+1},'{POSITIONS[i]}',{n1(mm[i])},{known},1.0)")
    L.append("INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known,granularity_mm) VALUES")
    L.append("  " + ",\n  ".join(mvals) + ";")
L.append("")
L.append("COMMIT;")
open('006_seed_volume.sql', 'w').write("\n".join(L) + "\n")
print(f"volume written: {len(units)} units, {len(tyres)} tyres, {len(fitments)} fitments, {len(inspections)} inspections")
