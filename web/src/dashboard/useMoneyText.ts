import { moneyOrEmpty, moneyText, useCurrency } from "../api/money";
import type { MoneyFigure, MoneyLine } from "./dashboard.view";

// Rule 2: a view hands money on as the wire string, and this is where it
// meets the tenant's currency, through formatMoney and nowhere else.
export function useMoneyText() {
  const currency = useCurrency();
  function figure(f: MoneyFigure): string {
    return f.set === undefined
      ? moneyText(f.value, f.visible, currency)
      : moneyOrEmpty(f.value, f.visible, f.set.tyreCount, f.set.empty, currency);
  }
  function line(l: MoneyLine): string {
    return "text" in l ? l.text : `${l.before}${figure(l.money)}${l.after}`;
  }
  return { figure, line };
}
