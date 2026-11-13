// PNM records are deleted one year after they were entered. The database does
// the rows (purge_old_pnms(), also run daily by pg_cron); this removes the
// photos left behind, which only the storage API is allowed to delete.

const NOT_SET_UP = /PGRST202|PGRST205|Could not find the (function|table)|Bucket not found|does not exist/i;

export async function pnmRetention(sb) {
  const purged = await sb.rpc('purge_old_pnms');
  if (purged.error) {
    if (NOT_SET_UP.test(`${purged.error.code} ${purged.error.message}`)) return 'recruitment not set up yet';
    throw new Error(`deleting old PNMs: ${purged.error.message}`);
  }

  // Each PNM's photos live in a folder named after his id.
  const folders = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb.storage.from('pnm-photos').list('', { limit: 1000, offset });
    if (error) {
      if (NOT_SET_UP.test(error.message)) return `${purged.data} old PNM record(s) deleted`;
      throw new Error(`listing PNM photos: ${error.message}`);
    }
    folders.push(...data.filter((x) => x.id === null).map((x) => x.name)); // folders have no id
    if (data.length < 1000) break;
  }

  const alive = new Set();
  for (let i = 0; i < folders.length; i += 200) {
    const { data, error } = await sb.from('pnms').select('id').in('id', folders.slice(i, i + 200));
    if (error) throw new Error(`checking PNMs: ${error.message}`);
    data.forEach((r) => alive.add(r.id));
  }

  let removed = 0;
  for (const folder of folders.filter((f) => !alive.has(f))) {
    const { data: files } = await sb.storage.from('pnm-photos').list(folder, { limit: 100 });
    const paths = (files || []).map((f) => `${folder}/${f.name}`);
    if (paths.length) {
      const { error } = await sb.storage.from('pnm-photos').remove(paths);
      if (!error) removed += paths.length;
    }
  }
  return `${purged.data} old PNM record(s) and ${removed} photo(s) deleted`;
}
