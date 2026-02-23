import { getContext } from '../../../extensions.js';
import { event_types, eventSource } from '../../../../script.js';
import { getCharaFilename } from '../../../utils.js';
import {
    world_info,
    world_names,
    selected_world_info
} from '../../../world-info.js';

const CONFIG = {
    id: 'enhanced-wb-panel-v6',
    btnId: 'wb-menu-btn-v6',
    settingsKey: 'WorldbookEditor_Metadata', // extension_settings
    colors: {
        accent: '#3b82f6', // A modern blue
    }
};

const STATE = {
    currentView: 'editor', // 'editor' | 'binding' | 'manage' | 'stitcher'
    currentBookName: null,
    isInitialized: false,
    isManageDirty: true,

    // Data cache
    entries: [],
    allBookNames: [],
    metadata: {},

    // Batch selection
    selectedEntries: new Set(),

    // Stitcher view state
    stitcher: {
        left: { name: null, entries: [] },
        right: { name: null, entries: [] },
    },

    boundBooksSet: {},
    bindings: {
        char: { primary: null, additional: [] },
        global: [],
        chat: null
    },
    debouncer: null
};

// ST native position enum for UI conversion
const WI_POSITION_MAP = {
    0: 'before_character_definition',
    1: 'after_character_definition',
    2: 'before_author_note',
    3: 'after_author_note',
    4: 'at_depth',
    5: 'before_example_messages',
    6: 'after_example_messages'
};
const WI_POSITION_MAP_REV = Object.fromEntries(Object.entries(WI_POSITION_MAP).map(([k, v]) => [v, parseInt(k)]));

/**
 * [Compatibility Polyfill] Update character's primary worldbook
 */
async function charUpdatePrimaryWorld(name) {
    const context = getContext();
    const charId = context.characterId;
    if (charId === undefined || charId === null) return;
    const character = context.characters[charId];
    if (!character) return;
    if (!character.data.extensions) character.data.extensions = {};
    character.data.extensions.world = name;
    if (context.saveCharacterDebounced) {
        context.saveCharacterDebounced();
    }
}

/**
 * [Compatibility Polyfill] Set character's auxiliary worldbooks
 */
function charSetAuxWorlds(fileName, books) {
    const context = getContext();
    if (!world_info.charLore) world_info.charLore = [];
    const idx = world_info.charLore.findIndex(e => e.name === fileName);
    if (books.length === 0) {
        if (idx !== -1) world_info.charLore.splice(idx, 1);
    } else if (idx === -1) {
        world_info.charLore.push({ name: fileName, extraBooks: books });
    } else {
        world_info.charLore[idx].extraBooks = books;
    }
    if (context.saveSettingsDebounced) {
        context.saveSettingsDebounced();
    }
}

// --- Binding handlers ---
async function setCharBindings(type, worldName, isEnabled) {
    const context = getContext();
    if (type === 'primary') {
        await charUpdatePrimaryWorld(isEnabled ? worldName : '');
    } else if (type === 'auxiliary') {
        const charId = context.characterId;
        if (charId === undefined) return;
        const charAvatar = context.characters[charId].avatar;
        const charFileName = getCharaFilename(null, { manualAvatarKey: charAvatar });
        const charLoreEntry = world_info.charLore?.find(e => e.name === charFileName);
        let currentBooks = charLoreEntry ? [...charLoreEntry.extraBooks] : [];
        if (isEnabled) {
            if (!currentBooks.includes(worldName)) currentBooks.push(worldName);
        } else {
            currentBooks = currentBooks.filter(name => name !== worldName);
        }
        charSetAuxWorlds(charFileName, currentBooks);
    } else if (type === 'chat') {
        if (isEnabled) {
            context.chatMetadata['world_info'] = worldName;
        } else if (context.chatMetadata['world_info'] === worldName) {
            delete context.chatMetadata['world_info'];
        }
        context.saveMetadataDebounced();
    } else if (type === 'global') {
        const command = isEnabled ? `/world silent=true "${worldName}"` : `/world state=off silent=true "${worldName}"`;
        await context.executeSlashCommands(command);
    }
}

const API = {
    // --- Read ---
    async getAllBookNames() {
        return [...(world_names || [])].sort((a, b) => a.localeCompare(b));
    },
    async getCharBindings() {
        const context = getContext();
        const charId = context.characterId;
        if (charId === undefined) return { primary: null, additional: [] };
        const character = context.characters[charId];
        if (!character) return { primary: null, additional: [] };
        const primary = character.data?.extensions?.world || null;
        let additional = [];
        const fileName = character.avatar.replace(/\.[^/.]+$/, "");
        const charLore = world_info.charLore || [];
        const entry = charLore.find(e => e.name === fileName);
        if (entry && Array.isArray(entry.extraBooks)) {
            additional = [...entry.extraBooks];
        }
        return { primary, additional };
    },
    async getGlobalBindings() {
        return [...(selected_world_info || [])];
    },
    async getChatBinding() {
        return getContext().chatMetadata?.world_info || null;
    },
    async loadBook(name) {
        const data = await getContext().loadWorldInfo(name);
        if (!data) throw new Error(`Worldbook ${name} not found`);
        const safeEntries = data.entries ? structuredClone(data.entries) : {};
        const entries = Object.values(safeEntries);
        return entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    // --- Write ---
    async saveBookEntries(name, entriesArray) {
        if (!name || !Array.isArray(entriesArray)) return;
        const oldData = await getContext().loadWorldInfo(name) || { entries: {} };
        const newEntriesObj = {};
        entriesArray.forEach(entry => {
            const oldEntry = (oldData.entries && oldData.entries[entry.uid]) ? oldData.entries[entry.uid] : {};
            newEntriesObj[entry.uid] = { ...oldEntry, ...structuredClone(entry) };
        });
        const newData = { ...oldData, entries: newEntriesObj };
        await getContext().saveWorldInfo(name, newData, false);
    },
    async createEntry(name, newEntriesArray) {
        const currentEntries = await this.loadBook(name);
        const combined = [...newEntriesArray, ...currentEntries];
        await this.saveBookEntries(name, combined);
    },
    async deleteEntries(name, uidsToDelete) {
        let currentEntries = await this.loadBook(name);
        currentEntries = currentEntries.filter(e => !uidsToDelete.includes(e.uid));
        await this.saveBookEntries(name, currentEntries);
    },
    // --- Meta ---
    getMetadata() { return getContext().extensionSettings[CONFIG.settingsKey] || {}; },
    async saveMetadata(data) {
        const context = getContext();
        context.extensionSettings[CONFIG.settingsKey] = data;
        context.saveSettingsDebounced();
    },
    // --- WB Management ---
    async createWorldbook(name) {
        await getContext().saveWorldInfo(name, { entries: {} }, true);
        await getContext().updateWorldInfoList();
    },
    async deleteWorldbook(name) {
        await fetch('/api/worldinfo/delete', { method: 'POST', headers: getContext().getRequestHeaders(), body: JSON.stringify({ name }), });
        await getContext().updateWorldInfoList();
    },
    async renameWorldbook(oldName, newName) {
        const data = await getContext().loadWorldInfo(oldName);
        if (data) {
            await getContext().saveWorldInfo(newName, data, true);
            const { primary, additional } = await this.getCharBindings();
            if (primary === oldName) await setCharBindings('primary', newName, true);
            if (additional.includes(oldName)) {
                await setCharBindings('auxiliary', oldName, false);
                await setCharBindings('auxiliary', newName, true);
            }
            const global = await this.getGlobalBindings();
            if (global.includes(oldName)) {
                await setCharBindings('global', oldName, false);
                await setCharBindings('global', newName, true);
            }
            const chat = await this.getChatBinding();
            if (chat === oldName) await setCharBindings('chat', newName, true);
            await this.deleteWorldbook(oldName);
        }
    }
};

const Actions = {
    async flushPendingSave() {
        if (STATE.debouncer) {
            clearTimeout(STATE.debouncer);
            STATE.debouncer = null;
            if (STATE.currentBookName && Array.isArray(STATE.entries)) {
                await API.saveBookEntries(STATE.currentBookName, STATE.entries);
            }
        }
    },

    async init() {
        if (STATE.isInitialized) return;
        const es = eventSource, et = event_types;
        es.on(et.SETTINGS_UPDATED, () => { if (document.getElementById(CONFIG.id)) this.refreshAllContext(); });
        es.on(et.WORLDINFO_UPDATED, (name, data) => { if (STATE.currentBookName === name) this.loadBook(name); });
        es.on(et.CHAT_CHANGED, () => { if (document.getElementById(CONFIG.id)) this.refreshAllContext(); });
        es.on(et.CHARACTER_SELECTED, () => setTimeout(() => { if (document.getElementById(CONFIG.id)) this.refreshAllContext(); }, 100));
        es.on(et.CHARACTER_EDITED, () => { if (document.getElementById(CONFIG.id)) this.refreshAllContext(); });
        STATE.isInitialized = true;
        await this.refreshAllContext();
    },

    async refreshAllContext() {
        const [all, char, glob, chat] = await Promise.all([
            API.getAllBookNames(),
            API.getCharBindings(),
            API.getGlobalBindings(),
            API.getChatBinding(),
        ]);
        STATE.allBookNames = all.sort((a, b) => a.localeCompare(b));
        STATE.bindings.char = char;
        STATE.bindings.global = glob;
        STATE.bindings.chat = chat;
        STATE.metadata = API.getMetadata();
        UI.renderBookSelector();
        UI.updateHeaderInfo();
    },

    async switchView(viewName) {
        await this.flushPendingSave();
        Actions.clearSelection();

        UI.updateGlider(viewName);
        document.querySelectorAll('.wb-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === viewName));

        setTimeout(() => {
            STATE.currentView = viewName;
            document.querySelectorAll('.wb-view-section').forEach(el => el.classList.add('wb-hidden'));
            const targetView = document.getElementById(`wb-view-${viewName}`);
            if (targetView) targetView.classList.remove('wb-hidden');

            if (viewName === 'binding') UI.renderBindingView();
            else if (viewName === 'manage') UI.renderManageView();
            else if (viewName === 'stitcher') UI.renderStitcherView();
            else if (viewName === 'editor') {
                UI.renderBookSelector();
                UI.updateHeaderInfo();
                UI.renderSnapshotMenu();
            }
        }, 10);
    },

    async loadBook(name) {
        if (!name) return;
        await this.flushPendingSave();
        STATE.currentBookName = name;
        Actions.clearSelection();

        try {
            const loadedEntries = await API.loadBook(name);
            if (STATE.currentBookName !== name) return;
            STATE.entries = loadedEntries;
            UI.updateHeaderInfo();
            UI.renderList();
            UI.renderSnapshotMenu();
            const selector = document.getElementById('wb-book-selector');
            if (selector) selector.value = name;
        } catch (e) {
            if (STATE.currentBookName === name) toastr.error(`无法加载世界书 "${name}"`);
        }
    },

    updateEntry(uid, updater) {
        const entry = STATE.entries.find(e => e.uid === uid);
        if (!entry) return;
        updater(entry);
        UI.updateCardStatus(uid);
        if (STATE.debouncer) clearTimeout(STATE.debouncer);
        const targetBookName = STATE.currentBookName;
        const targetEntries = STATE.entries;
        STATE.debouncer = setTimeout(() => {
            if (targetBookName && targetEntries) {
                API.saveBookEntries(targetBookName, targetEntries);
            }
        }, 300);
    },

    async addNewEntry() {
        if (!STATE.currentBookName) return toastr.warning("请先选择一本世界书");
        const maxUid = STATE.entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1);
        const newEntry = { uid: maxUid + 1, comment: '新建条目', disable: false, content: '', constant: false, key: [], order: 0, position: 1, depth: 4, probability: 100, selective: true };
        await API.createEntry(STATE.currentBookName, [newEntry]);
        await this.loadBook(STATE.currentBookName);
    },

    async deleteEntries(uids) {
        if (!confirm(`确定要删除选中的 ${uids.length} 个条目吗？`)) return;
        await API.deleteEntries(STATE.currentBookName, uids);
        Actions.clearSelection();
        await this.loadBook(STATE.currentBookName);
    },

    // --- BATCH OPERATIONS ---
    toggleEntrySelection(uid, isSelected) {
        if (isSelected) {
            STATE.selectedEntries.add(uid);
        } else {
            STATE.selectedEntries.delete(uid);
        }
        UI.renderBatchToolbar();
        const card = document.querySelector(`.wb-card[data-uid="${uid}"]`);
        if (card) card.classList.toggle('selected-for-batch', isSelected);
    },
    selectAllEntries() {
        const allVisibleUIDs = Array.from(document.querySelectorAll('#wb-entry-list .wb-card')).map(card => Number(card.dataset.uid));
        allVisibleUIDs.forEach(uid => STATE.selectedEntries.add(uid));
        UI.renderList(document.getElementById('wb-search-entry').value);
        UI.renderBatchToolbar();
    },
    invertSelection() {
        const allVisibleUIDs = Array.from(document.querySelectorAll('#wb-entry-list .wb-card')).map(card => Number(card.dataset.uid));
        allVisibleUIDs.forEach(uid => {
            if (STATE.selectedEntries.has(uid)) {
                STATE.selectedEntries.delete(uid);
            } else {
                STATE.selectedEntries.add(uid);
            }
        });
        UI.renderList(document.getElementById('wb-search-entry').value);
        UI.renderBatchToolbar();
    },
    clearSelection() {
        STATE.selectedEntries.clear();
        UI.renderList(document.getElementById('wb-search-entry').value);
        UI.renderBatchToolbar();
    },
    async batchUpdate(updater) {
        if (STATE.selectedEntries.size === 0) return toastr.warning("没有选中的条目");
        STATE.selectedEntries.forEach(uid => {
            const entry = STATE.entries.find(e => e.uid === uid);
            if (entry) updater(entry);
        });
        await this.flushPendingSave();
        UI.renderList();
        toastr.success(`${STATE.selectedEntries.size} 个条目已更新`);
    },
    async batchDelete() {
        if (STATE.selectedEntries.size === 0) return;
        await this.deleteEntries(Array.from(STATE.selectedEntries));
    },

    // --- SNAPSHOTS ---
    getSnapshots() {
        const bookMeta = STATE.metadata[STATE.currentBookName] || {};
        return bookMeta.snapshots || [];
    },
    async saveSnapshot() {
        if (!STATE.currentBookName) return;
        const name = prompt("请输入快照名称:", `配置 ${new Date().toLocaleString()}`);
        if (!name) return;
        const stateMap = {};
        STATE.entries.forEach(entry => { stateMap[entry.uid] = entry.disable; });
        
        const bookMeta = STATE.metadata[STATE.currentBookName] || {};
        if (!bookMeta.snapshots) bookMeta.snapshots = [];
        bookMeta.snapshots.push({ name, states: stateMap });
        
        if (!STATE.metadata[STATE.currentBookName]) STATE.metadata[STATE.currentBookName] = bookMeta;
        await API.saveMetadata(STATE.metadata);
        UI.renderSnapshotMenu();
        toastr.success("快照已保存");
    },
    async loadSnapshot(snapshotName) {
        const snapshot = this.getSnapshots().find(s => s.name === snapshotName);
        if (!snapshot) return;
        STATE.entries.forEach(entry => {
            if (snapshot.states.hasOwnProperty(entry.uid)) {
                entry.disable = snapshot.states[entry.uid];
            }
        });
        await this.flushPendingSave();
        UI.renderList();
        toastr.success(`已加载快照: ${snapshotName}`);
    },
    async deleteSnapshot(snapshotName) {
        if (!confirm(`确定要删除快照 "${snapshotName}" 吗?`)) return;
        const bookMeta = STATE.metadata[STATE.currentBookName];
        if (bookMeta && bookMeta.snapshots) {
            bookMeta.snapshots = bookMeta.snapshots.filter(s => s.name !== snapshotName);
            await API.saveMetadata(STATE.metadata);
            UI.renderSnapshotMenu();
        }
    },

    // --- STITCHER ---
    async loadStitcherBook(panel, bookName) {
        await this.flushPendingSave(); // Save any pending changes from editor view
        if (!bookName) {
            STATE.stitcher[panel] = { name: null, entries: [] };
        } else {
            try {
                const entries = await API.loadBook(bookName);
                STATE.stitcher[panel] = { name: bookName, entries };
            } catch (e) {
                toastr.error(`加载 ${bookName} 失败`);
                STATE.stitcher[panel] = { name: null, entries: [] };
            }
        }
        UI.renderStitcherPanel(panel);
    },
    handleStitcherDrop(sourcePanel, targetPanel, uid, isCopy) {
        const sourceList = STATE.stitcher[sourcePanel].entries;
        const targetList = STATE.stitcher[targetPanel].entries;
        const entryIndex = sourceList.findIndex(e => e.uid === uid);
        if (entryIndex === -1) return;
        
        let [movedEntry] = isCopy ? [structuredClone(sourceList[entryIndex])] : sourceList.splice(entryIndex, 1);
        
        if (isCopy) {
            const maxUid = targetList.reduce((max, e) => Math.max(max, Number(e.uid) || 0), 0);
            movedEntry.uid = maxUid + 1;
        }

        targetList.unshift(movedEntry);

        UI.renderStitcherPanel(sourcePanel);
        UI.renderStitcherPanel(targetPanel);
    },
    async saveStitcherPanel(panel) {
        const { name, entries } = STATE.stitcher[panel];
        if (!name) return;
        if (!confirm(`确定要将当前列表覆盖到世界书 "${name}" 吗?`)) return;
        try {
            await API.saveBookEntries(name, entries);
            toastr.success(`"${name}" 已保存`);
        } catch (e) {
            toastr.error(`保存 "${name}" 失败: ${e.message}`);
        }
    },

    // Other actions...
    async saveBindings() {
        const view = document.getElementById('wb-view-binding');
        // This is a simplified version, as your original was complex and might need full re-integration based on new UI
        const primary = view.querySelector('#wb-bind-char-primary').value;
        await setCharBindings('primary', primary, !!primary);
        // ... handle aux, global, chat
        toastr.success("绑定已保存");
        await this.refreshAllContext();
    },
    getTokenCount(text) {
        try { return getContext().getTokenCount(text || ''); }
        catch (e) { return Math.ceil((text || '').length / 3); }
    },
    async jumpToEditor(bookName) {
        await this.loadBook(bookName);
        this.switchView('editor');
    },
};

const UI = {
    updateGlider(tabName) {
        const glider = document.querySelector('.wb-tab-glider');
        const targetTab = document.querySelector(`.wb-tab[data-tab="${tabName}"]`);
        if (glider && targetTab) {
            glider.style.width = `${targetTab.offsetWidth}px`;
            glider.style.transform = `translateX(${targetTab.offsetLeft}px)`;
        }
    },

    async open() {
        if (document.getElementById(CONFIG.id)) return;
        const panel = document.createElement('div');
        panel.id = CONFIG.id;
        panel.innerHTML = `
            <div class="wb-header-bar">
                <div class="wb-tabs">
                    <div class="wb-tab-glider"></div>
                    <div class="wb-tab active" data-tab="editor"><i class="fa-solid fa-pen-to-square"></i> 编辑</div>
                    <div class="wb-tab" data-tab="binding"><i class="fa-solid fa-link"></i> 绑定</div>
                    <div class="wb-tab" data-tab="manage"><i class="fa-solid fa-list-check"></i> 管理</div>
                    <div class="wb-tab" data-tab="stitcher"><i class="fa-solid fa-wand-magic-sparkles"></i> 缝合</div>
                </div>
                <div id="wb-close" class="wb-header-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="wb-content">
                <div id="wb-loading-layer" style="position:absolute;inset:0;background:rgba(255,255,255,0.8);z-index:100;display:flex;align-items:center;justify-content:center;"><i class="fa-solid fa-circle-notch fa-spin" style="font-size:2em;color:#3b82f6;"></i></div>
                
                <!-- Editor View -->
                <div id="wb-view-editor" class="wb-view-section">
                    <div class="wb-book-bar">
                        <select id="wb-book-selector" style="flex:1;"></select>
                        <div class="wb-menu-wrapper" id="wb-snapshot-menu-container"></div>
                        <div class="wb-menu-wrapper" id="wb-main-menu-container"></div>
                    </div>
                    <div class="wb-tool-bar">
                        <input class="wb-input-dark" id="wb-search-entry" style="flex:1;" placeholder="搜索条目...">
                        <button class="wb-btn-circle" id="btn-select-all" title="全选/取消全选"><i class="fa-solid fa-check-double"></i></button>
                        <button class="wb-btn-circle" id="btn-invert-select" title="反选"><i class="fa-solid fa-circle-half-stroke"></i></button>
                        <button class="wb-btn-circle" id="btn-add-entry" title="新建条目"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    <div class="wb-list" id="wb-entry-list"></div>
                </div>

                <!-- Binding View -->
                <div id="wb-view-binding" class="wb-view-section wb-hidden"></div>
                
                <!-- Manage View -->
                <div id="wb-view-manage" class="wb-view-section wb-hidden"></div>

                <!-- Stitcher View -->
                <div id="wb-view-stitcher" class="wb-view-section wb-hidden"></div>
            </div>
            <div id="wb-batch-toolbar" class="wb-batch-toolbar"></div>
        `;
        document.body.appendChild(panel);

        const $ = (sel) => panel.querySelector(sel);
        $('#wb-close').onclick = () => panel.remove();
        $$('.wb-tab').forEach(el => el.onclick = () => Actions.switchView(el.dataset.tab));
        $('#wb-book-selector').addEventListener('change', (e) => Actions.loadBook(e.target.value));
        $('#wb-search-entry').oninput = (e) => UI.renderList(e.target.value);
        $('#btn-add-entry').onclick = () => Actions.addNewEntry();
        $('#btn-select-all').onclick = () => Actions.selectAllEntries();
        $('#btn-invert-select').onclick = () => Actions.invertSelection();

        this.renderMainMenu();

        const loader = $('#wb-loading-layer');
        await Actions.refreshAllContext();
        
        const charPrimary = STATE.bindings.char.primary;
        let targetBook = charPrimary && STATE.allBookNames.includes(charPrimary) ? charPrimary : STATE.allBookNames[0];
        if (targetBook) await Actions.loadBook(targetBook);
        
        loader.style.display = 'none';
        UI.updateGlider('editor');
        setTimeout(() => $('.wb-tab-glider').classList.add('wb-glider-animating'), 50);
        Actions.switchView('editor');
    },

    renderBookSelector() {
        const selector = document.getElementById('wb-book-selector');
        if (!selector) return;
        selector.innerHTML = STATE.allBookNames.map(name => `<option value="${name}">${name}</option>`).join('');
        if (STATE.currentBookName) selector.value = STATE.currentBookName;
        this.applyCustomDropdown('wb-book-selector');
    },
    
    renderMainMenu() {
        const container = document.getElementById('wb-main-menu-container');
        if(!container) return;
        container.innerHTML = `
            <button class="wb-btn-circle" title="更多操作"><i class="fa-solid fa-ellipsis-vertical"></i></button>
            <div class="wb-menu-dropdown">
                <div class="wb-menu-item" data-action="create"><i class="fa-solid fa-plus"></i> 新建世界书</div>
                <div class="wb-menu-item" data-action="rename"><i class="fa-solid fa-pen"></i> 重命名</div>
                <div class="wb-menu-item danger" data-action="delete"><i class="fa-solid fa-trash"></i> 删除</div>
            </div>
        `;
        const btn = container.querySelector('button');
        const menu = container.querySelector('.wb-menu-dropdown');
        btn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('show'); };
        document.addEventListener('click', () => menu.classList.remove('show'));
        menu.addEventListener('click', async (e) => {
            const item = e.target.closest('.wb-menu-item');
            if(!item) return;
            const action = item.dataset.action;
            menu.classList.remove('show');
            if (action === 'create') {
                const name = prompt("新世界书名称:");
                if (name && !STATE.allBookNames.includes(name)) await API.createWorldbook(name);
            } else if (action === 'rename') {
                const newName = prompt("重命名为:", STATE.currentBookName);
                if (newName && newName !== STATE.currentBookName && !STATE.allBookNames.includes(newName)) await API.renameWorldbook(STATE.currentBookName, newName);
            } else if (action === 'delete') {
                if (confirm(`确定删除 "${STATE.currentBookName}"?`)) await API.deleteWorldbook(STATE.currentBookName);
            }
            await Actions.refreshAllContext();
            await Actions.loadBook(STATE.allBookNames[0]);
        });
    },

    renderSnapshotMenu() {
        const container = document.getElementById('wb-snapshot-menu-container');
        if (!container) return;

        const snapshots = Actions.getSnapshots();
        let snapshotItems = '';
        if (snapshots.length > 0) {
            snapshotItems += `<div style="border-top:1px solid #e5e7eb; margin: 5px -15px;"></div>`;
            snapshots.forEach(s => {
                snapshotItems += `
                    <div class="wb-menu-item" style="justify-content:space-between;">
                        <span data-action="load" data-name="${s.name}">${s.name}</span>
                        <i class="fa-solid fa-trash" data-action="delete" data-name="${s.name}" style="color:#9ca3af;cursor:pointer;"></i>
                    </div>
                `;
            });
        }

        container.innerHTML = `
            <button class="wb-btn-circle" title="条目状态快照"><i class="fa-solid fa-camera"></i></button>
            <div class="wb-menu-dropdown">
                <div class="wb-menu-item" data-action="save"><i class="fa-solid fa-floppy-disk"></i> 保存当前状态</div>
                ${snapshotItems}
            </div>
        `;

        const btn = container.querySelector('button');
        const menu = container.querySelector('.wb-menu-dropdown');
        btn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('show'); };
        document.addEventListener('click', () => menu.classList.remove('show'));
        menu.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) return;
            const action = target.dataset.action;
            const name = target.dataset.name;
            menu.classList.remove('show');
            if (action === 'save') Actions.saveSnapshot();
            else if (action === 'load') Actions.loadSnapshot(name);
            else if (action === 'delete') Actions.deleteSnapshot(name);
        });
    },

    renderList(filterText = '') {
        const list = document.getElementById('wb-entry-list');
        if (!list) return;
        list.innerHTML = '';
        const term = filterText.toLowerCase();
        STATE.entries.forEach(entry => {
            const name = entry.comment || '';
            if (term && !name.toLowerCase().includes(term)) return;
            const card = this.createCard(entry);
            list.appendChild(card);
        });
        this.updateHeaderInfo();
    },

    createCard(entry) {
        const isEnabled = !entry.disable;
        const isConstant = !!entry.constant;
        const isSelected = STATE.selectedEntries.has(entry.uid);

        const card = document.createElement('div');
        card.className = `wb-card ${isEnabled ? (isConstant ? 'type-blue' : 'type-green') : 'disabled'} ${isSelected ? 'selected-for-batch' : ''}`;
        card.dataset.uid = entry.uid;

        const posOptions = Object.entries(WI_POSITION_MAP).map(([val, key]) => `<option value="${val}" ${entry.position == val ? 'selected' : ''}>${key.replace(/_/g, ' ')}</option>`).join('');

        card.innerHTML = `
            <div class="wb-card-selector">
                <input type="checkbox" ${isSelected ? 'checked' : ''}>
            </div>
            <div class="wb-card-content">
                <div class="wb-card-header">
                    <input class="wb-inp-title" value="${entry.comment || ''}" placeholder="条目名称">
                    <div class="wb-token-display">${Actions.getTokenCount(entry.content)}</div>
                    <i class="fa-solid fa-pen-to-square" title="编辑内容" style="cursor:pointer;color:#9ca3af;padding:5px;"></i>
                </div>
                <div class="wb-card-footer">
                    <div class="wb-ctrl-group"><label class="wb-switch"><input type="checkbox" class="inp-enable" ${isEnabled ? 'checked' : ''}><span class="wb-slider purple"></span></label></div>
                    <div class="wb-ctrl-group"><label class="wb-switch"><input type="checkbox" class="inp-type" ${isConstant ? 'checked' : ''}><span class="wb-slider blue"></span></label></div>
                    <div class="wb-ctrl-group"><select class="wb-inp-num inp-pos">${posOptions}</select></div>
                    <div class="wb-ctrl-group" ${entry.position != 4 ? 'style="display:none"' : ''}><span>D</span><input type="number" class="wb-inp-num inp-depth" value="${entry.depth || 4}"></div>
                    <div class="wb-ctrl-group"><span>O</span><input type="number" class="wb-inp-num inp-order" value="${entry.order || 0}"></div>
                </div>
            </div>
        `;

        const q = (s) => card.querySelector(s);
        q('.wb-card-selector input').onchange = (e) => Actions.toggleEntrySelection(entry.uid, e.target.checked);
        q('.inp-title').oninput = (e) => Actions.updateEntry(entry.uid, d => d.comment = e.target.value);
        q('.fa-pen-to-square').onclick = () => UI.openContentPopup(entry);
        q('.inp-enable').onchange = (e) => Actions.updateEntry(entry.uid, d => d.disable = !e.target.checked);
        q('.inp-type').onchange = (e) => Actions.updateEntry(entry.uid, d => d.constant = e.target.checked);
        q('.inp-pos').onchange = (e) => Actions.updateEntry(entry.uid, d => d.position = Number(e.target.value));
        q('.inp-depth').oninput = (e) => Actions.updateEntry(entry.uid, d => d.depth = Number(e.target.value));
        q('.inp-order').oninput = (e) => Actions.updateEntry(entry.uid, d => d.order = Number(e.target.value));

        return card;
    },

    updateCardStatus(uid) {
        const card = document.querySelector(`.wb-card[data-uid="${uid}"]`);
        const entry = STATE.entries.find(e => e.uid === uid);
        if (!card || !entry) return;
        card.className = `wb-card ${!entry.disable ? (entry.constant ? 'type-blue' : 'type-green') : 'disabled'} ${STATE.selectedEntries.has(uid) ? 'selected-for-batch' : ''}`;
        card.querySelector('.wb-token-display').textContent = Actions.getTokenCount(entry.content);
        card.querySelector('.inp-pos').value = entry.position;
        card.querySelector('.inp-pos').parentElement.nextElementSibling.style.display = entry.position == 4 ? '' : 'none';
        this.updateHeaderInfo();
    },

    updateHeaderInfo() {
        const count = STATE.entries.length;
        const enabled = STATE.entries.filter(e => !e.disable).length;
        // This is a placeholder for where more stats could go
    },

    renderBatchToolbar() {
        const toolbar = document.getElementById('wb-batch-toolbar');
        if (!toolbar) return;
        const count = STATE.selectedEntries.size;
        if (count === 0) {
            toolbar.classList.remove('show');
            return;
        }
        toolbar.innerHTML = `
            <div class="wb-batch-info">${count} 项已选中</div>
            <div class="wb-batch-actions">
                <button class="wb-batch-btn" data-action="enable" title="启用"><i class="fa-solid fa-eye"></i></button>
                <button class="wb-batch-btn" data-action="disable" title="禁用"><i class="fa-solid fa-eye-slash"></i></button>
                <button class="wb-batch-btn" data-action="set_const" title="设为常驻"><i class="fa-solid fa-anchor"></i></button>
                <button class="wb-batch-btn" data-action="set_select" title="设为选择性"><i class="fa-solid fa-key"></i></button>
                <button class="wb-batch-btn" data-action="delete" title="删除" style="color:#ef4444;"><i class="fa-solid fa-trash"></i></button>
            </div>
            <i class="fa-solid fa-xmark" style="cursor:pointer;margin-left:10px;" title="取消选择"></i>
        `;
        toolbar.classList.add('show');
        toolbar.querySelector('.fa-xmark').onclick = () => Actions.clearSelection();
        toolbar.querySelector('.wb-batch-actions').onclick = (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const action = btn.dataset.action;
            if (action === 'enable') Actions.batchUpdate(e => e.disable = false);
            else if (action === 'disable') Actions.batchUpdate(e => e.disable = true);
            else if (action === 'set_const') Actions.batchUpdate(e => e.constant = true);
            else if (action === 'set_select') Actions.batchUpdate(e => e.constant = false);
            else if (action === 'delete') Actions.batchDelete();
        };
    },

    // --- NEW/MODIFIED VIEWS ---
    renderBindingView() {
        const view = document.getElementById('wb-view-binding');
        if (!view) return;
        const { char, global, chat } = STATE.bindings;
        const createOpts = (selected) => `<option value="">(无)</option>` + STATE.allBookNames.map(name => `<option value="${name}" ${name === selected ? 'selected' : ''}>${name}</option>`).join('');
        
        view.innerHTML = `
            <div class="wb-bind-grid">
                <div class="wb-bind-card">
                    <div class="wb-bind-title">角色世界书</div>
                    <div class="wb-bind-label">主要世界书</div>
                    <select id="wb-bind-char-primary" class="wb-input-dark">${createOpts(char.primary)}</select>
                    <div class="wb-bind-label">附加世界书</div>
                    <div id="wb-bind-char-aux" class="wb-multi-select-container"></div>
                </div>
                <div class="wb-bind-card">
                    <div class="wb-bind-title">全局世界书 <i class="fa-solid fa-info-circle" style="font-size:0.7em;color:#9ca3af;" title="双击条目可快速跳转到编辑"></i></div>
                    <div id="wb-bind-global" class="wb-multi-select-container"></div>
                </div>
                 <div class="wb-bind-card">
                    <div class="wb-bind-title">聊天世界书</div>
                    <select id="wb-bind-chat" class="wb-input-dark">${createOpts(chat)}</select>
                </div>
            </div>
            <button id="wb-save-bindings" class="wb-btn-rect" style="margin: 20px auto; display: block;">保存绑定</button>
        `;
        
        const renderCheckList = (containerId, selectedSet, type) => {
            const container = view.querySelector(`#${containerId}`);
            container.innerHTML = `<div class="wb-multi-select-list"></div>`;
            const list = container.querySelector('.wb-multi-select-list');
            STATE.allBookNames.forEach(name => {
                const item = document.createElement('div');
                item.className = `wb-multi-select-item ${selectedSet.has(name) ? 'selected' : ''}`;
                item.textContent = name;
                item.onclick = () => setCharBindings(type, name, !selectedSet.has(name)).then(()=>Actions.refreshAllContext().then(()=>this.renderBindingView()));
                if (type === 'global') {
                    item.ondblclick = () => Actions.jumpToEditor(name);
                }
                list.appendChild(item);
            });
        };

        renderCheckList('wb-bind-char-aux', new Set(char.additional), 'auxiliary');
        renderCheckList('wb-bind-global', new Set(global), 'global');
        
        view.querySelector('#wb-bind-char-primary').onchange = (e) => setCharBindings('primary', e.target.value, !!e.target.value);
        view.querySelector('#wb-bind-chat').onchange = (e) => setCharBindings('chat', e.target.value, !!e.target.value);
    },

    renderManageView() { /* Your existing manage view code can be ported here */ },

    renderStitcherView() {
        const view = document.getElementById('wb-view-stitcher');
        if (!view) return;
        view.innerHTML = `
            <div class="wb-stitcher-panel" id="stitcher-left">
                <select class="wb-input-dark"></select>
                <div class="wb-stitcher-list"></div>
                <button class="wb-btn-rect secondary">保存</button>
            </div>
            <div class="wb-stitcher-panel" id="stitcher-right">
                <select class="wb-input-dark"></select>
                <div class="wb-stitcher-list"></div>
                <button class="wb-btn-rect secondary">保存</button>
            </div>
        `;

        ['left', 'right'].forEach(panel => {
            const panelEl = view.querySelector(`#stitcher-${panel}`);
            const select = panelEl.querySelector('select');
            select.innerHTML = '<option value="">选择世界书...</option>' + STATE.allBookNames.map(name => `<option value="${name}">${name}</option>`).join('');
            select.onchange = (e) => Actions.loadStitcherBook(panel, e.target.value);
            panelEl.querySelector('button').onclick = () => Actions.saveStitcherPanel(panel);

            const listEl = panelEl.querySelector('.wb-stitcher-list');
            listEl.addEventListener('dragover', e => e.preventDefault());
            listEl.addEventListener('drop', e => {
                e.preventDefault();
                const sourcePanel = e.dataTransfer.getData('text/sourcePanel');
                const uid = Number(e.dataTransfer.getData('text/uid'));
                const isCopy = e.ctrlKey || e.metaKey;
                Actions.handleStitcherDrop(sourcePanel, panel, uid, isCopy);
            });
        });
        
        this.renderStitcherPanel('left');
        this.renderStitcherPanel('right');
    },
    
    renderStitcherPanel(panel) {
        const panelEl = document.getElementById(`stitcher-${panel}`);
        if (!panelEl) return;
        const listEl = panelEl.querySelector('.wb-stitcher-list');
        listEl.innerHTML = '';
        const { name, entries } = STATE.stitcher[panel];
        if (name) panelEl.querySelector('select').value = name;
        entries.forEach(entry => {
            const item = this.createStitcherItem(entry, panel);
            listEl.appendChild(item);
        });
    },

    createStitcherItem(entry, panel) {
        const item = document.createElement('div');
        item.className = 'wb-stitcher-item';
        if (entry.constant) item.classList.add('constant');
        if (entry.disable) item.classList.add('disabled');
        item.draggable = true;
        item.innerHTML = `<span class="wb-stitcher-item-name">${entry.comment || '无标题'}</span><i class="fa-solid fa-copy wb-stitcher-item-copy" title="按住Ctrl拖动可复制"></i>`;
        
        item.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/uid', entry.uid);
            e.dataTransfer.setData('text/sourcePanel', panel);
            e.currentTarget.classList.add('dragging');
        });
        item.addEventListener('dragend', e => e.currentTarget.classList.remove('dragging'));
        
        return item;
    },

    // other UI helpers...
    applyCustomDropdown(selectId) { /* Your existing code */ },
    openContentPopup(entry) { /* Your existing code, modified to not require triggerBtn */ },
};

jQuery(async () => {
    const injectButton = () => {
        if (document.getElementById(CONFIG.btnId)) return;
        const container = document.querySelector('#options .options-content');
        if (container) {
            const html = `<a id="${CONFIG.btnId}" class="interactable" title="世界书管理器" tabindex="0"><i class="fa-lg fa-solid fa-book-journal-whills"></i><span>世界书</span></a>`;
            $(container).append(html);
            $(`#${CONFIG.btnId}`).on('click', (e) => {
                e.preventDefault();
                $('#options').hide();
                UI.open();
            });
        }
    };
    injectButton();
    const performInit = async () => {
        try { await Actions.init(); } catch (e) { console.error("WB Editor Init Failed:", e); }
    };
    if (typeof world_names === 'undefined') {
        eventSource.on(event_types.APP_READY, performInit);
    } else {
        performInit();
    }
});
