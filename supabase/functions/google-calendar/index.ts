// google-calendar: former name of calendar-add, kept so app versions already open in browsers keep
// working. Same handler. Safe to delete once no client calls it.
import { calendarAddHandler } from '../_shared/calendar-add.ts';
Deno.serve(calendarAddHandler);
