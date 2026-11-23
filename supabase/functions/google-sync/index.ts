// google-sync: former name of accounts-sync, kept so app versions already open in browsers keep
// working. Same handler: syncs every connected account. Safe to delete once no client calls it.
import { syncHandler } from '../_shared/sync-core.ts';
Deno.serve(syncHandler);
