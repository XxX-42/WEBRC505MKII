import { XMLHelper } from './utils/XMLHelper.js';
import { SystemParser } from './parsers/SystemParser.js';
import { TrackParser } from './parsers/TrackParser.js';
import { AssignParser } from './parsers/AssignParser.js';
import { EffectParser } from './parsers/EffectParser.js';
import { ThemeManager } from './ui/ThemeManager.js';
import { UIManager } from './ui/UIManager.js';

document.addEventListener('DOMContentLoaded', () => {
    // Initialize Managers
    const themeManager = new ThemeManager('themeToggle');
    const uiManager = new UIManager('contentArea', 'tabs', 'memoryName');

    // DOM Elements
    const fileInput = document.getElementById('fileInput');
    const dropZone = document.getElementById('dropZone');
    const tabBtns = document.querySelectorAll('.tab-btn');

    // Drag and Drop Logic
    if (dropZone && fileInput) {
        dropZone.addEventListener('click', () => fileInput.click());

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('dragover');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            if (e.dataTransfer.files.length) {
                handleFile(e.dataTransfer.files[0]);
            }
        });

        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length) {
                handleFile(e.target.files[0]);
            }
        });
    }

    // Tab Logic
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            const target = btn.dataset.tab;
            const pane = document.getElementById(`pane-${target}`);
            if (pane) pane.classList.add('active');
        });
    });

    function handleFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const xmlDoc = XMLHelper.parseXML(e.target.result);

                // Check for standard RC0 tags
                const memTag = xmlDoc.getElementsByTagName('mem')[0];
                if (!memTag) {
                    throw new Error("No <mem> tag found. Is this a valid RC0 file?");
                }

                processData(memTag);
                uiManager.showTabs();

            } catch (err) {
                alert("Error parsing file: " + err.message);
                console.error(err);
            }
        };
        reader.readAsText(file);
    }

    function processData(memNode) {
        // 1. Parse System (Name)
        const memoryName = SystemParser.parseName(memNode);
        uiManager.updateMemoryName(memoryName);

        // 2. Parse Tracks
        const tracks = TrackParser.parse(memNode);

        // 3. Parse Assigns
        const assigns = AssignParser.parse(memNode);

        // 4. Parse Effects
        const effects = EffectParser.parse(memNode);

        // Render everything
        uiManager.render(tracks, assigns, effects);
    }
});
