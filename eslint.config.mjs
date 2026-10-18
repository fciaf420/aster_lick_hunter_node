import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const REACT_APIS_MISSING_FROM_NEXT_VENDORED_REACT = [
  "Activity",
  "ViewTransition",
  "addTransitionType",
  "useEffectEvent",
];

const REACT_APIS_PATTERN = REACT_APIS_MISSING_FROM_NEXT_VENDORED_REACT.join("|");

const REACT_VENDORED_MESSAGE =
  "Not exported by the React vendored in Next 15.5 (next/dist/compiled/react), " +
  "which is what App Router pages run on. It would type-check and pass jest but " +
  "throw at runtime. See AGENTS.md (React version note).";

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_"
      }],
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // Next 15.5 runs App Router pages on its own vendored React
    // (next/dist/compiled/react, a 19.2 canary) rather than node_modules/react.
    // These APIs exist in the installed react 19.3 and in @types/react 19.3, so
    // tsc, jest and `next build` all accept them, but they are undefined at
    // runtime in the real app. Remove this block once Next vendors a React that
    // exports them (verify with: node -e "console.log(Object.keys(
    // require('next/dist/compiled/react')))").
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      // no-restricted-syntax rather than no-restricted-imports: the latter also
      // rejects every `import * as React from "react"` once importNames is set.
      "no-restricted-syntax": [
        "error",
        {
          selector: `ImportDeclaration[source.value='react'] > ImportSpecifier[imported.name=/^(${REACT_APIS_PATTERN})$/]`,
          message: REACT_VENDORED_MESSAGE,
        },
        {
          selector: `:matches(MemberExpression, JSXMemberExpression)[object.name='React'][property.name=/^(${REACT_APIS_PATTERN})$/]`,
          message: REACT_VENDORED_MESSAGE,
        },
      ],
    },
  },
  {
    files: ["src/app/wiki/**/*.tsx"],
    rules: {
      "react/no-unescaped-entities": "off",
    },
  },
];

export default eslintConfig;
