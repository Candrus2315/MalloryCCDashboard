import { parseAcuityAppointment, parseAcuityDateCreatedCalendar, parseAcuityInstant } from "../src/server/sync/acuity-live";
const row: Record<string, unknown> = {
  id: "1", datetime: "2026-10-07T20:30:00-0400",
  datetimeCreated: "2026-09-21T11:27:31-0500", dateCreated: "September 21, 2026",
  type: "x", canceled: false, firstName: "J", lastName: "D", phone: "", email: "",
};
console.log("instant:", parseAcuityInstant("2026-09-21T11:27:31-0500"));
console.log("calendar Sep 1:", parseAcuityDateCreatedCalendar("Sep 1, 2026"));
const p = parseAcuityAppointment(row);
console.log(JSON.stringify({ createdAt: p?.createdAt, cbd: p?.createdAtBusinessDate, prec: p?.createdTimePrecision, src: p?.createdTimeSource }));
