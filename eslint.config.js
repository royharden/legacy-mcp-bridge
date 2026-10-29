// eslint.config.js — flat config. TypeScript-recommended everywhere; stdout is MCP protocol only (no console in src/);
// money paths ban float parsing and toFixed; legacy/ is plain JavaScript and gets the basic recommended rules only.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const MONEY_MESSAGE = "Money is integer minor units with BigInt intermediates; no float parsing or formatting on money paths.";

const nodeGlobals = {
  process: "readonly",
  Buffer: "readonly",
  console: "readonly",
  URL: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
};

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "results/**", "fixtures/**", "coverage/**"],
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    files: ["src/fixedwidth/**/*.ts", "src/bridge/**/*.ts", "parity/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "parseFloat", message: MONEY_MESSAGE }],
      "no-restricted-properties": ["error", { object: "Number", property: "parseFloat", message: MONEY_MESSAGE }],
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.name='parseFloat']", message: MONEY_MESSAGE },
        { selector: "MemberExpression[property.name='toFixed']", message: MONEY_MESSAGE },
      ],
    },
  },
  {
    files: ["legacy/**/*.mjs", "eslint.config.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: nodeGlobals,
    },
  },
);
