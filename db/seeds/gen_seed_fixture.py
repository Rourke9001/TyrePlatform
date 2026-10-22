import json
from dataclasses import dataclass

from seed_policy import RETREAD_THRESHOLD_MM

R = {
    1: (800, [13, 13, 14]),
    2: (800, [15, 14, 14]),
    3: (750, [14, 12, 15]),
    4: (750, [14, 12, 14]),
    5: (750, [15, 11, 15]),
    6: (700, [17, 11, 16]),
    7: (750, [6, 1, 6]),
    8: (750, [5, 1, 6]),
    9: (750, [9, 6, 8]),
    10: (750, [7, 7, 8]),
    11: (750, [6, 4, 4]),
    12: (750, [6, 5, 4]),
    13: (700, [6, 6, 4]),
    14: (750, [5, 6, 5]),
    15: (750, [7, 7, 6]),
    16: (200, [7, 4, 5]),
    17: (750, [8, 7, 8]),
    18: (750, [0, 5, 8]),
    19: (700, [9, 8, 8]),
    20: (750, [8, 7, 8]),
    21: (750, [3, 3, 3]),
    22: (750, [4, 3, 4]),
    23: (750, [12, 12, 12]),
    24: (700, [11, 10, 10]),
    25: (750, [14, 13, 14]),
    26: (750, [14, 14, 14]),
}
SPARE = (700, [6, 2, 6])
# Tread at the earlier capture is this sheet's plus a per-position delta
# (TYRE-35). One sheet cannot yield a wear rate: BR-ANL-001 needs a pair of
# readings and FR-ANL-002 needs them a configured distance apart. The deltas
# differ across positions so that a rate cannot pass a test by being a
# constant: over 10,000km, +0.5/+1.0/+2.0mm are 0.05/0.10/0.20 mm per
# 1000km.
PRIOR_DELTA = {1: 0.5, 9: 2.0, 15: 1.5}
PRIOR_DEFAULT = 1.0
T = "11111111-1111-1111-1111-111111111111"
T2 = "22222222-2222-2222-2222-222222222222"
T3 = "33333333-3333-3333-3333-333333333333"
# CHG-010 / CFL-007: canonical tread positions by ordinal, relative to the
# vehicle centreline. The 2021-style sheet recorded three boxes with no stated
# convention (OI-28), so every fixture measurement loads orientation_known =
# FALSE (CHG-011): it counts toward min/average tread but is excluded from any
# directional wear-pattern diagnosis. Whole-millimetre sheet => granularity 1.0
# (CHG-012).
POSITIONS = ["OUTER", "CENTRE", "INNER"]


# sheet position 1..26 -> (member unit, that unit's own position code).
# The sheet numbering is a display projection of the 2026-07-23 composition
# (CFL-006); it is not stored anywhere in the schema.
def member(p):
    if p <= 10:
        return (1, str(p))
    if p <= 18:
        return (2, str(p - 10))
    return (3, str(p - 18))


UNIT = {
    1: ("HORSE", "HORSE_6X4", "HORSE", "Horse"),
    2: ("LINK6", "TRAILER_2AXLE", "TRAILER", "6m link"),
    3: ("LINK12", "TRAILER_2AXLE", "TRAILER", "12m link"),
}


# The strings in the fixture's BAC tenant that name BAC, its vehicles or the
# real sheet the readings were copied from. The demonstration tenant swaps
# them and keeps every number (U92, OR-TRN-003).
@dataclass(frozen=True)
class FixtureNames:
    branding: dict | None
    registrations: dict[int, str]
    code_fleet: str
    comment: str
    defect_report: str
    driver_subject: bool


# Branding is tenant configuration like any threshold (rule 5, FR-TEN-011);
# the three values differ visibly so a cross-tenant leak shows up on sight
# (TYRE-26). logoUrl stays null: staging blob storage is private, so a logo
# URL cannot render until serving arrives with RBAC.
#
# #E2202A is BAC's real brand red (--accent in the BAC Transport site's
# design system), used for the testing phase. A red brand is also the live
# proof of the theming rule: chrome goes brand red while the below-removal
# status red stays its own fixed colour.
FIXTURE = FixtureNames(
    branding={
        "displayName": "BAC Transport",
        "primaryColor": "#E2202A",
        "logoUrl": None,
    },
    registrations={1: "BAC039SP", 2: "BAC040SP", 3: "BAC041SP"},
    code_fleet="BAC",
    comment="7/8 are needed to be replaced. 21/22 are almost finished. 18 need its smooth one side. Trailers need to be checked, bushies and alignment.",
    defect_report="Trailers are leaking water when raining.",
    driver_subject=True,
)
OTHER_BRANDING = {
    T2: {
        "displayName": "Second Fleet",
        "primaryColor": "#7A2E8D",
        "logoUrl": None,
    },
    T3: {
        "displayName": "Sandbox Fleet",
        "primaryColor": "#1F7A5A",
        "logoUrl": None,
    },
}


def measurements(rd_key, values, delta=0.0):
    vals = ",".join(
        f"('{T}',md5('{rd_key}')::uuid,{i + 1},'{POSITIONS[i]}',{(v + delta):.1f},false,1.0)"
        for i, v in enumerate(values)
    )
    return f"INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known,granularity_mm) VALUES {vals};"


# The fixture's rows for tenant 1, and with others the Second Fleet and
# Sandbox rows the isolation sweep and the write surfaces need.
def fixture_body(names, others):
    L = []
    branding = {}
    if names.branding is not None:
        branding[T] = names.branding
    if others:
        branding.update(OTHER_BRANDING)
    for btid, bval in branding.items():
        L.append(
            f"INSERT INTO app.configuration (tenant_id,key,value) VALUES ('{btid}','branding','{json.dumps(bval)}'::jsonb);"
        )
    L.append("")
    L.append(
        "INSERT INTO app.depot (id,tenant_id,name,type) VALUES (md5('depot1')::uuid,'%s','Johannesburg','DEPOT');"
        % T
    )
    # driver1 and driver2 carry a sign-in subject so suite section 68 can prove
    # a subject resolves only in its own tenant (TYRE-317).
    subject = "md5('subject-driver1')::uuid" if names.driver_subject else "NULL"
    L.append(
        "INSERT INTO app.app_user (id,tenant_id,email,display_name,staff_number,role,subject) VALUES"
    )
    L.append(
        "  (md5('driver1')::uuid,'%s','melusi@example.invalid','Melusi','EMP-0001','DRIVER',%s);"
        % (T, subject)
    )
    L.append(
        "INSERT INTO app.user_depot (tenant_id,user_id,depot_id) VALUES ('%s',md5('driver1')::uuid,md5('depot1')::uuid);"
        % T
    )
    L.append("-- Sipho deliberately has no user_depot row: the verification suite pins")
    L.append(
        "-- the depot-scoping count, and nothing about assignment needs depot scope."
    )
    L.append(
        "INSERT INTO app.app_user (id,tenant_id,email,display_name,staff_number,role) VALUES"
    )
    L.append(
        "  (md5('driver3')::uuid,'%s','sipho@example.invalid','Sipho','EMP-0002','DRIVER');"
        % T
    )
    # A CONTROLLER and an ORG_ADMIN so the management surfaces have someone to
    # be in development. Neither gets a user_depot row: their scope is the
    # whole tenant (FR-AUT-007/009), and the suite pins tenant 1 at exactly one
    # depot-scoped user.
    L.append(
        "INSERT INTO app.app_user (id,tenant_id,email,display_name,staff_number,role) VALUES"
    )
    L.append(
        "  (md5('controller1')::uuid,'%s','nomsa@example.invalid','Nomsa','EMP-0003','CONTROLLER'),"
        % T
    )
    L.append(
        "  (md5('admin1')::uuid,'%s','pieter@example.invalid','Pieter','EMP-0004','ORG_ADMIN');"
        % T
    )
    L.append("")
    if others:
        # The second tenant gets a depot-scoped user too, so the cross-tenant
        # sweep in the verification suite has real foreign user_depot rows to
        # prove invisible. With none, that isolation check would pass
        # vacuously.
        L.append(
            "INSERT INTO app.depot (id,tenant_id,name,type) VALUES (md5('depot2')::uuid,'%s','Cape Town','DEPOT');"
            % T2
        )
        L.append(
            "INSERT INTO app.app_user (id,tenant_id,email,display_name,staff_number,role,subject) VALUES"
        )
        L.append(
            "  (md5('driver2')::uuid,'%s','thabo@example.invalid','Thabo','EMP-2001','DRIVER',md5('subject-driver2')::uuid);"
            % T2
        )
        L.append(
            "INSERT INTO app.user_depot (tenant_id,user_id,depot_id) VALUES ('%s',md5('driver2')::uuid,md5('depot2')::uuid);"
            % T2
        )
        L.append("")
        # Deliberately carries NO tyres, fitments or readings: nothing here may
        # be reachable by an Appendix E or Appendix J assertion, and an empty
        # estate is the cheapest guarantee of that. What it does carry is the
        # minimum an operator needs to be present in the app at all: a depot,
        # one user per role, and two units on the shared configuration library.
        # The write surfaces have a tenant to be exercised against as they land
        # (TYRE-3, TYRE-55). Its fleet numbers repeat tenant 1's on purpose:
        # fleet numbers are unique per tenant, never globally (DR-003), and a
        # sandbox that quietly used distinct ones would hide a regression in
        # that constraint rather than expose it.
        L.append(
            "INSERT INTO app.depot (id,tenant_id,name,type) VALUES (md5('sbdepot1')::uuid,'%s','Sandbox Depot','DEPOT');"
            % T3
        )
        # Dispatch (TYRE-92) needs a destination of each kind, and nothing
        # creates a depot through the API yet. Sandbox only, because BAC's rows
        # are the fixture.
        L.append(
            "INSERT INTO app.depot (id,tenant_id,name,type) VALUES (md5('sbretreader1')::uuid,'%s','Sandbox Retreaders','RETREADER'),(md5('sbbreakdown1')::uuid,'%s','Sandbox Roadside','BREAKDOWN_SUPPLIER');"
            % (T3, T3)
        )
        L.append(
            "INSERT INTO app.app_user (id,tenant_id,email,display_name,staff_number,role) VALUES"
        )
        L.append(
            "  (md5('sbdriver1')::uuid,'%s','sandbox-driver@example.invalid','Sandbox Driver','SBX-0001','DRIVER'),"
            % T3
        )
        L.append(
            "  (md5('sbcontroller1')::uuid,'%s','sandbox-controller@example.invalid','Sandbox Controller','SBX-0002','CONTROLLER'),"
            % T3
        )
        L.append(
            "  (md5('sbadmin1')::uuid,'%s','sandbox-admin@example.invalid','Sandbox Admin','SBX-0003','ORG_ADMIN');"
            % T3
        )
        # Only the driver is depot-scoped; a controller and an org admin see the
        # whole tenant (FR-AUT-007/009), so a user_depot row for either would
        # misrepresent the scope the dashboard is being exercised at.
        L.append(
            "INSERT INTO app.user_depot (tenant_id,user_id,depot_id) VALUES ('%s',md5('sbdriver1')::uuid,md5('sbdepot1')::uuid);"
            % T3
        )
        for sbseq, (sbfleet, sbreg, sbcfg, sbkind) in {
            1: ("HORSE", "SBX001GP", "HORSE_6X4", "HORSE"),
            2: ("LINK6", "SBX002GP", "TRAILER_2AXLE", "TRAILER"),
        }.items():
            L.append(
                "INSERT INTO app.vehicle (id,tenant_id,fleet_number,registration,configuration_id,unit_kind,body_type,home_depot_id,current_odometer,status)"
            )
            L.append(
                f"  VALUES (md5('sbveh{sbseq}')::uuid,'{T3}','{sbfleet}','{sbreg}',md5('{T3}{sbcfg}')::uuid,'{sbkind}','Flat deck',md5('sbdepot1')::uuid,250000,'ACTIVE');"
            )
        # FR-AUT-005 scopes GET /api/my/vehicles to the driver's own units,
        # so without an open trip the sandbox driver's capture list is empty
        # and the tenant cannot be walked end to end.
        L.append(
            "INSERT INTO app.trip (id,tenant_id,vehicle_id,user_id,started_at,started_by) VALUES"
        )
        L.append(
            f"  (md5('sbtrip1')::uuid,'{T3}',md5('sbveh1')::uuid,md5('sbdriver1')::uuid,'2026-01-01'::timestamp AT TIME ZONE 'Africa/Johannesburg',md5('sbcontroller1')::uuid);"
        )
        # Sandbox's catalogue takes every branch of the Receive tyres pickers
        # (TYRE-318): a branded NEW pattern, an unbranded NEW pattern, a brand
        # that owns no pattern, and a RETREAD-only pattern the form must not
        # offer. The names differ from gen_seed_volume.py's, because the three
        # tables are UNIQUE (tenant_id, name) and make db-volume loads into
        # this tenant.
        L.append(
            "INSERT INTO app.tyre_size (id,tenant_id,name,construction) VALUES (md5('sbsz1')::uuid,'%s','295/80R22.5','RADIAL'),(md5('sbsz2')::uuid,'%s','385/65R22.5','RADIAL');"
            % (T3, T3)
        )
        L.append(
            "INSERT INTO app.tyre_brand (id,tenant_id,name) VALUES (md5('sbbr1')::uuid,'%s','Sandbox Tyres'),(md5('sbbr2')::uuid,'%s','Practice Tyres');"
            % (T3, T3)
        )
        L.append(
            "INSERT INTO app.tyre_pattern (id,tenant_id,name,brand_id,applies_to) VALUES (md5('sbpt1')::uuid,'%s','SBX Drive',md5('sbbr1')::uuid,'NEW'),(md5('sbpt2')::uuid,'%s','SBX All Position',NULL,'NEW'),(md5('sbpt3')::uuid,'%s','SBX Retread',NULL,'RETREAD');"
            % (T3, T3, T3)
        )
        L.append("")
    L.append(
        "INSERT INTO app.tyre_size (id,tenant_id,name,construction) VALUES (md5('sz1')::uuid,'%s','315/80R22.5','RADIAL');"
        % T
    )
    L.append(
        "INSERT INTO app.tyre_brand (id,tenant_id,name) VALUES (md5('br1')::uuid,'%s','Dunlop');"
        % T
    )
    L.append(
        "INSERT INTO app.tyre_pattern (id,tenant_id,name,brand_id) VALUES (md5('pt1')::uuid,'%s','SP431',md5('br1')::uuid);"
        % T
    )
    L.append("")
    # three units (ADR-0007): a horse and two link trailers, each on its own
    # unit-scoped configuration, unit_kind backfilled at source (CHG-027)
    for seq, (fleet, cfg, kind, label) in UNIT.items():
        reg = names.registrations[seq]
        L.append(
            "INSERT INTO app.vehicle (id,tenant_id,fleet_number,registration,configuration_id,unit_kind,body_type,unit_descriptor,home_depot_id,current_odometer,status)"
        )
        L.append(
            f"  VALUES (md5('veh{seq}')::uuid,'{T}','{fleet}','{reg}',md5('{T}{cfg}')::uuid,'{kind}','Flat deck',$${label}$$,md5('depot1')::uuid,412500,'ACTIVE');"
        )
    L.append("")
    # Trips (FR-VEH-007 as amended, TYRE-326). Sipho's ended trip is the
    # retained history FR-VEH-008 asks for. Melusi's opens in 2025 because a
    # fixture inspection is attributed to the trip that covers it, and the
    # fixture's inspections fall inside his.
    L.append(
        "INSERT INTO app.trip (id,tenant_id,vehicle_id,user_id,started_at,ended_at,started_by,ended_by) VALUES"
    )
    L.append(
        f"  (md5('trip0')::uuid,'{T}',md5('veh1')::uuid,md5('driver3')::uuid,'2024-06-01'::timestamp AT TIME ZONE 'Africa/Johannesburg','2025-01-01'::timestamp AT TIME ZONE 'Africa/Johannesburg',md5('controller1')::uuid,md5('controller1')::uuid),"
    )
    L.append(
        f"  (md5('trip1')::uuid,'{T}',md5('veh1')::uuid,md5('driver1')::uuid,'2025-01-01'::timestamp AT TIME ZONE 'Africa/Johannesburg',NULL,md5('controller1')::uuid,NULL);"
    )
    L.append("")
    # Tenant 2 gets a vehicle named HORSE (fleet numbers may collide across
    # tenants, DR-003) and one trip: foreign rows for the isolation sweep, as
    # the tenant-2 user_depot seed above.
    if others:
        L.append(
            "INSERT INTO app.vehicle (id,tenant_id,fleet_number,registration,configuration_id,unit_kind,status) VALUES"
        )
        L.append(
            f"  (md5('t2veh1')::uuid,'{T2}','HORSE','CAA111111',md5('{T2}HORSE_6X4')::uuid,'HORSE','ACTIVE');"
        )
        L.append(
            "INSERT INTO app.trip (id,tenant_id,vehicle_id,user_id,started_at) VALUES"
        )
        L.append(
            f"  (md5('t2trip1')::uuid,'{T2}',md5('t2veh1')::uuid,md5('driver2')::uuid,'2026-01-01'::timestamp AT TIME ZONE 'Africa/Johannesburg');"
        )
        L.append("")
    L.append(
        "INSERT INTO app.combination (id,tenant_id,motive_vehicle_id) VALUES (md5('comb1')::uuid,'{}',md5('veh1')::uuid);".format(
            T
        )
    )
    for seq, (fleet, cfg, kind, label) in UNIT.items():
        L.append(
            f"INSERT INTO app.combination_member (tenant_id,combination_id,vehicle_id,sequence,descriptor) VALUES ('{T}',md5('comb1')::uuid,md5('veh{seq}')::uuid,{seq},$${label}$$);"
        )
    L.append("")
    L.append(
        "-- rand_per_mm derivation (BR-VAL-002) matches SRS Appendix E (seed_policy.py);"
    )
    L.append("-- the seed states inputs only, never the answer (rule 2).")
    L.append(
        "-- display_code keeps the sheet's branded strings verbatim: codes are opaque"
    )
    L.append(
        "-- display data, not keys (CHG-021, ADR-0008), and the historical sheet is the"
    )
    L.append(
        "-- fixture's source of truth. cost_source INVOICE: these prices are the SRS"
    )
    L.append(
        "-- worked examples' purchase figures, not estimates (CHG-036). The uniform"
    )
    L.append(
        "-- casing figure is the onboarding audit value, not a retreader valuation"
    )
    L.append("-- (CHG-016); a zero would load as NULL, and the sheet carries none.")
    allpos = [(p, member(p)) for p in sorted(R)] + [("S", (3, "S"))]
    for p, (mseq, own) in allpos:
        tid = f"tyre{p}"
        L.append(
            "INSERT INTO app.tyre (id,tenant_id,display_code,size_id,brand_id,pattern_id,status,purchase_date,received_date,purchase_price,cost_source,new_tread_mm,rand_per_mm,casing_value,state)"
        )
        L.append(
            f"  VALUES (md5('{tid}')::uuid,'{T}','2102{names.code_fleet}{p}',md5('sz1')::uuid,md5('br1')::uuid,md5('pt1')::uuid,'NEW','2024-03-01','2024-03-01',4319.91,'INVOICE',25.0,app.rand_per_mm(4319.91,25.0,{RETREAD_THRESHOLD_MM}),1837.50,'FITTED');"
        )
    L.append("")
    L.append("-- Fitments: each tyre on its own unit's own position code (BR-VEH-003).")
    L.append(
        "-- Trailers have no odometer (CFL-003): their fitments carry NULL and the"
    )
    L.append("-- distance provenance defaults to UNAVAILABLE (CHG-042, ADR-0010).")
    for p, (mseq, own) in allpos:
        odo = "380000" if mseq == 1 else "NULL"
        L.append(
            "INSERT INTO app.fitment (tenant_id,tyre_id,vehicle_id,position_id,fitted_at,fitted_odometer,fitted_tread_mm)"
        )
        L.append(
            f"  SELECT '{T}',md5('tyre{p}')::uuid,md5('veh{mseq}')::uuid,pos.id,'2025-06-01T06:00:00Z',{odo},25.0"
        )
        L.append(
            "    FROM app.position pos JOIN app.vehicle v ON v.configuration_id=pos.configuration_id"
        )
        L.append(f"   WHERE v.id=md5('veh{mseq}')::uuid AND pos.code='{own}';")
    L.append("")
    # The earlier capture, 25 days and 10,000km before the sheet below. It is
    # emitted first so the load order is chronological, and it carries only
    # the 26 running positions: a spare read once is the FR-ANL-003
    # insufficient-data case the fixture has to contain. Every figure pinned on
    # the Appendix J sheet resolves the LATEST reading of each tyre, so that
    # sheet still governs all of them and this capture moves none.
    L.append(
        "INSERT INTO app.inspection (id,tenant_id,vehicle_id,combination_id,user_id,client_uuid,started_at,submitted_at,odometer,device_id,app_version,duration_seconds)"
    )
    L.append(
        f"  VALUES (md5('insp0')::uuid,'{T}',md5('veh1')::uuid,md5('comb1')::uuid,md5('driver1')::uuid,md5('cli0')::uuid,"
    )
    L.append(
        "          '2026-06-28T05:38:00Z','2026-06-28T05:45:00Z',402500,'seed-fixture','0.0.0-fixture',420);"
    )
    L.append("")
    for p, (mseq, own) in allpos:
        if p == "S":
            continue
        kpa, rd = R[p]
        dl = PRIOR_DELTA.get(p, PRIOR_DEFAULT)
        L.append(
            "INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)"
        )
        L.append(
            f"  SELECT md5('rd0{p}')::uuid,'{T}',md5('insp0')::uuid,md5('veh{mseq}')::uuid,pos.id,md5('tyre{p}')::uuid,{kpa}"
        )
        L.append(
            "    FROM app.position pos JOIN app.vehicle v ON v.configuration_id=pos.configuration_id"
        )
        L.append(f"   WHERE v.id=md5('veh{mseq}')::uuid AND pos.code='{own}';")
        L.append(measurements(f"rd0{p}", rd, dl))
    L.append("")
    L.append(
        "INSERT INTO app.inspection (id,tenant_id,vehicle_id,combination_id,user_id,client_uuid,started_at,submitted_at,odometer,device_id,app_version,duration_seconds,comment,defect_report)"
    )
    L.append(
        f"  VALUES (md5('insp1')::uuid,'{T}',md5('veh1')::uuid,md5('comb1')::uuid,md5('driver1')::uuid,md5('cli1')::uuid,"
    )
    L.append(
        "          '2026-07-23T05:40:00Z','2026-07-23T05:46:30Z',412500,'seed-fixture','0.0.0-fixture',390,"
    )
    L.append(f"          $${names.comment}$$,")
    L.append(f"          $${names.defect_report}$$);")
    L.append("")
    for p, (mseq, own) in allpos:
        kpa, rd = SPARE if p == "S" else R[p]
        L.append(
            "INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)"
        )
        L.append(
            f"  SELECT md5('rd{p}')::uuid,'{T}',md5('insp1')::uuid,md5('veh{mseq}')::uuid,pos.id,md5('tyre{p}')::uuid,{kpa}"
        )
        L.append(
            "    FROM app.position pos JOIN app.vehicle v ON v.configuration_id=pos.configuration_id"
        )
        L.append(f"   WHERE v.id=md5('veh{mseq}')::uuid AND pos.code='{own}';")
        L.append(measurements(f"rd{p}", rd))
    L.append("")
    return L


def main():
    L = [
        "-- Seed: R13 acceptance fixture (SRS v1.3 Appendix J)",
        "-- ONE completed capture sheet, used as a golden test case. Test data, not a",
        "-- condition assessment of any vehicle.",
        "SET search_path = app, public;",
        f"SET app.tenant_id = '{T}';",
        "BEGIN;",
        "",
    ]
    L.extend(fixture_body(FIXTURE, others=True))
    L.append("COMMIT;")
    open("003_seed_fixture.sql", "w").write("\n".join(L) + "\n")
    print("fixture written")


if __name__ == "__main__":
    main()
