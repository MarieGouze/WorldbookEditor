import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import { world_info, world_names } from '../../../world-info.js';
import { getCharaFilename } from '../../../utils.js';

// ===============================================================
//
//                 Worldbook Suite - Final & Fixed
//
// ===============================================================


// --- 配置 ---
const CONFIG = {
    ID: 'worldbook-suite-panel',
    // 【修复】使用您原版代码中的稳定按钮ID
    BTN_ID: 'wb-menu-btn-v6-suite',
    SETTINGS_KEY: 'worldbook_suite_metadata',
    TABS: ['editor', 'binding', 'stitcher'],
};

// --- 全局状态管理器 ---
const STATE = {
    isInitialized: false,
    currentView: 'editor',
    currentBook: null,
    books: [],
    metadata: {},
    entries: [],
    selectedEntries: new Set(),
    stitcher: {
        left: { book: null, entries: [], selected: new Set() },
        right: { book: null, entries: [], selected: new Set() },
    },
    saveDebouncer: null,
};


// --- API层 (与酒馆核心交互) ---
const API = {
    async loadAllBooks() {
        return [...(world_names || [])].sort((a, b) => a.localeCompare(b));
    },
    async loadBookData(bookName) {
        if (!bookName) return [];
        try {
            const data = await getContext().loadWorldInfo(bookName);
            const entries = data.entries ? Object.values(structuredClone(data.entries)) : [];
            return entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        } catch (error) {
            console.error(`Error loading book ${bookName}:`, error);
            toastr.error(`加载世界书 "${bookName}" 失败。`);
            return [];
        }
    },
    async saveBookData(bookName, entries) {
        if (!bookName) return;
        const currentData = await getContext().loadWorldInfo(bookName) || { entries: {} };
        const newEntriesObject = {};
        entries.forEach(entry => {
            newEntriesObject[entry.uid] = { ...entry };
        });
        const finalData = { ...currentData, entries: newEntriesObject };
        await getContext().saveWorldInfo(bookName, finalData, false);
    },
    getMetadata() {
        return getContext().extensionSettings[CONFIG.SETTINGS_KEY] || {};
    },
    async saveMetadata(data) {
        getContext().extensionSettings[CONFIG.SETTINGS_KEY] = data;
        getContext().saveSettingsDebounced();
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
        return { primary, extra, global: world_info.globalSelect || [] };
    }
};

// --- 业务逻辑层 ---
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
            if (document.getElementById(CONFIG.ID)) {
                this.reloadData().then(() => UI.render());
            }
        };
        eventSource.on(event_types.WORLDINFO_UPDATED, handler);
        eventSource.on(event_types.SETTINGS_UPDATED, handler);
        eventSource.on(event_types.CHARACTER_SELECTED, handler);
        eventSource.on(event_types.CHAT_CHANGED, handler);
    },

    switchView(view) {
        STATE.currentView = view;
        UI.render();
    },

    async openBook(bookName) {
        await this.saveCurrentBook(true);
        STATE.currentBook = bookName;
        STATE.selectedEntries.clear();
        STATE.entries = bookName ? await API.loadBookData(bookName) : [];
        UI.render();
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

    toggleSelection(uid) {
        STATE.selectedEntries.has(uid) ? STATE.selectedEntries.delete(uid) : STATE.selectedEntries.add(uid);
        UI.renderBatchActionBar();
        UI.updateCardSelectionState(uid);
    },

    selectAll(invert = false) {
        const allEntryIds = STATE.entries.map(e => e.uid);
        if (invert) {
            const newSelection = new Set();
            allEntryIds.forEach(uid => !STATE.selectedEntries.has(uid) && newSelection.add(uid));
            STATE.selectedEntries = newSelection;
        } else {
            allEntryIds.forEach(uid => STATE.selectedEntries.add(uid));
        }
        UI.render();
    },

    clearSelection() {
        STATE.selectedEntries.clear();
        UI.render();
    },

    batchUpdate(key, value) {
        const isToggle = typeof value === 'function';
        STATE.selectedEntries.forEach(uid => {
            const entry = STATE.entries.find(e => e.uid === uid);
            if (entry) entry[key] = isToggle ? value(entry[key]) : value;
        });
        this.saveCurrentBook(true);
        this.clearSelection();
    },

    async saveSnapshot() {
        const name = prompt("请输入快照名称:", `配置 ${new Date().toLocaleTimeString()}`);
        if (!name || !STATE.currentBook) return;
        const enabledUids = STATE.entries.filter(e => !e.disable).map(e => e.uid);
        const bookMeta = STATE.metadata[STATE.currentBook] || {};
        bookMeta.snapshots = bookMeta.snapshots || {};
        bookMeta.snapshots[name] = enabledUids;
        STATE.metadata[STATE.currentBook] = bookMeta;
        await API.saveMetadata(STATE.metadata);
        toastr.success(`快照 "${name}" 已保存!`);
        UI.render();
    },

    loadSnapshot(snapshotName) {
        if (!snapshotName || !STATE.currentBook) return;
        const bookMeta = STATE.metadata[STATE.currentBook];
        const snapshotUids = bookMeta?.snapshots?.[snapshotName];
        if (!snapshotUids) return toastr.error("找不到该快照。");
        const enabledUids = new Set(snapshotUids);
        STATE.entries.forEach(entry => entry.disable = !enabledUids.has(entry.uid));
        this.saveCurrentBook(true);
        toastr.success(`已加载快照 "${snapshotName}"。`);
        UI.render();
    },

    async deleteSnapshot(snapshotName) {
        if (!snapshotName || !STATE.currentBook || !confirm(`确定要删除快照 "${snapshotName}" 吗?`)) return;
        const bookMeta = STATE.metadata[STATE.currentBook];
        if (bookMeta?.snapshots?.[snapshotName]) {
            delete bookMeta.snapshots[snapshotName];
            await API.saveMetadata(STATE.metadata);
            toastr.success(`快照 "${snapshotName}" 已删除。`);
            UI.render();
        }
    },

    async loadBookForStitcher(panel, bookName) {
        const stitcherPanel = STATE.stitcher[panel];
        stitcherPanel.book = bookName;
        stitcherPanel.selected.clear();
        stitcherPanel.entries = bookName ? await API.loadBookData(bookName) : [];
        UI.renderStitcherPanel(panel);
    },

    moveOrCopyStitcherEntries(sourcePanel, targetPanel, copy = false) {
        const source = STATE.stitcher[sourcePanel];
        const target = STATE.stitcher[targetPanel];
        if (!source.book || !target.book) return toastr.warning("请先在左右两边都选择一个世界书。");
        if (source.selected.size === 0) return toastr.info("请在源面板中选择至少一个条目。");

        const entriesToTransfer = [];
        source.entries.forEach(entry => {
            if (source.selected.has(entry.uid)) entriesToTransfer.push(structuredClone(entry));
        });

        if (copy) {
            // 【修复】使用手动、可靠的方式生成新UID，不再依赖外部函数
            let nextAvailableUid = target.entries.reduce((max, e) => Math.max(max, e.uid), -1) + 1;
            const targetUids = new Set(target.entries.map(e => e.uid));
            entriesToTransfer.forEach(entry => {
                while (targetUids.has(nextAvailableUid)) {
                    nextAvailableUid++;
                }
                entry.uid = nextAvailableUid;
                targetUids.add(nextAvailableUid);
                nextAvailableUid++;
            });
        } else {
            source.entries = source.entries.filter(entry => !source.selected.has(entry.uid));
            source.selected.clear();
        }

        target.entries.push(...entriesToTransfer);
        
        Promise.all([
            API.saveBookData(target.book, target.entries),
            copy ? Promise.resolve() : API.saveBookData(source.book, source.entries)
        ]).then(() => {
            toastr.success(`条目已成功${copy ? '复制' : '移动'}!`);
            this.loadBookForStitcher(sourcePanel, source.book);
            this.loadBookForStitcher(targetPanel, target.book);
        });
    }
};


// --- UI渲染层 ---
const UI = {
    open() {
        const existingPanel = document.getElementById(CONFIG.ID);
        if (existingPanel) return existingPanel.remove();
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
        let viewHtml;
        switch(STATE.currentView) {
            case 'binding': viewHtml = this.getBindingViewHtml(); break;
            case 'stitcher': viewHtml = this.getStitcherViewHtml(); break;
            default: viewHtml = this.getEditorViewHtml(); break;
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
            <main class="ws-main-content">${viewHtml}</main>
            <div id="ws-batch-action-bar"></div>
        `;
        
        this.bindEvents();
        this.updateGlider();

        if (STATE.currentView === 'editor') this.renderEditorView();
        if (STATE.currentView === 'stitcher') this.renderStitcherView();
    },

    bindEvents() {
        const panel = document.getElementById(CONFIG.ID);
        panel.querySelector('.ws-close-button').addEventListener('click', () => panel.remove());
        panel.querySelectorAll('.ws-tab').forEach(tab => tab.addEventListener('click', () => Actions.switchView(tab.dataset.view)));

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
        
        if (STATE.currentView === 'stitcher') {
            const leftPanel = panel.querySelector('#ws-stitcher-panel-left');
            const rightPanel = panel.querySelector('#ws-stitcher-panel-right');
            leftPanel.querySelector('.ws-select').addEventListener('change', (e) => Actions.loadBookForStitcher('left', e.target.value));
            rightPanel.querySelector('.ws-select').addEventListener('change', (e) => Actions.loadBookForStitcher('right', e.target.value));
            
            const leftMoveBtn = leftPanel.querySelector('.ws-stitcher-footer button:nth-of-type(1)');
            const leftCopyBtn = leftPanel.querySelector('.ws-stitcher-footer button:nth-of-type(2)');
            const rightMoveBtn = rightPanel.querySelector('.ws-stitcher-footer button:nth-of-type(1)');
            const rightCopyBtn = rightPanel.querySelector('.ws-stitcher-footer button:nth-of-type(2)');

            leftMoveBtn.addEventListener('click', () => Actions.moveOrCopyStitcherEntries('left', 'right', false));
            leftCopyBtn.addEventListener('click', () => Actions.moveOrCopyStitcherEntries('left', 'right', true));
            rightMoveBtn.addEventListener('click', () => Actions.moveOrCopyStitcherEntries('right', 'left', false));
            rightCopyBtn.addEventListener('click', () => Actions.moveOrCopyStitcherEntries('right', 'left', true));
        }

        if (STATE.currentView === 'binding') {
            panel.querySelectorAll('.ws-book-list-item').forEach(item => {
                item.addEventListener('dblclick', () => {
                    const bookName = item.dataset.book;
                    Actions.switchView('editor');
                    setTimeout(() => Actions.openBook(bookName), 50);
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
    
    getEditorViewHtml() {
        const bookOptions = STATE.books.map(b => `<option value="${b}" ${STATE.currentBook === b ? 'selected' : ''}>${b}</option>`).join('');
        const snapshots = STATE.metadata[STATE.currentBook]?.snapshots || {};
        const snapshotOptions = Object.keys(snapshots).map(name => `<option value="${name}">${name}</option>`).join('');
        return `<div class="ws-view" id="ws-view-editor"><div class="ws-editor-toolbar"><select id="ws-book-selector" class="ws-select ws-book-selector"><option value="">选择世界书...</option>${bookOptions}</select><input type="search" id="ws-entry-search" class="ws-input ws-search-input" placeholder="搜索条目..."><div class="ws-selection-toolbar"><button id="ws-select-all" class="ws-button" title="全选"><i class="fa-solid fa-check-double"></i></button><button id="ws-select-invert" class="ws-button" title="反选"><i class="fa-solid fa-wand-magic"></i></button><button id="ws-select-none" class="ws-button" title="取消全选"><i class="fa-solid fa-xmark"></i></button></div><div class="ws-state-snapshot-controls"><select id="ws-snapshot-load" class="ws-select"><option value="">加载快照...</option>${snapshotOptions}</select><button id="ws-snapshot-save" class="ws-button" title="保存当前开关状态"><i class="fa-solid fa-save"></i></button><button id="ws-snapshot-delete" class="ws-button" title="删除选中快照"><i class="fa-solid fa-trash"></i></button></div></div><div class="ws-entry-list-container"><div id="ws-entry-list" class="ws-entry-list"></div></div></div>`;
    },

    getBindingViewHtml() {
        const bindings = API.getBindings();
        const globalEnabled = new Set(bindings.global);
        const createBookList = (books) => books.map(book => `<div class="ws-book-list-item" data-book="${book}" title="双击编辑">${book}</div>`).join('') || '<div class="ws-empty-list">无</div>';
        const globalBooks = STATE.books.filter(book => globalEnabled.has(book));
        return `<div class="ws-view" id="ws-view-binding"><style>.ws-binding-section{margin-bottom:25px;}.ws-book-list{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;}.ws-book-list-item{background:#fff;border:1px solid #e5e7eb;padding:8px 14px;border-radius:8px;cursor:pointer;transition:all .2s;user-select:none;}.ws-book-list-item:hover{border-color:#66ccff;color:#0ea5e9;transform:translateY(-2px);box-shadow:0 4px 8px rgba(0,0,0,.05);}.ws-empty-list{color:#9ca3af;font-style:italic;}.ws-hint{font-size:.85em;color:#9ca3af;text-align:center;margin-top:20px;}</style><div class="ws-binding-section"><h3>全局世界书 (仅显示已启用)</h3><div class="ws-book-list">${createBookList(globalBooks)}</div></div><div class="ws-binding-section"><h3>角色主要世界书</h3><div class="ws-book-list">${bindings.primary ? createBookList([bindings.primary]) : '<div class="ws-empty-list">无</div>'}</div></div><div class="ws-binding-section"><h3>角色附加世界书 (${bindings.extra.length})</h3><div class="ws-book-list">${createBookList(bindings.extra)}</div></div><p class="ws-hint">提示：双击任意世界书即可跳转至编辑界面。</p></div>`;
    },

    getStitcherViewHtml() {
        const bookOptions = STATE.books.map(b => `<option value="${b}">${b}</option>`).join('');
        const optionPlaceholder = '<option value="">选择世界书...</option>';
        const panelHtml = (side) => `<div class="ws-stitcher-panel" id="ws-stitcher-panel-${side}"><div class="ws-stitcher-header"><select id="ws-stitcher-${side}-book" class="ws-select">${optionPlaceholder}${bookOptions}</select></div><div class="ws-stitcher-toolbar"><input type="search" class="ws-input ws-stitcher-search" data-panel="${side}" placeholder="搜索..."><button class="ws-button ws-stitcher-select-all" data-panel="${side}">全选</button></div><div class="ws-stitcher-list"></div><div class="ws-stitcher-footer"><button class="ws-button">移动 &gt;</button><button class="ws-button primary">复制 &gt;&gt;</button></div></div>`;
        return `<div class="ws-view ws-stitcher-container" id="ws-view-stitcher">${panelHtml('left')}${panelHtml('right')}</div>`;
    },

    renderEditorView() {
        const listEl = document.getElementById('ws-entry-list');
        if (!listEl) return;
        listEl.innerHTML = STATE.entries.length > 0 ? '' : '<div class="ws-empty-list" style="text-align:center; padding: 40px;">这个世界书是空的。</div>';
        STATE.entries.forEach(entry => {
            const card = document.createElement('div');
            card.className = `ws-entry-card ${entry.disable ? 'disabled' : ''} ${STATE.selectedEntries.has(entry.uid) ? 'selected' : ''}`;
            card.dataset.uid = entry.uid;
            card.innerHTML = `<input type="checkbox" class="ws-entry-checkbox" ${STATE.selectedEntries.has(entry.uid) ? 'checked' : ''}><div class="ws-entry-content"><div class="ws-entry-header"><span class="ws-entry-comment">${entry.comment || '无标题'}</span></div><div class="ws-entry-details"><div class="ws-entry-detail-item ws-entry-enabled-toggle ${!entry.disable ? 'active' : ''}" title="启用/禁用"><i class="fa-solid fa-power-off"></i></div><div class="ws-entry-detail-item ws-entry-constant-toggle ${entry.constant ? 'active' : ''}" title="常驻/非常驻"><i class="fa-solid fa-star"></i></div><div class="ws-entry-detail-item"><span>深度 ${entry.depth ?? 4}</span></div><div class="ws-entry-detail-item"><span>顺序 ${entry.order ?? 0}</span></div></div></div>`;
            listEl.appendChild(card);
            card.querySelector('.ws-entry-checkbox').addEventListener('click', (e) => { e.stopPropagation(); Actions.toggleSelection(entry.uid); });
            card.addEventListener('dblclick', () => Actions.toggleSelection(entry.uid));
        });
        this.renderBatchActionBar();
    },

    renderStitcherPanel(side) {
        const panelState = STATE.stitcher[side];
        const panelEl = document.getElementById(`ws-stitcher-panel-${side}`);
        if (!panelEl) return;
        const listEl = panelEl.querySelector('.ws-stitcher-list');
        listEl.innerHTML = panelState.entries.length > 0 ? '' : '<div class="ws-empty-list" style="text-align:center; padding: 20px;">请选择世界书</div>';
        panelEl.querySelector('.ws-select').value = panelState.book || '';

        panelState.entries.forEach(entry => {
            const entryEl = document.createElement('div');
            entryEl.className = `ws-stitcher-entry ${panelState.selected.has(entry.uid) ? 'selected' : ''}`;
            entryEl.dataset.uid = entry.uid;
            entryEl.innerHTML = `<input type="checkbox" class="ws-entry-checkbox" ${panelState.selected.has(entry.uid) ? 'checked' : ''}><span class="ws-stitcher-entry-name">${entry.comment || '无标题'}</span>`;
            listEl.appendChild(entryEl);
            const checkbox = entryEl.querySelector('.ws-entry-checkbox');
            const toggle = () => {
                panelState.selected.has(entry.uid) ? panelState.selected.delete(entry.uid) : panelState.selected.add(entry.uid);
                entryEl.classList.toggle('selected');
                checkbox.checked = panelState.selected.has(entry.uid);
            };
            checkbox.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
            entryEl.addEventListener('click', toggle);
        });

        panelEl.querySelector('.ws-stitcher-select-all').onclick = () => {
            const allSelected = panelState.entries.length > 0 && panelState.entries.every(e => panelState.selected.has(e.uid));
            panelState.entries.forEach(e => allSelected ? panelState.selected.delete(e.uid) : panelState.selected.add(e.uid));
            this.renderStitcherPanel(side);
        };
    },

    renderBatchActionBar() {
        const bar = document.getElementById('ws-batch-action-bar');
        if (!bar) return;
        if (STATE.selectedEntries.size > 0) {
            bar.classList.add('visible');
            bar.innerHTML = `<span id="ws-batch-selection-count">已选择 ${STATE.selectedEntries.size} 项</span><div class="ws-batch-actions"><button class="ws-button" id="batch-enable">启用</button><button class="ws-button" id="batch-disable">禁用</button><button class="ws-button" id="batch-toggle-constant">切换常驻</button></div>`;
            document.getElementById('batch-enable').addEventListener('click', () => Actions.batchUpdate('disable', false));
            document.getElementById('batch-disable').addEventListener('click', () => Actions.batchUpdate('disable', true));
            document.getElementById('batch-toggle-constant').addEventListener('click', () => Actions.batchUpdate('constant', (currentValue) => !currentValue));
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


// --- 插件入口点 (已采用您提供的稳定版本逻辑) ---
jQuery(async () => {
    const injectButton = () => {
        if (document.getElementById(CONFIG.BTN_ID)) return;
        const container = document.querySelector('#options .options-content');

        if (container) {
            const buttonHtml = `
                <a id="${CONFIG.BTN_ID}" class="interactable" title="世界书增强套件" tabindex="0">
                    <i class="fa-lg fa-solid fa-book-atlas"></i>
                    <span>世界书套件</span>
                </a>
            `;
            $(container).append(buttonHtml);

            $(`#${CONFIG.BTN_ID}`).于('click'， (e) => {
                e.preventDefault();
                $('#options').hide();
                UI.open();
            });
            console.log("[Worldbook Suite] Button injected successfully.");
        } else {
            console.warn("[Worldbook Suite] Target container #options .options-content not found.");
        }
    };

    const performInit = async () => {
        try {
            await Actions.init();
        } catch (e) {
            console.error("[Worldbook Suite] Initialization failed:", e);
        }
    };

    injectButton();

    if (typeof world_names === 'undefined') {
        eventSource.于(event_types.APP_READY, performInit);
    } else {
        performInit();
    }
});
