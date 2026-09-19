// house/money-stays-string: rule 2's web half, enforced rather than
// remembered (spec U31, U37; TYRE-36). A value typed Money
// (web/src/api/money.ts) is the server's exact decimal string, and every
// conversion or arithmetic operator on it reintroduces the double the
// string boundary exists to keep out. Money + Money is refused too:
// concatenating two amounts is never meant. "R" + money, a label, is fine.
//
// Type-aware on purpose: Number() is right for a quantity and an odometer,
// so a syntactic ban would fail correct code. The brand is found by
// property name, which is why Money declares __money as a plain key.
const CONVERTERS = new Set(["Number", "parseFloat", "parseInt"]);
const ARITHMETIC = new Set(["-", "*", "/", "%", "**"]);
const COMPOUND = new Set(["-=", "*=", "/=", "%=", "**="]);

function isMoney(type) {
  if (type.isUnion()) {
    return type.types.some(isMoney);
  }
  return type.getProperty("__money") !== undefined;
}

// ts.TypeFlags.NumberLike, spelled as the bits so the rule needs no
// typescript import of its own.
const NUMBER_LIKE = 8 | 32 | 256;

function isNumeric(type) {
  if (type.isUnion()) {
    return type.types.some(isNumeric);
  }
  return (type.flags & NUMBER_LIKE) !== 0;
}

export const moneyStaysString = {
  meta: {
    type: "problem",
    docs: {
      description: "money is the server's decimal string; never convert it or do arithmetic on it",
    },
    schema: [],
    messages: {
      money:
        "{{what}} on a Money value. Money stays the server's decimal string (rule 2): format it with formatRand, and a total is a SQL column, never a client sum.",
    },
  },
  defaultOptions: [],
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
      // Loud, not quiet: a gate that cannot see types must not pass. The
      // config turns this rule off for the files that have no program.
      throw new Error(
        "house/money-stays-string needs type information: enable parserOptions.projectService for this file or turn the rule off for it",
      );
    }
    const checker = services.program.getTypeChecker();
    const typeOf = (node) => checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
    const money = (node) => isMoney(typeOf(node));
    const numeric = (node) => isNumeric(typeOf(node));
    const refuse = (node, what) => context.report({ node, messageId: "money", data: { what } });
    return {
      CallExpression(node) {
        // globalThis.Number(m) reaches the same converter as Number(m), so
        // the callee is matched through a member access too, or a rename
        // walks around the rule.
        const callee = node.callee;
        const name =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" &&
                !callee.computed &&
                callee.property.type === "Identifier"
              ? callee.property.name
              : null;
        if (
          name !== null &&
          CONVERTERS.has(name) &&
          node.arguments.length > 0 &&
          money(node.arguments[0])
        ) {
          refuse(node, `${name}()`);
        }
      },
      UnaryExpression(node) {
        if ((node.operator === "+" || node.operator === "-") && money(node.argument)) {
          refuse(node, `unary ${node.operator}`);
        }
      },
      BinaryExpression(node) {
        const arithmetic = ARITHMETIC.has(node.operator) && (money(node.left) || money(node.right));
        // `+` is the one operator a label legitimately uses ("R" + m), so it
        // is refused only where the other side is money or a number: both
        // read as arithmetic and neither is, since JavaScript concatenates.
        const added =
          node.operator === "+" &&
          ((money(node.left) && (money(node.right) || numeric(node.right))) ||
            (money(node.right) && (money(node.left) || numeric(node.left))));
        if (arithmetic || added) {
          refuse(node, `operator ${node.operator}`);
        }
      },
      AssignmentExpression(node) {
        if (COMPOUND.has(node.operator) && (money(node.left) || money(node.right))) {
          refuse(node, `operator ${node.operator}`);
        }
      },
    };
  },
};
