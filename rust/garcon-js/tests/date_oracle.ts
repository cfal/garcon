if (Bun.version !== "1.4.3") throw new Error("Expected Bun 1.4.3, got " + Bun.version);

const dates = [
  "", "2024", "2024-2", "2024-2-3", "2024-02-03", " 2024-02-03 ",
  "02/03/04", "2024/02/03", "03 Feb 2024", "Sat, 03 Feb 2024 12:34:56 GMT",
  "2024-02-03 12:34:56", "2024-02-03T12:34:56", "2024-02-03T12:34:56+0230",
  "2024-02-03T12:34:56+02", "2024-02-03T12:34:56.123456Z",
  "2024-02-03T12:34:56.000000000123456Z", "2024-2-3T00:00:00Z",
  " 2024-02-03T00:00:00Z ", "2024-02-30", "2024-02-30T00:00:00Z",
  "2023-02-29", "2024-02-32", "2024-02-03T24:00:00Z", "2024-02-03T24:01:00Z",
  "2024-02-03T24:00:00.0001Z", "2024-02-03T23:59:60Z",
  "0", "12", "13", "32", "49", "50", "99", "0012", "0012 ", "0099", "20240203",
  "+275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.001Z",
  "+275760-09-13T00:00:00.000", "-271821-04-20T00:00:00.000Z",
  "-271821-04-19T23:59:59.999Z", "-271821-04-20T00:00:00.000",
  "-000001-01-01T00:00Z", "+000000-01-01", "-000000-01-01", "0000-01-01",
  "2024-01T12:34Z", "2024T12:34Z", "2024-02-03t04:00z", "2024-02-03Z",
  "2024-02-03 (comment (nested))", "2024-02-03 (unterminated", "2024-02-03)",
  "xyz123", "xyz 2024/02/03", "2024/02/03 xyz", "2024-02-03\0after",
  "04/09/2023 3::25", "04/09/2023 3:25.123", "04/09/2023 3:25:12.125 PM",
  "04/09/2023 3:25:12PM", "04/09/2023 13:25 PM", "04/09/2023 02:12 Z",
  "Sat Feb 3 2024 12:34:56 GMT-8", "Sat Feb 3 2024 12:34:56 GMT-8:59",
  "Sat Feb 3 2024 12:34:56 GMT-8:60", "Sat Feb 3 2024 12:34:56 GMT-999999999:30",
  "2024\u00a0Feb\u202f03", "\ufeffSat, 03 Feb 2024 12:34:56 GMT",
  "2024-02-03 12:30:00\v", "2024-02-03 12:30:00\v(\u0100)",
  "2024-02-03 12:30:00\v\u00a0", "2024-02-03 12:30:00\v\u202f",
  "2024-02-03\u2028", "\u20292024-02-03", "2024-02-03\u0085", "2024\t02 03",
  "Sat, 03 Februaryextended 2024 12:34:56 GMT", "2024-02.03", "2024/02/03/",
  "2024-03-10T01:59:59", "2024-03-10T02:00:00", "2024-03-10T02:30:00",
  "2024-03-10T03:00:00", "2024-11-03T01:30:00", "2024-11-03T02:00:00",
  "2024-04-07T02:30:00", "2024-09-29T02:30:00", "1883-11-18T12:00:00",
  "1906-01-01T00:04:00", "1972-01-07T00:00:00", "1972-01-07T00:44:29",
  "1800-01-01T00:00:00", "1900-01-01T00:00:00", "1940-01-01T00:00:00",
];

for (const year of ["0001", "07", "99", "1970", "2024", "+010000"]) {
  for (const monthDay of ["-01-01", "-04-31", "-0-2", "/2/12", "/02/03", " feb 2"]) {
    for (const time of ["", " T01:02Z", "T01:02+1730", " 12:12:01 GMT", " 1:02:03 AM"]) {
      dates.push(year + monthDay + time);
    }
  }
}

const instants = [
  -8640000000000001, -8640000000000000, 8640000000000000, 8640000000000001,
  -210866803200000, -62198755200000, -62167219200000, -62135596800000, -1, 0, 1,
  ...[
    "1800-01-01T00:00Z", "1883-11-18T16:59:59.999Z", "1883-11-18T17:00Z",
    "1900-01-01T00:00Z", "1906-01-01T00:00Z", "1940-01-01T00:00Z",
    "1972-01-07T00:44:29.999Z", "1972-01-07T00:44:30Z",
    "2024-03-10T06:59:59.999Z", "2024-03-10T07:00Z",
    "2024-11-03T05:59:59.999Z", "2024-11-03T06:00Z", "2024-11-03T00:00Z",
    "2100-09-30T12:00:00.251Z", "2100-04-01T00:00:00.501Z",
  ].map((date) => Date.parse(date)),
];

const names = [
  "UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland", "Africa/Monrovia",
  "America/Coyhaique", "aMeRiCa/NeW_yOrK", "ASIA/CALCUTTA", "US/Eastern", "NZ",
  "CET", "EST", "MST", "HST", "PST", "CST", "IST", "WET", "America/Atka",
  "US/Pacific-New", "Canada/East-Saskatchewan", "SystemV/EST5", "Etc/Unknown",
  "GMT0", "Etc/GMT", "Etc/GMT+5", "Etc/Universal", "Etc/Zulu", "Factory",
  "+01", "+0130", "-0130", "+01:30", "-00:00", "+2359", "+24:00", "+01:60",
  "+1", "+01:00:00", "\u221201:30", "UTC+01", "UTC ", "", "does/not/exist",
];

const local = instants.map((time) => {
  const date = new Date(time);
  return [time, Number.isNaN(date.valueOf()) ? null : [
    date.getFullYear(), date.getMonth(), date.getDate(), date.getDay(),
    date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds(),
    date.getTimezoneOffset(),
  ]];
});
const intl = names.map((timeZone) => {
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone, numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit",
    });
    return [timeZone, { days: instants.map((time) => {
      try {
        const parts = Object.fromEntries(f.formatToParts(time).map(({ type, value }) => [type, value]));
        return { day: parts.year.padStart(4, "0") + "-" + parts.month + "-" + parts.day };
      } catch (error) {
        return { error: [error.name, error.message] };
      }
    }) }];
  } catch (error) {
    return [timeZone, { error: [error.name, error.message] }];
  }
});

console.log(JSON.stringify({
  dates: dates.map((text) => [text, Date.parse(text)]),
  local,
  intl,
}));
