/**
 * Gets all keys from an object where the value is not undefined.
 *
 * @param obj - The object to examine.
 * @returns An array of keys with defined values.
 */
export function defined_keys(obj: Record<string, unknown>) {
  return Object.keys(obj).filter((key) => obj[key] !== undefined);
}

/**
 * Checks whether an object has any defined properties.
 *
 * @param obj - The object to examine.
 * @returns True if the object has at least one defined property.
 */
export function has_data(obj: Record<string, unknown>) {
  return defined_keys(obj).length > 0;
}

/**
 * Returns undefined if the value is empty (empty array or object with no defined keys).
 *
 * @template T - The type of the value.
 * @param obj - The value to check.
 * @returns The value if non-empty, otherwise undefined.
 */
export function undefined_if_empty<T = unknown>(obj: T) {
  if (obj === null || obj === undefined) {
    return undefined;
  }
  if (Array.isArray(obj)) {
    return obj.length === 0 ? undefined : obj;
  }
  if (typeof obj === "object") {
    return defined_keys(obj as Record<string, unknown>).length === 0 ? undefined : obj;
  }
  return obj;
}

/**
 * Recursively merges two values together.
 *
 * For objects, properties are merged recursively. For arrays, elements are concatenated.
 * For primitives, the supplemental value replaces the original.
 *
 * @template T - The type of values being merged.
 * @param original - The original value.
 * @param supplemental - The value to merge in.
 * @returns The merged result.
 */
export function deep_merge<T = unknown>(original: T, supplemental: T): T {
  if (supplemental === undefined || supplemental === null) {
    return original;
  }
  if (original === undefined || original === null) {
    return supplemental;
  }
  if (typeof original === "object" && typeof supplemental === "object") {
    if (Array.isArray(original)) {
      if (!Array.isArray(supplemental)) {
        throw new Error("type mismatch");
      }
      return [...original, ...supplemental] as T;
    } else {
      if (Array.isArray(supplemental)) {
        throw new Error("type mismatch");
      }
      const result = { ...original } as Record<string, unknown>;
      for (const [key, value] of Object.entries(supplemental)) {
        result[key] = deep_merge(result[key], value);
      }
      return result as T;
    }
  }
  if (typeof supplemental !== typeof original) {
    throw new Error("type mismatch");
  }
  if (
    typeof supplemental === "string" ||
    typeof supplemental === "number" ||
    typeof supplemental === "boolean"
  ) {
    return supplemental as T;
  }
  throw new Error("unsupported type");
}

/**
 * Copies a property from source to destination only if it is defined.
 *
 * @template TKey - The key type.
 * @template TSource - The source object type.
 * @param key - The property key to copy.
 * @param source - The source object.
 * @param destination - The destination object.
 */
export function copy_if_defined<TKey extends keyof TSource, TSource extends object>(
  key: TKey,
  source: TSource,
  destination: Partial<Pick<TSource, TKey>>,
) {
  if (source[key] !== undefined) {
    destination[key] = source[key];
  }
}

/**
 * Type guard that checks if an object contains a specific key.
 *
 * @template T - The object type.
 * @template K - The key type.
 * @param obj - The object to check.
 * @param key - The key to look for.
 * @returns True if the object contains the key.
 */
export function contains_key<T extends object, K extends string | number>(
  obj: T,
  key: K,
): obj is T & Record<K, unknown> {
  return key in obj;
}

/**
 * Gets a value from a nested object path.
 *
 * @param node - The object to traverse.
 * @param key_path - The path to the value (dot-separated string or array of keys).
 * @returns The value at the path, or undefined if not found.
 */
export function get_nested_value(node: unknown, key_path: string | (string | number)[]): unknown {
  if (typeof key_path === "string") {
    return get_nested_value(node, key_path.split("."));
  }
  const [key, ...rest] = key_path;

  if (typeof node !== "object" || node === null || key === undefined) {
    return node;
  }
  if (!contains_key(node, key)) {
    return undefined;
  }
  return get_nested_value(node[key], rest);
}

/**
 * Sets a value at a nested object path.
 *
 * Creates intermediate objects/arrays as needed.
 *
 * @param node - The object to modify.
 * @param key_path - The path to set (dot-separated string or array of keys).
 * @param value - The value to set.
 */
export function set_nested_value(
  node: unknown,
  key_path: string | (string | number)[],
  value: unknown,
) {
  if (typeof key_path === "string") {
    set_nested_value(node, key_path.split("."), value);
    return;
  }
  const [key, next_key, ...rest] = key_path;

  if (key === undefined) {
    throw new Error("invalid object key");
  }
  if (typeof node !== "object" || node === null) {
    throw new Error("invalid object value");
  }
  const obj = node as Record<string | number, unknown>;

  if (next_key === undefined || next_key === null) {
    obj[key] = value;
    return;
  }
  if (obj[key] === undefined || obj[key] === null) {
    obj[key] = typeof next_key === "number" || /^\d+$/.test(String(next_key)) ? [] : {};
  }
  set_nested_value(obj[key], [next_key, ...rest], value);
}

/**
 * Deletes a value at a nested object path.
 *
 * @param node - The object to modify.
 * @param key_path - The path to delete (dot-separated string or array of keys).
 */
export function delete_nested_value(node: unknown, key_path: string | (string | number)[]) {
  if (typeof key_path === "string") {
    delete_nested_value(node, key_path.split("."));
    return;
  }
  const [key, next_key, ...rest] = key_path;

  if (key === undefined) {
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  const obj = node as Record<string | number, unknown>;

  if (!contains_key(obj, key)) {
    return;
  }

  if (next_key === undefined) {
    delete obj[key];
    return;
  }
  delete_nested_value(obj[key], [next_key, ...rest]);
}
