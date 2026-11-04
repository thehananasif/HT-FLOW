// Eagerly imports every module window so their registerModule() calls run at startup.
// Kept separate from registry.ts: eager globs become static imports, which must not run
// before the registry itself has initialised.
import.meta.glob('./*/index.tsx', { eager: true });
