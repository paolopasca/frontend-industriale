const PREFIX = 'daino';
const LEGACY_KEYS = [
  'replan_chat_messages',
  'daino_last_session_id',
  'daino_last_run_id',
] as const;

function buildKey(key: string, slug: string): string {
  return `${PREFIX}:${slug}:${key}`;
}

export function setSlugScoped(key: string, slug: string, value: string): void {
  try {
    localStorage.setItem(buildKey(key, slug), value);
  } catch {
    // ignore quota/availability failures
  }
}

export function getSlugScoped(key: string, slug: string): string | null {
  try {
    return localStorage.getItem(buildKey(key, slug));
  } catch {
    return null;
  }
}

export function removeSlugScoped(key: string, slug: string): void {
  try {
    localStorage.removeItem(buildKey(key, slug));
  } catch {
    // ignore
  }
}

export function clearSlugScoped(slug: string): void {
  const prefix = `${PREFIX}:${slug}:`;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) localStorage.removeItem(k);
    }
  } catch {
    // ignore
  }
}

let legacyMigrated = false;
export function migrateLegacyKeys(): void {
  if (legacyMigrated) return;
  legacyMigrated = true;
  try {
    LEGACY_KEYS.forEach(k => {
      try {
        localStorage.removeItem(k);
      } catch {
        // ignore individual key failure
      }
    });
  } catch {
    // ignore
  }
}
