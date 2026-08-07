/// <reference types="vite/client" />

// Type-only declaration for the Deno global used by Supabase Edge Functions.
// Some edge-function modules are imported by Vitest suites, so the repo
// typecheck must know the global exists. This declaration is type-only:
// it emits nothing and does not change any runtime behavior.
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve: (handler: (req: Request) => Response | Promise<Response>) => unknown;
};
