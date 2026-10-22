/** PCM retained solely for Browser undo/redo, shared by every track in an engine. */
export const BROWSER_PCM_HISTORY_BUDGET_BYTES = 512 * 1024 * 1024;

/**
 * Control-thread accounting. Counts all retained Float32 channel bytes, including
 * a pending overdub's pre-edit copy; excludes live loops and worklet/export PCM.
 * Slots are never evicted from another track to make an edit fit.
 */
export class PcmHistoryBudget {
    public readonly limitBytes: number;
    private readonly slots = new Map<object, number>();
    private retainedBytesValue = 0;

    /** A smaller limit is useful for exercising admission without huge allocations. */
    public constructor(limitBytes = BROWSER_PCM_HISTORY_BUDGET_BYTES) {
        if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new RangeError('Invalid PCM history budget');
        this.limitBytes = limitBytes;
    }

    public get retainedBytes(): number { return this.retainedBytesValue; }

    public canReplace(owner: object, bytes: number): boolean {
        return Number.isSafeInteger(bytes) && bytes >= 0
            && this.retainedBytesValue - (this.slots.get(owner) ?? 0) + bytes <= this.limitBytes;
    }

    /** Preflight a multi-owner edit without changing any retained slot. */
    public canReplaceMany(replacements: readonly { owner: object; bytes: number }[]): boolean {
        let nextTotal = this.retainedBytesValue;
        const seen = new Set<object>();
        for (const replacement of replacements) {
            if (seen.has(replacement.owner) || !Number.isSafeInteger(replacement.bytes) || replacement.bytes < 0) return false;
            seen.add(replacement.owner);
            nextTotal -= this.slots.get(replacement.owner) ?? 0;
            nextTotal += replacement.bytes;
            if (!Number.isSafeInteger(nextTotal) || nextTotal < 0 || nextTotal > this.limitBytes) return false;
        }
        return true;
    }

    /** Atomically update multiple owners after a successful aggregate preflight. */
    public replaceMany(replacements: readonly { owner: object; bytes: number }[]): boolean {
        if (!this.canReplaceMany(replacements)) return false;
        for (const { owner, bytes } of replacements) {
            const previous = this.slots.get(owner) ?? 0;
            this.retainedBytesValue += bytes - previous;
            if (bytes === 0) this.slots.delete(owner);
            else this.slots.set(owner, bytes);
        }
        return true;
    }

    public replace(owner: object, bytes: number): boolean {
        if (!this.canReplace(owner, bytes)) return false;
        this.retainedBytesValue += bytes - (this.slots.get(owner) ?? 0);
        if (bytes === 0) this.slots.delete(owner);
        else this.slots.set(owner, bytes);
        return true;
    }

    /** Move a retained PCM reservation to another owner without changing its byte total. */
    public transfer(fromOwner: object, toOwner: object): boolean {
        if (fromOwner === toOwner) return this.slots.has(fromOwner);
        const bytes = this.slots.get(fromOwner);
        if (bytes === undefined) return false;
        const replacedBytes = this.slots.get(toOwner) ?? 0;
        this.retainedBytesValue -= replacedBytes;
        this.slots.delete(fromOwner);
        this.slots.delete(toOwner);
        if (bytes > 0) this.slots.set(toOwner, bytes);
        return true;
    }

    public release(owner: object): void { this.replace(owner, 0); }
}

const engineBudgets = new WeakMap<object, PcmHistoryBudget>();

export function getBrowserPcmHistoryBudget(engine: object): PcmHistoryBudget {
    let budget = engineBudgets.get(engine);
    if (!budget) {
        budget = new PcmHistoryBudget();
        engineBudgets.set(engine, budget);
    }
    return budget;
}

/** Register a fresh engine's shared history ledger before TrackAudio instances are created. */
export function createBrowserPcmHistoryBudget(engine: object, limitBytes: number): PcmHistoryBudget {
    if (engineBudgets.has(engine)) throw new Error('Browser PCM history budget was already created for this engine.');
    const budget = new PcmHistoryBudget(limitBytes);
    engineBudgets.set(engine, budget);
    return budget;
}

export function audioBufferPcmBytes(buffer: AudioBuffer | null): number {
    return buffer ? buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT : 0;
}
