// tests/helpers/ts-resolve-hook.mjs
//
// Lets a plain `node --experimental-strip-types` process load clodex's TypeScript
// sources directly: src/ uses ESM `./x.js` specifiers that point at `./x.ts` on
// disk, which Node's resolver does not rewrite on its own. Only relative
// specifiers are touched, and only after the real `.js` fails to resolve.
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
    try {
      return await next(specifier, context);
    } catch {
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
  }
  return next(specifier, context);
}
