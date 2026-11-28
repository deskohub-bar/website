export const requireValue = <Value>(
  value: Value,
  label = "value"
): NonNullable<Value> => {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label}`);
  }
  return value;
};
