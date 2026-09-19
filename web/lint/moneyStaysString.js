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
    const money = (node) =>
      isMoney(checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node)));
    const refuse = (node, what) => context.report({ node, messageId: "money", data: { what } });
    return {
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          CONVERTERS.has(node.callee.name) &&
          node.arguments.length > 0 &&
          money(node.arguments[0])
        ) {
          refuse(node, `${node.callee.name}()`);
        }
      },
      UnaryExpression(node) {
        if ((node.operator === "+" || node.operator === "-") && money(node.argument)) {
          refuse(node, `unary ${node.operator}`);
        }
      },
      BinaryExpression(node) {
        const arithmetic = ARITHMETIC.has(node.operator) && (money(node.left) || money(node.right));
        const concatenated = node.operator === "+" && money(node.left) && money(node.right);
        if (arithmetic || concatenated) {
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
