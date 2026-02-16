import { XMLHelper } from '../utils/XMLHelper.js';

export class EffectParser {
    static parse(memNode) {
        const effectsData = [];
        const allChildren = Array.from(memNode.children);

        // Filter mainly for ICTL, ECTL, EQ, MASTER, RHYTHM
        const effectNodes = allChildren.filter(node =>
            node.tagName.startsWith('ICTL') ||
            node.tagName.startsWith('ECTL') ||
            node.tagName.startsWith('EQ') ||
            node.tagName.startsWith('MASTER') ||
            node.tagName.startsWith('RHYTHM')
        );

        effectNodes.forEach(node => {
            effectsData.push({
                name: node.tagName,
                params: XMLHelper.nodeToDict(node)
            });
        });

        return effectsData;
    }
}
