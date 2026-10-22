export interface Rc505EncoderField {
  value: number;
  min: number;
  max: number;
  step: number;
  kind?: 'number' | 'enum' | 'boolean' | 'action';
  options?: readonly { value: number }[];
}

/** Physical detents select discrete options; their wire values need not be consecutive. */
export function advanceRc505EncoderField(field: Rc505EncoderField, delta: number, accelerated = false): number {
  if (!Number.isFinite(delta) || delta === 0 || field.kind === 'action') return field.value;
  const steps = Math.trunc(delta) * (accelerated ? 5 : 1);
  if (!steps) return field.value;
  if (field.options?.length) {
    const current = Math.max(0, field.options.findIndex((option) => option.value === field.value));
    const next = Math.max(0, Math.min(field.options.length - 1, current + steps));
    return field.options[next]!.value;
  }
  return Math.max(field.min, Math.min(field.max, Number((field.value + steps * field.step).toFixed(8))));
}
