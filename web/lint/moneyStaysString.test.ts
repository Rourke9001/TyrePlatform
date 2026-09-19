// @vitest-environment node
import { afterAll, describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { moneyStaysString } from "./moneyStaysString.js";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// The same brand web/src/api/money.ts declares, inlined so each case is one
// self-contained program; the rule finds it by the property name.
const brand =
  'type Money = string & { readonly __money: "rand" }; declare const m: Money; declare const s: string; declare const q: number; declare const maybe: Money | undefined; let acc: Money;';

const tester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: { allowDefaultProject: ["*.ts*"] },
      tsconfigRootDir: fileURLToPath(new URL("./fixtures/", import.meta.url)),
    },
  },
});

tester.run("money-stays-string", moneyStaysString, {
  valid: [
    { code: `${brand} const label = "R" + m;` },
    { code: `${brand} const copy: string = m;` },
    { code: `${brand} Number(s); parseFloat(s); parseInt(s, 10); q * 2; -q;` },
    { code: `${brand} const label2 = "R" + m + " in total";` },
  ],
  invalid: [
    { code: `${brand} Number(m);`, errors: [{ messageId: "money" }] },
    { code: `${brand} parseFloat(m);`, errors: [{ messageId: "money" }] },
    { code: `${brand} parseInt(m, 10);`, errors: [{ messageId: "money" }] },
    { code: `${brand} +m;`, errors: [{ messageId: "money" }] },
    { code: `${brand} -m;`, errors: [{ messageId: "money" }] },
    { code: `${brand} m + m;`, errors: [{ messageId: "money" }] },
    { code: `${brand} m - s;`, errors: [{ messageId: "money" }] },
    { code: `${brand} q * m;`, errors: [{ messageId: "money" }] },
    { code: `${brand} if (maybe) { maybe / 2; }`, errors: [{ messageId: "money" }] },
    { code: `${brand} acc -= s;`, errors: [{ messageId: "money" }] },
  ],
});
