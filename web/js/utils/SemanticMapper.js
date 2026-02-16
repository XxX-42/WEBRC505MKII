export class SemanticMapper {
    /**
     * RC-505mkII Parameter Mapping
     * Based on "Machine Dump" logic: XML tags <A>, <B>, <C> correspond to memory address offsets.
     */

    // Track Parameters (Based on user context and general loop station logic)
    static TRACK_MAP = {
        'A': { name: 'Reverse', type: 'bool' },       // Example: Off / On
        'B': { name: 'One Shot', type: 'bool' },      // Example: Off / On
        'C': { name: 'Level', type: 'range', min: 0, max: 200 }, // Volume
        'D': 'Pan',                                   // L50 - R50
        'E': 'Start Mode',                            // Immediate / Fade
        'F': 'Stop Mode',                             // Immediate / Fade / Loop End
        'G': 'Measure',                               // Auto / Free / 1-xxx
        'H': 'Loop Sync',                             // Off / On
        'I': 'Tempo Sync',                            // Off / On
        'J': 'Input Routing',                         // Input selection
        'K': 'Output Routing',                        // Output selection
        // ... extend as needed
    };

    // Effect Parameters (Generic Structure for most FX)
    static FX_MAP = {
        'A': 'Rate/Value',
        'B': 'Depth',
        'C': 'Resonance',
        'D': 'Effect Level',
        // Real mapping depends on the specific Effect Type ID
    };

    static mapTrackParam(key, value) {
        const mapping = this.TRACK_MAP[key];
        if (!mapping) return { name: key, value };

        let name, processedValue = value;

        if (typeof mapping === 'string') {
            name = mapping;
        } else {
            name = mapping.name;
            // Value processing logic
            if (mapping.type === 'bool') {
                processedValue = (value == '1' || value == 'ON') ? 'ON' : 'OFF';
            } else if (mapping.type === 'range') {
                // Keep as is or normalize
            }
        }

        return { name, value: processedValue };
    }

    static mapEffectParam(contextTag, key, value) {
        // contextTag example: ICTL1_TRACK1_FX or AB_LPF
        // We can parse the contextTag to guess the effect type if provided

        let name = this.FX_MAP[key] || key;
        return { name, value };
    }
}
