import { BROWSER_OFFICIAL_PARAMETER_KEYS as streamControls } from '../dsp/OfficialBrowserParameters';
import { BROWSER_OFFICIAL_PITCH_PARAMETER_KEYS as pitchControls } from '../dsp/OfficialPitchParameters';
/** Only executable, behavior-tested adapters are admitted to the public UI. */
export const BROWSER_OFFICIAL_PARAMETER_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({ ...streamControls, ...pitchControls });
