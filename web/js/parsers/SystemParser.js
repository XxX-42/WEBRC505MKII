export class SystemParser {
    static parseName(memNode) {
        const nameNode = memNode.getElementsByTagName('NAME')[0];
        if (nameNode) {
            const asciiCodes = Array.from(nameNode.children).map(child => parseInt(child.textContent));
            return asciiCodes.map(c => String.fromCharCode(c)).join('').trim();
        }
        return "Unknown";
    }
}
