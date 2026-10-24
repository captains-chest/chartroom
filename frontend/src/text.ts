// Plain-text formatting. No DOM, so pure modules and the worker can use it too.

/** `n` and the noun, plural unless there is exactly one: "1 sensor", "3 sensors". */
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
