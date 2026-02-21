import { XMLHelper } from './utils/XMLHelper.js';
import { SystemParser } from './parsers/SystemParser.js';
import { TrackParser } from './parsers/TrackParser.js';
import { AssignParser } from './parsers/AssignParser.js';
import { EffectParser } from './parsers/EffectParser.js';
import { InputTrackFxParser } from './parsers/InputTrackFxParser.js';
import { ThemeManager } from './ui/ThemeManager.js';
import { UIManager } from './ui/UIManager.js';
import { FileHandleManager } from './utils/FileHandleManager.js';

document.addEventListener('DOMContentLoaded', () => {
    const themeManager = new ThemeManager('themeToggle');
    const uiManager = new UIManager('contentArea', 'tabs', 'memoryName');

    // Debug Mode State
    const debugToggle = document.getElementById('debugToggle');

    debugToggle.addEventListener('click', () => {
        const isDebug = !debugToggle.classList.contains('active');
        if (isDebug) {
            debugToggle.classList.add('active');
            debugToggle.style.color = 'var(--accent-red)';
            debugToggle.style.textShadow = '0 0 8px var(--accent-red)';
        } else {
            debugToggle.classList.remove('active');
            debugToggle.style.color = '#666';
            debugToggle.style.textShadow = 'none';
        }
        uiManager.setDebugMode(isDebug);
    });


    // DOM Elements
    const fileInput = document.getElementById('fileInput');
    const dropZone = document.getElementById('dropZone');
    const tabBtns = document.querySelectorAll('.tab-btn');

    // Drag and Drop Logic
    if (dropZone && fileInput) {
        dropZone.addEventListener('click', async () => {
            // New "Memory" feature: Try to use File System Access API
            if ('showOpenFilePicker' in window) {
                try {
                    const pickerOptions = {
                        types: [{
                            description: 'RC-505MK2 Memory Files',
                            accept: {
                                'application/octet-stream': ['.RC0', '.rc0'] // Standard logic for extensions
                            }
                        }],
                        multiple: false
                    };

                    // Try to restore last handle
                    const lastHandle = await FileHandleManager.getHandle();
                    if (lastHandle) {
                        pickerOptions.startIn = lastHandle;
                    }

                    const [fileHandle] = await window.showOpenFilePicker(pickerOptions);

                    // Save handle for next time
                    await FileHandleManager.saveHandle(fileHandle);

                    const file = await fileHandle.getFile();
                    handleFile(file);

                } catch (err) {
                    if (err.name !== 'AbortError') {
                        console.error('File Picker Error:', err);
                        // Fallback gracefully
                        fileInput.click();
                    }
                }
            } else {
                // Fallback for legacy browsers
                fileInput.click();
            }
        });

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('dragover');
        });

        dropZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');

            // Try to remember the folder from dragged file
            if (e.dataTransfer.items) {
                for (const item of e.dataTransfer.items) {
                    // Modern API: getAsFileSystemHandle
                    if (item.kind === 'file' && typeof item.getAsFileSystemHandle === 'function') {
                        try {
                            const handle = await item.getAsFileSystemHandle();
                            if (handle && handle.kind === 'file') {
                                await FileHandleManager.saveHandle(handle);
                                break;
                            }
                        } catch (err) {
                            // Ignore if we can't get handle (e.g. cross-origin/sandbox issues)
                            console.debug('Could not get file handle from drag item:', err);
                        }
                    }
                }
            }

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

                processData(xmlDoc);
                uiManager.showTabs();

            } catch (err) {
                alert("Error parsing file: " + err.message);
                console.error(err);
            }
        };
        reader.readAsText(file);
    }

    function processData(xmlDoc) {
        const memNode = xmlDoc.getElementsByTagName('mem')[0];
        if (!memNode) throw new Error("No <mem> tag found");

        // 1. Parse System (Name)
        const memoryName = SystemParser.parseName(memNode);
        uiManager.updateMemoryName(memoryName);

        // 2. Parse Tracks
        const tracks = TrackParser.parse(memNode);

        // 3. Parse Assigns
        const assigns = AssignParser.parse(memNode);

        // 4. Parse Effects (CTL/Pedal)
        const effects = EffectParser.parse(memNode);

        // 5. Parse Input & Track FX
        // Note: FX data is in <ifx> (Input FX) and <tfx> (Track FX) tags, which are siblings of <mem>
        const ifxNode = xmlDoc.getElementsByTagName('ifx')[0] || memNode; // Fallback to memNode if not found (unexpected)
        const tfxNode = xmlDoc.getElementsByTagName('tfx')[0] || memNode;

        const inputTrackFx = InputTrackFxParser.parse(ifxNode, tfxNode);

        // Render everything
        uiManager.render(tracks, assigns, effects, inputTrackFx);
    }
});
