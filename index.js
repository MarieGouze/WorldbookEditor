import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import { world_info, world_names } from '../../../world-info.js';
import { getCharaFilename, getNextLorebookUid } from '../../../utils.js';

// Configuration
const CONFIG = {
    ID: 'worldbook-suite-panel',
    SETTINGS_KEY: 'worldbook_suite_metadata',
    TABS: ['editor', 'binding', 'stitcher'], // Added 'stitcher'
};

// Global State
const STATE = {
    isInitialized: false,
    currentView: 'editor',
    currentBook: null,
    books: [],
    metadata: {},
    entries: [],
    selectedEntries: new Set(),
    stitcher: {
        left: { book: null, entries: [], selected: new Set(), searchTerm: '' },
        right: { book: null, entries: [], selected: new Set(), searchTerm: '' },
    },
    saveDebouncer: null,
};

// --- API Layer (Interacting with SillyTavern) ---
const API = {
    async loadAllBooks() {
        return [...(world_names || [])].sort((a, b) => a.localeCompare(b));
    },
    async loadBookData(bookName) {
        if (!bookName) return [];
        const data = await getContext().loadWorldInfo(bookName);
        const entries = data.entries ? Object.values(structuredClone(data.entries)) : [];
        return entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    async saveBookData(bookName, entries) {
        if (!bookName) return;
        const currentData = await getContext().loadWorldInfo(bookName) || {};
        const newEntriesObject = {};
        entries.forEach(entry => {
            newEntriesObject[entry.uid] = entry;
        });
        const finalData = { ...currentData, entries: newEntriesObject };
        await getContext().saveWorldInfo(bookName, finalData, false);
    },
    async updateWorldList() {
        await getContext().updateWorldInfoList();
    },
    getMetadata() {
        return getContext().extensionSettings[CONFIG.SETTINGS_KEY] || {};
    },
    async saveMetadata(data) {
        getContext().extensionSettings[CONFIG.SETTINGS_KEY] = data;
        await getContext().saveSettings();
    },
    getBindings() {
        const context = getContext();
        const charId = context.characterId;
        const character = context.characters[charId];
        
        let primary = null, extra = [];
        if (character) {
            primary = character.data.extensions?.world;
            const charFile = getCharaFilename(null, { manualAvatarKey: character.avatar });
            const loreEntry = world_info.charLore?.find(e => e.name === charFile);
            extra = loreEntry?.extraBooks || [];
        }

        return {
            primary,
            extra,
            global: world_info.globalSelect,
        };
    }
};

// --- Actions (Business Logic) ---
const Actions = {
    async init() {
        if (STATE.isInitialized) return;
        await this.reloadData();
        this.registerEventListeners();
        STATE.isInitialized = true;
    },

    async reloadData() {
        STATE.books = await API.loadAllBooks();
        STATE.metadata = API.getMetadata();
    },

    registerEventListeners() {
        const handler = () => {
            if (!document.getElementById(CONFIG.ID)) return;
            Actions.reloadData().then(() => {
                UI.render(); // Full re-render on external changes
            });
        };
        eventSource.on(event_types.WORLDINFO_UPDATED, handler);
        eventSource.on(event_types.SETTINGS_UPDATED, handler);
        eventSource.on(event_types.CHARACTER_SELECTED, handler);
    },

    switchView(view) {
        STATE.currentView = view;
        UI.render();
    },

    async openBook(bookName) {
        await this.saveCurrentBook(true); // Force save before switching
        STATE.currentBook = bookName;
        STATE.selectedEntries.clear();
        if (bookName) {
            STATE.entries = await API.loadBookData(bookName);
        } else {
            STATE.entries = [];
        }
        UI.render();
    },
    
    updateEntry(uid, key, value) {
        const entry = STATE.entries.find(e => e.uid === uid);
        if (entry) {
            entry[key] = value;
            this.saveCurrentBook(); // Debounced save
        }
    },
    
    saveCurrentBook(force = false) {
        if (STATE.saveDebouncer) clearTimeout(STATE.saveDebouncer);
        const doSave = () => {
            if (STATE.currentBook && STATE.entries) {
                API.saveBookData(STATE.currentBook, STATE.entries);
            }
        };

        if (force) {
            doSave();
        } else {
            STATE.saveDebouncer = setTimeout(doSave, 500);
        }
    },

    // Batch Selection
    toggleSelection(uid) {
        if (STATE.selectedEntries.has(uid)) {
            STATE.selectedEntries.delete(uid);
        } else {
            STATE.selectedEntries.add(uid);
        }
        UI.renderBatchActionBar();
        UI.updateCardSelectionState(uid);
    },

    selectAll(invert = false) {
        const visibleEntryIds = STATE.entries.map(e => e.uid); // In a real scenario, this would respect search filters
        if (invert) {
            const newSelection = new Set();
            for (const uid of visibleEntryIds) {
                if (!STATE.selectedEntries.has(uid)) {
                    newSelection.add(uid);
                }
            }
            STATE.selectedEntries = newSelection;
        } else {
            visibleEntryIds.forEach(uid => STATE.selectedEntries.add(uid));
        }
        UI.render();
    },

    clearSelection() {
        STATE.selectedEntries.clear();
        UI.render();
    },
    
    // Batch Actions
    batchUpdate(key, value) {
        STATE.selectedEntries.forEach(uid => {
            const entry = STATE.entries.find(e => e.uid === uid);
            if (entry) entry[key] = value;
        });
        this.saveCurrentBook(true);
        UI.render();
    },
    
    // Snapshots
    async saveSnapshot() {
        const name = prompt("输入快照名称:", `快照 ${new Date().toLocaleString()}`);
        if (!name || !STATE.currentBook) return;

        const enabledUids = STATE.entries.filter(e => !e.disable).map(e => e.uid);
        
        const bookMeta = STATE.metadata[STATE.currentBook] || {};
        bookMeta.snapshots = bookMeta.snapshots || {};
        bookMeta.snapshots[name] = enabledUids;
        
        STATE.metadata[STATE.currentBook] = bookMeta;
        await API.saveMetadata(STATE.metadata);
        UI.render();
    },

    loadSnapshot(snapshotName) {
        if (!snapshotName || !STATE.currentBook) return;
        const bookMeta = STATE.metadata[STATE.currentBook];
        const enabledUids = new Set(bookMeta?.snapshots?.[snapshotName]);
        if (!enabledUids) return;

        STATE.entries.forEach(entry => {
            entry.disable = !enabledUids.has(entry.uid);
        });
        this.saveCurrentBook(true);
        UI.render();
    },
    
    async deleteSnapshot(snapshotName) {
        if (!snapshotName || !STATE.currentBook || !confirm(`确定删除快照 "${snapshotName}" 吗?`)) return;
        const bookMeta = STATE.metadata[STATE.currentBook];
        if (bookMeta?.snapshots?.[snapshotName]) {
            delete bookMeta.snapshots[snapshotName];
            await API.saveMetadata(STATE.metadata);
            UI.render();
        }
    },
    
    // Stitcher Actions
    async loadBookForStitcher(panel, bookName) {
        const stitcherPanel = STATE.stitcher[panel];
        stitcherPanel.book = bookName;
        stitcherPanel.selected.clear();
        if (bookName) {
            stitcherPanel.entries = await API.loadBookData(bookName);
        } else {
            stitcherPanel.entries = [];
        }
        UI.renderStitcherPanel(panel);
    },
    
    moveOrCopyStitcherEntries(sourcePanel, targetPanel, copy = false) {
        const source = STATE.stitcher[sourcePanel];
        const target = STATE.stitcher[targetPanel];
        
        if (!source.book || !target.book || source.selected.size === 0) {
            toastr.warning("请选择源世界书、目标世界书以及至少一个条目。");
            return;
        }

        const entriesToMove = [];
        source.entries.forEach(entry => {
            if(source.selected.has(entry.uid)) {
                entriesToMove.push(structuredClone(entry));
            }
        });
        
        if (copy) {
            entriesToMove.forEach(entry => {
                entry.uid = getNextLorebookUid(target.entries);
            });
        } else {
             // If move, filter them out from the source
            source.entries = source.entries.filter(entry => !source.selected.has(entry.uid));
        }

        target.entries.push(...entriesToMove);
        
        // Save both books and reload UI
        Promise.all([
            API.saveBookData(target.book, target.entries),
            copy ? null : API.saveBookData(source.book, source.entries)
        ]).then(() => {
            toastr.success(`条目已${copy ? '复制' : '移动'}!`);
            this.loadBookForStitcher(sourcePanel, source.book);
            this.loadBookForStitcher(targetPanel, target.book);
        });
    }
};

// --- UI Layer ---
const UI = {
    open() {
        if (document.getElementById(CONFIG.ID)) {
            document.getElementById(CONFIG.ID).remove();
            return;
        }
        Actions.init().then(() => {
            const panel = document.createElement('div');
            panel.id = CONFIG.ID;
            document.body.appendChild(panel);
            this.render();
        });
    },

    render() {
        const panel = document.getElementById(CONFIG.ID);
        if (!panel) return;

        let viewHtml = '';
        switch(STATE.currentView) {
            case 'binding': viewHtml = this.getBindingViewHtml(); break;
            case 'stitcher': viewHtml = this.getStitcherViewHtml(); break;
            case 'editor':
            default:
                viewHtml = this.getEditorViewHtml(); break;
        }
        
        panel.innerHTML = `
            <div class="ws-header">
                <div class="ws-tabs">
                    <div class="ws-tab-glider"></div>
                    <div class="ws-tab ${STATE.currentView === 'editor' ? 'active' : ''}" data-view="editor"><i class="fa-solid fa-pen-ruler"></i> 编辑</div>
                    <div class="ws-tab ${STATE.currentView === 'binding' ? 'active' : ''}" data-view="binding"><i class="fa-solid fa-link"></i> 绑定</div>
                    <div class="ws-tab ${STATE.currentView === 'stitcher' ? 'active' : ''}" data-view="stitcher"><i class="fa-solid fa-wand-magic-sparkles"></i> 缝合</div>
                </div>
                <div class="ws-close-button"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <main class="ws-main-content">
                ${viewHtml}
            </main>
            <div id="ws-batch-action-bar"></div>
        `;
        
        this.bindEvents();
        this.updateGlider();

        // Render dynamic parts
        if(STATE.currentView === 'editor') this.renderEditorView();
        if(STATE.currentView === 'stitcher') this.renderStitcherView();
        if(STATE.currentView === 'binding') this.renderBindingView();
    },

    bindEvents() {
        const panel = document.getElementById(CONFIG.ID);
        panel.querySelector('.ws-close-button').addEventListener('click', () => panel.remove());
        
        panel.querySelectorAll('.ws-tab').forEach(tab => {
            tab.addEventListener('click', () => Actions.switchView(tab.dataset.view));
        });

        // Editor events
        if (STATE.currentView === 'editor') {
            panel.querySelector('#ws-book-selector')?.addEventListener('change', (e) => Actions.openBook(e.target.value));
            panel.querySelector('#ws-select-all')?.addEventListener('click', () => Actions.selectAll());
            panel.querySelector('#ws-select-invert')?.addEventListener('click', () => Actions.selectAll(true));
            panel.querySelector('#ws-select-none')?.addEventListener('click', () => Actions.clearSelection());
            panel.querySelector('#ws-snapshot-save')?.addEventListener('click', () => Actions.saveSnapshot());
            panel.querySelector('#ws-snapshot-load')?.addEventListener('change', (e) => Actions.loadSnapshot(e.target.value));
            panel.querySelector('#ws-snapshot-delete')?.addEventListener('click', () => {
                const select = panel.querySelector('#ws-snapshot-load');
                if (select.value) Actions.deleteSnapshot(select.value);
            });
        }
        
        // Stitcher events
        if (STATE.currentView === 'stitcher') {
            panel.querySelector('#ws-stitcher-left-book')?.addEventListener('change', (e) => Actions.loadBookForStitcher('left', e.target.value));
            panel.querySelector('#ws-stitcher-right-book')?.addEventListener('change', (e) => Actions.loadBookForStitcher('right', e.target.value));
            panel.querySelector('#ws-move-to-right')?.addEventListener('click', () => Actions.moveOrCopyStitcherEntries('left', 'right', false));
            panel.querySelector('#ws-copy-to-right')?.addEventListener('click', () => Actions.moveOrCopyStitcherEntries('left', 'right', true));
            panel.querySelector('#ws-move-to-left')?.addEventListener('click', () => Actions.moveOrCopyStitcherEntries('right', 'left', false));
            panel.querySelector('#ws-copy-to-left')?.addEventListener('click', () => Actions.moveOrCopyStitcherEntries('right', 'left', true));
        }

        // Binding events (double-click)
        if (STATE.currentView === 'binding') {
            panel.querySelectorAll('.ws-book-list-item').forEach(item => {
                item.addEventListener('dblclick', () => {
                    const bookName = item.dataset.book;
                    Actions.openBook(bookName).then(() => {
                        Actions.switchView('editor');
                    });
                });
            });
        }
    },

    updateGlider() {
        const activeTab = document.querySelector('.ws-tab.active');
        const glider = document.querySelector('.ws-tab-glider');
        if (activeTab && glider) {
            glider.style.width = `${activeTab.offsetWidth}px`;
            glider.style.transform = `translateX(${activeTab.offsetLeft}px)`;
        }
    },
    
    // --- HTML Structure Getters ---
    getEditorViewHtml() {
        const bookOptions = STATE.books.map(b => `<option value="${b}" ${STATE.currentBook === b ? 'selected' : ''}>${b}</option>`).join('');
        const snapshots = STATE.metadata[STATE.currentBook]?.snapshots || {};
        const snapshotOptions = Object.keys(snapshots).map(name => `<option value="${name}">${name}</option>`).join('');

        return `
            <div class="ws-view" id="ws-view-editor">
                <div class="ws-editor-toolbar">
                    <select id="ws-book-selector" class="ws-select ws-book-selector">${bookOptions}</select>
                    <input type="search" id="ws-entry-search" class="ws-input ws-search-input" placeholder="搜索条目...">
                    <div class="ws-selection-toolbar">
                        <button id="ws-select-all" class="ws-button"><i class="fa-solid fa-check-double"></i> 全选</button>
                        <button id="ws-select-invert" class="ws-button"><i class="fa-solid fa-wand-magic"></i> 反选</button>
                        <button id="ws-select-none" class="ws-button"><i class="fa-solid fa-xmark"></i> 取消</button>
                    </div>
                    <div class="ws-state-snapshot-controls">
                        <select id="ws-snapshot-load" class="ws-select"><option value="">加载状态...</option>${snapshotOptions}</select>
                        <button id="ws-snapshot-save" class="ws-button" title="保存当前开关状态"><i class="fa-solid fa-save"></i></button>
                        <button id="ws-snapshot-delete" class="ws-button" title="删除选中状态"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
                <div class="ws-entry-list-container">
                    <div id="ws-entry-list" class="ws-entry-list"></div>
                </div>
            </div>`;
    },

    getBindingViewHtml() {
        const bindings = API.getBindings();
        const globalEnabled = new Set(bindings.global);

        let html = '<div class="ws-view" id="ws-view-binding">';
        html += '<h3>全局世界书 (只显示已启用的)</h3><div class="ws-book-list">';
        STATE.books.forEach(book => {
            if (globalEnabled.has(book)) {
                 html += `<div class="ws-book-list-item" data-book="${book}">${book}</div>`;
            }
        });
        html += '</div>';
        
        html += `<h3>角色主要世界书: <span class="ws-highlight">${bindings.primary || '无'}</span></h3>`;
        if (bindings.primary) {
            html += `<div class="ws-book-list"><div class="ws-book-list-item" data-book="${bindings.primary}">${bindings.primary}</div></div>`;
        }

        html += `<h3>角色附加世界书 (${bindings.extra.length})</h3><div class="ws-book-list">`;
        bindings.extra.forEach(book => {
            html += `<div class="ws-book-list-item" data-book="${book}">${book}</div>`;
        });
        html += '</div><p class="ws-hint">提示：双击任意世界书即可跳转至编辑界面。</p></div>';

        return html.replace('</div><div', '</div><style>.ws-book-list{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px;}.ws-book-list-item{background:#fff;border:1px solid #e5e7eb;padding:8px 12px;border-radius:8px;cursor:pointer;transition:all .2s;}.ws-book-list-item:hover{border-color:#66ccff;color:#0ea5e9;transform:translateY(-2px);box-shadow:0 4px 8px rgba(0,0,0,0.05);}.ws-highlight{color:#66ccff;font-weight:bold;}.ws-hint{font-size:.85em;color:#9ca3af;margin-top:20px;}</style><div');
    },

    getStitcherViewHtml() {
        const bookOptions = STATE.books.map(b => `<option value="${b}">${b}</option>`).join('');
        return `
            <div class="ws-view ws-stitcher-container" id="ws-view-stitcher">
                <!-- Left Panel -->
                <div class="ws-stitcher-panel" id="ws-stitcher-panel-left">
                    <div class="ws-stitcher-header">
                        <select id="ws-stitcher-left-book" class="ws-select"><option value="">选择左侧世界书</option>${bookOptions}</select>
                    </div>
                    <div class="ws-stitcher-toolbar">
                        <input type="search" class="ws-input ws-stitcher-search" placeholder="搜索...">
                        <button class="ws-button ws-stitcher-select-all">全选</button>
                    </div>
                    <div class="ws-stitcher-list"></div>
                    <div class="ws-stitcher-footer">
                        <button id="ws-move-to-right" class="ws-button">移动到右侧 &gt;</button>
                        <button id="ws-copy-to-right" class="ws-button primary">复制到右侧 &gt;&gt;</button>
                    </div>
                </div>

                <!-- Center Actions (for mobile) -->
                <div class="ws-stitcher-actions">
                    <button id="ws-swap-panels" class="ws-button" title="交换左右面板"><i class="fa-solid fa-exchange-alt"></i></button>
                </div>
                
                <!-- Right Panel -->
                <div class="ws-stitcher-panel" id="ws-stitcher-panel-right">
                     <div class="ws-stitcher-header">
                        <select id="ws-stitcher-right-book" class="ws-select"><option value="">选择右侧世界书</option>${bookOptions}</select>
                    </div>
                    <div class="ws-stitcher-toolbar">
                        <input type="search" class="ws-input ws-stitcher-search" placeholder="搜索...">
                        <button class="ws-button ws-stitcher-select-all">全选</button>
                    </div>
                    <div class="ws-stitcher-list"></div>
                    <div class="ws-stitcher-footer">
                        <button id="ws-move-to-left" class="ws-button">&lt; 移动到左侧</button>
                        <button id="ws-copy-to-left" class="ws-button primary">&lt;&lt; 复制到左侧</button>
                    </div>
                </div>
            </div>`;
    },

    // --- View Renderers ---
    renderEditorView() {
        const listEl = document.getElementById('ws-entry-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        STATE.entries.forEach(entry => {
            const card = document.createElement('div');
            card.className = `ws-entry-card ${entry.disable ? 'disabled' : ''} ${STATE.selectedEntries.has(entry.uid) ? 'selected' : ''}`;
            card.dataset.uid = entry.uid;
            card.innerHTML = `
                <input type="checkbox" class="ws-entry-checkbox" ${STATE.selectedEntries.has(entry.uid) ? 'checked' : ''}>
                <div class="ws-entry-content">
                    <div class="ws-entry-header">
                        <span class="ws-entry-comment">${entry.comment || '无标题'}</span>
                        <div class="ws-entry-actions">
                           <!-- more actions can go here -->
                        </div>
                    </div>
                    <div class="ws-entry-details">
                        <div class="ws-entry-detail-item ws-entry-enabled-toggle ${!entry.disable ? 'active' : ''}"><i class="fa-solid fa-power-off"></i> <span>${!entry.disable ? '已启用' : '已禁用'}</span></div>
                        <div class="ws-entry-detail-item ws-entry-constant-toggle ${entry.constant ? 'active' : ''}"><i class="fa-solid fa-star"></i> <span>${entry.constant ? '常驻' : '非常驻'}</span></div>
                        <div class="ws-entry-detail-item"><i class="fa-solid fa-layer-group"></i> <span>深度 ${entry.depth ?? 4}</span></div>
                        <div class="ws-entry-detail-item"><i class="fa-solid fa-sort-numeric-up"></i> <span>顺序 ${entry.order ?? 0}</span></div>
                    </div>
                </div>
            `;
            listEl.appendChild(card);
            
            card.querySelector('.ws-entry-checkbox').addEventListener('change', () => Actions.toggleSelection(entry.uid));
        });
        this.renderBatchActionBar();
    },
    
    renderBindingView() {
        // Double-click is handled in bindEvents, this is just for content rendering.
    },
    
    renderStitcherView() {
        this.renderStitcherPanel('left');
        this.renderStitcherPanel('right');
    },

    renderStitcherPanel(panel) {
        const panelState = STATE.stitcher[panel];
        const panelEl = document.getElementById(`ws-stitcher-panel-${panel}`);
        const listEl = panelEl.querySelector('.ws-stitcher-list');
        listEl.innerHTML = '';

        panelEl.querySelector('.ws-select').value = panelState.book || '';

        panelState.entries.forEach(entry => {
            const entryEl = document.createElement('div');
            entryEl.className = `ws-stitcher-entry ${panelState.selected.has(entry.uid) ? 'selected' : ''}`;
            entryEl.dataset.uid = entry.uid;
            entryEl.draggable = true;
            entryEl.innerHTML = `
                <input type="checkbox" class="ws-entry-checkbox" ${panelState.selected.has(entry.uid) ? 'checked' : ''}>
                <span class="ws-stitcher-entry-name">${entry.comment || '无标题'}</span>
            `;
            listEl.appendChild(entryEl);

            // Bind stitcher-specific selection
            entryEl.querySelector('.ws-entry-checkbox').addEventListener('change', () => {
                if (panelState.selected.has(entry.uid)) {
                    panelState.selected.delete(entry.uid);
                } else {
                    panelState.selected.add(entry.uid);
                }
                entryEl.classList.toggle('selected');
            });
        });
    },

    // --- Component Renderers ---
    renderBatchActionBar() {
        const bar = document.getElementById('ws-batch-action-bar');
        if (!bar) return;
        if (STATE.selectedEntries.size > 0) {
            bar.classList.add('visible');
            bar.innerHTML = `
                <span id="ws-batch-selection-count">已选择 ${STATE.selectedEntries.size} 项</span>
                <div class="ws-batch-actions">
                    <button class="ws-button" id="batch-enable">启用</button>
                    <button class="ws-button" id="batch-disable">禁用</button>
                    <button class="ws-button" id="batch-toggle-constant">切换常驻</button>
                </div>
            `;
            document.getElementById('batch-enable').addEventListener('click', () => Actions.batchUpdate('disable', false));
            document.getElementById('batch-disable').addEventListener('click', () => Actions.batchUpdate('disable', true));
            document.getElementById('batch-toggle-constant').addEventListener('click', () => {
                // This is a toggle, a bit more complex logic
                const firstSelected = STATE.entries.find(e => STATE.selectedEntries.has(e.uid));
                if (firstSelected) {
                    Actions.batchUpdate('constant', !firstSelected.constant);
                }
            });
        } else {
            bar.classList.remove('visible');
        }
    },
    
    updateCardSelectionState(uid) {
        const card = document.querySelector(`.ws-entry-card[data-uid="${uid}"]`);
        if (card) {
            card.classList.toggle('selected', STATE.selectedEntries.has(uid));
            card.querySelector('.ws-entry-checkbox').checked = STATE.selectedEntries.has(uid);
        }
    },
};

// --- Entry Point ---
jQuery(async () => {
    // Create and inject the button into the UI
    const optionsMenu = $('#options-menu');
    if (optionsMenu.length > 0) {
        const buttonHtml = `
            <div id="worldbook-suite-button" class="option_item">
                <i class="fa-solid fa-book-atlas"></i>
                <span>世界书套件</span>
            </div>
        `;
        optionsMenu.append(buttonHtml);
        $('#worldbook-suite-button').on('click', () => {
            $('#options').hide();
            UI.open();
        });
    }
});
