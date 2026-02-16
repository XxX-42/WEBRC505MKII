document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('fileInput');
    const dropZone = document.getElementById('dropZone');
    const memoryNameDisplay = document.getElementById('memoryName');
    const contentArea = document.getElementById('contentArea');
    const tabsNav = document.getElementById('tabs');
    const tabBtns = document.querySelectorAll('.tab-btn');
    const themeToggleBtn = document.getElementById('themeToggle');

    // Theme Logic
    themeToggleBtn.addEventListener('click', () => {
        document.body.classList.toggle('light-mode');
        const isLight = document.body.classList.contains('light-mode');
        localStorage.setItem('theme', isLight ? 'light' : 'dark');
    });

    // Load saved theme
    if (localStorage.getItem('theme') === 'light') {
        document.body.classList.add('light-mode');
    }

    // Drag and Drop Logic
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
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(e.target.result, "text/xml");

                // Basic Validation
                if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
                    throw new Error("Invalid XML file");
                }

                // Check for standard RC0 tags
                const memTag = xmlDoc.getElementsByTagName('mem')[0];
                if (!memTag) {
                    throw new Error("No <mem> tag found. Is this a valid RC0 file?");
                }

                parseData(memTag);
                tabsNav.style.display = 'flex';

            } catch (err) {
                alert("Error parsing file: " + err.message);
            }
        };
        reader.readAsText(file);
    }

    function parseData(memNode) {
        // Clear previous
        contentArea.innerHTML = '';

        // 1. Parse Name
        const nameNode = memNode.getElementsByTagName('NAME')[0];
        if (nameNode) {
            const asciiCodes = Array.from(nameNode.children).map(child => parseInt(child.textContent));
            // Filter out 0s or invalid chars if needed
            const nameStr = asciiCodes.map(c => String.fromCharCode(c)).join('').trim();
            memoryNameDisplay.textContent = nameStr;
        }

        // 2. Parse Tracks
        const tracksData = [];
        for (let i = 1; i <= 6; i++) {
            const trackNode = memNode.getElementsByTagName(`TRACK${i}`)[0];
            if (trackNode) {
                tracksData.push({
                    id: i,
                    params: xmlNodeToDict(trackNode)
                });
            }
        }

        // 3. Parse Assigns
        const assignsData = [];
        for (let i = 1; i <= 16; i++) {
            const assignNode = memNode.getElementsByTagName(`ASSIGN${i}`)[0];
            if (assignNode) {
                assignsData.push({
                    id: i,
                    params: xmlNodeToDict(assignNode)
                });
            }
        }

        // 4. Parse Effects/Others
        // Group by prefix? Or just listing generic blocks
        // For simple visualization, getting all ICTL tags
        const effectsData = [];
        const allChildren = Array.from(memNode.children);

        // Filter mainly for ICTL, ECTL, EQ
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
                params: xmlNodeToDict(node)
            });
        });

        renderUI(tracksData, assignsData, effectsData);
    }

    function xmlNodeToDict(node) {
        const dict = {};
        for (let child of node.children) {
            dict[child.tagName] = child.textContent;
        }
        return dict;
    }

    function renderUI(tracks, assigns, effects) {
        // Create Panes
        const tracksPane = createPane('tracks', true);
        const assignsPane = createPane('assigns');
        const effectsPane = createPane('effects');
        const systemPane = createPane('system'); // Placeholder for now

        // Render Tracks
        const trackGrid = document.createElement('div');
        trackGrid.className = 'track-grid';

        tracks.forEach(track => {
            const col = document.createElement('div');
            col.className = 'track-col';

            const header = document.createElement('div');
            header.className = 'track-header';
            header.textContent = `TRACK ${track.id}`;
            col.appendChild(header);

            const paramsDiv = document.createElement('div');
            paramsDiv.className = 'track-params';
            paramsDiv.appendChild(createParamTable(track.params));
            col.appendChild(paramsDiv);

            trackGrid.appendChild(col);
        });
        tracksPane.appendChild(trackGrid);

        // Render Assigns
        const assignsGrid = document.createElement('div');
        assignsGrid.className = 'data-grid';
        assigns.forEach(assign => {
            const card = document.createElement('div');
            card.className = 'card';

            const title = document.createElement('div');
            title.className = 'card-title';
            title.textContent = `ASSIGN ${assign.id}`;
            card.appendChild(title);

            card.appendChild(createParamTable(assign.params));
            assignsGrid.appendChild(card);
        });
        assignsPane.appendChild(assignsGrid);

        // Render Effects
        const effectsGrid = document.createElement('div');
        effectsGrid.className = 'data-grid';
        effects.forEach(fx => {
            const card = document.createElement('div');
            card.className = 'card';

            const title = document.createElement('div');
            title.className = 'card-title';
            title.textContent = fx.name;
            card.appendChild(title);

            card.appendChild(createParamTable(fx.params));
            effectsGrid.appendChild(card);
        });
        effectsPane.appendChild(effectsGrid);

        contentArea.appendChild(tracksPane);
        contentArea.appendChild(assignsPane);
        contentArea.appendChild(effectsPane);
        contentArea.appendChild(systemPane);
    }

    function createPane(id, isActive = false) {
        const pane = document.createElement('div');
        pane.id = `pane-${id}`;
        pane.className = `tab-pane ${isActive ? 'active' : ''}`;
        return pane;
    }

    function createParamTable(params) {
        const table = document.createElement('table');
        table.className = 'param-table';

        for (let [key, val] of Object.entries(params)) {
            const tr = document.createElement('tr');

            const tdKey = document.createElement('td');
            tdKey.className = 'param-key';
            tdKey.textContent = key;

            const tdVal = document.createElement('td');
            tdVal.className = 'param-val';
            tdVal.textContent = val;

            tr.appendChild(tdKey);
            tr.appendChild(tdVal);
            table.appendChild(tr);
        }
        return table;
    }
});
