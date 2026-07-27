// Obsidian's own plugin linter — the same rule set the community directory's
// automated review runs against every published version. Run `npm run lint`
// before cutting a release; a failing version is pulled from search within a
// day, so this is cheaper to satisfy here than in a resubmission.
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "build/**", "node_modules/**", "tools/**", "*.mjs"],
  },
  ...obsidianmd.configs.recommended,
  {
    // The recommended set includes type-aware rules (`await-thenable` and
    // friends), which need the program, not just the syntax tree. Scoped to
    // TypeScript: the same config also lints manifest.json, which has no
    // program to build.
    files: ["**/*.ts"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
      globals: {
        // Build-time constant, `define`d by esbuild (see virtual.d.ts).
        __REFLOW_DEV__: "readonly",
        // `manifest.json` lives at the repository root, because that is where
        // the community directory reads it from. This config's base path is
        // plugin/, so the obsidianmd rules can no longer find it and fall back
        // to assuming a mobile-capable plugin, which makes Electron's `process`
        // look undefined. The manifest says `isDesktopOnly: true`; the checks
        // that read it directly live in `npm run lint:manifest`. (The
        // "Failed to load JSON file ... manifest.json" line eslint prints is
        // that same lookup missing, and is harmless.)
        process: "readonly",
      },
    },
    rules: {
      // Warnings, not errors: every one of these lands on a *third-party*
      // surface with no usable types — transformers.js's `env` bag, ORT's
      // wasmPaths, pdf.js internals, and `catch (e: any)`. Typing them properly
      // means hand-writing declarations for libraries that change monthly,
      // which trades a real maintenance burden for no user-visible safety. They
      // stay visible so a new one gets noticed; `npm run lint` fails only on
      // the obsidianmd/* rules, which are the ones review acts on.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-any": "off",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
    },
  },
  {
    // The conversion worker has no `document` and no `activeDocument` — reading
    // `globalThis` is the only way to see what the environment offers — and its
    // console mirror is how worker-side diagnostics reach the renderer at all.
    files: ["worker.ts"],
    rules: {
      "obsidianmd/prefer-active-doc": "off",
      "obsidianmd/rule-custom-message": "off",
    },
  },
  {
    // probe.ts is development-only: release builds resolve it to probe-stub.ts
    // (see esbuild.config.mjs), so nothing here reaches an installed plugin.
    files: ["probe.ts"],
    rules: {
      "obsidianmd/prefer-active-doc": "off",
      "obsidianmd/rule-custom-message": "off",
      "obsidianmd/no-global-app": "off",
    },
  },
);
