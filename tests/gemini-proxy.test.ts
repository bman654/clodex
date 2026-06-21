// tests/gemini-proxy.test.ts
import { describe, it, expect } from 'vitest';
import { translateGeminiRequest } from '../src/gemini-proxy.js';

describe('translateGeminiRequest', () => {
  it('maps basic user and assistant turns', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi there' }] },
        { role: 'user', parts: [{ text: 'How are you?' }] },
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 256,
      },
    };

    const params = translateGeminiRequest(body);
    expect(params.system).toBeUndefined();
    expect(params.temperature).toBe(0.7);
    expect(params.maxOutputTokens).toBe(256);
    expect(params.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
      { role: 'user', content: [{ type: 'text', text: 'How are you?' }] },
    ]);
  });

  it('extracts system instructions', () => {
    const body = {
      systemInstruction: {
        parts: [{ text: 'You are a helpful assistant' }],
      },
      contents: [
        { role: 'user', parts: [{ text: 'Hi' }] },
      ],
    };

    const params = translateGeminiRequest(body);
    expect(params.system).toBe('You are a helpful assistant');
    expect(params.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ]);
  });

  it('merges consecutive messages of the same role (especially user)', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'Message 1' }] },
        { role: 'user', parts: [{ text: 'Message 2' }] },
        { role: 'model', parts: [{ text: 'Response 1' }] },
        { role: 'model', parts: [{ text: 'Response 2' }] },
      ],
    };

    const params = translateGeminiRequest(body);
    expect(params.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Message 1' },
          { type: 'text', text: 'Message 2' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Response 1' },
          { type: 'text', text: 'Response 2' },
        ],
      },
    ]);
  });

  it('maps tool declarations', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Run tool' }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'getWeather',
              description: 'Get weather for city',
              parameters: {
                type: 'OBJECT',
                properties: {
                  city: { type: 'STRING' },
                },
                required: ['city'],
              },
            },
          ],
        },
      ],
    };

    const params = translateGeminiRequest(body);
    expect(params.tools).toBeDefined();
    expect(Object.keys(params.tools)).toEqual(['getWeather']);
    expect(params.tools.getWeather.description).toBe('Get weather for city');
  });

  it('translates function response to tool-result and groups consecutive tool turns', () => {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'What is the weather?' }],
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'getWeather',
                args: { city: 'Paris' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'getWeather',
                response: { temp: '22C' },
              },
            },
          ],
        },
      ],
    };

    const params = translateGeminiRequest(body);
    
    // We expect 3 messages: user prompt, assistant tool-call, and tool result
    expect(params.messages).toHaveLength(3);
    
    expect(params.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'What is the weather?' }],
    });

    expect(params.messages[1].role).toBe('assistant');
    expect(params.messages[1].content[0].type).toBe('tool-call');
    expect(params.messages[1].content[0].toolName).toBe('getWeather');
    expect(params.messages[1].content[0].input).toEqual({ city: 'Paris' });
    const toolCallId = params.messages[1].content[0].toolCallId;
    expect(toolCallId).toBeDefined();

    expect(params.messages[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: 'getWeather',
          output: {
            type: 'text',
            value: '{"temp":"22C"}',
          },
        },
      ],
    });
  });

  it('supports JSON response format configuration', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Give JSON' }] }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    };

    const params = translateGeminiRequest(body);
    expect(params.responseFormat).toEqual({ type: 'json' });
  });
});
