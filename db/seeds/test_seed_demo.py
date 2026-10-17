import re
import unittest

from gen_seed_demo import demo_sql
from gen_seed_fixture import FIXTURE, fixture_body

# Case-sensitive on purpose: ids are lowercase hex, and the fixture's strings
# name BAC in capitals (U92: the readings must never read as findings about
# BAC's vehicles).
BAC = re.compile(r"BAC|Bac|\bbac\b")


class DemoTenant(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = demo_sql()

    def test_names_no_bac(self):
        found = BAC.search(self.sql)
        self.assertIsNone(found, found and self.sql[found.start() - 80 : found.end()])

    def test_no_sign_in_subject(self):
        self.assertNotIn("subject-", self.sql)

    def test_no_branding_row(self):
        self.assertNotIn("'branding'", self.sql)

    def test_one_tenant(self):
        self.assertNotIn("22222222-", self.sql)
        self.assertNotIn("33333333-", self.sql)
        self.assertIn("'Demonstration Fleet','demo','ACTIVE'", self.sql)

    def test_binds_before_tenant_row(self):
        begin = self.sql.index("BEGIN;")
        bind = self.sql.index("set_config('app.tenant_id'")
        tenant = self.sql.index("INSERT INTO app.tenant ")
        self.assertLess(begin, bind)
        self.assertLess(bind, tenant)
        self.assertTrue(self.sql.endswith("COMMIT;\n"))
        self.assertEqual(self.sql.count("COMMIT;"), 1)

    def test_numbers_kept(self):
        fixture = "\n".join(fixture_body(FIXTURE, others=False)).split("\n")
        demo = self.sql.split("\n")
        for prefix in ("INSERT INTO app.reading_measurement", "INSERT INTO app.tyre "):
            want = sum(1 for line in fixture if line.startswith(prefix))
            self.assertGreater(want, 0, prefix)
            self.assertEqual(
                sum(1 for line in demo if line.startswith(prefix)), want, prefix
            )


if __name__ == "__main__":
    unittest.main()
