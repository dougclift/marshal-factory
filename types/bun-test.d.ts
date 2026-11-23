// The slice of bun:test that the panel clock regression uses to stub next/navigation.
// @types/bun would also retype global fetch, which lib/linear.ts relies on, so this declares only the module.
declare module "bun:test" {
  export const mock: {
    module(specifier: string, factory: () => Record<string, unknown>): void;
  };
}
