// Fixed public holidays under §§1–2 of Act No. 245/2000 Sb. (month-day).
const fixedPublicHolidays = new Set([
  "1-1",
  "5-1",
  "5-8",
  "7-5",
  "7-6",
  "9-28",
  "10-28",
  "11-17",
  "12-24",
  "12-25",
  "12-26",
]);

// Meeus–Jones–Butcher Gregorian computus.
function getEasterSunday(year: number): Temporal.PlainDate {
  const lunarCycleYear = year % 19;
  const century = Math.floor(year / 100);
  const yearOfCentury = year % 100;
  const leapCenturies = Math.floor(century / 4);
  const centuryCorrection = Math.floor((century + 8) / 25);
  const lunarCorrection = Math.floor((century - centuryCorrection + 1) / 3);
  const epact =
    (19 * lunarCycleYear + century - leapCenturies - lunarCorrection + 15) % 30;
  const weekdayCorrection =
    (32 +
      2 * (century % 4) +
      2 * Math.floor(yearOfCentury / 4) -
      epact -
      (yearOfCentury % 4)) %
    7;
  const exception = Math.floor(
    (lunarCycleYear + 11 * epact + 22 * weekdayCorrection) / 451
  );
  const date = epact + weekdayCorrection - 7 * exception + 114;

  return Temporal.PlainDate.from({
    year,
    month: Math.floor(date / 31),
    day: (date % 31) + 1,
  });
}

export function isCzechWorkingDay(date: Temporal.PlainDate): boolean {
  if (
    date.dayOfWeek > 5 ||
    fixedPublicHolidays.has(`${date.month}-${date.day}`)
  )
    return false;

  if (date.dayOfWeek === 5) {
    return !getEasterSunday(date.year).subtract({ days: 2 }).equals(date);
  }

  if (date.dayOfWeek === 1) {
    return !getEasterSunday(date.year).add({ days: 1 }).equals(date);
  }

  return true;
}
