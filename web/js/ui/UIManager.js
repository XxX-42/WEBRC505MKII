export class UIManager {
    constructor(contentAreaId, tabsNavId, memoryNameId) {
        this.contentArea = document.getElementById(contentAreaId);
        this.tabsNav = document.getElementById(tabsNavId);
        this.memoryNameDisplay = document.getElementById(memoryNameId);
    }

    updateMemoryName(name) {
        if (this.memoryNameDisplay) {
            this.memoryNameDisplay.textContent = name;
        }
    }

    showTabs() {
        if (this.tabsNav) {
            this.tabsNav.style.display = 'flex';
        }
    }

    render(tracks, assigns, effects) {
        this.contentArea.innerHTML = '';

        // Create Panes
        const tracksPane = this.createPane('tracks', true);
        const assignsPane = this.createPane('assigns');
        const effectsPane = this.createPane('effects');
        const systemPane = this.createPane('system');

        // Render Tracks
        this.renderTracks(tracks, tracksPane);

        // Render Assigns
        this.renderAssigns(assigns, assignsPane);

        // Render Effects
        this.renderEffects(effects, effectsPane);

        this.contentArea.appendChild(tracksPane);
        this.contentArea.appendChild(assignsPane);
        this.contentArea.appendChild(effectsPane);
        this.contentArea.appendChild(systemPane);

        // Re-attach tab logic since DOM changed or just initial setup
        this.setupTabListeners();
    }

    renderTracks(tracks, container) {
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
            paramsDiv.appendChild(this.createParamTable(track.params));
            col.appendChild(paramsDiv);

            trackGrid.appendChild(col);
        });
        container.appendChild(trackGrid);
    }

    renderAssigns(assigns, container) {
        const assignsGrid = document.createElement('div');
        assignsGrid.className = 'data-grid';
        assigns.forEach(assign => {
            const card = document.createElement('div');
            card.className = 'card';

            const title = document.createElement('div');
            title.className = 'card-title';
            title.textContent = `ASSIGN ${assign.id}`;
            card.appendChild(title);

            card.appendChild(this.createParamTable(assign.params));
            assignsGrid.appendChild(card);
        });
        container.appendChild(assignsGrid);
    }

    renderEffects(effects, container) {
        const effectsGrid = document.createElement('div');
        effectsGrid.className = 'data-grid';
        effects.forEach(fx => {
            const card = document.createElement('div');
            card.className = 'card';

            const title = document.createElement('div');
            title.className = 'card-title';
            title.textContent = fx.name;
            card.appendChild(title);

            card.appendChild(this.createParamTable(fx.params));
            effectsGrid.appendChild(card);
        });
        container.appendChild(effectsGrid);
    }

    createPane(id, isActive = false) {
        const pane = document.createElement('div');
        pane.id = `pane-${id}`;
        pane.className = `tab-pane ${isActive ? 'active' : ''}`;
        return pane;
    }

    createParamTable(params) {
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

    setupTabListeners() {
        const tabBtns = document.querySelectorAll('.tab-btn');
        tabBtns.forEach(btn => {
            // Remove old listeners to prevent duplicates if called multiple times?
            // Actually new DOM elements (panes) are created, but buttons are static in HTML.
            // Using a simple approach: clone node to strip listeners or just handle carefully.
            // Since this app is simple, we can just add listener. 
            // Better: delegating from parent, but let's stick to simple for now.

            // Re-adding listeners might be tricky if we don't remove old ones.
            // Let's assume this is called once or we handle it in app.js
            // Actually, tab buttons are outside contentArea, so they persist.
            // We should NOT add listeners here if they are already added in app.js or init.
            // I'll move tab logic to app.js or a separate TabManager to be cleaner.
        });
    }
}
