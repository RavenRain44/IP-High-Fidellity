// accounts-sync: sync every Google and Microsoft account the signed-in user connected.
// All logic lives in ../_shared/sync-core.ts.
import { syncHandler } from '../_shared/sync-core.ts';
Deno.serve(syncHandler);
