# The reference data every tenant starts with: the unit-type library and the
# exception rule catalogue. The fixture generators and the provisioning path
# both emit it through library_lines, so a real tenant and the fixture
# tenants cannot drift apart (TYRE-374).

# CHG-070..073: the configuration library describes UNITS, not combinations
# (CFL-008, ADR-0007). A rig is a dated composition of units; its numbering is
# a display projection computed at render time (CFL-006), so no combination
# entry and no position map exist here. Body type is a vehicle attribute
# (CHG-071), so the tipper/tanker/tautliner entries collapsed into these six.
#
# Status per CHG-072: BAC confirmed it runs only what its own sheets show.
# UNVERIFIED is not "proposed". Nobody proposed anything (CFL-008).
UNITS = [
    # code            name                 kind      status        axles: (class, dual?)
    (
        "HORSE_4X2",
        "Truck tractor 4x2",
        "HORSE",
        "CONFIRMED",
        [("STEER", False), ("DRIVE", True)],
    ),
    (
        "HORSE_6X4",
        "Truck tractor 6x4",
        "HORSE",
        "CONFIRMED",
        [("STEER", False), ("DRIVE", True), ("DRIVE", True)],
    ),
    (
        "TRAILER_2AXLE",
        "2-axle trailer",
        "TRAILER",
        "CONFIRMED",
        [("TRAILER", True), ("TRAILER", True)],
    ),
    (
        "TRAILER_3AXLE",
        "3-axle trailer",
        "TRAILER",
        "UNVERIFIED",
        [("TRAILER", True), ("TRAILER", True), ("TRAILER", True)],
    ),
    (
        "RIGID_4X2",
        "Rigid truck 4x2",
        "RIGID",
        "UNVERIFIED",
        [("STEER", False), ("DRIVE", True)],
    ),
    (
        "LIGHT_4X2",
        "Light vehicle 4x2",
        "LIGHT",
        "UNVERIFIED",
        [("STEER", False), ("DRIVE", False)],
    ),
]


def build(axles):
    rows = []
    own = 0
    for axle, (cls, dual) in enumerate(axles, start=1):
        slots = (
            [
                ("LEFT", "OUTER"),
                ("LEFT", "INNER"),
                ("RIGHT", "INNER"),
                ("RIGHT", "OUTER"),
            ]
            if dual
            else [("LEFT", "SINGLE"), ("RIGHT", "SINGLE")]
        )
        for side, slot in slots:
            own += 1
            rows.append(dict(own=own, axle=axle, cls=cls, side=side, slot=slot))
    return rows


EXCEPTION_RULES = [
    ("FR-EXC-020", "Tread below removal threshold", "CRITICAL"),
    ("FR-EXC-021", "Tread approaching threshold", "WARNING"),
    ("FR-EXC-022", "Pressure dangerously under", "CRITICAL"),
    ("FR-EXC-023", "Pressure under", "WARNING"),
    ("FR-EXC-028", "Damage reported", "WARNING"),
    ("FR-EXC-035", "Irregular wear across the tread", "WARNING"),
    ("FR-EXC-036", "Dual-mate mismatch", "WARNING"),
    ("FR-EXC-038", "Spare below removal threshold", "CRITICAL"),
    ("FR-EXC-039", "Suspected pressure transcription", "INFO"),
]


def library_lines(tid):
    L = []
    L.append("-- The exception rule catalogue (FR-EXC-004): severity and enabled live")
    L.append("-- here; every threshold lives in threshold_policy, target_pressure or")
    L.append("-- configuration, so this table never carries a number (B7 spec U6).")
    L.append("-- FR-EXC-038 is CRITICAL, not the SRS table's WARNING: it is the only")
    L.append("-- reading under which Appendix J's 19 exceptions carry 11 urgent, and a")
    L.append("-- spare at scrap depth fails when it is finally needed (Q21; spec U1,")
    L.append("-- errata row prepared). FR-EXC-032 has no row on purpose: it is the")
    L.append("-- money attribute of the 020 and 038 rows, served by v_tyre_at_risk")
    L.append("-- (spec U19). FR-EXC-037 has none because Appendix H.2 defers it.")
    for code, name, sev in EXCEPTION_RULES:
        L.append(
            f"INSERT INTO app.exception_rule (id,tenant_id,code,name,enabled,severity) VALUES (md5('{tid}excr-{code}')::uuid,'{tid}','{code}',$${name}$$,true,'{sev}');"
        )
    L.append("")
    for code, name, kind, status, axles in UNITS:
        rows = build(axles)
        L.append(
            "INSERT INTO app.axle_configuration (id,tenant_id,code,name,axle_count,evidential_status,default_spare_count)"
        )
        L.append(
            f"  VALUES (md5('{tid}{code}')::uuid,'{tid}','{code}',$${name}$$,{len(axles)},'{status}',1);"
        )
        vals = []
        for r in rows:
            vals.append(
                f"('{tid}',md5('{tid}{code}')::uuid,'{r['own']}',{r['own']},{r['axle']},'{r['cls']}','{r['side']}','{r['slot']}',false,'FIXED',NULL,$${name}$$)"
            )
        # CHG-031: the spare position is a default; the real count is whatever
        # inspections find, so more spare positions may exist per unit in data
        vals.append(
            f"('{tid}',md5('{tid}{code}')::uuid,'S',{len(rows) + 1},NULL,'SPARE',NULL,NULL,true,'FIXED',1,$${name}$$)"
        )
        L.append(
            "INSERT INTO app.position (tenant_id,configuration_id,code,sequence,axle_number,axle_class,side,slot,is_spare,axle_type,spare_ordinal,unit_label) VALUES"
        )
        L.append(",\n".join("  " + v for v in vals) + ";")
        L.append("")
    return L
