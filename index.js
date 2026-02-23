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
    settingsKey: 'WorldbookEditor_Metadata',
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
const WI_POSITION_MAP = { 0: 'before_character_definition', 1: 'after_character_definition', 2: 'before_author_note', 3: 'after_author_note', 4: 'at_depth', 5: 'before_example_messages', 6: 'after_example_messages' };
const WI_POSITION_MAP_REV = Object.fromEntries(Object.entries(WI_POSITION_MAP).map(([k, v]) => [v, parseInt(k)]));


// =================================================================
// CRITICAL FIX: Re-integrated user's original compatibility functions
// =================================================================
async function charUpdatePrimaryWorld(name) {
    const context = getContext();
    const charId = context.characterId;
    if (charId === undefined || charId === null) return;
    const character = context.characters[charId];
    if (!character) return;
    if (!character.data.extensions) character.data.extensions = {};
    character.data.extensions.world = name;
    const uiSelect = document.getElementById('character_world');
    if (uiSelect) {
        uiSelect.value = name;
        uiSelect.dispatchEvent(new Event('change'));
    }
    const setWorldBtn = document.getElementById('set_character_world');
    if (setWorldBtn) {
        if (name) setWorldBtn.classList.add('world_set');
        else setWorldBtn.classList.remove('world_set');
    }
    if (context.saveCharacterDebounced) context.saveCharacterDebounced();
}

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
    if (context.saveSettingsDebounced) context.saveSettingsDebounced();
}

async function setCharBindings(type, worldName, isEnabled) {
    const context = getContext();
    if (type === 'primary') {
        await charUpdatePrimaryWorld(isEnabled ? worldName : '');
    } else if (type === 'auxiliary') {
        const charId = context.characterId;
        if (!charId && charId !== 0) return;
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
        if (isEnabled) context.chatMetadata['world_info'] = worldName;
        else if (context.chatMetadata['world_info'] === worldName) delete context.chatMetadata['world_info'];
        context.saveMetadataDebounced();
    } else if (type === 'global') {
        const command = isEnabled ? `/world silent=true "${worldName}"` : `/world state=off silent=true "${worldName}"`;
        await context.executeSlashCommands(command);
    }
}
// =================================================================
// END OF COMPATIBILITY FIX
// =================================================================


const API = {
    // --- Read ---
    async getAllBookNames() { return [...(world_names || [])].sort((a, b) => a.localeCompare(b)); },
    async getCharBindings() {
        const context = getContext();
        const charId = context.characterId;
        if (charId === undefined || charId === null) return { primary: null, additional: [] };
        const character = context.characters[charId];
        if (!character) return { primary: null, additional: [] };
        const primary = character.data?.extensions?.world || null;
        const fileName = character.avatar.replace(/\.[^/.]+$/, "");
        const entry = (world_info.charLore || []).find(e => e.name === fileName);
        const additional = (entry && Array.isArray(entry.extraBooks)) ? [...entry.extraBooks] : [];
        return { primary, additional };
    },
    async getGlobalBindings() { return [...(selected_world_info || [])]; },
    async getChatBinding() { return getContext().chatMetadata?.world_info || null; },
    async loadBook(name) {
        const data = await getContext().loadWorldInfo(name);
        if (!data) throw new Error(`Worldbook ${name} not found`);
        const entries = Object.values(data.entries ? structuredClone(data.entries) : {});
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
        await getContext().saveWorldInfo(name, { ...oldData, entries: newEntriesObj }, false);
    },
    async createEntry(name, newEntriesArray) {
        const currentEntries = await this.loadBook(name);
        await this.saveBookEntries(name, [...newEntriesArray, ...currentEntries]);
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
    async createWorldbook(name) { await getContext().saveWorldInfo(name, { entries: {} }, true); await getContext().updateWorldInfoList(); },
    async deleteWorldbook(name) { await fetch('/api/worldinfo/delete', { method: 'POST', headers: getContext().getRequestHeaders(), body: JSON.stringify({ name }) }); await getContext().updateWorldInfoList(); },
    async renameWorldbook(oldName, newName) {
        const data = await getContext().loadWorldInfo(oldName);
        if (!data) return;
        await getContext().saveWorldInfo(newName, data, true);
        const { primary, additional } = await this.getCharBindings();
        if (primary === oldName) await setCharBindings('primary', newName, true);
        if (additional.includes(oldName)) { await setCharBindings('auxiliary', oldName, false); await setCharBindings('auxiliary', newName, true); }
        if ((await this.getGlobalBindings()).includes(oldName)) { await setCharBindings('global', oldName, false); await setCharBindings('global', newName, true); }
        if ((await this.getChatBinding()) === oldName) await setCharBindings('chat', newName, true);
        await this.deleteWorldbook(oldName);
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
        const onUpdate = async () => { if (document.getElementById(CONFIG.id)) await this.refreshAllContext(); };
        es.on(et.SETTINGS_UPDATED, onUpdate);
        es.on(et.CHAT_CHANGED, onUpdate);
        es.on(et.CHARACTER_SELECTED, () => setTimeout(onUpdate, 100));
        es.on(et.CHARACTER_EDITED, onUpdate);
        es.on(et.WORLDINFO_UPDATED, async (name) => { 
            await this.refreshAllContext();
            if (STATE.currentBookName === name) await this.loadBook(name); 
        });
        STATE.isInitialized = true;
    },

    async refreshAllContext() {
        try {
            const [all, char, glob, chat] = await Promise.all([API.getAllBookNames(), API.getCharBindings(), API.getGlobalBindings(), API.getChatBinding()]);
            STATE.allBookNames = all;
            STATE.bindings = { char, global: glob, chat };
            STATE.metadata = API.getMetadata();
            if (document.getElementById(CONFIG.id)) {
                if(STATE.currentView === 'binding') UI.renderBindingView();
                else if(STATE.currentView === 'stitcher') UI.renderStitcherView();
                else if(STATE.currentView === 'editor') UI.renderBookSelector();
            }
        } catch (error) {
            console.error("Error refreshing context:", error);
            toastr.error("刷新上下文失败");
        }
    },

    async switchView(viewName) {
        await this.flushPendingSave();
        Actions.clearSelection();

        UI.updateGlider(viewName);
        document.querySelectorAll('.wb-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === viewName));

        STATE.currentView = viewName;
        document.querySelectorAll('.wb-view-section').forEach(el => el.classList.add('wb-hidden'));
        const targetView = document.getElementById(`wb-view-${viewName}`);
        if (targetView) targetView.classList.remove('wb-hidden');

        if (viewName === 'binding') UI.renderBindingView();
        else if (viewName === 'manage') UI.renderManageView();
        else if (viewName === 'stitcher') UI.renderStitcherView();
        else if (viewName === 'editor') {
            UI.renderBookSelector();
            UI.renderSnapshotMenu();
        }
    },

    async loadBook(name) {
        if (!name) {
            STATE.entries = [];
            UI.renderList();
            return;
        }
        await this.flushPendingSave();
        STATE.currentBookName = name;
        Actions.clearSelection();

        try {
            const loadedEntries = await API.loadBook(name);
            if (STATE.currentBookName !== name) return; // Race condition check
            STATE.entries = loadedEntries;
            UI.renderList();
            UI.renderSnapshotMenu();
            const selector = document.getElementById('wb-book-selector');
            if (selector) selector.value = name;
        } catch (e) {
            console.error(`Error loading book ${name}:`, e);
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
            if (targetBookName && targetEntries) API.saveBookEntries(targetBookName, targetEntries);
        }, 300);
    },

    async addNewEntry() {
        if (!STATE.currentBookName) return toastr.warning("请先选择一本世界书");
        const maxUid = STATE.entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), 0);
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
        if (isSelected) STATE.selectedEntries.add(uid);
        else STATE.selectedEntries.delete(uid);
        UI.renderBatchToolbar();
        const card = document.querySelector(`.wb-card[data-uid="${uid}"]`);
        if (card) card.classList.toggle('selected-for-batch', isSelected);
    },
    selectAllEntries() {
        const allVisibleUIDs = Array.from(document.querySelectorAll('#wb-entry-list .wb-card')).map(card => Number(card.dataset.uid));
        const allSelected = allVisibleUIDs.every(uid => STATE.selectedEntries.has(uid));
        allVisibleUIDs.forEach(uid => this.toggleEntrySelection(uid, !allSelected));
    },
    invertSelection() {
        const allVisibleUIDs = Array.from(document.querySelectorAll('#wb-entry-list .wb-card')).map(card => Number(card.dataset.uid));
        allVisibleUIDs.forEach(uid => this.toggleEntrySelection(uid, !STATE.selectedEntries.has(uid)));
    },
    clearSelection() {
        STATE.selectedEntries.clear();
        document.querySelectorAll('.wb-card.selected-for-batch').forEach(c => c.classList.remove('selected-for-batch'));
        document.querySelectorAll('.wb-card-selector input').forEach(c => c.checked = false);
        UI.renderBatchToolbar();
    },
    async batchUpdate(updater) {
        if (STATE.selectedEntries.size === 0) return toastr.warning("没有选中的条目");
        STATE.selectedEntries.forEach(uid => this.updateEntry(uid, updater));
        await this.flushPendingSave();
        toastr.success(`${STATE.selectedEntries.size} 个条目已更新`);
    },
    async batchDelete() {
        if (STATE.selectedEntries.size === 0) return;
        await this.deleteEntries(Array.from(STATE.selectedEntries));
    },

    // --- SNAPSHOTS ---
    getSnapshots() { return (STATE.metadata[STATE.currentBookName] || {}).snapshots || []; },
    async saveSnapshot() {
        if (!STATE.currentBookName) return;
        const name = prompt("请输入快照名称:", `配置 ${new Date().toLocaleDateString()}`);
        if (!name) return;
        const stateMap = Object.fromEntries(STATE.entries.map(e => [e.uid, e.disable]));
        const bookMeta = STATE.metadata[STATE.currentBookName] || {};
        if (!bookMeta.snapshots) bookMeta.snapshots = [];
        bookMeta.snapshots.push({ name, states: stateMap });
        STATE.metadata[STATE.currentBookName] = bookMeta;
        await API.saveMetadata(STATE.metadata);
        UI.renderSnapshotMenu();
        toastr.success("快照已保存");
    },
    async loadSnapshot(snapshotName) {
        const snapshot = this.getSnapshots().find(s => s.name === snapshotName);
        if (!snapshot) return;
        STATE.entries.forEach(entry => { if (snapshot.states.hasOwnProperty(entry.uid)) entry.disable = snapshot.states[entry.uid]; });
        await this.flushPendingSave();
        UI.renderList();
        toastr.success(`已加载快照: ${snapshotName}`);
    },
    async deleteSnapshot(snapshotName) {
        if (!confirm(`确定要删除快照 "${snapshotName}" 吗?`)) return;
        const bookMeta = STATE.metadata[STATE.currentBookName];
        if (bookMeta?.snapshots) {
            bookMeta.snapshots = bookMeta.snapshots.filter(s => s.name !== snapshotName);
            await API.saveMetadata(STATE.metadata);
            UI.renderSnapshotMenu();
        }
    },

    // --- STITCHER ---
    async loadStitcherBook(panel, bookName) {
        await this.flushPendingSave();
        if (!bookName) STATE.stitcher[panel] = { name: null, entries: [] };
        else {
            try { STATE.stitcher[panel] = { name: bookName, entries: await API.loadBook(bookName) }; }
            catch (e) { toastr.error(`加载 ${bookName} 失败`); STATE.stitcher[panel] = { name: null, entries: [] }; }
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
            const maxUidInAll = [...STATE.stitcher.left.entries, ...STATE.stitcher.right.entries].reduce((max, e) => Math.max(max, Number(e.uid) || 0), 0);
            movedEntry.uid = maxUidInAll + 1;
        }
        targetList.unshift(movedEntry);
        UI.renderStitcherPanel(sourcePanel);
        UI.renderStitcherPanel(targetPanel);
    },
    async saveStitcherPanel(panel) {
        const { name, entries } = STATE.stitcher[panel];
        if (!name) return;
        if (!confirm(`确定要将当前列表覆盖到世界书 "${name}" 吗?`)) return;
        try { await API.saveBookEntries(name, entries); toastr.success(`"${name}" 已保存`); }
        catch (e) { toastr.error(`保存 "${name}" 失败: ${e.message}`); }
    },
    
    // --- Other actions ---
    getTokenCount(text) { try { return getContext().getTokenCount(text || ''); } catch (e) { return Math.ceil((text || '').length / 3); } },
    async jumpToEditor(bookName) { await this.loadBook(bookName); this.switchView('editor'); },
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
                <div id="wb-loading-layer" style="position:absolute;inset:0;background:rgba(255,255,255,0.8);backdrop-filter:blur(2px);z-index:100;display:flex;align-items:center;justify-content:center;"><i class="fa-solid fa-circle-notch fa-spin" style="font-size:2em;color:#3b82f6;"></i></div>
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
                <div id="wb-view-binding" class="wb-view-section wb-hidden"></div>
                <div id="wb-view-manage" class="wb-view-section wb-hidden"><div style="text-align:center;color:#9ca3af;padding:20px;">管理视图正在施工中...</div></div>
                <div id="wb-view-stitcher" class="wb-view-section wb-hidden"></div>
            </div>
            <div id="wb-batch-toolbar" class="wb-batch-toolbar"></div>
        `;
        document.body.appendChild(panel);

        const $ = (sel) => panel.querySelector(sel);
        const $$ = (sel) => panel.querySelectorAll(sel);

        $('#wb-close').onclick = () => { Actions.flushPendingSave(); panel.remove(); };
        $$('.wb-tab').forEach(el => el.onclick = () => Actions.switchView(el.dataset.tab));
        $('#wb-book-selector').addEventListener('change', (e) => Actions.loadBook(e.target.value));
        $('#wb-search-entry').oninput = (e) => UI.renderList(e.target.value);
        $('#btn-add-entry').onclick = () => Actions.addNewEntry();
        $('#btn-select-all').onclick = () => Actions.selectAllEntries();
        $('#btn-invert-select').onclick = () => Actions.invertSelection();

        this.renderMainMenu();
        this.renderSnapshotMenu();

        try {
            await Actions.refreshAllContext();
            const charPrimary = STATE.bindings.char.primary;
            let targetBook = (charPrimary && STATE.allBookNames.includes(charPrimary)) ? charPrimary : STATE.allBookNames[0];
            await Actions.loadBook(targetBook);
        } catch (error) {
            console.error("Error during panel opening:", error);
            toastr.error("打开面板时出错，请检查控制台。");
        } finally {
            $('#wb-loading-layer').style.display = 'none';
        }

        UI.updateGlider('editor');
        setTimeout(() => $('.wb-tab-glider')?.classList.add('wb-glider-animating'), 50);
    },

    renderBookSelector() {
        const selector = document.getElementById('wb-book-selector');
        if (!selector) return;
        const currentVal = selector.value;
        const optionsHtml = STATE.allBookNames.map(name => `<option value="${name}">${name}</option>`).join('');
        if (selector.innerHTML !== optionsHtml) selector.innerHTML = optionsHtml;
        const targetBook = STATE.currentBookName || currentVal;
        if (targetBook && STATE.allBookNames.includes(targetBook)) selector.value = targetBook;
        else if (STATE.allBookNames.length > 0) selector.value = STATE.allBookNames[0];
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
        const closeAllMenus = () => document.querySelectorAll('.wb-menu-dropdown.show').forEach(m => m.classList.remove('show'));
        btn.onclick = (e) => { e.stopPropagation(); const isShown = menu.classList.contains('show'); closeAllMenus(); if(!isShown) menu.classList.add('show'); };
        menu.addEventListener('click', async (e) => {
            const item = e.target.closest('[data-action]');
            if(!item) return;
            menu.classList.remove('show');
            const action = item.dataset.action;
            let nextBook = STATE.currentBookName;

            if (action === 'create') {
                const name = prompt("新世界书名称:");
                if (name && !STATE.allBookNames.includes(name)) { await API.createWorldbook(name); nextBook = name; }
            } else if (action === 'rename') {
                const newName = prompt("重命名为:", STATE.currentBookName);
                if (newName && newName !== STATE.currentBookName && !STATE.allBookNames.includes(newName)) { await API.renameWorldbook(STATE.currentBookName, newName); nextBook = newName; }
            } else if (action === 'delete') {
                if (confirm(`确定删除 "${STATE.currentBookName}"?`)) { await API.deleteWorldbook(STATE.currentBookName); nextBook = STATE.allBookNames.filter(b => b !== STATE.currentBookName)[0]; }
            }
            await Actions.refreshAllContext();
            await Actions.loadBook(nextBook);
        });
        document.addEventListener('click', closeAllMenus);
    },

    renderSnapshotMenu() {
        const container = document.getElementById('wb-snapshot-menu-container');
        if (!container) return;
        const snapshots = Actions.getSnapshots();
        container.innerHTML = `
            <button class="wb-btn-circle" title="条目状态快照"><i class="fa-solid fa-camera"></i></button>
            <div class="wb-menu-dropdown">
                <div class="wb-menu-item" data-action="save"><i class="fa-solid fa-floppy-disk"></i> 保存当前状态为快照</div>
                ${snapshots.length > 0 ? `<div style="border-top:1px solid #e5e7eb; margin: 5px -15px;"></div>` : ''}
                ${snapshots.map(s => `
                    <div class="wb-menu-item" style="justify-content:space-between;">
                        <span data-action="load" data-name="${s.name}" style="flex:1;cursor:pointer;">${s.name}</span>
                        <i class="fa-solid fa-trash" data-action="delete" data-name="${s.name}" title="删除快照" style="padding:5px;cursor:pointer;color:#9ca3af;transition:color 0.2s;"></i>
                    </div>`).join('')}
            </div>`;
        const btn = container.querySelector('button');
        const menu = container.querySelector('.wb-menu-dropdown');
        const closeAllMenus = () => document.querySelectorAll('.wb-menu-dropdown.show').forEach(m => m.classList.remove('show'));
        btn.onclick = (e) => { e.stopPropagation(); const isShown = menu.classList.contains('show'); closeAllMenus(); if(!isShown) menu.classList.add('show'); };
        menu.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) return;
            e.stopPropagation();
            const action = target.dataset.action;
            const name = target.dataset.name;
            if (action !== 'delete') menu.classList.remove('show');
            if (action === 'save') Actions.saveSnapshot();
            else if (action === 'load') Actions.loadSnapshot(name);
            else if (action === 'delete') Actions.deleteSnapshot(name);
        });
        menu.querySelectorAll('.fa-trash').forEach(i => { i.onmouseover = e => e.target.style.color = '#ef4444'; i.onmouseout = e => e.target.style.color = '#9ca3af'; });
    },

    renderList(filterText = '') {
        const list = document.getElementById('wb-entry-list');
        if (!list) return;
        list.innerHTML = '';
        const term = (filterText || '').toLowerCase();
        const frag = document.createDocumentFragment();
        STATE.entries.forEach(entry => {
            if (term && !(entry.comment || '').toLowerCase().includes(term)) return;
            frag.appendChild(this.createCard(entry));
        });
        list.appendChild(frag);
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
            <div class="wb-card-selector"><input type="checkbox" ${isSelected ? 'checked' : ''}></div>
            <div class="wb-card-content">
                <div class="wb-card-header">
                    <input class="wb-inp-title" value="${entry.comment || ''}" placeholder="条目名称">
                    <div class="wb-token-display">${Actions.getTokenCount(entry.content)}</div>
                    <i class="fa-solid fa-pen-to-square" title="编辑内容" style="cursor:pointer;color:#9ca3af;padding:5px;"></i>
                </div>
                <div class="wb-card-footer">
                    <div class="wb-ctrl-group"><label class="wb-switch"><input type="checkbox" class="inp-enable" ${isEnabled ? 'checked' : ''}><span class="wb-slider purple"></span></label></div>
                    <div class="wb-ctrl-group"><label class="wb-switch"><input type="checkbox" class="inp-type" ${isConstant ? 'checked' : ''}><span class="wb-slider blue"></span></label></div>
                    <div class="wb-ctrl-group"><select class="wb-inp-num inp-pos" style="width:130px;">${posOptions}</select></div>
                    <div class="wb-ctrl-group" ${entry.position != 4 ? 'style="display:none"' : ''}><span>D</span><input type="number" class="wb-inp-num inp-depth" value="${entry.depth || 4}"></div>
                    <div class="wb-ctrl-group"><span>O</span><input type="number" class="wb-inp-num inp-order" value="${entry.order || 0}"></div>
                </div>
            </div>`;
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
        card.querySelector('.inp-pos').parentElement.nextElementSibling.style.display = entry.position == 4 ? '' : 'none';
    },

    renderBatchToolbar() {
        const toolbar = document.getElementById('wb-batch-toolbar');
        if (!toolbar) return;
        const count = STATE.selectedEntries.size;
        if (count === 0) { toolbar.classList.remove('show'); return; }
        toolbar.innerHTML = `
            <div class="wb-batch-info">${count} 项已选中</div>
            <div class="wb-batch-actions">
                <button class="wb-batch-btn" data-action="enable" title="启用"><i class="fa-solid fa-eye"></i></button>
                <button class="wb-batch-btn" data-action="disable" title="禁用"><i class="fa-solid fa-eye-slash"></i></button>
                <button class="wb-batch-btn" data-action="set_const" title="设为常驻"><i class="fa-solid fa-anchor"></i></button>
                <button class="wb-batch-btn" data-action="set_select" title="设为选择性"><i class="fa-solid fa-key"></i></button>
                <button class="wb-batch-btn" data-action="delete" title="删除" style="color:#ef4444;"><i class="fa-solid fa-trash"></i></button>
            </div>
            <i class="fa-solid fa-xmark" style="cursor:pointer;margin-left:10px;" title="取消选择"></i>`;
        toolbar.classList.add('show');
        toolbar.querySelector('.fa-xmark').onclick = () => Actions.clearSelection();
        toolbar.querySelector('.wb-batch-actions').onclick = (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const action = btn.dataset.action;
            if (action === 'enable') Actions.batchUpdate(ent => ent.disable = false);
            else if (action === 'disable') Actions.batchUpdate(ent => ent.disable = true);
            else if (action === 'set_const') Actions.batchUpdate(ent => ent.constant = true);
            else if (action === 'set_select') Actions.batchUpdate(ent => ent.constant = false);
            else if (action === 'delete') Actions.batchDelete();
        };
    },

    // --- VIEWS ---
    renderBindingView() {
        const view = document.getElementById('wb-view-binding');
        if (!view) return;
        const { char, global, chat } = STATE.bindings;
        const createOpts = (selected) => `<option value="">(无)</option>` + STATE.allBookNames.map(name => `<option value="${name}" ${name === selected ? 'selected' : ''}>${name}</option>`).join('');
        view.innerHTML = `
            <div class="wb-bind-grid">
                <div class="wb-bind-card"><div class="wb-bind-title">角色世界书</div><div class="wb-bind-label">主要世界书</div><select id="wb-bind-char-primary" class="wb-input-dark">${createOpts(char.primary)}</select><div class="wb-bind-label">附加世界书</div><div id="wb-bind-char-aux" class="wb-multi-select-container"></div></div>
                <div class="wb-bind-card"><div class="wb-bind-title">全局世界书 <i class="fa-solid fa-info-circle" style="font-size:0.7em;color:#9ca3af;" title="双击条目可快速跳转到编辑"></i></div><div id="wb-bind-global" class="wb-multi-select-container"></div></div>
                <div class="wb-bind-card"><div class="wb-bind-title">聊天世界书</div><select id="wb-bind-chat" class="wb-input-dark">${createOpts(chat)}</select></div>
            </div>`;
        const renderCheckList = (containerId, selectedSet, type) => {
            const list = view.querySelector(`#${containerId}`).appendChild(document.createElement('div'));
            list.className = 'wb-multi-select-list';
            STATE.allBookNames.forEach(name => {
                const item = list.appendChild(document.createElement('div'));
                item.className = `wb-multi-select-item ${selectedSet.has(name) ? 'selected' : ''}`;
                item.textContent = name;
                item.onclick = async () => { item.classList.toggle('selected'); await setCharBindings(type, name, item.classList.contains('selected')); await Actions.refreshAllContext(); };
                if (type === 'global') item.ondblclick = () => Actions.jumpToEditor(name);
            });
        };
        renderCheckList('wb-bind-char-aux', new Set(char.additional), 'auxiliary');
        renderCheckList('wb-bind-global', new Set(global), 'global');
        view.querySelector('#wb-bind-char-primary').onchange = async (e) => { await setCharBindings('primary', e.target.value, !!e.target.value); await Actions.refreshAllContext(); };
        view.querySelector('#wb-bind-chat').onchange = async (e) => { await setCharBindings('chat', e.target.value, !!e.target.value); await Actions.refreshAllContext(); };
    },

    renderManageView() {
        const container = document.getElementById('wb-view-manage');
        if(container) container.innerHTML = `<div style="text-align:center;color:#9ca3af;padding:20px;">管理视图正在施工中...</div>`;
    },

    renderStitcherView() {
        const view = document.getElementById('wb-view-stitcher');
        if (!view) return;
        view.innerHTML = `
            <div class="wb-stitcher-panel" id="stitcher-left"><select class="wb-input-dark"></select><div class="wb-stitcher-list"></div><button class="wb-btn-rect secondary">保存到左侧书</button></div>
            <div class="wb-stitcher-panel" id="stitcher-right"><select class="wb-input-dark"></select><div class="wb-stitcher-list"></div><button class="wb-btn-rect secondary">保存到右侧书</button></div>`;
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
                Actions.handleStitcherDrop(e.dataTransfer.getData('text/sourcePanel'), panel, Number(e.dataTransfer.getData('text/uid')), e.ctrlKey || e.metaKey);
            });
        });
        this.renderStitcherPanel('left'); this.renderStitcherPanel('right');
    },
    
    renderStitcherPanel(panel) {
        const panelEl = document.getElementById(`stitcher-${panel}`);
        if (!panelEl) return;
        const listEl = panelEl.querySelector('.wb-stitcher-list');
        listEl.innerHTML = '';
        const { name, entries } = STATE.stitcher[panel];
        if (name) panelEl.querySelector('select').value = name;
        entries.forEach(entry => listEl.appendChild(this.createStitcherItem(entry, panel)));
    },

    createStitcherItem(entry, panel) {
        const item = document.createElement('div');
        item.className = `wb-stitcher-item ${entry.constant ? 'constant' : ''} ${entry.disable ? 'disabled' : ''}`;
        item.draggable = true;
        item.innerHTML = `<span class="wb-stitcher-item-name" title="${entry.comment || '无标题'}">${entry.comment || '无标题'}</span><i class="fa-solid fa-copy wb-stitcher-item-copy" title="按住Ctrl/Cmd拖动可复制"></i>`;
        item.ondragstart = e => { e.dataTransfer.setData('text/uid', entry.uid); e.dataTransfer.setData('text/sourcePanel', panel); e.currentTarget.classList.add('dragging'); };
        item.ondragend = e => e.currentTarget.classList.remove('dragging');
        return item;
    },

    openContentPopup(entry) {
        const old = document.getElementById('wb-content-popup-overlay');
        if (old) old.remove();
        const overlay = document.createElement('div');
        overlay.id = 'wb-content-popup-overlay';
        overlay.className = 'wb-modal-overlay';
        overlay.innerHTML = `<div class="wb-content-popup">
            <div class="wb-popup-header"><span>${entry.comment || '编辑条目'}</span></div>
            <input class="wb-input-dark" id="wb-popup-keys" placeholder="关键词 (英文逗号分隔)" value="${(entry.key || []).join(', ')}">
            <textarea class="wb-input-dark" id="wb-popup-content" style="flex:1;resize:none;" placeholder="在此编辑内容...">${entry.content || ''}</textarea>
            <div class="wb-popup-footer"><button class="wb-btn-rect secondary" id="wb-popup-cancel">取消</button><button class="wb-btn-rect" id="wb-popup-save">保存</button></div>
        </div>`;
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.querySelector('#wb-popup-cancel').onclick = close;
        overlay.onclick = (e) => { if (e.target === overlay) close(); };
        overlay.querySelector('#wb-popup-save').onclick = () => {
            const content = overlay.querySelector('#wb-popup-content').value;
            const keys = overlay.querySelector('#wb-popup-keys').value.split(',').map(s => s.trim()).filter(Boolean);
            Actions.updateEntry(entry.uid, d => { d.content = content; d.key = keys; });
            close();
        };
    },
    
    applyCustomDropdown(selectId) { /* Your original code can be placed here if needed. For now, it's disabled for simplicity and compatibility. */ },
};

jQuery(async () => {
    const injectButton = () => {
        if (document.getElementById(CONFIG.btnId)) return;
        const container = document.querySelector('#options .options-content');
        if (container) {
            $(container).append(`<a id="${CONFIG.btnId}" class="interactable" title="世界书管理器" tabindex="0"><i class="fa-lg fa-solid fa-book-journal-whills"></i><span>世界书</span></a>`);
            $(`#${CONFIG.btnId}`).on('click', (e) => { e.preventDefault(); $('#options').hide(); UI.open(); });
        }
    };
    
    // Initializer that waits for the app to be ready
    const init = async () => { 
        try { 
            await Actions.init(); 
        } catch (e) { 
            console.error("Worldbook Editor Init Failed:", e); 
        } 
    };
    
    // Check if ST is ready, otherwise wait for the event
    if (typeof world_names === 'undefined') {
        eventSource.on(event_types.APP_READY, init);
    } else {
        init();
    }
    
    injectButton();
});
