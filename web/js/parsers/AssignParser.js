import { XMLHelper } from '../utils/XMLHelper.js';

export class AssignParser {
    static parse(memNode) {
        const assignsData = [];
        for (let i = 1; i <= 16; i++) {
            const assignNode = memNode.getElementsByTagName(`ASSIGN${i}`)[0];
            if (assignNode) {
                assignsData.push({
                    id: i,
                    params: XMLHelper.nodeToDict(assignNode)
                });
            }
        }
        return assignsData;
    }
}
