import { AssistantMessage, Message } from "../conversations/index.ts";
import { ContextTransformer, TransformContext } from "./types.ts";

/**
 * Combines multiple context transformers into a single transformation pipeline.
 *
 * Transformers are applied in the order provided.
 */
export class CompositeContextTransformer implements ContextTransformer {
  readonly #transformers: ContextTransformer[];

  /**
   * Creates a new composite context transformer.
   *
   * @param transformers - The transformers to compose.
   */
  constructor(transformers: ContextTransformer[]) {
    this.#transformers = transformers;
  }

  /**
   * Transforms prompt messages by applying all transformers in sequence.
   *
   * @param messages - The messages to transform.
   * @returns A promise that resolves to the transformed messages.
   */
  async transform_prompt(messages: Message[], context?: TransformContext): Promise<Message[]> {
    for (const transformer of this.#transformers) {
      messages = await transformer.transform_prompt(messages, context);
    }
    return messages;
  }

  /**
   * Transforms a completion message by applying all transformers in sequence.
   *
   * @param message - The assistant message to transform.
   * @returns A promise that resolves to the transformed message.
   */
  async transform_completion(message: AssistantMessage): Promise<AssistantMessage> {
    for (const transformer of this.#transformers) {
      message = await transformer.transform_completion(message);
    }
    return message;
  }
}
