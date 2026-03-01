import { describe, expect, it } from "vitest";
import { convertJsonSchemaToParameters } from "../schema-converter.ts";

describe("convertJsonSchemaToParameters", () => {
  it("returns empty array for schema with no properties", () => {
    const schema = { type: "object" };
    const result = convertJsonSchemaToParameters(schema);
    expect(result).toEqual([]);
  });

  it("converts required string property", () => {
    const schema = {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
    };
    const result = convertJsonSchemaToParameters(schema);
    expect(result).toEqual([{ name: "city", type: "string", required: true }]);
  });

  it("converts optional string property", () => {
    const schema = {
      type: "object",
      properties: {
        city: { type: "string" },
      },
    };
    const result = convertJsonSchemaToParameters(schema);
    expect(result).toEqual([{ name: "city", type: "string", required: false }]);
  });

  it("converts number property (required)", () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    };
    const result = convertJsonSchemaToParameters(schema);
    expect(result).toEqual([{ name: "count", type: "number", required: true }]);
  });

  it("converts integer property as number type", () => {
    const schema = {
      type: "object",
      properties: {
        age: { type: "integer" },
      },
      required: ["age"],
    };
    const result = convertJsonSchemaToParameters(schema);
    expect(result).toEqual([{ name: "age", type: "number", required: true }]);
  });

  it("converts boolean property", () => {
    const schema = {
      type: "object",
      properties: {
        verbose: { type: "boolean" },
      },
      required: ["verbose"],
    };
    const result = convertJsonSchemaToParameters(schema);
    expect(result).toEqual([{ name: "verbose", type: "boolean", required: true }]);
  });

  it("converts string enum property", () => {
    const schema = {
      type: "object",
      properties: {
        color: { type: "string", enum: ["red", "green", "blue"] },
      },
      required: ["color"],
    };
    const result = convertJsonSchemaToParameters(schema);
    expect(result).toEqual([
      {
        name: "color",
        type: "string",
        required: true,
        enum: ["red", "green", "blue"],
      },
    ]);
  });

  it("converts nested object with sub-properties", () => {
    const schema = {
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            zip: { type: "string" },
          },
          required: ["street"],
        },
      },
      required: ["address"],
    };
    const result = convertJsonSchemaToParameters(schema);
    expect(result).toEqual([
      {
        name: "address",
        type: "object",
        required: true,
        properties: {
          street: { type: "string", required: true },
          zip: { type: "string", required: false },
        },
      },
    ]);
  });

  it("converts array with items type", () => {
    const schema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["tags"],
    };
    const result = convertJsonSchemaToParameters(schema);
    expect(result).toEqual([
      {
        name: "tags",
        type: "array",
        required: true,
        items: { type: "string", required: false },
      },
    ]);
  });

  it("handles nested required fields correctly (inner object has its own required list)", () => {
    const schema = {
      type: "object",
      properties: {
        person: {
          type: "object",
          properties: {
            name: { type: "string" },
            nickname: { type: "string" },
          },
          required: ["name"],
        },
      },
    };
    const result = convertJsonSchemaToParameters(schema);
    expect(result).toEqual([
      {
        name: "person",
        type: "object",
        required: false,
        properties: {
          name: { type: "string", required: true },
          nickname: { type: "string", required: false },
        },
      },
    ]);
  });

  it("preserves description fields on parameters", () => {
    const schema = {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
      },
      required: ["city"],
    };
    const result = convertJsonSchemaToParameters(schema);
    expect(result).toEqual([
      {
        name: "city",
        type: "string",
        required: true,
        description: "City name",
      },
    ]);
  });
});
