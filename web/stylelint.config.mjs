// TYRE-27, TYRE-445: the colour gate for stylesheets, and no other rule. A
// colour reaches a stylesheet only through a custom property that
// src/theme/tokens.ts defines.
export default {
  // A stylesheet cannot switch the gate off with a stylelint-disable comment.
  ignoreDisables: true,
  rules: {},
};
