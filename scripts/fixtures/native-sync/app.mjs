// One phone: the app's own native modules, opened on PHONE_DB.
const SRC = new URL('../../../src/', import.meta.url).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function open() {
  const dbn = await import(SRC + 'lib/db-native.js');
  await dbn.getDb();
  const sync = await import(SRC + 'lib/sync.js');
  const { NtApiCached: api } = await import(SRC + 'lib/api-cached.js');
  const online = process.env.NT_SERVER;
  return {
    src: SRC, dbn, api, sleep, fullSync: sync.fullSync,
    async sync() {
      const r = await sync.fullSync(true, true);
      if (!r.ok) throw new Error('sync ' + JSON.stringify(r));
    },
    // Writes made while the server can't be reached.
    async offline(fn) {
      process.env.NT_SERVER = 'http://127.0.0.1:9';
      try { return await fn(); } finally { await sleep(300); process.env.NT_SERVER = online; }
    },
    food: async serverId => (await api.getFoods()).find(f => f.server_id === serverId),
    done(x) { console.log('RESULT ' + JSON.stringify(x ?? null)); process.exit(0); },
  };
}
