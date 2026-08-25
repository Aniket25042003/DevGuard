/**
 * Negative fixture: strict flags must stay enabled.
 *
 * - noUncheckedIndexedAccess makes bare index access possibly-undefined (TS2532).
 * - exactOptionalPropertyTypes forbids assigning `undefined` to an optional
 *   property declared without `| undefined` (TS2379).
 */

export function firstChar(values: string[]): string {
  return values[0].charAt(0);
}

interface Options {
  timeout?: number;
}

export const broken: Options = {
  timeout: undefined,
};
