import { describe, expect, it } from 'vitest';
import { LatestMixerWrites } from '../../src/composables/latestMixerWrites';

describe('latest mixer writes', () => {
  it('reproduces the former busy guard dropping a later target', async () => {
    let busy = false; let release!: () => void; const sent: number[] = [];
    const pending = new Promise<void>(resolve => { release = resolve; });
    const oldHandler = async (value: number) => { if (busy) return; busy = true; sent.push(value); await pending; busy = false; };
    const first = oldHandler(10); await oldHandler(30); release(); await first;
    expect(sent).toEqual([10]);
  });
  it('keeps the latest target while an acknowledgement is pending', async () => {
    const queue = new LatestMixerWrites();
    const sent: number[] = [];
    let release!: () => void;
    const first = new Promise<void>(resolve => { release = resolve; });
    const write = async (value: number) => { sent.push(value); if (sent.length === 1) await first; };
    queue.submit('native:1', 10, write, () => true, () => {});
    queue.submit('native:1', 20, write, () => true, () => {});
    queue.submit('native:1', 30, write, () => true, () => {});
    expect(sent).toEqual([10]);
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toEqual([10, 30]);
  });
  it('discards queued targets after an uncertain failure', async () => {
    const queue = new LatestMixerWrites(); let reject!: (e: Error) => void;
    const first = new Promise<void>((_, fail) => { reject = fail; }); const sent: number[] = [];
    const write = async (value: number) => { sent.push(value); await first; };
    queue.submit('native:1', 10, write, () => true, () => {});
    queue.submit('native:1', 30, write, () => true, () => {});
    reject(new Error('unknown')); await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toEqual([10]);
  });
  it('invalidates queued writes on a Memory boundary and holds the barrier through reconciliation', async () => {
    const queue = new LatestMixerWrites(); let fail!: (e: Error) => void; let finishRead!: () => void;
    const pending = new Promise<void>((_, reject) => { fail = reject; });
    const read = new Promise<void>(resolve => { finishRead = resolve; }); const sent: number[] = [];
    queue.submit('host:1', 10, async value => { sent.push(value); await pending; }, () => true, async () => { await read; });
    queue.submit('host:1', 30, async value => { sent.push(value); }, () => true, () => {});
    queue.invalidate(); fail(new Error('unknown')); await Promise.resolve();
    expect(queue.hasPending()).toBe(true); finishRead(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(queue.hasPending()).toBe(false); expect(sent).toEqual([10]);
  });
  it('releases the barrier even if reconciliation throws', async () => {
    const queue = new LatestMixerWrites();
    queue.submit('host:1', 10, async () => { throw Error('write'); }, () => true, async () => { throw Error('read'); });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(queue.hasPending()).toBe(false);
  });

  it('runs different channels independently while coalescing each channel', async () => {
    const queue = new LatestMixerWrites(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }); const sent: string[] = [];
    queue.submit('host:1', 10, async value => { sent.push(`1:${value}`); await pending; }, () => true, () => {});
    queue.submit('host:2', 20, async value => { sent.push(`2:${value}`); }, () => true, () => {});
    expect(sent).toEqual(['1:10', '2:20']); release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(queue.hasPending()).toBe(false);
  });

});
