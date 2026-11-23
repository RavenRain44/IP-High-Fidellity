// calendar-add: put a meeting the user confirmed onto their Google or Outlook calendar.
// All logic lives in ../_shared/calendar-add.ts.
import { calendarAddHandler } from '../_shared/calendar-add.ts';
Deno.serve(calendarAddHandler);
