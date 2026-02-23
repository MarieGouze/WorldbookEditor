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
        accent: '#7c5cbd',
    }
};

const STATE = {
    currentView: 'editor', // 'editor' | 'binding' | 'manage' | 'stitch'
    currentBookName: null,
    isInitialized: false,
    isManageDirty: true,

    entries: [],
    allBookNames: [],
    metadata: {},
    boundBooksSet: {},

    bindings: { char: { primary: null, additional: [] }, global: [], chat: null },

    // 批量操作状态
    selectionMode: false,
    selectedUids: new Set(),

    // 缝合模式状态
    dual: {
        left: { name: null, entries: [] },
        right: { name: null, entries: [] }
    },

    debouncer: null
};

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

// --- 基础辅助函数 ---
async function charUpdatePrimaryWorld(name) {
    const context = getContext();
    const charId = context.characterId;
    if (charId === undefined || charId === null) return;
    const character = context.characters[charId];
    if (!character) return;
    if (!character.data.extensions) character.data.extensions = {};
    character.data.extensions.world = name;
    const uiSelect = document.getElementById('character_world');
    if (uiSelect) { uiSelect.value = name; uiSelect.dispatchEvent(new Event('change')); }
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
    if (books.length === 0) { if (idx !== -1) world_info.charLore.splice(idx, 1); }
    else if (idx === -1) { world_info.charLore.push({ name: fileName, extraBooks: books }); }
    else { world_info.charLore[idx].extraBooks = books; }
    if (context.saveSettingsDebounced) context.saveSettingsDebounced();
}

async function setCharBindings(type, worldName, isEnabled) {
    const context = getContext();
    if (type === 'primary') {
        await charUpdatePrimaryWorld(isEnabled ? worldName : '');
        return;
    }
    if (type === 'auxiliary') {
        const charId = context.characterId;
        if (!charId && charId !== 0) return;
        const charAvatar = context.characters[charId].avatar;
        const charFileName = getCharaFilename(null, { manualAvatarKey: charAvatar });
        const charLoreEntry = world_info.charLore?.find(e => e.name === charFileName);
        let currentBooks = charLoreEntry ? [...charLoreEntry.extraBooks] : [];
        if (isEnabled) { if (!currentBooks.includes(worldName)) currentBooks.push(worldName); }
        else { currentBooks = currentBooks.filter(name => name !== worldName); }
        charSetAuxWorlds(charFileName, currentBooks);
        return;
    }
    if (type === 'chat') {
        if (isEnabled) context.chatMetadata['world_info'] = worldName;
        else if (context.chatMetadata['world_info'] === worldName) delete context.chatMetadata['world_info'];
        context.saveMetadataDebounced();
        return;
    }
    if (type === 'global') {
        const command = isEnabled ? `/world silent=true "${worldName}"` : `/world state=off silent=true "${worldName}"`;
        await context.executeSlashCommands(command);
        return;
    }
}

const API = {
    async getAllBookNames() { return [...(world_names || [])].sort((a, b) => a.localeCompare(b)); },
    async getCharBindings() {
        const context = getContext();
        const charId = context.characterId;
        if (charId === undefined || charId === null) return { primary: null, additional: [] };
        const character = context.characters[charId];
        if (!character) return { primary: null, additional: [] };
        const primary = character.data?.extensions?.world || null;
        let additional = [];
        const fileName = character.avatar.replace(/\.[^/.]+$/, "");
        const entry = (world_info.charLore || []).find(e => e.name === fileName);
        if (entry && Array.isArray(entry.extraBooks)) additional = [...entry.extraBooks];
        return { primary, additional };
    },
    async getGlobalBindings() { return [...(selected_world_info || [])]; },
    async getChatBinding() { return getContext().chatMetadata?.world_info || null; },
    
    async loadBook(name) {
        const data = await getContext().loadWorldInfo(name);
        if (!data) throw new Error(`Worldbook ${name} not found`);
        const safeEntries = data.entries ? structuredClone(data.entries) : {};
        return Object.values(safeEntries).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    async saveBookEntries(name, entriesArray) {
        if (!name || !Array.isArray(entriesArray)) return;
        const oldData = await getContext().loadWorldInfo(name) || { entries: {} };
        const newEntriesObj = {};
        entriesArray.forEach(entry => {
            const uid = entry.uid;
            const oldEntry = (oldData.entries && oldData.entries[uid]) ? oldData.entries[uid] : {};
            newEntriesObj[uid] = { ...oldEntry, ...entry };
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
    async getAllBoundBookNames() {
        const context = getContext();
        const characters = context.characters || [];
        const boundMap = {};
        characters.forEach(char => {
            if (!char || !char.data) return;
            const primary = char.data.extensions?.world;
            if (primary) {
                if (!boundMap[primary]) boundMap[primary] = [];
                boundMap[primary].push(char.name);
            }
        });
        return boundMap;
    },
    getMetadata() { return getContext().extensionSettings[CONFIG.settingsKey] || {}; },
    async saveMetadata(data) {
        const context = getContext();
        context.extensionSettings[CONFIG.settingsKey] = data;
        context.saveSettingsDebounced();
    },
    async createWorldbook(name) {
        await getContext().saveWorldInfo(name, { entries: {} }, true);
        await getContext().updateWorldInfoList();
    },
    async deleteWorldbook(name) {
        await fetch('/api/worldinfo/delete', {
            method: 'POST',
            headers: getContext().getRequestHeaders(),
            body: JSON.stringify({ name }),
        });
        await getContext().updateWorldInfoList();
    },
    async renameWorldbook(oldName, newName) {
        const data = await getContext().loadWorldInfo(oldName);
        if (data) {
            await getContext().saveWorldInfo(newName, data, true);
            // 简单迁移逻辑
            const { primary } = await this.getCharBindings();
            if (primary === oldName) await setCharBindings('primary', newName, true);
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
    
    // --- 预设 (Feature) ---
    async savePreset(presetName) {
        if (!STATE.currentBookName || !presetName) return;
        const enabledUids = STATE.entries.filter(e => !e.disable).map(e => e.uid);
        
        await Actions.updateMeta(STATE.currentBookName, (meta) => {
            if (!meta.presets) meta.presets = {};
            meta.presets[presetName] = enabledUids;
        });
        toastr.success(`预设 "${presetName}" 已保存`);
    },

    async loadPreset(presetName) {
        if (!STATE.currentBookName) return;
        const meta = STATE.metadata[STATE.currentBookName] || {};
        const presets = meta.presets || {};
        const targetUids = presets[presetName];
        
        if (!targetUids) return toastr.error("预设不存在");

        let changed = false;
        STATE.entries.forEach(entry => {
            const shouldEnable = targetUids.includes(entry.uid);
            const isEnabled = !entry.disable;
            if (shouldEnable !== isEnabled) {
                entry.disable = !shouldEnable;
                changed = true;
            }
        });

        if (changed) {
            UI.renderList();
            UI.renderGlobalStats();
            // 触发防抖保存
            Actions.updateEntry(null, () => {}); 
            toastr.success(`预设 "${presetName}" 已应用`);
        } else {
            toastr.info("状态无变化");
        }
    },
    
    async deletePreset(presetName) {
        if (!STATE.currentBookName) return;
        if (!confirm(`确定删除预设 "${presetName}" 吗？`)) return;
        await Actions.updateMeta(STATE.currentBookName, (meta) => {
             if (meta.presets) delete meta.presets[presetName];
        });
        UI.renderPresetsMenu(); // Refresh menu if open
        toastr.success("预设已删除");
    },

    // --- 批量操作 (Feature) ---
    toggleSelectionMode() {
        STATE.selectionMode = !STATE.selectionMode;
        STATE.selectedUids.clear();
        UI.renderList(); // 重绘列表以显示/隐藏复选框
        UI.renderBatchBar();
    },
    
    toggleEntrySelection(uid) {
        if (STATE.selectedUids.has(uid)) STATE.selectedUids.delete(uid);
        else STATE.selectedUids.add(uid);
        UI.updateBatchBarStatus();
        UI.updateCardSelectionState(uid);
    },

    selectAllEntries() {
        STATE.entries.forEach(e => STATE.selectedUids.add(e.uid));
        UI.refreshSelectionVisuals();
    },

    deselectAllEntries() {
        STATE.selectedUids.clear();
        UI.refreshSelectionVisuals();
    },
    
    invertSelection() {
        STATE.entries.forEach(e => {
            if (STATE.selectedUids.has(e.uid)) STATE.selectedUids.delete(e.uid);
            else STATE.selectedUids.add(e.uid);
        });
        UI.refreshSelectionVisuals();
    },

    async batchAction(action, value) {
        if (STATE.selectedUids.size === 0) return toastr.warning("未选择任何条目");
        
        let needRefresh = false;
        const uids = Array.from(STATE.selectedUids);
        
        if (action === 'delete') {
            if (!confirm(`确定删除选中的 ${uids.length} 个条目吗？`)) return;
            await API.deleteEntries(STATE.currentBookName, uids);
            await this.loadBook(STATE.currentBookName); // Reload
            STATE.selectedUids.clear();
            STATE.selectionMode = false;
            UI.renderBatchBar();
            return;
        }

        uids.forEach(uid => {
            const entry = STATE.entries.find(e => e.uid === uid);
            if (!entry) return;
            
            if (action === 'enable') entry.disable = !value;
            else if (action === 'constant') entry.constant = value;
            else if (action === 'depth') entry.depth = parseInt(value) || 4;
            else if (action === 'order') entry.order = parseInt(value) || 0;
            else if (action === 'position') entry.position = parseInt(value) || 0;
        });

        UI.renderList();
        UI.renderGlobalStats();
        // Trigger save
        Actions.updateEntry(null, () => {});
        toastr.success("批量操作执行完成");
    },

    // --- 缝合模式 (Feature) ---
    async loadDualBook(side, name) {
        STATE.dual[side].name = name;
        if (!name) {
            STATE.dual[side].entries = [];
        } else {
            try {
                STATE.dual[side].entries = await API.loadBook(name);
            } catch(e) { console.error(e); }
        }
        UI.renderDualList(side);
    },

    async transferEntries(sourceSide, targetSide, entryUids, isMove = false) {
        const source = STATE.dual[sourceSide];
        const target = STATE.dual[targetSide];
        if (!source.name || !target.name) return;

        // 1. 获取源条目
        const entriesToTransfer = source.entries.filter(e => entryUids.includes(e.uid));
        if (entriesToTransfer.length === 0) return;

        // 2. 准备新条目 (重新生成 UID 以防冲突)
        // 获取目标最大UID
        let maxUid = target.entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1);
        
        const newEntries = entriesToTransfer.map(e => {
            maxUid++;
            return {
                ...e,
                uid: maxUid // Assign new UID
            };
        });

        // 3. 写入目标
        await API.createEntry(target.name, newEntries);
        
        // 4. 如果是移动，删除源
        if (isMove) {
            await API.deleteEntries(source.name, entryUids);
            await this.loadDualBook(sourceSide, source.name); // Reload source
        }

        // 5. Reload target
        await this.loadDualBook(targetSide, target.name);
        toastr.success(`成功${isMove ? '移动' : '复制'} ${entriesToTransfer.length} 个条目`);
    },

    // --- 初始化 ---
    async init() {
        if (STATE.isInitialized) return;
        UI.initTooltips();
        this.registerCharDeleteListener();
        eventSource.on(event_types.SETTINGS_UPDATED, () => { if (document.getElementById(CONFIG.id)) this.refreshAllContext(); });
        eventSource.on(event_types.WORLDINFO_UPDATED, (name, data) => { if (STATE.currentBookName === name) this.loadBook(name); });
        eventSource.on(event_types.CHAT_CHANGED, () => { if (document.getElementById(CONFIG.id)) this.refreshAllContext(); });
        STATE.isInitialized = true;
        await this.refreshAllContext();
    },

    async refreshAllContext() {
        try {
            const [all, char, glob, chat, boundSet] = await Promise.all([
                API.getAllBookNames(), API.getCharBindings(), API.getGlobalBindings(), API.getChatBinding(), API.getAllBoundBookNames()
            ]);
            STATE.allBookNames = all.sort((a, b) => a.localeCompare(b));
            STATE.bindings = { char, global: glob, chat };
            STATE.boundBooksSet = boundSet;
            STATE.metadata = API.getMetadata();
            UI.renderBookSelector();
        } catch (e) { console.error(e); }
    },

    switchView(viewName) {
        UI.updateGlider(viewName);
        document.querySelectorAll('.wb-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === viewName));
        
        setTimeout(() => {
            STATE.currentView = viewName;
            document.querySelectorAll('.wb-view-section').forEach(el => el.classList.add('wb-hidden'));
            const targetView = document.getElementById(`wb-view-${viewName}`);
            if (targetView) targetView.classList.remove('wb-hidden');

            if (viewName === 'binding') UI.renderBindingView();
            else if (viewName === 'manage') { if (STATE.isManageDirty) { UI.renderManageView(); STATE.isManageDirty = false; } }
            else if (viewName === 'stitch') { UI.initDualView(); }
            else if (viewName === 'editor') {
                UI.renderBookSelector();
                UI.updateHeaderInfo();
            }
        }, 10);
    },

    async loadBook(name) {
        if (!name) return;
        await this.flushPendingSave();
        STATE.currentBookName = name;
        try {
            const loadedEntries = await API.loadBook(name);
            if (STATE.currentBookName !== name) return;
            STATE.entries = loadedEntries;
            STATE.selectedUids.clear(); // Reset selection on book change
            UI.updateHeaderInfo();
            UI.renderList();
            UI.renderBatchBar(); // Hide or update
        } catch (e) {
            if (STATE.currentBookName === name) toastr.error(`无法加载世界书 "${name}"`);
        }
    },

    updateEntry(uid, updater) {
        // uid null means generic update (trigger save)
        if (uid !== null) {
            const entry = STATE.entries.find(e => e.uid === uid);
            if (entry) updater(entry);
        }
        if (STATE.debouncer) clearTimeout(STATE.debouncer);
        const targetBookName = STATE.currentBookName;
        const targetEntries = STATE.entries;
        STATE.debouncer = setTimeout(() => {
            STATE.debouncer = null;
            if (targetBookName && targetEntries) API.saveBookEntries(targetBookName, targetEntries);
        }, 300);
    },

    async addNewEntry() {
        if (!STATE.currentBookName) return toastr.warning("请先选择一本世界书");
        const maxUid = STATE.entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1);
        const newEntry = {
            uid: maxUid + 1, comment: '新建条目', disable: false, content: '', constant: false, key: [], order: 0, position: 1, depth: 4, probability: 100, selective: true
        };
        await API.createEntry(STATE.currentBookName, [newEntry]);
        await this.loadBook(STATE.currentBookName);
    },

    async deleteEntry(uid) {
        if (!confirm("确定要删除此条目吗？")) return;
        await API.deleteEntries(STATE.currentBookName, [uid]);
        await this.loadBook(STATE.currentBookName);
    },
    
    // --- Meta & Manage ---
    async updateMeta(bookName, updater) {
        if (!STATE.metadata[bookName]) STATE.metadata[bookName] = { group: '', note: '' };
        updater(STATE.metadata[bookName]);
        await API.saveMetadata(STATE.metadata);
    },
    
    // 双击跳转逻辑
    async jumpToEditor(bookName) {
        await this.loadBook(bookName);
        this.switchView('editor');
    },

    // --- Token ---
    getTokenCount(text) {
        if (!text) return 0;
        try { return getContext().getTokenCount(text); } catch(e) { return Math.ceil(text.length / 3); }
    }
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
                    <div class="wb-tab" data-tab="stitch"><i class="fa-solid fa-columns"></i> 缝合</div>
                    <div class="wb-tab" data-tab="manage"><i class="fa-solid fa-list-check"></i> 管理</div>
                    <div class="wb-tab" data-tab="binding"><i class="fa-solid fa-link"></i> 绑定</div>
                </div>
                <div id="wb-close" class="wb-header-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>

            <div class="wb-content">
                <!-- 视图 1: 编辑器 -->
                <div id="wb-view-editor" class="wb-view-section">
                    <div class="wb-book-bar">
                        <select id="wb-book-selector" style="flex:1;"><option>加载中...</option></select>
                        <!-- 预设按钮 -->
                        <div style="position:relative">
                            <button class="wb-btn-circle" id="btn-wb-preset" title="预设管理"><i class="fa-solid fa-bookmark"></i></button>
                            <div class="wb-preset-menu" id="wb-preset-menu">
                                <div style="padding:10px; border-bottom:1px solid #eee; font-weight:bold; color:#555">条目状态预设</div>
                                <div id="wb-preset-list"></div>
                                <div style="padding:5px; border-top:1px solid #eee">
                                    <button class="wb-btn-rect" id="btn-save-preset" style="width:100%; font-size:0.8em; padding:6px;">+ 保存当前状态</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <!-- 批量操作栏 -->
                    <div id="wb-batch-bar" class="wb-bulk-bar wb-hidden">
                        <div class="wb-bulk-info" id="wb-batch-count">已选 0 项</div>
                        <div class="wb-bulk-actions">
                            <button class="wb-btn-sm" data-action="all">全选</button>
                            <button class="wb-btn-sm" data-action="invert">反选</button>
                            <div style="width:1px; background:#ccc; margin:0 5px;"></div>
                            <button class="wb-btn-sm" data-action="enable">启用</button>
                            <button class="wb-btn-sm" data-action="disable">禁用</button>
                            <button class="wb-btn-sm" data-action="constant">设为常驻</button>
                            <button class="wb-btn-sm" style="color:#ef4444" data-action="delete">删除</button>
                        </div>
                    </div>

                    <div class="wb-stat-line">
                         <div id="wb-display-count" style="font-size:0.9em; color:#666"></div>
                    </div>

                    <div class="wb-tool-bar">
                        <input class="wb-input-dark" id="wb-search-entry" style="flex:1; border-radius:15px; padding-left:15px;" placeholder="搜索条目...">
                        <button class="wb-btn-circle" id="btn-batch-mode" title="批量选择模式"><i class="fa-solid fa-check-double"></i></button>
                        <button class="wb-btn-circle" id="btn-add-entry" title="新建条目"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    <div class="wb-list" id="wb-entry-list"></div>
                </div>

                <!-- 视图 2: 缝合/双面板 (Feature) -->
                <div id="wb-view-stitch" class="wb-view-section wb-hidden">
                    <div class="wb-dual-container">
                        <!-- Left Panel -->
                        <div class="wb-dual-col" id="wb-dual-left">
                            <div class="wb-dual-header">
                                <select class="wb-select dual-book-select" data-side="left"></select>
                                <div class="wb-dual-toolbar">
                                    <button class="wb-btn-sm btn-select-all" data-side="left">全选</button>
                                    <button class="wb-btn-sm btn-transfer" data-from="left" data-to="right" title="复制到右侧">复制 &rarr;</button>
                                    <button class="wb-btn-sm btn-transfer-move" data-from="left" data-to="right" title="移动到右侧">移动 &rarr;</button>
                                </div>
                            </div>
                            <div class="wb-dual-list" data-side="left"></div>
                        </div>
                        <!-- Right Panel -->
                        <div class="wb-dual-col" id="wb-dual-right">
                             <div class="wb-dual-header">
                                <select class="wb-select dual-book-select" data-side="right"></select>
                                <div class="wb-dual-toolbar">
                                    <button class="wb-btn-sm btn-transfer-move" data-from="right" data-to="left" title="移动到左侧">&larr; 移动</button>
                                    <button class="wb-btn-sm btn-transfer" data-from="right" data-to="left" title="复制到左侧">&larr; 复制</button>
                                    <button class="wb-btn-sm btn-select-all" data-side="right">全选</button>
                                </div>
                            </div>
                            <div class="wb-dual-list" data-side="right"></div>
                        </div>
                    </div>
                </div>

                <!-- 视图 3: 管理 -->
                <div id="wb-view-manage" class="wb-view-section wb-hidden">
                     <div class="wb-tool-bar">
                        <input class="wb-input-dark" id="wb-manage-search" style="width:100%;border-radius:15px;padding-left:15px" placeholder="搜索世界书...">
                    </div>
                    <div class="wb-manage-content" id="wb-manage-content" style="flex:1; overflow-y:auto"></div>
                </div>
                
                <!-- 视图 4: 绑定 (Placeholder for existing logic) -->
                <div id="wb-view-binding" class="wb-view-section wb-hidden">
                    <div id="wb-binding-placeholder" style="padding:20px; text-align:center">绑定界面 (逻辑同原版)</div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        const $ = (sel) => panel.querySelector(sel);
        const $$ = (sel) => panel.querySelectorAll(sel);

        // Core Events
        $('#wb-close').onclick = () => panel.remove();
        $$('.wb-tab').forEach(el => el.onclick = () => Actions.switchView(el.dataset.tab));
        
        // Editor Events
        $('#wb-book-selector').onchange = (e) => Actions.loadBook(e.target.value);
        $('#wb-search-entry').oninput = (e) => UI.renderList(e.target.value);
        $('#btn-add-entry').onclick = () => Actions.addNewEntry();
        $('#btn-batch-mode').onclick = () => Actions.toggleSelectionMode();

        // Preset Menu
        $('#btn-wb-preset').onclick = (e) => {
            e.stopPropagation();
            $('#wb-preset-menu').classList.toggle('show');
            UI.renderPresetsMenu();
        };
        document.addEventListener('click', (e) => {
            if (!$('#wb-preset-menu').contains(e.target) && e.target !== $('#btn-wb-preset')) {
                $('#wb-preset-menu').classList.remove('show');
            }
        });
        $('#btn-save-preset').onclick = () => {
            const name = prompt("请输入预设名称:");
            if (name) Actions.savePreset(name);
        };

        // Batch Actions
        $$('#wb-batch-bar button').forEach(btn => {
            btn.onclick = () => {
                const action = btn.dataset.action;
                if (action === 'all') Actions.selectAllEntries();
                else if (action === 'invert') Actions.invertSelection();
                else if (action === 'enable') Actions.batchAction('enable', true);
                else if (action === 'disable') Actions.batchAction('enable', false);
                else if (action === 'constant') Actions.batchAction('constant', true);
                else if (action === 'delete') Actions.batchAction('delete');
            };
        });

        // Manage View Search
        $('#wb-manage-search').oninput = (e) => UI.renderManageView(e.target.value);

        // Stitch/Dual View Events
        $$('.dual-book-select').forEach(sel => {
            sel.onchange = (e) => Actions.loadDualBook(sel.dataset.side, e.target.value);
        });
        $$('.btn-transfer').forEach(btn => {
            btn.onclick = () => UI.handleDualTransfer(btn.dataset.from, btn.dataset.to, false);
        });
        $$('.btn-transfer-move').forEach(btn => {
            btn.onclick = () => UI.handleDualTransfer(btn.dataset.from, btn.dataset.to, true);
        });
        $$('.btn-select-all').forEach(btn => {
            btn.onclick = () => UI.toggleDualSelectAll(btn.dataset.side);
        });

        // Init Data
        await Actions.refreshAllContext();
        UI.renderBookSelector();
        
        // Auto-load logic
        if (STATE.allBookNames.length > 0 && !STATE.currentBookName) {
            const charBook = STATE.bindings.char.primary;
            if (charBook && STATE.allBookNames.includes(charBook)) await Actions.loadBook(charBook);
            else await Actions.loadBook(STATE.allBookNames[0]);
        } else if (STATE.currentBookName) {
             UI.renderList();
        }

        UI.updateGlider('editor');
        setTimeout(() => $('.wb-tab-glider').classList.add('wb-glider-animating'), 50);
        Actions.switchView('editor');
    },

    renderBookSelector() {
        const selector = document.getElementById('wb-book-selector');
        if (!selector) return;
        selector.innerHTML = STATE.allBookNames.map(n => `<option value="${n}">${n}</option>`).join('');
        if (STATE.currentBookName) selector.value = STATE.currentBookName;
    },

    // --- 预设菜单渲染 ---
    renderPresetsMenu() {
        const list = document.getElementById('wb-preset-list');
        if (!list || !STATE.currentBookName) return;
        const meta = STATE.metadata[STATE.currentBookName] || {};
        const presets = meta.presets || {};
        
        if (Object.keys(presets).length === 0) {
            list.innerHTML = `<div style="padding:10px; color:#999; text-align:center">无预设</div>`;
            return;
        }

        list.innerHTML = Object.keys(presets).map(name => `
            <div class="wb-preset-item" onclick="Actions.loadPreset('${name}')">
                <span>${name}</span>
                <span class="wb-preset-actions">
                    <i class="fa-solid fa-trash" style="color:#ef4444" onclick="event.stopPropagation(); Actions.deletePreset('${name}')"></i>
                </span>
            </div>
        `).join('');
    },

    // --- 批量操作栏 ---
    renderBatchBar() {
        const bar = document.getElementById('wb-batch-bar');
        const btn = document.getElementById('btn-batch-mode');
        if (STATE.selectionMode) {
            bar.classList.remove('wb-hidden');
            btn.classList.add('active');
            UI.updateBatchBarStatus();
        } else {
            bar.classList.add('wb-hidden');
            btn.classList.remove('active');
        }
    },
    updateBatchBarStatus() {
        document.getElementById('wb-batch-count').textContent = `已选 ${STATE.selectedUids.size} 项`;
    },
    updateCardSelectionState(uid) {
        const card = document.querySelector(`.wb-card[data-uid="${uid}"]`);
        if (card) {
            if (STATE.selectedUids.has(uid)) card.classList.add('selected');
            else card.classList.remove('selected');
        }
    },
    refreshSelectionVisuals() {
        document.querySelectorAll('.wb-card').forEach(card => {
            const uid = parseInt(card.dataset.uid);
            if (STATE.selectedUids.has(uid)) card.classList.add('selected');
            else card.classList.remove('selected');
        });
        UI.updateBatchBarStatus();
    },

    // --- 编辑器列表渲染 ---
    renderList(filterText = '') {
        const list = document.getElementById('wb-entry-list');
        if (!list) return;
        list.innerHTML = '';
        const term = filterText.toLowerCase();
        
        STATE.entries.forEach((entry, index) => {
            const name = entry.comment || '';
            if (term && !name.toLowerCase().includes(term)) return;
            const card = this.createCard(entry, index);
            list.appendChild(card);
        });
        UI.renderGlobalStats();
    },

    createCard(entry, index) {
        const isEnabled = !entry.disable;
        const card = document.createElement('div');
        card.className = `wb-card ${isEnabled ? '' : 'disabled'} ${entry.constant ? 'type-blue' : 'type-green'}`;
        card.dataset.uid = entry.uid;

        let selectionHtml = '';
        if (STATE.selectionMode) {
            const isSelected = STATE.selectedUids.has(entry.uid);
            if (isSelected) card.classList.add('selected');
            selectionHtml = `
                <div class="wb-card-checkbox" onclick="Actions.toggleEntrySelection(${entry.uid})">
                    <div class="wb-checkbox-custom"></div>
                </div>`;
        }

        const innerHtml = `
            ${selectionHtml}
            <div style="flex:1; padding:10px;">
                <div class="wb-row">
                    <input class="wb-inp-title inp-name" value="${entry.comment || ''}" placeholder="名称">
                    <div style="margin-left:auto; display:flex; gap:10px; align-items:center;">
                        <span class="wb-token-display" style="font-size:0.8em; background:#eee; padding:2px 6px; border-radius:4px;">${Actions.getTokenCount(entry.content)} T</span>
                        <i class="fa-solid fa-trash btn-delete" style="cursor:pointer; color:#aaa"></i>
                    </div>
                </div>
                <div class="wb-row" style="margin-top:8px;">
                     <div class="wb-ctrl-group"><label class="wb-switch"><input type="checkbox" class="inp-enable" ${isEnabled ? 'checked' : ''}><span class="wb-slider purple"></span></label></div>
                     <div class="wb-ctrl-group"><label class="wb-switch"><input type="checkbox" class="inp-constant" ${entry.constant ? 'checked' : ''}><span class="wb-slider blue"></span></label></div>
                     <input type="number" class="wb-inp-num inp-order" value="${entry.order ?? 0}" title="顺序" style="width:50px">
                </div>
            </div>
        `;
        
        // 包装一层 Flex 容器以支持复选框横向排列
        card.innerHTML = `<div class="wb-card-row">${innerHtml}</div>`;

        // Bindings
        const q = (s) => card.querySelector(s);
        q('.inp-name').onchange = (e) => Actions.updateEntry(entry.uid, d => d.comment = e.target.value);
        q('.inp-enable').onchange = (e) => {
             Actions.updateEntry(entry.uid, d => d.disable = !e.target.checked);
             card.classList.toggle('disabled', !e.target.checked);
        };
        q('.inp-constant').onchange = (e) => Actions.updateEntry(entry.uid, d => d.constant = e.target.checked);
        q('.inp-order').onchange = (e) => Actions.updateEntry(entry.uid, d => d.order = parseInt(e.target.value));
        q('.btn-delete').onclick = () => Actions.deleteEntry(entry.uid);

        return card;
    },

    // --- 管理视图 ---
    renderManageView(filterText = '') {
        const container = document.getElementById('wb-manage-content');
        if (!container) return;
        container.innerHTML = '';
        const term = (filterText || '').toLowerCase();
        
        // 简单列表渲染
        STATE.allBookNames.forEach(name => {
            if (term && !name.toLowerCase().includes(term)) return;
            const card = document.createElement('div');
            card.className = 'wb-manage-card';
            card.style.cursor = 'pointer';
            card.innerHTML = `
                <div class="wb-card-top">
                    <div class="wb-card-title">${name}</div>
                    <div style="font-size:0.8em; color:#999">双击编辑</div>
                </div>
            `;
            // 双击进入编辑器 (Requested Feature)
            card.ondblclick = () => Actions.jumpToEditor(name);
            // 单击选中效果 (可选)
            card.onclick = () => {
                document.querySelectorAll('.wb-manage-card').forEach(c => c.style.borderColor = '#e5e7eb');
                card.style.borderColor = '#7c5cbd';
            };
            container.appendChild(card);
        });
    },

    // --- 缝合模式 (Stitch View) ---
    initDualView() {
        // 初始化下拉框
        const opts = `<option value="">-- 选择世界书 --</option>` + STATE.allBookNames.map(n => `<option value="${n}">${n}</option>`).join('');
        document.querySelectorAll('.dual-book-select').forEach(sel => sel.innerHTML = opts);
        
        // 恢复之前的状态
        if(STATE.dual.left.name) document.querySelector('.dual-book-select[data-side="left"]').value = STATE.dual.left.name;
        if(STATE.dual.right.name) document.querySelector('.dual-book-select[data-side="right"]').value = STATE.dual.right.name;

        UI.renderDualList('left');
        UI.renderDualList('right');
    },

    renderDualList(side) {
        const container = document.querySelector(`.wb-dual-list[data-side="${side}"]`);
        if (!container) return;
        const data = STATE.dual[side];
        container.innerHTML = '';

        if (!data.name) {
            container.innerHTML = '<div class="wb-dual-placeholder">请选择世界书</div>';
            return;
        }

        data.entries.forEach(entry => {
            const el = document.createElement('div');
            el.className = 'wb-card';
            el.dataset.uid = entry.uid;
            // 简化版卡片，仅用于拖拽和选择
            el.innerHTML = `
                <div style="display:flex; padding:8px; align-items:center; gap:8px;">
                    <input type="checkbox" class="dual-check">
                    <div style="flex:1; font-size:0.9em; font-weight:bold; overflow:hidden; text-overflow:ellipsis;">${entry.comment || '未命名'}</div>
                    <div style="font-size:0.8em; color:#888">#${entry.uid}</div>
                </div>
            `;
            
            // Drag Start
            el.draggable = true;
            el.ondragstart = (e) => {
                e.dataTransfer.setData('text/plain', JSON.stringify({
                    side: side,
                    uids: [entry.uid] // Drag single item
                }));
                el.classList.add('dragging');
            };
            el.ondragend = () => el.classList.remove('dragging');

            container.appendChild(el);
        });

        // Drop Zone Logic
        container.ondragover = (e) => { e.preventDefault(); container.classList.add('drag-over'); };
        container.ondragleave = () => container.classList.remove('drag-over');
        container.ondrop = (e) => {
            e.preventDefault();
            container.classList.remove('drag-over');
            try {
                const raw = e.dataTransfer.getData('text/plain');
                if (!raw) return;
                const payload = JSON.parse(raw);
                if (payload.side === side) return; // Same side drop ignored for now
                // Transfer single dragged item
                Actions.transferEntries(payload.side, side, payload.uids, false); // Default copy on drag
            } catch(err) { console.error(err); }
        };
    },

    toggleDualSelectAll(side) {
        const container = document.querySelector(`.wb-dual-list[data-side="${side}"]`);
        const checkboxes = container.querySelectorAll('.dual-check');
        const allChecked = Array.from(checkboxes).every(c => c.checked);
        checkboxes.forEach(c => c.checked = !allChecked);
    },

    handleDualTransfer(fromSide, toSide, isMove) {
        const container = document.querySelector(`.wb-dual-list[data-side="${fromSide}"]`);
        const checked = Array.from(container.querySelectorAll('.dual-check:checked')).map(c => {
            return parseInt(c.closest('.wb-card').dataset.uid);
        });
        
        if (checked.length === 0) return toastr.warning("请先勾选需要转移的条目");
        Actions.transferEntries(fromSide, toSide, checked, isMove);
    },

    // --- Misc ---
    updateHeaderInfo() { }, // Placeholder
    renderGlobalStats() {
        const count = STATE.entries.length;
        const div = document.getElementById('wb-display-count');
        if(div) div.textContent = `${count} 条目`;
    },
    initTooltips() { /* Tooltip init logic */ }
};

// --- Initialization ---
jQuery(async () => {
    const injectButton = () => {
        if (document.getElementById(CONFIG.btnId)) return;
        const container = document.querySelector('#options .options-content');
        if (container) {
            const html = `<a id="${CONFIG.btnId}" class="interactable" title="世界书加强版" tabindex="0"><i class="fa-lg fa-solid fa-book-journal-whills"></i><span>世界书PRO</span></a>`;
            $(container).append(html);
            $(`#${CONFIG.btnId}`).on('click', (e) => { e.preventDefault(); $('#options').hide(); UI.open(); });
        }
    };
    injectButton();
    if (typeof world_names === 'undefined') eventSource.on(event_types.APP_READY, () => Actions.init());
    else Actions.init();
});
