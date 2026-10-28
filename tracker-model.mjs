export function monthBounds(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid month.");
  const [y, m] = month.split("-").map(Number);
  const end =
    m === 12
      ? `${y + 1}-01-01`
      : `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-01`;
  return { start: month + "-01", end };
}
export function entryMonth(entry) {
  const date = entry.entry_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || ""))
    throw new Error("Entry date is missing.");
  const parsed = new Date(date + "T00:00:00Z");
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    throw new Error("Invalid entry date.");
  return date.slice(0, 7);
}
export function parseAmount(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text))
    throw new Error("Enter a positive amount with at most two decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n || cents > 10000000000n)
    throw new Error("Amount is outside the supported range.");
  return Number(cents);
}
