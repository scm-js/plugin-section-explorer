// The one Node API tests/ko.test.ts uses, for the type-check (the project has no @types/node).
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
