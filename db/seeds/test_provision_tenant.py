import contextlib
import copy
import io
import json
import os
import tempfile
import unittest
import uuid
from decimal import Decimal

from provision_tenant import (
    Refusal,
    load,
    main,
    provisioning_sql,
    row_counts,
    sql_literal,
    validate,
)
from seed_policy import (
    CLASS_THRESHOLDS,
    CONFIG_DEFAULTS,
    MAX_RETREADS,
    PRESSURE_TOLERANCE_PCT,
    RETREAD_THRESHOLD_MM,
    TARGET_KPA,
    WARNING_THRESHOLD_MM,
)
from tenant_library import EXCEPTION_RULES, UNITS, build

TID = "0f0e0d0c-0b0a-4908-8706-050403020100"
TEMPLATE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "provision_template.json"
)
# The non-ASCII depot name, spelled by code point so the test file stays ASCII.
DEPOT_SUD = "D" + chr(233) + "p" + chr(244) + "t Sud"


def minimal():
    return {
        "name": "Test Fleet",
        "subdomain": "test-fleet",
        "depots": [{"name": "Main yard"}],
        "consent": [
            {"purpose": "SERVICE_DELIVERY", "granted": True, "notice_version": "n1"}
        ],
    }


def policy(doc, section, value):
    doc.setdefault("policy", {})[section] = value
    return doc


def config(key, value):
    return lambda d: policy(d, "configuration", {key: value})


def threshold(scope, fields):
    return lambda d: policy(d, "threshold_policy", {scope: fields})


def target(scope, fields):
    return lambda d: policy(d, "target_pressure", {scope: fields})


def put(key, value):
    def apply(d):
        d[key] = value
        return d

    return apply


def drop(key):
    def apply(d):
        del d[key]
        return d

    return apply


def consent(*records):
    return put("consent", list(records))


def record(**fields):
    base = {"purpose": "SERVICE_DELIVERY", "granted": True, "notice_version": "n1"}
    base.update(fields)
    return {k: v for k, v in base.items() if v is not ...}


def depots(*items):
    return put("depots", list(items))


def generated(prefix):
    def apply(d):
        d["display_code_policy"] = "GENERATED"
        d["display_code_prefix"] = prefix
        return d

    return apply


SCRATCH = tempfile.TemporaryDirectory()


def tearDownModule():
    SCRATCH.cleanup()


def scratch(suffix):
    return os.path.join(SCRATCH.name, uuid.uuid4().hex + suffix)


def written(doc, encoding="utf-8"):
    path = scratch(".json")
    with open(path, "w", encoding=encoding, newline="\n") as f:
        f.write(json.dumps(doc, ensure_ascii=False, default=str))
    return path


def raw(text):
    path = scratch(".json")
    with open(path, "wb") as f:
        f.write(text.encode("utf-8"))
    return path


def as_loaded(value):
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, list):
        return [as_loaded(v) for v in value]
    return value


REFUSALS = [
    ("id", put("id", "11111111-1111-1111-1111-111111111111"), "id"),
    ("unknown top key", put("colour", 1), "colour"),
    ("unknown depot key", depots({"name": "A", "phone": "1"}), "phone"),
    ("unknown policy key", put("policy", {"budget": {}}), "budget"),
    ("unknown config key", config("removal_threshold_mm", 4), "removal_threshold_mm"),
    ("unknown threshold field", threshold("FLEET", {"scrap_mm": 3}), "scrap_mm"),
    ("unknown target field", target("STEER", {"psi": 120}), "psi"),
    ("unknown consent key", consent(record(signed_by="x")), "signed_by"),
    ("not an object", lambda d: [d], "object"),
    ("no name", drop("name"), "name"),
    ("empty name", put("name", ""), "name"),
    ("padded name", put("name", " Test Fleet"), "name"),
    ("name not a string", put("name", 7), "name"),
    ("newline", put("name", "A\nB"), "name"),
    ("control in a depot", depots({"name": "A", "address": "1\tRoad"}), "address"),
    ("no subdomain", drop("subdomain"), "subdomain"),
    ("subdomain shape", put("subdomain", "Test_Fleet"), "subdomain"),
    ("subdomain hyphen end", put("subdomain", "test-"), "subdomain"),
    ("policy unknown", put("display_code_policy", "MIXED"), "display_code_policy"),
    (
        "GENERATED no prefix",
        put("display_code_policy", "GENERATED"),
        "display_code_prefix",
    ),
    ("FREE with prefix", put("display_code_prefix", "ABC"), "display_code_prefix"),
    (
        "FREE stated with prefix",
        lambda d: generated("ABC")(d) | {"display_code_policy": "FREE"},
        "display_code_prefix",
    ),
    ("prefix shape", generated("ab"), "display_code_prefix"),
    ("prefix long", generated("ABCDEFGHI"), "display_code_prefix"),
    ("pressure unit", put("pressure_unit", "kPa"), "pressure_unit"),
    ("distance unit", put("distance_unit", "MILES"), "distance_unit"),
    ("currency shape", put("currency", "ZA"), "currency"),
    ("timezone shape", put("timezone", "Africa/Johannesburg'"), "timezone"),
    ("no depot", depots(), "depot"),
    ("depots missing", drop("depots"), "depot"),
    ("depot no name", depots({"type": "STORE"}), "name"),
    ("depot type", depots({"name": "A", "type": "WAREHOUSE"}), "WAREHOUSE"),
    ("depot twice", depots({"name": "A"}, {"name": "A", "type": "STORE"}), "A"),
    (
        "config bool as int",
        config("reading_staleness_days", True),
        "reading_staleness_days",
    ),
    (
        "config string as int",
        config("reading_staleness_days", "28"),
        "reading_staleness_days",
    ),
    (
        "config decimal as int",
        config("reading_staleness_days", Decimal("28.5")),
        "reading_staleness_days",
    ),
    ("config int as bool", config("capture_spares", 1), "capture_spares"),
    ("config bool as mm", config("width_spread_warn_mm", True), "width_spread_warn_mm"),
    ("config string as list", config("tread_bands", "0-4"), "tread_bands"),
    (
        "granularity",
        config("tread_capture_granularity_mm", Decimal("0.25")),
        "tread_capture_granularity_mm",
    ),
    ("reading count", config("tread_reading_count", 5), "tread_reading_count"),
    ("reading count two", config("tread_reading_count", 2), "tread_reading_count"),
    ("zero spread", config("width_spread_warn_mm", 0), "width_spread_warn_mm"),
    (
        "negative mate",
        config("dual_mate_warn_mm", Decimal("-1.0")),
        "dual_mate_warn_mm",
    ),
    ("zero days", config("reading_staleness_days", 0), "reading_staleness_days"),
    ("zero horizon", config("forecast_horizon_days", 0), "forecast_horizon_days"),
    ("bands empty", config("tread_bands", []), "tread_bands"),
    ("bands not from 0", config("tread_bands", [[1, 4], [5, None]]), "tread_bands"),
    (
        "bands not increasing",
        config("tread_bands", [[0, 4], [8, 10], [5, None]]),
        "tread_bands",
    ),
    (
        "bands open in the middle",
        config("tread_bands", [[0, None], [5, None]]),
        "tread_bands",
    ),
    ("bands last closed", config("tread_bands", [[0, 4], [5, 7]]), "tread_bands"),
    ("band element", config("tread_bands", [[0, 4], ["5", None]]), "tread_bands"),
    ("band bool", config("tread_bands", [[0, True], [5, None]]), "tread_bands"),
    ("band width", config("tread_bands", [[0, 4, 5], [5, None]]), "tread_bands"),
    (
        "band upper below lower",
        config("tread_bands", [[0, 4], [5, 3], [8, None]]),
        "upper bound",
    ),
    ("band upper at next", config("tread_bands", [[0, 5], [5, None]]), "upper bound"),
    ("reasons empty", config("removal_reasons", []), "removal_reasons"),
    (
        "reason not a string",
        config("removal_reasons", ["damage", 3]),
        "removal_reasons",
    ),
    (
        "reason twice",
        config("removal_reasons", ["damage", "damage"]),
        "removal_reasons",
    ),
    ("reason padded", config("removal_reasons", ["damage "]), "removal_reasons"),
    ("reason blank", config("removal_reasons", [""]), "removal_reasons"),
    ("threshold scope", threshold("AXLE_1", {"max_retreads": 1}), "AXLE_1"),
    (
        "precision",
        threshold("FLEET", {"retread_threshold_mm": Decimal("4.15")}),
        "4.15",
    ),
    (
        "warning precision",
        threshold("STEER", {"warning_threshold_mm": Decimal("6.05")}),
        "6.05",
    ),
    (
        "threshold string",
        threshold("FLEET", {"retread_threshold_mm": "4"}),
        "retread_threshold_mm",
    ),
    ("max retreads bool", threshold("FLEET", {"max_retreads": True}), "max_retreads"),
    (
        "max retreads decimal",
        threshold("FLEET", {"max_retreads": Decimal("1.0")}),
        "max_retreads",
    ),
    (
        "permitted not bool",
        threshold("STEER", {"retreads_permitted": 0}),
        "retreads_permitted",
    ),
    ("spare target", target("SPARE", {"target_kpa": 700}), "SPARE"),
    ("fleet target", target("FLEET", {"target_kpa": 700}), "FLEET"),
    ("target not int", target("STEER", {"target_kpa": Decimal("800.5")}), "target_kpa"),
    ("target bool", target("STEER", {"target_kpa": True}), "target_kpa"),
    ("pct precision", target("STEER", {"warn_under_pct": Decimal("12.25")}), "12.25"),
    ("pct string", target("STEER", {"warn_under_pct": "10"}), "warn_under_pct"),
    ("warn under 100", target("STEER", {"warn_under_pct": 100}), "warn_under_pct"),
    (
        "critical under 100",
        target("DRIVE", {"critical_under_pct": 200}),
        "critical_under_pct",
    ),
    ("platform_owned not a bool", put("platform_owned", "yes"), "platform_owned"),
    ("client file, consent left out", drop("consent"), "platform_owned"),
    ("client file, consent empty", consent(), "platform_owned"),
    ("platform-owned with a record", put("platform_owned", True), "platform_owned"),
    ("consent without notice", consent(record(notice_version=...)), "notice_version"),
    ("blank notice", consent(record(notice_version="  ")), "notice_version"),
    ("notice not a string", consent(record(notice_version=3)), "notice_version"),
    ("purpose", consent(record(purpose="MARKETING")), "MARKETING"),
    ("no purpose", consent(record(purpose=...)), "purpose"),
    ("purpose twice", consent(record(), record(granted=False)), "SERVICE_DELIVERY"),
    ("granted not a bool", consent(record(granted="yes")), "granted"),
    ("no granted", consent(record(granted=...)), "granted"),
    ("consent not a list", put("consent", {"purpose": "SERVICE_DELIVERY"}), "consent"),
]


class Refusals(unittest.TestCase):
    def test_minimal_validates(self):
        validate(minimal())

    def test_refusals(self):
        for label, mutate, phrase in REFUSALS:
            with self.subTest(label):
                doc = mutate(copy.deepcopy(minimal()))
                with self.assertRaises(Refusal) as caught:
                    validate(doc)
                self.assertIn(phrase, str(caught.exception))

    def test_id_message_says_why(self):
        doc = minimal()
        doc["id"] = "x"
        with self.assertRaises(Refusal) as caught:
            validate(doc)
        self.assertIn("TYRE-397", str(caught.exception))

    def test_repeated_key_refused(self):
        path = raw(
            '{"name": "a", "name": "b", "subdomain": "a", "depots": [{"name": "A"}],'
            ' "platform_owned": true}'
        )
        with self.assertRaises(Refusal) as caught:
            load(path)
        self.assertIn("name", str(caught.exception))

    def test_repeated_nested_key_refused(self):
        path = raw(
            '{"name": "a", "subdomain": "a", "depots": [{"name": "A"}], "platform_owned": true,'
            ' "policy": {"configuration": {}}, "policy": {"target_pressure": {}}}'
        )
        with self.assertRaises(Refusal) as caught:
            load(path)
        self.assertIn("policy", str(caught.exception))

    def test_nan_refused(self):
        for constant in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(constant):
                path = raw(
                    '{"name": "a", "subdomain": "a", "depots": [{"name": "A"}], "platform_owned": true,'
                    ' "policy": {"configuration": {"width_spread_warn_mm": %s}}}'
                    % constant
                )
                with self.assertRaises(Refusal):
                    load(path)

    def test_utf16_refused(self):
        path = written(minimal(), encoding="utf-16")
        with self.assertRaises(Refusal) as caught:
            load(path)
        self.assertIn("UTF-8", str(caught.exception))

    def test_cp1252_refused(self):
        doc = minimal()
        doc["depots"] = [{"name": DEPOT_SUD}]
        path = written(doc, encoding="cp1252")
        with self.assertRaises(Refusal) as caught:
            load(path)
        self.assertIn("UTF-8", str(caught.exception))

    def test_bom_accepted(self):
        validate(load(written(minimal(), encoding="utf-8-sig")))

    def test_numbers_load_as_decimal(self):
        doc = minimal()
        path = raw(
            json.dumps(doc)[:-1]
            + ', "policy": {"threshold_policy": {"FLEET": {"retread_threshold_mm": 4.1}}}}'
        )
        loaded = load(path)
        value = loaded["policy"]["threshold_policy"]["FLEET"]["retread_threshold_mm"]
        self.assertIs(type(value), Decimal)
        self.assertEqual(value, Decimal("4.1"))


class Merge(unittest.TestCase):
    def fleet(self, **over):
        row = {
            "retread_threshold_mm": RETREAD_THRESHOLD_MM,
            "warning_threshold_mm": WARNING_THRESHOLD_MM,
            "max_retreads": MAX_RETREADS,
            "retreads_permitted": True,
        }
        row.update(over)
        return row

    def test_defaults_when_no_policy(self):
        p = validate(minimal())
        self.assertEqual(p["configuration"], CONFIG_DEFAULTS)
        self.assertEqual(
            p["thresholds"],
            [(None, self.fleet()), ("STEER", self.fleet(**CLASS_THRESHOLDS["STEER"]))],
        )
        self.assertEqual(
            p["pressures"],
            [
                (cls, {"target_kpa": kpa, **PRESSURE_TOLERANCE_PCT})
                for cls, kpa in TARGET_KPA.items()
            ],
        )
        self.assertEqual(len(p["pressures"]), 4)

    def test_configuration_override(self):
        p = validate(config("reading_staleness_days", 21)(minimal()))
        self.assertEqual(dict(p["configuration"])["reading_staleness_days"], 21)
        self.assertEqual(
            [k for k, _ in p["configuration"]], [k for k, _ in CONFIG_DEFAULTS]
        )

    def test_class_scope_starts_from_fleet_row(self):
        doc = threshold(
            "FLEET",
            {
                "retread_threshold_mm": Decimal("5.0"),
                "warning_threshold_mm": Decimal("7.0"),
            },
        )(minimal())
        rows = dict(validate(doc)["thresholds"])
        self.assertEqual(rows[None]["retread_threshold_mm"], Decimal("5.0"))
        self.assertEqual(rows["STEER"]["retread_threshold_mm"], Decimal("5.0"))
        self.assertEqual(rows["STEER"]["warning_threshold_mm"], Decimal("7.0"))
        self.assertIs(rows["STEER"]["retreads_permitted"], False)

    def test_new_class_scope(self):
        rows = validate(threshold("DRIVE", {"max_retreads": 1})(minimal()))[
            "thresholds"
        ]
        self.assertEqual([scope for scope, _ in rows], [None, "STEER", "DRIVE"])
        self.assertEqual(dict(rows)["DRIVE"], self.fleet(max_retreads=1))

    def test_class_order_is_the_enum_order(self):
        doc = policy(
            minimal(),
            "threshold_policy",
            {"SPARE": {"max_retreads": 0}, "TRAILER": {"max_retreads": 3}, "FLEET": {}},
        )
        rows = validate(doc)["thresholds"]
        self.assertEqual(
            [scope for scope, _ in rows], [None, "STEER", "TRAILER", "SPARE"]
        )

    def test_target_override(self):
        rows = dict(
            validate(target("STEER", {"target_kpa": 820})(minimal()))["pressures"]
        )
        self.assertEqual(rows["STEER"], {"target_kpa": 820, **PRESSURE_TOLERANCE_PCT})
        self.assertEqual(rows["DRIVE"]["target_kpa"], TARGET_KPA["DRIVE"])


class Sql(unittest.TestCase):
    def sql(self, doc=None):
        return provisioning_sql(validate(doc or minimal()), TID)

    def test_every_policy_row_dated_minus_infinity(self):
        p = validate(minimal())
        text = provisioning_sql(p, TID)
        self.assertNotIn("2024-01-01", text)
        self.assertNotIn("now()", text)
        rows = len(p["configuration"]) + len(p["thresholds"]) + len(p["pressures"])
        self.assertEqual(text.count("'-infinity'"), rows)

    def test_binding_before_tenant_row(self):
        text = self.sql(put("timezone", "Pacific/Kiritimati")(minimal()))
        begin = text.index("BEGIN;")
        bind = text.index("set_config('app.tenant_id', '%s', true)" % TID)
        zone = text.index("pg_timezone_names")
        tenant = text.index("INSERT INTO app.tenant ")
        self.assertLess(begin, bind)
        self.assertLess(bind, zone)
        self.assertLess(zone, tenant)
        self.assertEqual(text.count("COMMIT;"), 1)
        self.assertTrue(text.rstrip().endswith("COMMIT;"))

    def test_no_timezone_check_without_timezone(self):
        self.assertNotIn("pg_timezone_names", self.sql())

    def test_tenant_row_is_provisioning(self):
        line = next(
            ln
            for ln in self.sql().split("\n")
            if ln.startswith("INSERT INTO app.tenant ")
        )
        self.assertIn("'PROVISIONING'", line)
        self.assertIn(f"'{TID}'", line)

    def test_sql_literal_doubles_quotes(self):
        self.assertEqual(sql_literal("Harbour's"), "'Harbour''s'")
        text = self.sql(put("name", "Harbour's Test Fleet")(minimal()))
        self.assertIn("'Harbour''s Test Fleet'", text)
        self.assertNotIn("'Harbour's", text)

    def test_quote_in_a_removal_reason(self):
        text = self.sql(config("removal_reasons", ["driver's report"])(minimal()))
        self.assertIn("'[\"driver''s report\"]'::jsonb", text)

    def test_counter_only_for_generated(self):
        self.assertNotIn("INSERT INTO app.display_code_counter", self.sql())
        text = self.sql(generated("PTF")(minimal()))
        self.assertEqual(text.count("INSERT INTO app.display_code_counter"), 1)
        self.assertIn("'PTF'", text)

    def test_platform_owned_without_consent(self):
        for doc in (
            drop("consent")(put("platform_owned", True)(minimal())),
            consent()(put("platform_owned", True)(minimal())),
        ):
            with self.subTest(consent=doc.get("consent", "absent")):
                p = validate(doc)
                self.assertEqual(row_counts(p)["tenant_consent"], 0)
                self.assertNotIn(
                    "INSERT INTO app.tenant_consent", provisioning_sql(p, TID)
                )

    def test_counts_match_statements(self):
        doc = generated("PTF")(minimal())
        doc["depots"].append({"name": "Second", "type": "STORE", "address": "2 Road"})
        doc["consent"].append(
            {
                "purpose": "ANONYMISED_BENCHMARKING",
                "granted": False,
                "notice_version": "n1",
            }
        )
        p = validate(threshold("DRIVE", {"max_retreads": 1})(doc))
        lines = provisioning_sql(p, TID).split("\n")

        def inserts(table):
            return sum(1 for ln in lines if ln.startswith(f"INSERT INTO app.{table} "))

        counts = row_counts(p)
        self.assertEqual(
            list(counts),
            [
                "configuration",
                "threshold_policy",
                "target_pressure",
                "axle_configuration",
                "position",
                "exception_rule",
                "display_code_counter",
                "depot",
                "tenant_consent",
            ],
        )
        for table in counts:
            if table in ("axle_configuration", "position"):
                continue
            with self.subTest(table):
                self.assertEqual(inserts(table), counts[table])
        self.assertEqual(inserts("axle_configuration"), counts["axle_configuration"])
        self.assertEqual(counts["axle_configuration"], len(UNITS))
        self.assertEqual(counts["exception_rule"], len(EXCEPTION_RULES))
        position_rows = sum(
            1 for ln in lines if ln.startswith(f"  ('{TID}',md5('{TID}")
        )
        self.assertEqual(position_rows, counts["position"])
        self.assertEqual(
            counts["position"], sum(len(build(axles)) + 1 for *_, axles in UNITS)
        )

    def test_count_gate_states_every_count(self):
        p = validate(generated("PTF")(minimal()))
        text = provisioning_sql(p, TID)
        gate = text[text.index("-- count gate") :]
        for table, n in row_counts(p).items():
            with self.subTest(table):
                self.assertIn(f"('{table}', {n})", gate)
        self.assertLess(
            text.index("seed_tenant_catalogue"), text.index("-- count gate")
        )
        self.assertLess(text.index("-- count gate"), text.index("COMMIT;"))


class Template(unittest.TestCase):
    def template(self):
        return load(TEMPLATE)

    def test_defaults_pass_their_domains(self):
        doc = policy(
            minimal(),
            "configuration",
            {k: as_loaded(v) for k, v in CONFIG_DEFAULTS},
        )
        p = validate(doc)
        self.assertEqual(p["configuration"], CONFIG_DEFAULTS)

    def test_template_lists_every_default(self):
        pol = self.template()["policy"]
        self.assertEqual(pol["configuration"], dict(CONFIG_DEFAULTS))
        self.assertEqual(list(pol["configuration"]), [k for k, _ in CONFIG_DEFAULTS])
        self.assertEqual(
            pol["threshold_policy"],
            {
                "FLEET": {
                    "retread_threshold_mm": RETREAD_THRESHOLD_MM,
                    "warning_threshold_mm": WARNING_THRESHOLD_MM,
                    "max_retreads": MAX_RETREADS,
                    "retreads_permitted": True,
                },
                **CLASS_THRESHOLDS,
            },
        )
        self.assertEqual(
            pol["target_pressure"],
            {
                cls: {"target_kpa": kpa, **PRESSURE_TOLERANCE_PCT}
                for cls, kpa in TARGET_KPA.items()
            },
        )

    def test_template_refused_until_notice_filled(self):
        doc = self.template()
        with self.assertRaises(Refusal) as caught:
            validate(doc)
        self.assertIn("notice_version", str(caught.exception))
        for rec in doc["consent"]:
            rec["notice_version"] = "signed-2026-10"
        validate(doc)


class Main(unittest.TestCase):
    def run_main(self, doc_path, out):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main([doc_path, out])
        return code, stdout.getvalue(), stderr.getvalue()

    def out_path(self):
        return scratch(".tenant.sql")

    def test_main_success(self):
        out = self.out_path()
        code, stdout, _ = self.run_main(written(minimal()), out)
        self.assertEqual(code, 0)
        first = stdout.split("\n")[0]
        self.assertRegex(first, r"^tenant id: [0-9a-f-]{36}$")
        with open(out, encoding="utf-8") as f:
            self.assertIn(first.split(": ")[1], f.read())
        self.assertEqual(stdout.split("\n")[1], f"wrote {out}")
        self.assertIn("configuration 16", stdout)

    def test_each_run_mints_a_fresh_id(self):
        path = written(minimal())
        ids = {self.run_main(path, self.out_path())[1].split("\n")[0] for _ in range(2)}
        self.assertEqual(len(ids), 2)

    def test_main_refusal_writes_nothing(self):
        doc = minimal()
        doc["id"] = "x"
        out = self.out_path()
        code, _, stderr = self.run_main(written(doc), out)
        self.assertEqual(code, 2)
        self.assertFalse(os.path.exists(out))
        self.assertTrue(stderr.startswith("refused: "), stderr)

    def test_non_ascii_round_trips(self):
        doc = minimal()
        doc["depots"] = [{"name": DEPOT_SUD}]
        path = raw(json.dumps(doc, ensure_ascii=False))
        out = self.out_path()
        code, _, _ = self.run_main(path, out)
        self.assertEqual(code, 0)
        with open(out, "rb") as f:
            self.assertIn(DEPOT_SUD.encode("utf-8"), f.read())

    def test_output_is_lf(self):
        out = self.out_path()
        self.assertEqual(self.run_main(written(minimal()), out)[0], 0)
        with open(out, "rb") as f:
            self.assertNotIn(b"\r\n", f.read())

    def test_output_declares_utf8(self):
        out = self.out_path()
        self.run_main(written(minimal()), out)
        with open(out, encoding="utf-8") as f:
            text = f.read()
        self.assertIn("SET client_encoding = 'UTF8';", text)
        self.assertIn("\\set ON_ERROR_STOP on", text)


if __name__ == "__main__":
    unittest.main()
