export interface RecordPlaySettings {
  readonly available: boolean;
  readonly recActionAvailable?: boolean;
  readonly quantizeAvailable?: boolean;
  readonly reason: string;
  readonly recAction: 'REC->DUB' | 'REC->PLAY' | null;
  readonly quantize: 'OFF' | 'MEASURE' | null;
  readonly autoRecAvailable: boolean;
  readonly bounceAvailable: false;
}
export type RecordPlaySettingsPatch = Partial<Pick<RecordPlaySettings, 'recAction' | 'quantize'>>;
export function assertRecordPlaySettings(patch: RecordPlaySettingsPatch): void {
  if (Object.keys(patch).some(key => key !== 'recAction' && key !== 'quantize') ||
      (patch.recAction !== undefined && patch.recAction !== 'REC->DUB' && patch.recAction !== 'REC->PLAY') ||
      (patch.quantize !== undefined && patch.quantize !== 'OFF' && patch.quantize !== 'MEASURE')) throw new RangeError('Unsupported record/play setting');
}
