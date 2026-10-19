// IndexedDB for engine tests running in Node
import "fake-indexeddb/auto";
// Offline tests must never contact the production gateway.
process.env.NEXT_PUBLIC_GATEWAY_URL = "";

// Tests never use the accounts built into app builds (web/.env.local)
for (const k of Object.keys(process.env)) if (/^NEXT_PUBLIC_(GCD|COMICVINE|METRON)_/.test(k)) delete process.env[k];
