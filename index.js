import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import { world_info, world_names, getNextLorebookUid } from '../../../world-info.js';
import { getCharaFilename } from '../../../utils.js';


// ===============================================================
//
//                      新功能集成 + 旧版逻辑修复
//
// ===============================================================


// --- 配置 ---
const CONFIG = {
    // 插件面板的主ID，用于CSS和JS选择
    ID: 'worldbook-suite-panel',
    // 注入到UI的按钮ID
    BTN_ID: 'worldbook-suite-button',
    // 存储元数据（如状态快照）的键
    SETTINGS_KEY: 'worldbook_suite_metadata',
    // 所有可用的视图/标签页
    TABS: ['editor', 'binding', 'stitcher'],
};

// --- 全局状态管理器 ---
const STATE = {
    isInitialized: false,
    currentView: 'editor',
    currentBook: null,
    books: [], // 所有世界书名称列表
    metadata: {}, // 存储快照等
    entries: [], // 当前打开的世界书的条目
    selectedEntries: new Set(), // 编辑器中选中的条目UID

    // 缝合器状态
    stitcher: {
        left: { book: null, entries: [], selected: new Set(), searchTerm: '' },
        right: { book: null, entries: [], selected: new Set(), searchTerm: '' },
    },
    saveDebouncer: null,
};


// --- API层 (与酒馆核心交互) ---
const API = {
    async loadAllBooks() {
        // 从核心变量获取，并排序
        return [...(world_names || [])].sort((a, b) => a.localeCompare(b));
    },
    async loadBookData(bookName) {
        if (!bookName) return [];
        try {
            const data = await getContext().loadWorldInfo(bookName);
            // 使用 structuredClone 进行深拷贝，防止污染缓存
            const entries = data.entries ? Object.values(structuredClone(data.entries)) : [];
            // 按 order 排序
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
            // 确保保存的是普通对象，而不是类的实例
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
        // 使用 saveSettingsDebounced 提高性能
        getContext().saveSettingsDebounced();
    },
    getBindings() {
        const context = getContext();
        const charId = context.characterId;
        const character = context.characters[charId];

        let primary = null, extra = [];
        if (character) {
            primary = character.data.extensions?.world;
            // 兼容旧版，手动从 world_info.charLore 查找
            const charFile = getCharaFilename(null, { manualAvatarKey: character.avatar });
            const loreEntry = world_info.charLore?.find(e => e.name === charFile);
            extra = loreEntry?.extraBooks || [];
        }

        return {
            primary,
            extra,
            // 全局启用的世界书列表
            global: world_info.globalSelect || [],
        };
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
            // 如果面板是打开的，就刷新数据并重绘
            if (document.getElementById(CONFIG.ID)) {
                this.reloadData().then(() => UI.render());
            }
        };
        // 监听这些事件以保持数据同步
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
        await this.saveCurrentBook(true); // 切换前强制保存
        STATE.currentBook = bookName;
        STATE.selectedEntries.clear(); // 清空选择
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
            // 延迟500毫秒保存，避免频繁写入
            STATE.saveDebouncer = setTimeout(doSave, 500);
        }
    },
    
    // --- 新功能：批量选择 ---
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
        // 这里简化为对当前所有条目操作，未来可优化为只对可见条目
        const allEntryIds = STATE.entries.map(e => e.uid);
        if (invert) {
            const newSelection = new Set();
            allEntryIds.forEach(uid => {
                if (!STATE.selectedEntries.has(uid)) {
                    newSelection.add(uid);
                }
            });
            STATE.selectedEntries = newSelection;
        } else {
            allEntryIds.forEach(uid => STATE.selectedEntries.add(uid));
        }
        UI.render(); // 完全重绘以更新所有复选框状态
    },

    clearSelection() {
        STATE.selectedEntries.clear();
        UI.render();
    },
    
    // --- 新功能：批量操作 ---
    batchUpdate(key, value) {
        let isToggle = (typeof value === 'function');
        STATE.selectedEntries.forEach(uid => {
            const entry = STATE.entries.find(e => e.uid === uid);
            if (entry) {
                entry[key] = isToggle ? value(entry[key]) : value;
            }
        });
        this.saveCurrentBook(true); // 立即保存
        this.clearSelection(); // 操作后清空选择
    },
    
    // --- 新功能：状态快照 ---
    async saveSnapshot() {
        const name = prompt("请输入快照名称:", `配置 ${new Date().toLocaleTimeString()}`);
        if (!name || !STATE.currentBook) return;

        // 只保存已启用条目的UID
        const enabledUids = STATE.entries.filter(e => !e.disable).map(e => e.uid);
        
        const bookMeta = STATE.metadata[STATE.currentBook] || {};
        bookMeta.snapshots = bookMeta.snapshots || {};
        bookMeta.snapshots[name] = enabledUids;
        
        STATE.metadata[STATE.currentBook] = bookMeta;
        await API.saveMetadata(STATE.metadata);
        toastr.success(`快照 "${name}" 已保存!`);
        UI.render(); // 重绘以更新下拉列表
    },

    loadSnapshot(snapshotName) {
        if (!snapshotName || !STATE.currentBook) return;
        
        const bookMeta = STATE.metadata[STATE.currentBook];
        const snapshotUids = bookMeta?.snapshots?.[snapshotName];
        if (!snapshotUids) {
            toastr.error("找不到该快照。");
            return;
        }
        
        const enabledUids = new Set(snapshotUids);
        STATE.entries.forEach(entry => {
            entry.disable = !enabledUids.has(entry.uid);
        });

        this.saveCurrentBook(true); // 立即保存更改
        toastr.success(`已加载快照 "${snapshotName}"。`);
        UI.render(); // 重绘界面以反映状态
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
    
    // --- 新功能：世界书缝合 ---
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
        
        if (!source.book || !target.book) {
            toastr.warning("请先在左右两边都选择一个世界书。");
            return;
        }
        if (source.selected.size === 0) {
            toastr.info("请在源面板中选择至少一个条目。");
            return;
        }

        const entriesToTransfer = [];
        source.entries.forEach(entry => {
            if (source.selected.has(entry.uid)) {
                entriesToTransfer.push(structuredClone(entry));
            }
        });

        // 如果是复制，为每个条目生成新的唯一UID
        if (copy) {
            entriesToTransfer.forEach(entry => {
                const existingUids = target.entries.map(e => e.uid);
                let newUid = Math.max(-1, ...existingUids) + 1;
                while (existingUids.includes(newUid)) {
                    newUid++;
                }
                entry.uid = newUid;
            });
        } else {
             // 如果是移动，从源数据中过滤掉
            source.entries = source.entries.filter(entry => !source.selected.has(entry.uid));
            source.selected.clear();
        }

        // 添加到目标
        target.entries.push(...entriesToTransfer);
        
        // 异步保存两个世界书，然后刷新UI
        Promise.all([
            API.saveBookData(target.book, target.entries),
            copy ? Promise.resolve() : API.saveBookData(source.book, source.entries)
        ]).then(() => {
            toastr.success(`条目已成功${copy ? '复制' : '移动'}!`);
            // 重新加载两个面板的数据以确保同步
            this.loadBookForStitcher(sourcePanel, source.book);
            this.loadBookForStitcher(targetPanel, target.book);
        });
    }
};


// --- UI渲染层 ---
const UI = {
    open() {
        const existingPanel = document.getElementById(CONFIG.ID);
        if (existingPanel) {
            existingPanel.remove();
            return;
        }
        
        // 初始化数据，然后渲染
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

        // 根据当前视图渲染动态内容
        if (STATE.currentView === 'editor') this.renderEditorView();
        if (STATE.currentView === 'stitcher') this.renderStitcherView();
        if (STATE.currentView === 'binding') this.renderBindingView();
    },

    bindEvents() {
        const panel = document.getElementById(CONFIG.ID);
        panel.querySelector('.ws-close-button').addEventListener('click', () => panel.remove());
        
        panel.querySelectorAll('.ws-tab').forEach(tab => {
            tab.addEventListener('click', () => Actions.switchView(tab.dataset.view));
        });

        // 编辑器视图的事件绑定
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
        
        // 缝合器视图的事件绑定
        if (STATE.currentView === 'stitcher') {
            panel.querySelector('#ws-stitcher-left-book').addEventListener('change', (e) => Actions.loadBookForStitcher('left', e.target.value));
            panel.querySelector('#ws-stitcher-right-book').addEventListener('change', (e) => Actions.loadBookForStitcher('right', e.target.value));
            // 绑定底部按钮
            const leftPanel = panel.querySelector('#ws-stitcher-panel-left');
            const rightPanel = panel.querySelector('#ws-stitcher-panel-right');
            leftPanel.querySelector('.ws-stitcher-footer #ws-move-to-right').addEventListener('click', () => Actions.moveOrCopyStitcherEntries('left', 'right', false));
            leftPanel.querySelector('.ws-stitcher-footer #ws-copy-to-right').addEventListener('click', () => Actions.moveOrCopyStitcherEntries('left', 'right', true));
            rightPanel.querySelector('.ws-stitcher-footer #ws-move-to-left').addEventListener('click', () => Actions.moveOrCopyStitcherEntries('right', 'left', false));
            rightPanel.querySelector('.ws-stitcher-footer #ws-copy-to-left').addEventListener('click', () => Actions.moveOrCopyStitcherEntries('right', 'left', true));
        }

        // 绑定视图的双击事件
        if (STATE.currentView === 'binding') {
            panel.querySelectorAll('.ws-book-list-item').forEach(item => {
                item.addEventListener('dblclick', () => {
                    const bookName = item.dataset.book;
                    Actions.switchView('editor');
                    // 延迟一点打开书，确保视图已切换
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
    
    // --- HTML模板 ---
    getEditorViewHtml() {
        const bookOptions = STATE.books.map(b => `<option value="${b}" ${STATE.currentBook === b ? 'selected' : ''}>${b}</option>`).join('');
        const snapshots = STATE.metadata[STATE.currentBook]?.snapshots || {};
        const snapshotOptions = Object.keys(snapshots).map(name => `<option value="${name}">${name}</option>`).join('');

        return `
            <div class="ws-view" id="ws-view-editor">
                <div class="ws-editor-toolbar">
                    <select id="ws-book-selector" class="ws-select ws-book-selector"><option value="">选择世界书...</option>${bookOptions}</select>
                    <input type="search" id="ws-entry-search" class="ws-input ws-search-input" placeholder="搜索条目...">
                    <div class="ws-selection-toolbar">
                        <button id="ws-select-all" class="ws-button"><i class="fa-solid fa-check-double"></i></button>
                        <button id="ws-select-invert" class="ws-button"><i class="fa-solid fa-wand-magic"></i></button>
                        <button id="ws-select-none" class="ws-button"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="ws-state-snapshot-controls">
                        <select id="ws-snapshot-load" class="ws-select"><option value="">加载快照...</option>${snapshotOptions}</select>
                        <button id="ws-snapshot-save" class="ws-button" title="保存当前开关状态"><i class="fa-solid fa-save"></i></button>
                        <button id="ws-snapshot-delete" class="ws-button" title="删除选中快照"><i class="fa-solid fa-trash"></i></button>
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

        const createBookList = (books) => books.map(book => `<div class="ws-book-list-item" data-book="${book}" title="双击编辑">${book}</div>`).join('') || '<div class="ws-empty-list">无</div>';

        const globalBooks = STATE.books.filter(book => globalEnabled.has(book));

        return `
            <div class="ws-view" id="ws-view-binding">
                <div class="ws-binding-section">
                    <h3>全局世界书 (仅显示已启用)</h3>
                    <div class="ws-book-list">${createBookList(globalBooks)}</div>
                </div>
                <div class="ws-binding-section">
                    <h3>角色主要世界书</h3>
                    <div class="ws-book-list">${bindings.primary ? createBookList([bindings.primary]) : '<div class="ws-empty-list">无</div>'}</div>
                </div>
                <div class="ws-binding-section">
                    <h3>角色附加世界书 (${bindings.extra.length})</h3>
                    <div class="ws-book-list">${createBookList(bindings.extra)}</div>
                </div>
                <p class="ws-hint">提示：双击任意世界书即可跳转至编辑界面。</p>
            </div>
            <style>
                .ws-binding-section { margin-bottom: 25px; }
                .ws-book-list { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
                .ws-book-list-item { background: #fff; border: 1px solid #e5e7eb; padding: 8px 14px; border-radius: 8px; cursor: pointer; transition: all .2s; user-select: none; }
                .ws-book-list-item:hover { border-color: #66ccff; color: #0ea5e9; transform: translateY(-2px); box-shadow: 0 4px 8px rgba(0,0,0,0.05); }
                .ws-empty-list { color: #9ca3af; font-style: italic; }
                .ws-hint { font-size: .85em; color: #9ca3af; text-align: center; margin-top: 20px; }
            </style>
        `;
    },

    getStitcherViewHtml() {
        const bookOptions = STATE.books.map(b => `<option value="${b}">${b}</option>`).join('');
        const optionPlaceholder = '<option value="">选择世界书...</option>';

        // Helper to generate a panel's HTML
        const panelHtml = (side) => `
            <div class="ws-stitcher-panel" id="ws-stitcher-panel-${side}">
                <div class="ws-stitcher-header">
                    <select id="ws-stitcher-${side}-book" class="ws-select">${optionPlaceholder}${bookOptions}</select>
                </div>
                <div class="ws-stitcher-toolbar">
                    <input type="search" class="ws-input ws-stitcher-search" data-panel="${side}" placeholder="搜索...">
                    <button class="ws-button ws-stitcher-select-all" data-panel="${side}">全选</button>
                </div>
                <div class="ws-stitcher-list"></div>
                <div class="ws-stitcher-footer">
                    <button id="ws-move-to-${side === 'left' ? 'right' : 'left'}" class="ws-button">移动 &gt;</button>
                    <button id="ws-copy-to-${side === 'left' ? 'right' : 'left'}" class="ws-button primary">复制 &gt;&gt;</button>
                </div>
            </div>`;
        
        return `<div class="ws-view ws-stitcher-container" id="ws-view-stitcher">${panelHtml('left')}${panelHtml('right')}</div>`;
    },

    // --- 动态渲染 ---
    renderEditorView() {
        const listEl = document.getElementById('ws-entry-list');
        if (!listEl) return;
        listEl.innerHTML = STATE.entries.length > 0 ? '' : '<div class="ws-empty-list" style="text-align:center; padding: 40px;">这个世界书是空的。</div>';
        
        STATE.entries.forEach(entry => {
            const card = document.createElement('div');
            card.className = `ws-entry-card ${entry.disable ? 'disabled' : ''} ${STATE.selectedEntries.has(entry.uid) ? 'selected' : ''}`;
            card.dataset.uid = entry.uid;
            
            card.innerHTML = `
                <input type="checkbox" class="ws-entry-checkbox" ${STATE.selectedEntries.has(entry.uid) ? 'checked' : ''}>
                <div class="ws-entry-content">
                    <div class="ws-entry-header"><span class="ws-entry-comment">${entry.comment || '无标题'}</span></div>
                    <div class="ws-entry-details">
                        <div class="ws-entry-detail-item ws-entry-enabled-toggle ${!entry.disable ? 'active' : ''}" title="启用/禁用"><i class="fa-solid fa-power-off"></i></div>
                        <div class="ws-entry-detail-item ws-entry-constant-toggle ${entry.constant ? 'active' : ''}" title="常驻/非常驻"><i class="fa-solid fa-star"></i></div>
                        <div class="ws-entry-detail-item"><span>深度 ${entry.depth ?? 4}</span></div>
                        <div class="ws-entry-detail-item"><span>顺序 ${entry.order ?? 0}</span></div>
                    </div>
                </div>
            `;
            listEl.appendChild(card);
            
            card.querySelector('.ws-entry-checkbox').addEventListener('click', (e) => {
                e.stopPropagation();
                Actions.toggleSelection(entry.uid);
            });
            // 双击卡片本身也可以切换选择
            card.addEventListener('dblclick', () => Actions.toggleSelection(entry.uid));
        });
        this.renderBatchActionBar();
    },
    
    renderBindingView() { /* 静态内容，无需额外渲染 */ },
    
    renderStitcherView() {
        this.renderStitcherPanel('left');
        this.renderStitcherPanel('right');
    },

    renderStitcherPanel(side) {
        const panelState = STATE.stitcher[side];
        const panelEl = document.getElementById(`ws-stitcher-panel-${side}`);
        if (!panelEl) return;
        
        const listEl = panelEl.querySelector('.ws-stitcher-list');
        listEl.innerHTML = '';
        panelEl.querySelector('.ws-select').value = panelState.book || '';

        panelState.entries.forEach(entry => {
            const entryEl = document.createElement('div');
            entryEl.className = `ws-stitcher-entry ${panelState.selected.has(entry.uid) ? 'selected' : ''}`;
            entryEl.dataset.uid = entry.uid;
            
            entryEl.innerHTML = `
                <input type="checkbox" class="ws-entry-checkbox" ${panelState.selected.has(entry.uid) ? 'checked' : ''}>
                <span class="ws-stitcher-entry-name">${entry.comment || '无标题'}</span>
            `;
            listEl.appendChild(entryEl);

            const checkbox = entryEl.querySelector('.ws-entry-checkbox');
            const toggle = () => {
                 if (panelState.selected.has(entry.uid)) {
                    panelState.selected.delete(entry.uid);
                } else {
                    panelState.selected.add(entry.uid);
                }
                entryEl.classList.toggle('selected');
                checkbox.checked = panelState.selected.has(entry.uid);
            };

            checkbox.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
            entryEl.addEventListener('click', toggle);
        });

        // 全选按钮
        panelEl.querySelector('.ws-stitcher-select-all').onclick = () => {
            const allSelected = panelState.entries.every(e => panelState.selected.has(e.uid));
            panelState.entries.forEach(e => {
                if (allSelected) panelState.selected.delete(e.uid);
                else panelState.selected.add(e.uid);
            });
            this.renderStitcherPanel(side);
        };
    },

    // --- 组件渲染 ---
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


// --- 插件入口点 (已修复) ---
jQuery(async () => {
    // 注入按钮的函数，使用您提供的稳定版本逻辑
    const injectButton = () => {
        // 防止重复添加
        if (document.getElementById(CONFIG.BTN_ID)) return;

        // 目标容器
        const container = document.querySelector('#options .options-content');

        if (container) {
            const buttonHtml = `
                <a id="${CONFIG.BTN_ID}" class="interactable" title="世界书增强套件" tabindex="0">
                    <i class="fa-lg fa-solid fa-book-atlas"></i>
                    <span>世界书套件</span>
                </a>
            `;
            $(container).append(buttonHtml);

            // 绑定点击事件
            $(`#${CONFIG.BTN_ID}`).于('click'， (e) => {
                e.preventDefault();
                $('#options').hide(); // 隐藏主菜单
                UI.open(); // 打开我们的插件面板
            });

            console.log("[Worldbook Suite] Button injected successfully.");
        } else {
            console.warn("[Worldbook Suite] Target container #options .options-content not found.");
        }
    };

    // 安全初始化插件的函数
    const performInit = async () => {
        try {
            await Actions.init();
            console.log("[Worldbook Suite] Pre-loading complete.");
        } catch (e) {
            console.error("[Worldbook Suite] Pre-loading failed:", e);
        }
    };

    // 立即执行按钮注入
    injectButton();

    // 检查酒馆核心是否就绪，然后执行初始化
    if (typeof world_names === 'undefined') {
        // 如果核心变量还不存在，就等待 APP_READY 事件
        console.log("[Worldbook Suite] Waiting for SillyTavern's APP_READY event...");
        eventSource.于(event_types.APP_READY, performInit);
    } else {
        // 如果已存在，直接初始化
        performInit();
    }
});
