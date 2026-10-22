# Provision one tenant from a file into PROVISIONING under a fresh id, with
# everything FR-TEN-006 and TYRE-387 option A require before activation
# (TYRE-374). docs/runbooks/provision-a-tenant.md runs it; the design is
# docs/superpowers/specs/2026-10-17-tenant-provisioning-design.md.
#
# Usage: python provision_tenant.py <provisioning file> <output sql>
#
# The generator refuses what the database would accept silently or the reader
# would break on later: file shape, vocabulary, precision and each
# configuration key's domain. Relationships the schema already checks
# (warning_above_retread, target_kpa's range, a taken subdomain) are left to
# the database, which refuses them inside the one transaction.
import json
import os
import re
import sys
import unicodedata
import uuid
from decimal import Decimal

from seed_policy import (
    CLASS_THRESHOLDS,
    CONFIG_DEFAULTS,
    MAX_RETREADS,
    PRESSURE_TOLERANCE_PCT,
    RETREAD_THRESHOLD_MM,
    TARGET_KPA,
    WARNING_THRESHOLD_MM,
)
from tenant_library import EXCEPTION_RULES, UNITS, build, library_lines


class Refusal(Exception):
    pass


# app.axle_class in enum order, the order class threshold rows are written in.
AXLE_CLASSES = ["STEER", "DRIVE", "TRAILER", "TAG", "SPARE"]
DEPOT_TYPES = ["DEPOT", "STORE", "RETREADER", "BREAKDOWN_SUPPLIER"]
# Adding a purpose is a code change, never file content (OR-LEG-005).
CONSENT_PURPOSES = ["SERVICE_DELIVERY", "ANONYMISED_BENCHMARKING"]

IDENTITY = [
    "name",
    "subdomain",
    "timezone",
    "locale",
    "currency",
    "pressure_unit",
    "distance_unit",
    "display_code_policy",
]
TOP = IDENTITY + [
    "display_code_prefix",
    "depots",
    "policy",
    "platform_owned",
    "consent",
]
THRESHOLD_FIELDS = [
    "retread_threshold_mm",
    "warning_threshold_mm",
    "max_retreads",
    "retreads_permitted",
]
PRESSURE_FIELDS = ["target_kpa", *PRESSURE_TOLERANCE_PCT]

SUBDOMAIN = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
# display_code_counter's CHECK (000030).
PREFIX = re.compile(r"^[A-Z0-9]{2,8}$")
# An IANA zone name's characters; the database checks the name itself.
TIMEZONE = re.compile(r"^[A-Za-z0-9_+\-/]+$")
# tenant.currency is char(3), which pads a shorter code instead of refusing it.
CURRENCY = re.compile(r"^[A-Z]{3}$")


def sql_literal(s):
    return "'" + s.replace("'", "''") + "'"


def _repeats_refused(pairs):
    seen = {}
    for key, value in pairs:
        if key in seen:
            raise Refusal(f"{key} appears twice in one object; say it once")
        seen[key] = value
    return seen


def _constant_refused(name):
    raise Refusal(f"{name} is not a number; write the figure itself")


def load(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            text = f.read()
    except UnicodeDecodeError:
        raise Refusal(
            f"{path} is not UTF-8; save it as UTF-8 (PowerShell 5's > writes UTF-16)"
        ) from None
    except OSError as e:
        raise Refusal(f"cannot read {path}: {e.strerror}") from None
    try:
        return json.loads(
            text,
            parse_float=Decimal,
            parse_constant=_constant_refused,
            object_pairs_hook=_repeats_refused,
        )
    except json.JSONDecodeError as e:
        raise Refusal(f"{path} is not JSON: {e}") from None


def _controls_refused(value, path):
    if isinstance(value, str):
        if any(unicodedata.category(c) == "Cc" for c in value):
            raise Refusal(f"{path} holds a control character such as a newline")
    elif isinstance(value, dict):
        for k, v in value.items():
            _controls_refused(v, f"{path}.{k}" if path else k)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _controls_refused(v, f"{path}[{i}]")


def _object(value, path, allowed):
    if not isinstance(value, dict):
        raise Refusal(f"{path} must be an object")
    for key in value:
        if key not in allowed:
            where = f"{path}.{key}" if path != "the file" else key
            raise Refusal(f"{where} is not a field this file accepts")
    return value


def _text(value, path):
    if not isinstance(value, str) or not value or value != value.strip():
        raise Refusal(
            f"{path} must be text that is not empty and has no space at either end"
        )
    return value


def _one_of(value, path, allowed):
    if value not in allowed:
        raise Refusal(f"{path} is {value!r}; it must be one of {', '.join(allowed)}")
    return value


def _bool(value, path):
    if type(value) is not bool:
        raise Refusal(f"{path} must be true or false")
    return value


def _whole(value, path):
    if type(value) is not int:
        raise Refusal(f"{path} must be a whole number")
    return value


def _tenth(value, path):
    # numeric(4,1) rounds a finer figure silently, so it is refused instead.
    if type(value) not in (int, Decimal):
        raise Refusal(f"{path} must be a number")
    d = Decimal(value)
    if d != d.quantize(Decimal("0.1")):
        raise Refusal(f"{path} is {value}; it takes at most one decimal place")
    return d


def _positive(value, path):
    if value <= 0:
        raise Refusal(f"{path} is {value}; it must be above 0")


def _granularity(value, path):
    # reading_measurement_granularity_mm_check (000011), which every
    # submitted measurement must meet (000041).
    if Decimal(value) not in (Decimal("1.0"), Decimal("0.5"), Decimal("0.1")):
        raise Refusal(f"{path} is {value}; it must be 1.0, 0.5 or 0.1")


def _reading_count(value, path):
    # app.submit_inspection refuses any other width with TY005 (000041,
    # CR-011's anatomy map), narrower than FR-CFG-023's range.
    if value not in (1, 3):
        raise Refusal(f"{path} is {value}; capture accepts 1 or 3 readings")


def _number(value):
    return type(value) in (int, Decimal)


def _bands(value, path):
    # FR-CFG-030, BR-RPT-003; app.tread_band_list casts both bounds to numeric
    # (000007), so a band the cast cannot read breaks every band query.
    shaped = (
        len(value) > 0
        and all(isinstance(b, list) and len(b) == 2 for b in value)
        and all(_number(b[0]) for b in value)
        and all(_number(b[1]) for b in value[:-1])
        and value[-1][1] is None
    )
    if not shaped:
        raise Refusal(
            f"{path} must be a list of [lower, upper] number pairs whose last upper"
            " bound, and only the last, is null"
        )
    lowers = [b[0] for b in value]
    if lowers[0] != 0 or any(a >= b for a, b in zip(lowers, lowers[1:])):
        raise Refusal(
            f"{path} must start at 0 with lower bounds that rise band by band"
        )
    # The band's label is built from its stored upper bound (000007), so an
    # upper bound outside the band would print on every composition chart.
    if any(not lo <= hi < nxt for (lo, hi), nxt in zip(value, lowers[1:])):
        raise Refusal(
            f"{path} has an upper bound below its own lower bound or at or above"
            " the next band's lower bound"
        )


def _reasons(value, path):
    # app.remove_tyre tests `reasons ? p_reason`, which only a string element
    # can satisfy (000039, FR-FIT-008).
    ok = (
        len(value) > 0
        and all(isinstance(r, str) and r and r == r.strip() for r in value)
        and len(set(value)) == len(value)
    )
    if not ok:
        raise Refusal(
            f"{path} must be a non-empty list of distinct reasons, each text with no"
            " space at either end"
        )


# app.configuration has no CHECK and a row at -infinity governs every date, so
# a value its reader refuses would break the tenant everywhere.
DOMAINS = {
    "tread_capture_granularity_mm": _granularity,
    "tread_reading_count": _reading_count,
    "width_spread_warn_mm": _positive,
    "dual_mate_warn_mm": _positive,
    "axle_divergence_warn_mm": _positive,
    "reading_staleness_days": _positive,
    "wear_rate_min_distance_km": _positive,
    "odometer_max_daily_km": _positive,
    "duplicate_inspection_min_hours": _positive,
    "submitted_at_future_skew_minutes": _positive,
    "inspection_max_duration_hours": _positive,
    "wear_rate_alert_multiple": _positive,
    "forecast_horizon_days": _positive,
    "inflation_compliance_window_days": _positive,
    "tread_bands": _bands,
    "removal_reasons": _reasons,
}


def _config_value(key, value, default, path):
    # Counts, days, hours, minutes and kilometres are whole, and several are
    # read ::int; a millimetre figure may carry a fraction.
    if isinstance(default, bool):
        ok = type(value) is bool
    elif isinstance(default, list):
        ok = isinstance(value, list)
    elif isinstance(default, float) or key.endswith("_mm"):
        ok = type(value) in (int, Decimal)
    else:
        ok = type(value) is int
    if not ok:
        raise Refusal(
            f"{path} has the wrong type; the default is {json.dumps(default)}"
        )
    check = DOMAINS.get(key)
    if check:
        check(value, path)
    return value


def _configuration(section):
    _object(section, "policy.configuration", dict(CONFIG_DEFAULTS))
    rows = []
    for key, default in CONFIG_DEFAULTS:
        if key in section:
            path = f"policy.configuration.{key}"
            rows.append((key, _config_value(key, section[key], default, path)))
        else:
            rows.append((key, default))
    return rows


def _threshold_fields(fields, path):
    _object(fields, path, THRESHOLD_FIELDS)
    out = {}
    for key, value in fields.items():
        where = f"{path}.{key}"
        if key == "max_retreads":
            out[key] = _whole(value, where)
        elif key == "retreads_permitted":
            out[key] = _bool(value, where)
        else:
            out[key] = _tenth(value, where)
    return out


def _thresholds(section):
    _object(section, "policy.threshold_policy", ["FLEET", *AXLE_CLASSES])
    fleet = {
        "retread_threshold_mm": Decimal(str(RETREAD_THRESHOLD_MM)),
        "warning_threshold_mm": Decimal(str(WARNING_THRESHOLD_MM)),
        "max_retreads": MAX_RETREADS,
        "retreads_permitted": True,
    }
    fleet.update(
        _threshold_fields(section.get("FLEET", {}), "policy.threshold_policy.FLEET")
    )
    rows = [(None, fleet)]
    # A class row pins every figure for its class, so it starts from the
    # merged fleet-wide row or a changed fleet figure would never reach it.
    for cls in AXLE_CLASSES:
        if cls not in CLASS_THRESHOLDS and cls not in section:
            continue
        row = dict(fleet)
        row.update(CLASS_THRESHOLDS.get(cls, {}))
        row.update(
            _threshold_fields(section.get(cls, {}), f"policy.threshold_policy.{cls}")
        )
        rows.append((cls, row))
    return rows


def _pressures(section):
    if not isinstance(section, dict):
        raise Refusal("policy.target_pressure must be an object")
    for cls in section:
        if cls not in TARGET_KPA:
            why = (
                "; a spare's pressure is unclassifiable (FR-CFG-013, errata E1)"
                if cls == "SPARE"
                else ""
            )
            raise Refusal(
                f"policy.target_pressure.{cls} is not a class with a target pressure{why}"
            )
    rows = []
    for cls, kpa in TARGET_KPA.items():
        row = {"target_kpa": kpa}
        row.update((k, Decimal(str(v))) for k, v in PRESSURE_TOLERANCE_PCT.items())
        fields = _object(
            section.get(cls, {}), f"policy.target_pressure.{cls}", PRESSURE_FIELDS
        )
        for key, value in fields.items():
            where = f"policy.target_pressure.{cls}.{key}"
            row[key] = (
                _whole(value, where) if key == "target_kpa" else _tenth(value, where)
            )
        # v_exception raises FR-EXC-022 and 023 below 100 minus these (000045),
        # so at 100 or more no pressure is ever under, at every date.
        for key in ("warn_under_pct", "critical_under_pct"):
            if row[key] >= 100:
                raise Refusal(
                    f"policy.target_pressure.{cls}.{key} is {row[key]}; at 100 or more"
                    " no reading can fall under it, so the exception never fires"
                )
        rows.append((cls, row))
    return rows


def _depots(value):
    if not isinstance(value, list) or not value:
        raise Refusal(
            "depots must list at least one depot; no route creates one, so a tenant"
            " without one cannot home a unit or scope a driver"
        )
    out, names = [], set()
    for i, depot in enumerate(value):
        path = f"depots[{i}]"
        _object(depot, path, ["name", "type", "address"])
        if "name" not in depot:
            raise Refusal(f"{path}.name is missing")
        row = {"name": _text(depot["name"], f"{path}.name")}
        if row["name"] in names:
            raise Refusal(f"{path}.name {row['name']!r} names a depot twice")
        names.add(row["name"])
        if "type" in depot:
            row["type"] = _one_of(depot["type"], f"{path}.type", DEPOT_TYPES)
        if "address" in depot:
            row["address"] = _text(depot["address"], f"{path}.address")
        out.append(row)
    return out


def _consent(doc, platform_owned):
    records = doc.get("consent")
    if platform_owned:
        if records not in (None, []):
            raise Refusal(
                "consent: this file states platform_owned, and no client signed"
                " anything for a platform-owned tenant, so it carries no consent record"
            )
        return []
    if not isinstance(records, list) or not records:
        raise Refusal(
            "consent: a client tenant carries the consent records from the agreement"
            ' it signed; a platform-owned tenant states "platform_owned": true instead'
        )
    out, purposes = [], set()
    for i, rec in enumerate(records):
        path = f"consent[{i}]"
        _object(rec, path, ["purpose", "granted", "notice_version"])
        for key in ("purpose", "granted"):
            if key not in rec:
                raise Refusal(f"{path}.{key} is missing")
        purpose = _one_of(rec["purpose"], f"{path}.purpose", CONSENT_PURPOSES)
        if purpose in purposes:
            raise Refusal(f"{path}.purpose {purpose} is stated twice")
        purposes.add(purpose)
        notice = rec.get("notice_version")
        if not isinstance(notice, str) or not notice.strip():
            raise Refusal(
                f"{path}.notice_version names the notice the client signed; only the"
                " owner can fill it in"
            )
        out.append(
            {
                "purpose": purpose,
                "granted": _bool(rec["granted"], f"{path}.granted"),
                "notice_version": _text(notice, f"{path}.notice_version"),
            }
        )
    return out


def validate(doc):
    if not isinstance(doc, dict):
        raise Refusal("the file must be one JSON object")
    if "id" in doc:
        raise Refusal(
            "id: the generator mints the tenant id, so the same file run on staging"
            " and on production never yields one shared id (TYRE-397)"
        )
    _object(doc, "the file", TOP)
    _controls_refused(doc, "")

    tenant = {}
    for key in ("name", "subdomain"):
        if key not in doc:
            raise Refusal(f"{key} is missing")
    tenant["name"] = _text(doc["name"], "name")
    if not isinstance(doc["subdomain"], str) or not SUBDOMAIN.match(doc["subdomain"]):
        raise Refusal(
            "subdomain must be lower-case letters, digits and inner hyphens, at most"
            " 63 characters"
        )
    tenant["subdomain"] = doc["subdomain"]
    if "timezone" in doc:
        if not isinstance(doc["timezone"], str) or not TIMEZONE.match(doc["timezone"]):
            raise Refusal(
                "timezone must be an IANA zone name such as Africa/Johannesburg"
            )
        tenant["timezone"] = doc["timezone"]
    if "locale" in doc:
        tenant["locale"] = _text(doc["locale"], "locale")
    if "currency" in doc:
        if not isinstance(doc["currency"], str) or not CURRENCY.match(doc["currency"]):
            raise Refusal("currency must be a three-letter code such as ZAR")
        tenant["currency"] = doc["currency"]
    # Nothing converts a stored kPa or km figure yet, so a known unit other
    # than these is refused by name; tenant_metric_units holds the same line
    # in the database (000059, FR-CFG-021).
    if "pressure_unit" in doc:
        unit = _one_of(doc["pressure_unit"], "pressure_unit", ["KPA", "PSI", "BAR"])
        if unit != "KPA":
            raise Refusal(
                f"pressure_unit is {unit}; pressure conversion is not built yet,"
                " so a tenant is KPA (FR-CFG-021)"
            )
        tenant["pressure_unit"] = unit
    if "distance_unit" in doc:
        unit = _one_of(doc["distance_unit"], "distance_unit", ["KM", "MI"])
        if unit != "KM":
            raise Refusal(
                f"distance_unit is {unit}; distance conversion is not built yet,"
                " so a tenant is KM (FR-CFG-021)"
            )
        tenant["distance_unit"] = unit

    prefix = None
    if "display_code_policy" in doc:
        tenant["display_code_policy"] = _one_of(
            doc["display_code_policy"], "display_code_policy", ["FREE", "GENERATED"]
        )
    if tenant.get("display_code_policy") == "GENERATED":
        prefix = doc.get("display_code_prefix")
        if not isinstance(prefix, str) or not PREFIX.match(prefix):
            raise Refusal(
                "display_code_prefix: a GENERATED tenant needs 2 to 8 capital letters"
                " or digits"
            )
    elif "display_code_prefix" in doc:
        raise Refusal("display_code_prefix is only for a GENERATED tenant")

    depots = _depots(doc.get("depots"))

    pol = _object(
        doc.get("policy", {}),
        "policy",
        ["configuration", "threshold_policy", "target_pressure"],
    )
    configuration = _configuration(pol.get("configuration", {}))
    thresholds = _thresholds(pol.get("threshold_policy", {}))
    pressures = _pressures(pol.get("target_pressure", {}))

    platform_owned = _bool(doc.get("platform_owned", False), "platform_owned")
    if "consent" in doc and not isinstance(doc["consent"], list):
        raise Refusal("consent must be a list of records")
    consent = _consent(doc, platform_owned)

    return {
        "tenant": tenant,
        "prefix": prefix,
        "depots": depots,
        "configuration": configuration,
        "thresholds": thresholds,
        "pressures": pressures,
        "platform_owned": platform_owned,
        "consent": consent,
    }


def row_counts(p):
    return {
        "configuration": len(p["configuration"]),
        "threshold_policy": len(p["thresholds"]),
        "target_pressure": len(p["pressures"]),
        "axle_configuration": len(UNITS),
        "position": sum(len(build(axles)) + 1 for *_, axles in UNITS),
        "exception_rule": len(EXCEPTION_RULES),
        "display_code_counter": 1 if p["prefix"] else 0,
        "depot": len(p["depots"]),
        "tenant_consent": len(p["consent"]),
    }


def _sql_value(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, Decimal)):
        return str(v)
    return sql_literal(v)


def provisioning_sql(p, tid, source=None):
    q = sql_literal(tid)
    L = [
        f"-- Tenant {tid}"
        + (f", provisioned from {re.sub(r'[^ -~]', '?', source)}" if source else "")
        + ".",
        "-- Generated by db/seeds/provision_tenant.py (TYRE-374); run it as the",
        "-- runbook docs/runbooks/provision-a-tenant.md says. One transaction,",
        "-- which commits itself only when the count gate at the end passes.",
        "\\set ON_ERROR_STOP on",
        "SET client_encoding = 'UTF8';",
        "BEGIN;",
        # tenant_self's WITH CHECK refuses the tenant row unless its id is bound
        # first, under a role that does not bypass RLS (rule 1).
        f"SELECT set_config('app.tenant_id', {q}, true) AS tenant;",
    ]
    tenant = p["tenant"]
    if "timezone" in tenant:
        # A bare text column takes a typo, and every tenant date breaks later.
        tz = sql_literal(tenant["timezone"])
        L += [
            "DO $tz$",
            "BEGIN",
            f"  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = {tz}) THEN",
            f"    RAISE EXCEPTION 'timezone % is not a zone Postgres knows', {tz};",
            "  END IF;",
            "END $tz$;",
        ]
    cols = ["id", *tenant, "state"]
    vals = [q, *(sql_literal(v) for v in tenant.values()), "'PROVISIONING'"]
    L.append(f"INSERT INTO app.tenant ({', '.join(cols)}) VALUES ({', '.join(vals)});")
    L.append("")
    # Every baseline row is dated -infinity, so it is in force at any date an
    # import can carry. A first row dated now() would leave everything older
    # unvalued for good (SRS §5.1 errata E1, db/CLAUDE.md Append-only).
    for key, value in p["configuration"]:
        doc = sql_literal(json.dumps(value, default=float))
        L.append(
            "INSERT INTO app.configuration (tenant_id, key, value, effective_from)"
            f" VALUES ({q}, {sql_literal(key)}, {doc}::jsonb, '-infinity');"
        )
    for cls, row in p["thresholds"]:
        figures = ", ".join(_sql_value(row[f]) for f in THRESHOLD_FIELDS)
        L.append(
            "INSERT INTO app.threshold_policy (tenant_id, axle_class, "
            + ", ".join(THRESHOLD_FIELDS)
            + f", effective_from) VALUES ({q}, {_sql_value(cls)}, {figures}, '-infinity');"
        )
    for cls, row in p["pressures"]:
        figures = ", ".join(_sql_value(row[f]) for f in PRESSURE_FIELDS)
        L.append(
            "INSERT INTO app.target_pressure (tenant_id, axle_class, "
            + ", ".join(PRESSURE_FIELDS)
            + f", effective_from) VALUES ({q}, {sql_literal(cls)}, {figures}, '-infinity');"
        )
    L.append("")
    L += library_lines(tid)
    if p["prefix"]:
        L.append(
            "INSERT INTO app.display_code_counter (tenant_id, prefix)"
            f" VALUES ({q}, {sql_literal(p['prefix'])});"
        )
    for depot in p["depots"]:
        cols = ["tenant_id", *depot]
        vals = [q, *(sql_literal(v) for v in depot.values())]
        L.append(
            f"INSERT INTO app.depot ({', '.join(cols)}) VALUES ({', '.join(vals)});"
        )
    L.append("SELECT app.seed_tenant_catalogue() AS platform_catalogue_seeded;")
    # Through the one writer the runbook and make record-consent share
    # (000059). No actor is bound at provisioning, so actor_id and created_by
    # stay NULL, and consent is dated now.
    for rec in p["consent"]:
        L.append(
            f"SELECT app.record_consent({sql_literal(rec['purpose'])},"
            f" {_sql_value(rec['granted'])}, {sql_literal(rec['notice_version'])});"
        )
    L.append("")
    expected = ",\n".join(
        f"      ({sql_literal(t)}, {n})" for t, n in row_counts(p).items()
    )
    L += [
        "-- count gate",
        # A mismatch rolls the whole tenant back, so nothing is half written.
        "DO $gate$",
        "DECLARE",
        "  tid uuid := app.current_tenant_id();",
        "  st text;",
        "  t text;",
        "  want bigint;",
        "  n bigint;",
        "BEGIN",
        "  SELECT state::text INTO st FROM app.tenant WHERE id = tid;",
        "  IF st IS DISTINCT FROM 'PROVISIONING' THEN",
        "    RAISE EXCEPTION 'count gate: tenant is %, expected PROVISIONING', coalesce(st, 'missing');",
        "  END IF;",
        "  FOR t, want IN",
        "    SELECT * FROM (VALUES",
        expected,
        "    ) AS v(t, want)",
        "  LOOP",
        "    EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id = $1', t) INTO n USING tid;",
        "    IF n <> want THEN",
        "      RAISE EXCEPTION 'count gate: % holds %, expected %', t, n, want;",
        "    END IF;",
        "  END LOOP;",
        "  FOR t IN SELECT unnest(ARRAY['tyre_size', 'tyre_brand', 'tyre_pattern']) LOOP",
        "    EXECUTE format('SELECT count(*) FROM app.platform_%I', t) INTO want;",
        "    EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id = $1 AND platform_catalogue_id IS NOT NULL', t)",
        "      INTO n USING tid;",
        "    IF n <> want THEN",
        "      RAISE EXCEPTION 'count gate: % holds % platform entries, expected %', t, n, want;",
        "    END IF;",
        "  END LOOP;",
        "END $gate$;",
        "COMMIT;",
    ]
    return "\n".join(L) + "\n"


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        # A refusal quoting a non-ASCII value must print on a cp1252 console.
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    if len(argv) != 2:
        print(
            "usage: python provision_tenant.py <provisioning file> <output sql>",
            file=sys.stderr,
        )
        return 2
    source, out = argv
    try:
        p = validate(load(source))
    except Refusal as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    tid = str(uuid.uuid4())
    sql = provisioning_sql(p, tid, source=os.path.basename(source))
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(sql)
    print(f"tenant id: {tid}")
    print(f"wrote {out}")
    for table, n in row_counts(p).items():
        print(f"{table} {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
