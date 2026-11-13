export interface Rc505LcdTextField {
  label: string;
  value: number;
  kind?: 'number' | 'enum' | 'boolean' | 'action';
  max?: number;
  options?: readonly { label: string; value: number }[];
  format?: (value: number) => string;
  reason?: string;
  shortLabel?: string;
  shortValue?: string;
  fullText?: string;
}

// Explicit engineering abbreviations, not an asserted hardware string table.
const words: Readonly<Record<string, string>> = {
  EFFECT: 'FX', FREQUENCY: 'FREQ', RESONANCE: 'RESO', SEPARATION: 'SEP',
  THRESHOLD: 'THRESH', COMPRESSION: 'COMP', SENSITIVITY: 'SENS',
  PARAMETERS: 'PARAM', PARAMETER: 'PARAM', PLAYBACK: 'PLAY',
  QUANTIZE: 'QUANT', QUANTIZATION: 'QUANT', VARIATION: 'VAR',
  RELEASE: 'REL', ATTACK: 'ATK', EXPRESSION: 'EXP',
  MODULATION: 'MOD',
};

export function shortRc505FieldLabel(label: string): string {
  return label.split(/\s+/).map(word => words[word.toUpperCase()] ?? word).join(' ');
}

export function fullRc505FieldValue(field: Rc505LcdTextField): string {
  if (!Number.isFinite(field.value)) return '--';
  if (field.format) return field.format(field.value);
  if (field.kind === 'action') return '';
  if (field.kind === 'boolean') return field.value >= 50 ? 'ON' : 'OFF';
  if (field.kind === 'enum') return field.options?.find(option => option.value === field.value)?.label ?? String(field.value);
  return `${Math.round(field.value)}${field.max === 100 ? '%' : ''}`;
}

export function rc505LcdFieldText(field: Rc505LcdTextField): { shortLabel: string; shortValue: string; fullText: string } {
  const value = fullRc505FieldValue(field);
  return {
    shortLabel: field.shortLabel ?? shortRc505FieldLabel(field.label),
    shortValue: field.shortValue ?? value,
    fullText: field.fullText ?? `${field.label}${value ? `: ${value}` : ''}${field.reason ? `\n${field.reason}` : ''}`,
  };
}
