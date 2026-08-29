import { describe, expect, it } from 'vitest';
import { consumeSseBuffer } from './sse';

describe('SSE framing', () => {
  it('parses id, event, and JSON data blocks', () => {
    const frames: Array<{ id?: string; event: string; data: unknown }> = [];
    const rest = consumeSseBuffer(
      'id: sess:1\nevent: turn.completed\ndata: {"sequenceNumber":1,"summary":"ok"}\n\npartial',
      (frame) => frames.push(frame),
    );
    expect(rest).toBe('partial');
    expect(frames).toEqual([
      {
        id: 'sess:1',
        event: 'turn.completed',
        data: { sequenceNumber: 1, summary: 'ok' },
      },
    ]);
  });
});
