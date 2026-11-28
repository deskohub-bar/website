import { type ClassValue, clsx } from "clsx";
import { Predicate } from "effect";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A value as the class value `cn` takes, keeping every entry `clsx` reads.
 * Entries `clsx` ignores, such as functions and symbols, become `undefined`,
 * so their siblings in an array survive.
 */
export function toClassValue<Value>(value: Value): ClassValue {
  if (Array.isArray(value)) return value.map(toClassValue);
  return Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBigInt(value) ||
    Predicate.isBoolean(value) ||
    Predicate.isNullish(value) ||
    Predicate.isObject(value)
    ? value
    : undefined;
}
