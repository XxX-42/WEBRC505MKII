export class XMLHelper {
    static parseXML(xmlString) {
        const parser = new DOMParser();
        // Fix for invalid XML tags starting with numbers (e.g. <0>, <1>)
        // Replace <d> with <_d> where d is a digit
        let sanitizedXml = xmlString.replace(/<(\/?)([0-9])(.*?)>/g, '<$1_$2$3>');
        // Fix for invalid XML tags starting with # (e.g. <#>)
        sanitizedXml = sanitizedXml.replace(/<(\/?)(#)(.*?)>/g, '<$1_HASH$3>');
        // Fix for invalid XML tags starting with # (e.g. <#>)
        sanitizedXml = sanitizedXml.replace(/<(\/?)(#)(.*?)>/g, '<$1_HASH$3>');

        // Fix for extra content after root element (e.g. <count> tag at the end)
        const rootEndIndex = sanitizedXml.lastIndexOf('</database>');
        if (rootEndIndex !== -1) {
            sanitizedXml = sanitizedXml.substring(0, rootEndIndex + 11);
        }

        const xmlDoc = parser.parseFromString(sanitizedXml, "text/xml");

        const parserError = xmlDoc.getElementsByTagName('parsererror')[0];
        if (parserError) {
            throw new Error("Invalid XML file: " + parserError.textContent);
        }
        return xmlDoc;
    }

    static nodeToDict(node) {
        const dict = {};
        for (let child of node.children) {
            dict[child.tagName] = child.textContent;
        }
        return dict;
    }
}
