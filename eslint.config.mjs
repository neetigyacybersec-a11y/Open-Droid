// Flat config (eslint 9). Replaces the old .eslintrc.json (parser+plugin pairs).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // ISSUE-96: low-level process access is only legal inside the approved
    // services. The architecture test also scans source text; this lint rule
    // gives the same failure at edit time.
    files: ["src/**/*.ts"],
    ignores: ["src/services/process-runner.ts", "src/services/managed-process.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              message: "Use src/services/process-runner.ts or managed-process.ts.",
            },
            {
              name: "child_process",
              message: "Use src/services/process-runner.ts or managed-process.ts.",
            },
          ],
        },
      ],
    },
  },
);
