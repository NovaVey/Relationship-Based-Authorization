import { defineConfig } from 'tsup';

export default defineConfig({
  // Every source file is its own entry, and bundle:false makes tsup
  // transpile each one independently rather than inlining imports —
  // this mirrors src/ 1:1 into dist/ instead of producing one fully
  // self-contained bundle per public entry point.
  //
  // This is load-bearing, not a style preference: src/tenant/context.ts
  // holds a module-level `AsyncLocalStorage` singleton that every other
  // module (rbac, rate-limit, audit) reads the active tenant from. With
  // bundle:true (the default), each of the package's public entry
  // points (., ./tenant, ./rbac, ./rate-limit, ...) gets built as an
  // independent, fully self-contained file — which means each one
  // inlines its OWN separate copy of context.ts, and therefore its own
  // separate AsyncLocalStorage instance. A consumer mixing subpath
  // imports (e.g. createTenantMiddleware from ./tenant with
  // subjectFromRequestRoles from ./rbac — exactly what the README's
  // own quickstart shows) would silently talk to two different
  // storages: the tenant middleware writes to one, rbac reads from
  // the other, and every read throws TenantContextError.
  //
  // Compiling module-per-file instead lets Node's own module
  // resolution — the ESM registry and the CJS require() cache, both
  // keyed by resolved file path — guarantee context.ts loads exactly
  // once per process, so every entry point that imports it (directly
  // or transitively) shares the same singleton. This works identically
  // for both output formats; `splitting: true` would not, since esbuild
  // does not support chunk-splitting for CJS output at all.
  entry: ['src/**/*.ts'],
  bundle: false,
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  outDir: 'dist',
});
