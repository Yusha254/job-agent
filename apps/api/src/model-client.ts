import { Injectable, ServiceUnavailableException } from '@nestjs/common';

@Injectable()
export class ModelClient {
  async json<T>(system: string, input: unknown, maxTokens = 2400): Promise<T> {
    const apiKey = process.env.LLM_API_KEY;
    if (!apiKey) throw new ServiceUnavailableException('Set LLM_API_KEY to run pipeline stages.');

    const baseUrl = (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(input) },
        ],
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new ServiceUnavailableException(`Model request failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new ServiceUnavailableException('Model returned an empty response.');
    try {
      return JSON.parse(content) as T;
    } catch {
      throw new ServiceUnavailableException('Model response was not valid JSON.');
    }
  }
}