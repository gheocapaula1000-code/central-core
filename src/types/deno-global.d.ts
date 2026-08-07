// Type-only declaration for the Deno global provided by the Supabase Edge
// Functions runtime. Some edge-function modules are imported by Vitest suites,
// so the repo typecheck must know the global exists. This declaration emits
// nothing and does not change any runtime behavior.
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve: (handler: (req: Request) => Response | Promise<Response>) => unknown;
};
