import { XMLHelper } from '../utils/XMLHelper.js';
import { SemanticMapper } from '../utils/SemanticMapper.js';

export class TrackParser {
    static parse(memNode) {
        const tracksData = [];
        for (let i = 1; i <= 6; i++) {
            const trackNode = memNode.getElementsByTagName(`TRACK${i}`)[0];
            if (trackNode) {
                const rawParams = XMLHelper.nodeToDict(trackNode);
                const processedParams = {};

                for (let [key, val] of Object.entries(rawParams)) {
                    const { name, value } = SemanticMapper.mapTrackParam(key, val);
                    processedParams[name] = value;
                }

                tracksData.push({
                    id: i,
                    params: processedParams
                });
            }
        }
        return tracksData;
    }
}
