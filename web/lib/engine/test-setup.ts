// IndexedDB for engine tests running in Node
import "fake-indexeddb/auto";

// Tests never use the accounts built into app builds (web/.env.local)
for (const k of Object.keys(process.env)) if (/^NEXT_PUBLIC_(GCD|COMICVINE|METRON)_/.test(k)) delete process.env[k];
