export interface SseFrame {
  readonly id?: string | undefined;
  readonly event: string;
  readonly data: unknown;
}

/**
 * Decode a fetch-based SSE body. C089 owns framing; C090 owns reconnect.
 */
export async function decodeSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeSseBuffer(buffer, onFrame);
    }
  } finally {
    reader.releaseLock();
  }
}

export function consumeSseBuffer(buffer: string, onFrame: (frame: SseFrame) => void): string {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const block of parts) {
    const frame = parseSseBlock(block);
    if (frame !== undefined) onFrame(frame);
  }
  return rest;
}

function parseSseBlock(block: string): SseFrame | undefined {
  let id: string | undefined;
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && id === undefined) return undefined;
  const joined = dataLines.join('\n');
  let data: unknown = joined;
  if (joined.startsWith('{') || joined.startsWith('[')) {
    try {
      data = JSON.parse(joined) as unknown;
    } catch {
      data = joined;
    }
  }
  return { event, data, ...(id !== undefined ? { id } : {}) };
}
