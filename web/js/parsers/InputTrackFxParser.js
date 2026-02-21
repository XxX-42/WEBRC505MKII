import { XMLHelper } from '../utils/XMLHelper.js';
import { SemanticMapper } from '../utils/SemanticMapper.js';

export class InputTrackFxParser {
    static parse(ifxNode, tfxNode) {
        // Based on user feedback: Input FX uses AA-DD, Track FX uses AA-DD
        // This implies AA, AB, AC, AD are Bank A, B, C, D? Or AA, BA, CA, DA?
        // Let's assume sequential first letters for Banks A-D: AA, AB, AC, AD.
        // If that fails, we can try AA, BA, CA, DA.
        
        // Update: User said "AA-DD". 
        // Inspection showed <tfx> has <AA>, <AB> etc.
        // It's likely AA=Bank A, AB=Bank B, AC=Bank C, AD=Bank D
        
        const inputFx = {
            A: this.parseBank(ifxNode, 'AA'),
            B: this.parseBank(ifxNode, 'AB'),
            C: this.parseBank(ifxNode, 'AC'),
            D: this.parseBank(ifxNode, 'AD')
        };

        const trackFx = {
            A: this.parseBank(tfxNode, 'AA'),
            B: this.parseBank(tfxNode, 'AB'),
            C: this.parseBank(tfxNode, 'AC'),
            D: this.parseBank(tfxNode, 'AD')
        };

        return { inputFx, trackFx };
    }

    static parseBank(memNode, prefix) {
        const bankData = [];
        const allChildren = Array.from(memNode.children);

        // DEBUG: Only log once per parsing session (A-D Input/Track) to avoid spam, 
        // but since we can't easily track state across static calls without flags, we accept 8 logs.
        // We really want to see WHAT the children are.
        if (prefix === 'AA') { // Log only for first call
            console.log(`[InputTrackFxParser] Total Children: ${allChildren.length}`);
            if (allChildren.length > 0) {
                console.log(`[InputTrackFxParser] First Child: ${allChildren[0].tagName}`);
                console.log(`[InputTrackFxParser] Last Child: ${allChildren[allChildren.length - 1].tagName}`);
                // Log identifiers of the last few nodes to see where it cuts off
                const lastFew = allChildren.slice(-5).map(n => n.tagName);
                console.log(`[InputTrackFxParser] Last 5 Children: ${lastFew.join(', ')}`);
            }
        }

        console.log(`[InputTrackFxParser] Parsing Bank Prefix: ${prefix}, Total Children: ${allChildren.length}`);

        // Find all tags starting with the prefix (e.g., CA_FILTER, CA_REVERB)
        // Also include the base tag (e.g., CA) which might hold active status or type
        const fxNodes = allChildren.filter(node => node.tagName.startsWith(prefix));

        console.log(`[InputTrackFxParser] Found ${fxNodes.length} nodes for prefix ${prefix}`);
        if (fxNodes.length > 0 && fxNodes.length < 5) {
            console.log(`[InputTrackFxParser] Nodes:`, fxNodes.map(n => n.tagName));
        }

        fxNodes.forEach(node => {
            const rawParams = XMLHelper.nodeToDict(node);
            const processedParams = {};

            for (let [key, val] of Object.entries(rawParams)) {
                // We can add specific mapping here if needed
                const { name, value } = SemanticMapper.mapFxParam(node.tagName, key, val);
                processedParams[name] = value;
            }

            // Clean up tag name for display (e.g., CA_LPF -> LPF)
            let displayName = node.tagName;
            if (node.tagName === prefix) {
                displayName = "Common / Status";
            } else if (node.tagName.startsWith(prefix + '_')) {
                displayName = node.tagName.substring(prefix.length + 1);
            }

            bankData.push({
                type: displayName,
                originalTag: node.tagName,
                params: processedParams
            });
        });

        return bankData;
    }
}
