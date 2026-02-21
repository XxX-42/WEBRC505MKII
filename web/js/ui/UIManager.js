export class UIManager {
    constructor(contentAreaId, tabsNavId, memoryNameId) {
        this.contentArea = document.getElementById(contentAreaId);
        this.tabsNav = document.getElementById(tabsNavId);
        this.memoryNameDisplay = document.getElementById(memoryNameId);

        // --- Debug Mode State ---
        this.isDebugMode = true; // default
        this.currentData = null; // store the parsed data for re-rendering

        // UX state for Input/Track FX
        this.uxState = {
            inputBank: 'A',
            trackBank: 'A',
            inputFxSlots: ['LPF', 'G2B', 'PATTERN_SLICER', 'GRANULAR_DELAY'],
            trackFxSlots: ['BEAT_SCATTER', 'FLANGER', 'TRANSPOSE', 'GRANULAR_DELAY']
        };
    }

    setDebugMode(isDebug) {
        if (this.isDebugMode === isDebug) return;
        this.isDebugMode = isDebug;
        if (this.currentData) {
            // Extract the pane and re-render only the fx pane to preserve active tab
            const inputTrackFxPane = document.getElementById('pane-input-track-fx');
            if (inputTrackFxPane) {
                this.renderInputTrackFx(this.currentData.inputTrackFx, inputTrackFxPane);
            }
        }
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

    render(tracks, assigns, effects, inputTrackFx = null) {
        this.currentData = { tracks, assigns, effects, inputTrackFx }; // Store for re-render
        this.contentArea.innerHTML = '';

        // Create Panes
        const tracksPane = this.createPane('tracks', true);
        const assignsPane = this.createPane('assigns');
        const effectsPane = this.createPane('effects');
        const systemPane = this.createPane('system');
        const inputTrackFxPane = this.createPane('input-track-fx'); // Single pane for both

        // Render Tracks
        this.renderTracks(tracks, tracksPane);

        // Render Assigns
        this.renderAssigns(assigns, assignsPane);

        // Render Effects
        this.renderEffects(effects, effectsPane);

        // Render Input & Track FX
        if (inputTrackFx) {
            this.renderInputTrackFx(inputTrackFx, inputTrackFxPane);
        }

        this.contentArea.appendChild(tracksPane);
        this.contentArea.appendChild(assignsPane);
        this.contentArea.appendChild(effectsPane);
        this.contentArea.appendChild(inputTrackFxPane);
        this.contentArea.appendChild(systemPane);

        // Re-attach tab logic since DOM changed
        // Note: In a real app, we'd use event delegation to avoid this re-attachment mess
        // For now, valid hack
    }

    renderInputTrackFx(data, container) {
        container.innerHTML = ''; // Clear previous content
        if (this.isDebugMode) {
            this.renderInputTrackFxDebug(data, container);
        } else {
            this.renderInputTrackFxUser(data, container);
        }
    }

    renderInputTrackFxUser(data, container) {
        container.innerHTML = ''; // \u6E05\u7A7A\u5185\u5BB9\u9632\u6B62\u91CD\u590D\u6DFB\u52A0
        if (!data || (!data.inputFx && !data.trackFx)) {
            const msg = document.createElement('div');
            msg.textContent = "No visible FX data";
            container.appendChild(msg);
            return;
        }

        // Layout
        const wrapper = document.createElement('div');
        wrapper.className = 'fx-container';
        wrapper.style.display = 'flex';
        wrapper.style.gap = '20px';
        wrapper.style.justifyContent = 'space-between';

        const createColumnUser = (title, bankKey, slotsKey, fxDataObj) => {
            const col = document.createElement('div');
            col.className = 'fx-column';
            col.style.flex = '1';

            const h3 = document.createElement('h3');
            h3.textContent = title;
            col.appendChild(h3);

            // Bank Selector
            const bankSelectorWrapper = document.createElement('div');
            bankSelectorWrapper.style.display = 'flex';
            bankSelectorWrapper.style.gap = '5px';
            bankSelectorWrapper.style.marginBottom = '15px';
            bankSelectorWrapper.style.justifyContent = 'center';

            ['A', 'B', 'C', 'D'].forEach(bank => {
                const btn = document.createElement('button');
                btn.textContent = `Bank ${bank}`;
                btn.className = 'tab-btn' + (this.uxState[bankKey] === bank ? ' active' : '');
                btn.style.padding = '5px 10px';
                btn.style.flex = '1';
                btn.onclick = () => {
                    this.uxState[bankKey] = bank;
                    this.renderInputTrackFxUser(data, container);
                };
                bankSelectorWrapper.appendChild(btn);
            });
            col.appendChild(bankSelectorWrapper);

            // FX Slots
            const slotsContainer = document.createElement('div');
            slotsContainer.className = 'user-fx-slots';
            slotsContainer.style.display = 'grid';
            slotsContainer.style.gridTemplateColumns = '1fr 1fr';
            slotsContainer.style.gap = '10px';
            slotsContainer.style.flex = '1';
            slotsContainer.style.overflowY = 'auto';

            const activeBankData = fxDataObj[this.uxState[bankKey]];

            // Group all effects available in this bank (filter out Common / Status and _SEQ)
            const availableEffects = activeBankData
                ? activeBankData
                    .map(f => f.type)
                    .filter(type => type !== 'Common / Status' && !type.includes('_SEQ'))
                : [];

            for (let i = 0; i < 4; i++) {
                const slotDiv = document.createElement('div');
                slotDiv.className = 'fx-block';
                slotDiv.style.display = 'flex';
                slotDiv.style.flexDirection = 'column';

                const slotHeader = document.createElement('div');
                slotHeader.style.display = 'flex';
                slotHeader.style.justifyContent = 'space-between';
                slotHeader.style.alignItems = 'center';
                slotHeader.style.marginBottom = '10px';
                slotHeader.style.borderBottom = '1px solid #333';
                slotHeader.style.paddingBottom = '5px';

                const label = document.createElement('h4');
                label.textContent = `FX ${i + 1}`;
                label.style.margin = '0';
                label.style.borderBottom = 'none';

                const select = document.createElement('select');
                select.className = 'fx-select';
                select.style.padding = '2px 5px';
                select.style.background = 'var(--panel-bg)';
                select.style.color = 'var(--text-color)';
                select.style.border = '1px solid var(--border-color)';
                select.style.cursor = 'pointer';

                // Ensure the currently selected option is in the list of available effects
                let currentSelectedType = this.uxState[slotsKey][i];
                // In case XML is empty or doesn't have it, at least we try to match what is possible

                availableEffects.forEach(effectType => {
                    const opt = document.createElement('option');
                    opt.value = effectType;
                    opt.textContent = effectType;
                    select.appendChild(opt);
                });

                // Set value or fallback to first
                if (availableEffects.includes(currentSelectedType)) {
                    select.value = currentSelectedType;
                } else if (availableEffects.length > 0) {
                    select.value = availableEffects[0];
                    this.uxState[slotsKey][i] = availableEffects[0];
                }

                select.onchange = (e) => {
                    this.uxState[slotsKey][i] = e.target.value;
                    this.renderInputTrackFxUser(data, container);
                };

                slotHeader.appendChild(label);
                slotHeader.appendChild(select);
                slotDiv.appendChild(slotHeader);

                // Find effect params
                const activeEffect = activeBankData ? activeBankData.find(f => f.type === select.value) : null;
                if (activeEffect) {
                    const lcdPanel = this.createLcdPanel(title, bankKey, select.value, i + 1, activeEffect.params);
                    slotDiv.appendChild(lcdPanel);
                } else {
                    const empty = document.createElement('div');
                    empty.textContent = "N/A";
                    empty.style.color = '#666';
                    slotDiv.appendChild(empty);
                }

                slotsContainer.appendChild(slotDiv);
            }

            col.appendChild(slotsContainer);
            return col;
        };

        wrapper.appendChild(createColumnUser('Input FX', 'inputBank', 'inputFxSlots', data.inputFx));
        wrapper.appendChild(createColumnUser('Track FX', 'trackBank', 'trackFxSlots', data.trackFx));

        container.appendChild(wrapper);
    }

    renderInputTrackFxDebug(data, container) {
        console.log("[UIManager] Rendering Input/Track FX - DEBUG", data);

        // Create Layout
        const wrapper = document.createElement('div');
        wrapper.className = 'fx-container'; // Reuse existing class for layout
        wrapper.style.display = 'flex';
        wrapper.style.gap = '20px';
        wrapper.style.justifyContent = 'space-between';

        const createColumn = (title) => {
            const col = document.createElement('div');
            col.className = 'fx-column';
            col.style.flex = '1';
            const h3 = document.createElement('h3');
            h3.textContent = title;
            col.appendChild(h3);
            const list = document.createElement('div');
            col.appendChild(list);
            return { col, list };
        };

        const inputCol = createColumn('Input FX (A-D)');
        const trackCol = createColumn('Track FX (A-D)');

        wrapper.appendChild(inputCol.col);
        wrapper.appendChild(trackCol.col);
        container.appendChild(wrapper);

        if (!data || (!data.inputFx && !data.trackFx)) {
            const msg = document.createElement('div');
            msg.textContent = "No visible FX data";
            container.appendChild(msg);
            return;
        }

        const renderBankGroup = (bankData, targetList, label) => {
            if (!bankData) return;

            for (let [bank, fxList] of Object.entries(bankData)) {
                const bankBlock = document.createElement('div');
                bankBlock.className = 'bank-block';
                bankBlock.style.marginBottom = '15px';
                bankBlock.style.border = '1px solid #444';
                bankBlock.style.padding = '10px';
                bankBlock.style.borderRadius = '4px';

                const bankTitle = document.createElement('div');
                bankTitle.className = 'bank-title';
                bankTitle.innerHTML = `<strong>Bank ${bank}</strong>`;
                bankTitle.style.marginBottom = '5px';
                bankTitle.style.borderBottom = '1px solid #555';
                bankBlock.appendChild(bankTitle);

                if (fxList.length === 0) {
                    const empty = document.createElement('div');
                    empty.textContent = "Empty / Off";
                    empty.style.fontStyle = 'italic';
                    empty.style.color = '#888';
                    bankBlock.appendChild(empty);
                } else {
                    fxList.forEach(fx => {
                        const item = document.createElement('div');
                        item.className = 'fx-item';

                        const typeHeader = document.createElement('div');
                        typeHeader.textContent = `Type: ${fx.type}`;
                        typeHeader.style.color = 'var(--accent-green)';
                        typeHeader.style.marginBottom = '5px';
                        item.appendChild(typeHeader);

                        // Params Table
                        const table = this.createParamTable(fx.params);
                        item.appendChild(table);
                        bankBlock.appendChild(item);
                    });
                }
                targetList.appendChild(bankBlock);
            }
        };

        renderBankGroup(data.inputFx, inputCol.list, 'Input FX');
        renderBankGroup(data.trackFx, trackCol.list, 'Track FX');
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

    createLcdPanel(title, bankKey, effectName, slotIndex, params) {
        const panel = document.createElement('div');
        panel.className = 'lcd-panel';

        const header = document.createElement('div');
        header.className = 'lcd-header-bar';

        const titleSpan = document.createElement('span');
        titleSpan.textContent = `${title}: FX ${this.uxState[bankKey]}-${slotIndex} [${effectName}]`;

        const iconDiv = document.createElement('div');
        iconDiv.className = 'lcd-header-icon';

        header.appendChild(titleSpan);
        header.appendChild(iconDiv);
        panel.appendChild(header);

        const grid = document.createElement('div');
        grid.className = 'lcd-params-grid';

        for (let [key, val] of Object.entries(params)) {
            const col = document.createElement('div');
            col.className = 'lcd-param-col';

            const valDiv = document.createElement('div');
            valDiv.className = 'lcd-param-val';
            valDiv.textContent = val;

            const knobWrapper = document.createElement('div');
            knobWrapper.className = 'knob-wrapper';

            const dotLeft = document.createElement('div');
            dotLeft.className = 'limit-dot-left';

            const dotRight = document.createElement('div');
            dotRight.className = 'limit-dot-right';

            const knobDial = document.createElement('div');
            knobDial.className = 'knob-dial';

            // Calculate knob rotation fake algorithm
            let angle = -135;
            const numVal = parseInt(val, 10);
            if (!isNaN(numVal)) {
                angle = -135 + (Math.min(100, Math.max(0, numVal)) / 100) * 270;
            } else if (val === 'OFF') {
                angle = -135;
            } else if (val === 'ON') {
                angle = 135;
            } else {
                let hash = 0;
                for (let c = 0; c < val.length; c++) hash += val.charCodeAt(c);
                angle = -135 + (hash % 271);
            }
            knobDial.style.transform = `rotate(${angle}deg)`;

            knobWrapper.appendChild(dotLeft);
            knobWrapper.appendChild(dotRight);
            knobWrapper.appendChild(knobDial);

            const labelDiv = document.createElement('div');
            labelDiv.className = 'lcd-param-label';
            labelDiv.textContent = key;

            col.appendChild(valDiv);
            col.appendChild(knobWrapper);
            col.appendChild(labelDiv);
            grid.appendChild(col);
        }
        panel.appendChild(grid);
        return panel;
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
