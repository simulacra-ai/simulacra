/**
 * Makes all properties of an object and their nested properties optional.
 *
 * @template T - The object type to make deeply partial.
 */
export type DeepPartial<T> = Partial<{ [K in keyof T]: Partial<T[K]> }>;

/**
 * Flattens intersection types for better IDE display.
 *
 * @template T - The type to prettify.
 */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};
