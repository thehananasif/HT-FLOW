// Eagerly imports every feed provider (feeds/*.ts) so registerFeedProvider() runs at startup.
import.meta.glob(['./*.ts', '!./registry.ts', '!./load.ts', '!./*.test.ts'], { eager: true });
