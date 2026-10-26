import { describe, expect, it } from "vitest";

import { installThemeStyle } from "./themeStyle";
import { themeCss } from "./tokens";

// A fresh document per case, so a style left by another test cannot make a
// second install look idempotent.
function blank(): Document {
  return document.implementation.createHTMLDocument("t");
}

describe("installThemeStyle", () => {
  it("puts the theme stylesheet in the head", () => {
    const doc = blank();
    installThemeStyle(doc);
    const style = doc.head.querySelector("style#tread-tokens");
    expect(style?.textContent).toBe(themeCss());
  });

  it("installs once however often it runs", () => {
    const doc = blank();
    installThemeStyle(doc);
    installThemeStyle(doc);
    expect(doc.querySelectorAll("#tread-tokens")).toHaveLength(1);
  });
});
