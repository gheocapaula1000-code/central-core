// Type-only ambient declaration for the Deno global provided by the Supabase
// Edge Functions runtime. Emits nothing and changes no runtime behavior; it
// only lets repo-wide typechecks resolve `Deno` in edge function sources.
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve: (handler: (req: Request) => Response | Promise<Response>) => unknown;
};
