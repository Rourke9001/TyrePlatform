// TYRE-27, TYRE-445: the colour gate for stylesheets, and no other rule. A
// colour reaches a stylesheet only through a custom property that
// src/theme/tokens.ts defines.
const remedy = "Read the token's custom property instead (web/CLAUDE.md, TYRE-27).";
const loadsUrl = new Set(["image-set", "-webkit-image-set", "image", "src"]);

export default {
  // A stylesheet cannot switch the gate off with a stylelint-disable comment.
  ignoreDisables: true,
  rules: {
    "color-no-hex": [true, { message: `A hex colour outside src/theme/tokens.ts. ${remedy}` }],
    "color-named": ["never", { message: `A named colour outside src/theme/tokens.ts. ${remedy}` }],
    // A pattern, since a string entry matches by case and RGB() would pass.
    // image-set(), -webkit-image-set(), image() and src() take a URL as a
    // bare string, which the scheme rule below does not read, so each is
    // refused whole (U206).
    "function-disallowed-list": [
      [
        /^(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)$/i,
        /^(?:-webkit-)?image-set$/i,
        /^image$/i,
        /^src$/i,
      ],
      {
        message: (name) =>
          loadsUrl.has(name.toLowerCase())
            ? `${name}() can load a data: URL from a bare string, which no rule here reads. Write a plain url() instead (ADR-0019, U206).`
            : `A colour function outside src/theme/tokens.ts. ${remedy}`,
      },
    ],
    // The production CSP loads no image, font or stylesheet from a data: URL
    // (ADR-0019), and an encoded one hides its colours from this gate.
    "function-url-scheme-disallowed-list": [
      ["data"],
      {
        message:
          "A data: URL, which the production CSP refuses to load (ADR-0019, U206). Put the file under src/ and url() its path.",
      },
    ],
    // @import loads a URL from its parameters, which no rule above reads,
    // and every stylesheet in src/ is imported from TS (U206). A pattern,
    // since a string entry matches by case and @IMPORT would pass.
    "at-rule-disallowed-list": [
      [/^import$/i],
      {
        message:
          "@import in a stylesheet. Import the stylesheet from TS, as every stylesheet in src/ is (U206).",
      },
    ],
  },
};
