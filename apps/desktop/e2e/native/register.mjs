// Lets plain Node (22.18+, built-in TypeScript type stripping) run the crawler sources, which use
// extensionless relative imports like the rest of the repo: "./core" resolves to "./core.ts".
import { register } from 'node:module';

const hook = `
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(specifier)) {
    try {
      return await next(specifier + '.ts', context);
    } catch {
      // not a .ts file: fall through
    }
  }
  return next(specifier, context);
}`;

register('data:text/javascript,' + encodeURIComponent(hook));
