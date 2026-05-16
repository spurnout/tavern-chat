import type { Config } from '../config.js';
import { TavernError } from '@tavern/shared';

const SYSTEM_PROMPT =
  'You are a tabletop role-playing game assistant. The user provides a transcript ' +
  'of a recent session and asks for a recap. Produce a recap that:\n' +
  '- Opens with one or two sentences setting the scene\n' +
  '- Then 4-8 bullet points covering the key beats in chronological order\n' +
  '- Names the player characters and NPCs that appeared\n' +
  '- Ends with one sentence noting open threads or unresolved questions\n' +
  '- Keeps a literary tone consistent with the game system (Tavern is system-agnostic;\n' +
  '  follow the transcript\'s register).\n' +
  '- Never invents facts. If something is unclear from the transcript, say so plainly.\n' +
  '- Keep the entire response under 500 words.';

export interface RecapResult {
  body: string;
  modelUsed: string;
}

/**
 * Wave 3 #48 — call the configured OpenAI-compatible Chat Completions
 * endpoint. Works with OpenAI, Ollama (`/v1`), llama.cpp's server,
 * LM Studio, OpenRouter, and anyone else who speaks the same protocol.
 *
 * Operators opt in by setting `LLM_ENDPOINT`. Without it, callers get a
 * structured error and the UI hides the affordance.
 */
export class RecapService {
  constructor(private readonly config: Config) {}

  isEnabled(): boolean {
    return Boolean(this.config.LLM_ENDPOINT);
  }

  async generate(transcript: string, opts?: { extraGuidance?: string }): Promise<RecapResult> {
    if (!this.config.LLM_ENDPOINT) {
      throw new TavernError(
        'INTERNAL_ERROR',
        'AI recap is not configured on this instance.',
        503,
      );
    }
    const url = this.config.LLM_ENDPOINT.replace(/\/+$/, '') + '/chat/completions';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.config.LLM_API_KEY) {
      headers.authorization = `Bearer ${this.config.LLM_API_KEY}`;
    }
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];
    if (opts?.extraGuidance) {
      messages.push({ role: 'system', content: opts.extraGuidance });
    }
    messages.push({
      role: 'user',
      content: `Here is the session transcript. Generate a recap.\n\n${transcript}`,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.LLM_MODEL,
          messages,
          temperature: 0.4,
          max_tokens: 800,
        }),
        // The recap path waits on a model; give it room. A real timeout
        // belongs at the route layer with AbortController.
      });
    } catch (err) {
      throw new TavernError(
        'INTERNAL_ERROR',
        `Could not reach the configured LLM endpoint: ${err instanceof Error ? err.message : 'network error'}`,
        502,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new TavernError(
        'INTERNAL_ERROR',
        `LLM endpoint returned ${response.status}: ${text.slice(0, 200)}`,
        502,
      );
    }
    const json = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const body = json.choices?.[0]?.message?.content?.trim();
    if (!body) {
      throw new TavernError(
        'INTERNAL_ERROR',
        'LLM endpoint returned no content',
        502,
      );
    }
    return {
      body,
      modelUsed: json.model ?? this.config.LLM_MODEL,
    };
  }
}
