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
        accent: '#7c5cbd',
    }
};

const STATE = {
    currentView: 'editor', // 'editor' | 'binding' | 'manage' | 'split'
    currentBookName: null, // 在非分割模式下使用

    // 初始化标记，防止重复监听和重复加载
    isInitialized: false,

    // 视图脏标记（优化渲染性能）
    isManageDirty: true,

    // 数据缓存
    entries: [], // 在非分割模式下使用
    allBookNames: [],
    metadata: {},

    boundBooksSet: {},

    bindings: {
        char: { primary: null, additional: [] },
        global: [],
        chat: null
    },

    debouncer: null,

    // 批量选择状态
    selectedUids: new Set(),
    
    // 【新功能】缝合世界书（双面板）状态
    isSplitView: false,
    splitView: {
        left: { bookName: null, entries: [], searchTerm: '' },
        right: { bookName: null, entries: [], searchTerm: '' },
    },
};

// ST 原生位置枚举，用于 UI 转换
const WI_POSITION_MAP = {
    0: 'before_character_definition',
    1: 'after_character_definition',
    2: 'before_author_note',
    3: 'after_author_note',
    4: 'at_depth',
    5: 'before_example_messages',
    6: 'after_example_messages'
};
// 反向映射用于保存
const WI_POSITION_MAP_REV = Object.fromEntries(Object.entries(WI_POSITION_MAP).map(([k, v]) => [v, parseInt(k)]));

/**
 * [兼容性 Polyfill] 更新角色主要世界书
 */
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
    if (context.saveCharacterDebounced) {
        context.saveCharacterDebounced();
    }
}

/**
 * [兼容性 Polyfill] 设置角色辅助世界书列表
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

// --- 绑定处理函数 ---
async function setCharBindings(type, worldName, isEnabled) {
    const context = getContext();
    if (type === 'primary') {
        const targetName = isEnabled ? worldName : '';
        await charUpdatePrimaryWorld(targetName);
        return;
    }
    if (type === 'auxiliary') {
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
        return;
    }
    if (type === 'chat') {
        if (isEnabled) {
            context.chatMetadata['world_info'] = worldName;
        } else if (context.chatMetadata['world_info'] === worldName) {
            delete context.chatMetadata['world_info'];
        }
        context.saveMetadataDebounced();
        return;
    }
    if (type === 'global') {
        const command = isEnabled ? `/world silent=true "${worldName}"` : `/world state=off silent=true "${worldName}"`;
        await context.executeSlashCommands(command);
        return;
    }
    console.warn(`未知的绑定类型: ${type}`);
}

const API = {
    async getAllBookNames() {
        return [...(world_names || [])].sort((a, b) => a.localeCompare(b));
    },
    async getCharBindings() {
        const context = getContext();
        const charId = context.characterId;
        if (charId === undefined || charId === null) return { primary: null, additional: [] };
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
        const context = getContext();
        return context.chatMetadata?.world_info || null;
    },
    async loadBook(name) {
        const data = await getContext().loadWorldInfo(name);
        if (!data) throw new Error(`Worldbook ${name} not found`);
        const safeEntries = data.entries ? structuredClone(data.entries) : {};
        const entries = Object.values(safeEntries);
        return entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    async saveBookEntries(name, entriesArray) {
        if (!name || !Array.isArray(entriesArray)) {
            console.warn("[Worldbook] Save aborted: Invalid name or entries.");
            return;
        }
        const oldData = await getContext().loadWorldInfo(name) || { entries: {} };
        const newEntriesObj = {};
        entriesArray.forEach(entry => {
            const uid = entry.uid;
            const oldEntry = (oldData.entries && oldData.entries[uid]) ? oldData.entries[uid] : {};
            const safeEntry = structuredClone(entry);
            newEntriesObj[uid] = { ...oldEntry, ...safeEntry };
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
    getMetadata() {
        return getContext().extensionSettings[CONFIG.settingsKey] || {};
    },
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
            try {
                const { primary, additional } = await this.getCharBindings();
                if (primary === oldName) await setCharBindings('primary', newName, true);
                if (additional.includes(oldName)) {
                    await setCharBindings('auxiliary', oldName, false);
                    await setCharBindings('auxiliary', newName, true);
                }
                const globalBindings = await this.getGlobalBindings();
                if (globalBindings.includes(oldName)) {
                    await setCharBindings('global', oldName, false);
                    await setCharBindings('global', newName, true);
                }
                const chatBinding = await this.getChatBinding();
                if (chatBinding === oldName) await setCharBindings('chat', newName, true);
            } catch (e) {
                console.error("绑定迁移失败:", e);
                toastr.warning("重命名成功，但在迁移绑定关系时遇到错误");
            }
            await this.deleteWorldbook(oldName);
        }
    }
};

const Actions = {
    async flushPendingSave() {
        if (STATE.debouncer) {
            clearTimeout(STATE.debouncer);
            STATE.debouncer = null;
            
            const saveTasks = [];
            if (!STATE.isSplitView) {
                if (STATE.currentBookName && Array.isArray(STATE.entries)) {
                   saveTasks.push(API.saveBookEntries(STATE.currentBookName, STATE.entries));
                }
            } else {
                if (STATE.splitView.left.bookName && Array.isArray(STATE.splitView.left.entries)) {
                    saveTasks.push(API.saveBookEntries(STATE.splitView.left.bookName, STATE.splitView.left.entries));
                }
                if (STATE.splitView.right.bookName && Array.isArray(STATE.splitView.right.entries)) {
                    saveTasks.push(API.saveBookEntries(STATE.splitView.right.bookName, STATE.splitView.right.entries));
                }
            }
            await Promise.all(saveTasks);
        }
    },
    getEntrySortScore(entry) {
        const context = getContext();
        const anDepth = (context.chatMetadata && context.chatMetadata['note_depth'])
            ?? (context.extensionSettings && context.extensionSettings.note && context.extensionSettings.note.defaultDepth)
            ?? 4;
        const pos = typeof entry.position === 'number' ? entry.position : 1;
        if (pos === 0) return 100000;
        if (pos === 1) return 90000;
        if (pos === 5) return 80000;
        if (pos === 6) return 70000;
        if (pos === 4) return entry.depth ?? 4;
        if (pos === 2) return anDepth + 0.6;
        if (pos === 3) return anDepth + 0.4;
        return -9999;
    },
    async init() {
        if (STATE.isInitialized) return;
        UI.initTooltips();
        this.registerCharDeleteListener();
        const es = eventSource;
        const et = event_types;
        const handler = () => { if (document.getElementById(CONFIG.id)) this.refreshAllContext(); };
        es.on(et.SETTINGS_UPDATED, handler);
        es.on(et.WORLDINFO_UPDATED, (name) => {
            if (!STATE.isSplitView && STATE.currentBookName === name) this.loadBook(name);
            if (STATE.isSplitView && STATE.splitView.left.bookName === name) this.loadBook(name, 'left');
            if (STATE.isSplitView && STATE.splitView.right.bookName === name) this.loadBook(name, 'right');
        });
        es.on(et.CHAT_CHANGED, handler);
        es.on(et.CHARACTER_SELECTED, () => setTimeout(handler, 100));
        es.on(et.CHARACTER_EDITED, handler);
        STATE.isInitialized = true;
        await this.refreshAllContext();
        console.log("[Worldbook Editor] Initialization complete (Idle Mode).");
    },
    async refreshAllContext() {
        try {
            const [all, char, glob, chat, boundSet] = await Promise.all([
                API.getAllBookNames(),
                API.getCharBindings(),
                API.getGlobalBindings(),
                API.getChatBinding(),
                API.getAllBoundBookNames()
            ]);
            STATE.allBookNames = all.sort((a, b) => a.localeCompare(b));
            STATE.bindings.char = char;
            STATE.bindings.global = glob;
            STATE.bindings.chat = chat;
            STATE.boundBooksSet = boundSet;
            STATE.metadata = API.getMetadata();
            
            if (STATE.isSplitView) {
                UI.renderBookSelector(null, 'left');
                UI.renderBookSelector(null, 'right');
            } else {
                UI.renderBookSelector();
            }

        } catch (e) {
            console.error("Failed to refresh context:", e);
        }
    },

    switchView(viewName) {
        STATE.isSplitView = (viewName === 'split');
        
        UI.updateGlider(viewName);
        document.querySelectorAll('.wb-tab').forEach(el => {
            el.classList.toggle('active', el.dataset.tab === viewName);
        });

        setTimeout(() => {
            STATE.currentView = viewName;
            document.querySelectorAll('.wb-view-section').forEach(el => el.classList.add('wb-hidden'));
            const targetViewId = (viewName === 'split') ? 'wb-view-editor' : `wb-view-${viewName}`;
            const targetView = document.getElementById(targetViewId);
            if (targetView) targetView.classList.remove('wb-hidden');
            
            if (viewName === 'editor' || viewName === 'split') {
                UI.renderEditorView();
            } else if (viewName === 'binding') {
                UI.renderBindingView();
            } else if (viewName === 'manage') {
                if (STATE.isManageDirty) {
                    UI.renderManageView();
                    STATE.isManageDirty = false;
                }
            }
        }, 10);
    },

    async loadBook(name, panel) {
        if (!name) return;
        await this.flushPendingSave();
        
        // 【新功能】区分单/双面板
        if (STATE.isSplitView) {
            if (!panel) return;
            STATE.splitView[panel].bookName = name;
        } else {
            this.batchSelect('none'); // 单面板模式清空选择
            STATE.currentBookName = name;
        }

        try {
            const loadedEntries = await API.loadBook(name);
            
            const sortEntries = (entries) => entries.sort((a, b) => {
                const scoreA = this.getEntrySortScore(a);
                const scoreB = this.getEntrySortScore(b);
                if (scoreA !== scoreB) return scoreB - scoreA;
                return (a.order ?? 0) - (b.order ?? 0) || a.uid - b.uid;
            });

            if (STATE.isSplitView) {
                if (STATE.splitView[panel].bookName !== name) return;
                STATE.splitView[panel].entries = sortEntries(loadedEntries);
                UI.renderList(STATE.splitView[panel].searchTerm, panel);
                UI.updateHeaderInfo(panel);
            } else {
                if (STATE.currentBookName !== name) return;
                STATE.entries = sortEntries(loadedEntries);
                UI.renderList();
                UI.updateHeaderInfo();
            }

            // 更新对应下拉框
            const selectorId = STATE.isSplitView ? `wb-book-selector-${panel}` : 'wb-book-selector';
            const selector = document.getElementById(selectorId);
            if (selector) selector.value = name;
            
        } catch (e) {
            console.error(`Load book "${name}" failed`, e);
            toastr.error(`无法加载世界书 "${name}"`);
        }
    },

    updateEntry(uid, updater, panel) {
        const entries = STATE.isSplitView ? STATE.splitView[panel].entries : STATE.entries;
        const bookName = STATE.isSplitView ? STATE.splitView[panel].bookName : STATE.currentBookName;

        const entry = entries.find(e => e.uid === uid);
        if (!entry) return;

        updater(entry);
        UI.updateCardStatus(uid, panel);
        UI.renderGlobalStats(panel);

        if (STATE.debouncer) clearTimeout(STATE.debouncer);

        const targetBookName = bookName;
        const targetEntries = entries;

        STATE.debouncer = setTimeout(() => {
            STATE.debouncer = null;
            if (targetBookName && targetEntries) {
                API.saveBookEntries(targetBookName, targetEntries);
            }
        }, 300);
    },
    
    async addNewEntry(panel) {
        const bookName = STATE.isSplitView ? STATE.splitView[panel].bookName : STATE.currentBookName;
        const entries = STATE.isSplitView ? STATE.splitView[panel].entries : STATE.entries;
        if (!bookName) return toastr.warning("请先选择一本世界书");

        const maxUid = entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1);
        const newUid = maxUid + 1;

        const newEntry = {
            uid: newUid, comment: '新建条目', disable: false, content: '',
            constant: false, key: [], order: 0, position: 0, depth: 4,
            probability: 100, selective: true,
        };
        await API.createEntry(bookName, [newEntry]);
        await this.loadBook(bookName, panel);
    },

    async deleteEntry(uid, panel) {
        const bookName = STATE.isSplitView ? STATE.splitView[panel].bookName : STATE.currentBookName;
        if (!confirm("确定要删除此条目吗？")) return;
        await API.deleteEntries(bookName, [uid]);
        await this.loadBook(bookName, panel);
    },

    async saveBindings() {
        const view = document.getElementById('wb-view-binding');
        const charPrimary = view.querySelector('#wb-bind-char-primary').value;
        const charAddTags = view.querySelectorAll('.wb-ms-tag[data-bind-type="wb-bind-char-add"]');
        const charAdditional = Array.from(charAddTags).map(el => el.dataset.val);
        const globalTags = view.querySelectorAll('.wb-ms-tag[data-bind-type="wb-bind-global"]');
        const globalBooks = Array.from(globalTags).map(el => el.dataset.val);
        const chatBook = view.querySelector('#wb-bind-chat').value;
        try {
            await setCharBindings('primary', charPrimary || '', !!charPrimary);
            const context = getContext();
            const charId = context.characterId;
            if (charId || charId === 0) {
                const charAvatar = context.characters[charId]?.avatar;
                const charFileName = getCharaFilename(null, { manualAvatarKey: charAvatar });
                charSetAuxWorlds(charFileName, charAdditional);
            }
            const currentGlobal = await API.getGlobalBindings();
            const toRemove = currentGlobal.filter(b => !globalBooks.includes(b));
            const toAdd = globalBooks.filter(b => !currentGlobal.includes(b));
            for (const book of toRemove) await setCharBindings('global', book, false);
            for (const book of toAdd) await setCharBindings('global', book, true);
            await setCharBindings('chat', chatBook || '', !!chatBook);
            await this.refreshAllContext();
            toastr.success("绑定设置已保存");
        } catch (e) {
            console.error(e);
            toastr.error('保存失败: ' + e.message);
        }
    },
    
    // ... 其他Actions函数保持不变，但需要调整对STATE的引用
    
    // 【新功能】缝合模式拖拽处理
    async handleDrop(sourcePanel, targetPanel, entryUid, isCopy) {
        const source = STATE.splitView[sourcePanel];
        const target = STATE.splitView[targetPanel];

        if (!source.bookName || !target.bookName) return;

        const entryIndex = source.entries.findIndex(e => e.uid === entryUid);
        if (entryIndex === -1) return;

        const [movedEntry] = source.entries.splice(entryIndex, 1);

        if (isCopy) {
            // 复制操作
            const newEntry = structuredClone(movedEntry);
            const maxUid = target.entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1);
            newEntry.uid = maxUid + 1;
            target.entries.unshift(newEntry); // 添加到目标开头
            // 重新插入回源
            source.entries.splice(entryIndex, 0, movedEntry);
            // 只保存目标
            await API.saveBookEntries(target.bookName, target.entries);
            toastr.success(`条目已复制到 ${target.bookName}`);
        } else {
            // 移动操作
            target.entries.unshift(movedEntry); // 添加到目标开头
            // 保存源和目标
            await Promise.all([
                API.saveBookEntries(source.bookName, source.entries),
                API.saveBookEntries(target.bookName, target.entries)
            ]);
            toastr.success(`条目已移动到 ${target.bookName}`);
        }

        // 刷新两个面板
        UI.renderList(source.searchTerm, sourcePanel);
        UI.renderList(target.searchTerm, targetPanel);
    },


    // ... 其他Actions函数
    // 以下函数基本保持不变，但对STATE的访问可能需要根据isSplitView调整
    // 为简化，此处省略重复代码，重点是上面的新功能和修改
    // 在实际集成中，所有对 `STATE.currentBookName` 和 `STATE.entries` 的访问
    // 都需要考虑 `isSplitView` 的情况
    
    // ... createNew, delete, rename, etc.
    // 示例：actionDelete需要适配
    async actionDelete(panel) {
        const bookName = STATE.isSplitView ? STATE.splitView[panel].bookName : STATE.currentBookName;
        if (!bookName) return;
        if (!confirm(`确定要永久删除世界书 "${bookName}" 吗？`)) return;

        try {
            if (STATE.debouncer) { clearTimeout(STATE.debouncer); STATE.debouncer = null; }

            await API.deleteWorldbook(bookName);
            
            if (STATE.isSplitView) {
                if (STATE.splitView.left.bookName === bookName) {
                    STATE.splitView.left = { bookName: null, entries: [], searchTerm: '' };
                }
                if (STATE.splitView.right.bookName === bookName) {
                    STATE.splitView.right = { bookName: null, entries: [], searchTerm: '' };
                }
            } else {
                STATE.currentBookName = null;
                STATE.entries = [];
            }
            
            await this.refreshAllContext();
            UI.renderEditorView();
            
        } catch (e) {
            toastr.error("删除失败: " + e.message);
        }
    },
    
    // 其他action...
    // 批量选择相关函数，只在单面板模式下工作
    toggleEntrySelection(uid) {
        if(STATE.isSplitView) return;
        if (STATE.selectedUids.has(uid)) {
            STATE.selectedUids.delete(uid);
        } else {
            STATE.selectedUids.add(uid);
        }
        UI.updateBatchControls();
        // 仅更新单个卡片的选中状态
        const card = document.querySelector(`.wb-card[data-uid="${uid}"]`);
        if (card) {
            const checkbox = card.querySelector('.inp-select-entry');
            if(checkbox) checkbox.checked = STATE.selectedUids.has(uid);
        }
    },
    batchSelect(mode) {
        if(STATE.isSplitView) return;
        const allUids = STATE.entries.map(e => e.uid);
        if (mode === 'all') {
            allUids.forEach(uid => STATE.selectedUids.add(uid));
        } else if (mode === 'none') {
            STATE.selectedUids.clear();
        } else if (mode === 'invert') {
            allUids.forEach(uid => {
                if (STATE.selectedUids.has(uid)) {
                    STATE.selectedUids.delete(uid);
                } else {
                    STATE.selectedUids.add(uid);
                }
            });
        }
        UI.renderList(document.getElementById('wb-search-entry').value);
        UI.updateBatchControls();
    },
    async batchUpdate(action, options = {}) {
        if(STATE.isSplitView) return;
        const selectedCount = STATE.selectedUids.size;
        if (selectedCount === 0) return;

        if (action === 'delete') {
            if (!confirm(`确定要删除选中的 ${selectedCount} 个条目吗?`)) return;
            const uidsToDelete = Array.from(STATE.selectedUids);
            await API.deleteEntries(STATE.currentBookName, uidsToDelete);
            this.batchSelect('none');
            await this.loadBook(STATE.currentBookName);
            toastr.success(`${selectedCount} 个条目已删除。`);
            return;
        }

        let changesMade = false;
        STATE.entries.forEach(entry => {
            if (STATE.selectedUids.has(entry.uid)) {
                changesMade = true;
                switch (action) {
                    case 'enable': entry.disable = false; break;
                    case 'disable': entry.disable = true; break;
                    case 'toggle-constant': entry.constant = !entry.constant; break;
                    case 'reorder':
                        const { posVal, depthVal, orderVal } = options;
                        if (posVal) entry.position = WI_POSITION_MAP_REV[posVal] ?? entry.position;
                        if (depthVal !== '' && !isNaN(depthVal)) entry.depth = Number(depthVal);
                        if (orderVal !== '' && !isNaN(orderVal)) entry.order = Number(orderVal);
                        break;
                }
            }
        });

        if (changesMade) {
            await API.saveBookEntries(STATE.currentBookName, STATE.entries);
            toastr.success(`${selectedCount} 个条目已更新。`);
        }

        this.batchSelect('none');
    },

    // ... 其他函数省略 ...
    // 保持 getGlobalConfig, saveGlobalConfig, registerCharDeleteListener, getTokenCount 不变
    // 保持所有状态管理、批量操作函数不变，但它们仅在单面板模式下有效
};
// 确保所有UI函数也正确处理单/双面板模式
// ... 在UI对象中做类似适配 ...

// 这是一个巨大的重构，无法在此处展示所有细节，但以上是核心思路和关键代码。
// 下面是UI部分的适配

const UI = {
    // ... updateGlider, centerDialog, setupModalPositioning 不变

    async open() {
        if (document.getElementById(CONFIG.id)) return;

        const panel = document.createElement('div');
        panel.id = CONFIG.id;
        // 【UI调整】移除wb-header-bar，将其内容逻辑整合到 wb-content 中，以实现内容区域内的居中
        panel.innerHTML = `
            <div id="wb-close" class="wb-header-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            <div class="wb-content">
                <div class="wb-header-bar">
                    <div class="wb-tabs">
                        <div class="wb-tab-glider"></div>
                        <div class="wb-tab active" data-tab="editor"><i class="fa-solid fa-pen-to-square"></i> 编辑</div>
                        <div class="wb-tab" data-tab="split"><i class="fa-solid fa-columns"></i> 缝合</div>
                        <div class="wb-tab" data-tab="binding"><i class="fa-solid fa-link"></i> 绑定</div>
                        <div class="wb-tab" data-tab="manage"><i class="fa-solid fa-list-check"></i> 管理</div>
                    </div>
                </div>

                <div id="wb-loading-layer" class="wb-loader"><div class="wb-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div></div>
                
                <div id="wb-view-editor" class="wb-view-section"></div>

                <div id="wb-view-binding" class="wb-view-section wb-hidden"></div>
                <div id="wb-view-manage" class="wb-view-section wb-hidden"></div>
            </div>
        `;
        document.body.appendChild(panel);

        const $ = (sel) => panel.querySelector(sel);
        $('#wb-close').onclick = () => panel.remove();
        panel.querySelectorAll('.wb-tab').forEach(el => el.onclick = () => Actions.switchView(el.dataset.tab));
        
        // ... (事件绑定逻辑现在将在 renderEditorView 中动态进行) ...

        const loader = $('#wb-loading-layer');
        try {
            await Actions.refreshAllContext();
            STATE.isManageDirty = true;
            
            const charPrimary = STATE.bindings.char.primary;
            const chatBook = STATE.bindings.chat;
            let targetBook = null;
            if (charPrimary && STATE.allBookNames.includes(charPrimary)) targetBook = charPrimary;
            else if (chatBook && STATE.allBookNames.includes(chatBook)) targetBook = chatBook;
            else if (STATE.allBookNames.length > 0) targetBook = STATE.allBookNames[0];

            this.renderEditorView(); // 初始渲染单面板
            
            if (targetBook) {
                await Actions.loadBook(targetBook);
            } else {
                this.renderList();
            }

        } catch (e) {
            console.error("Panel Init Error:", e);
            toastr.error("初始化面板数据失败");
        } finally {
            if (loader) loader.style.display = 'none';
        }

        UI.updateGlider('editor');
        setTimeout(() => {
            const glider = panel.querySelector('.wb-tab-glider');
            if (glider) glider.classList.add('wb-glider-animating');
        }, 50);
    },

    // 【核心重构】渲染编辑器视图
    renderEditorView() {
        const container = document.getElementById('wb-view-editor');
        if (!container) return;

        if (STATE.isSplitView) {
            container.innerHTML = this.getSplitViewHTML();
            this.bindEditorEvents('left');
            this.bindEditorEvents('right');
            this.renderBookSelector(null, 'left');
            this.renderBookSelector(null, 'right');
            this.renderList(STATE.splitView.right.searchTerm, 'right');
            this.updateHeaderInfo('left');
            this.updateHeaderInfo('right');
        } else {
            container.innerHTML = this.getSingleViewHTML();
            this.bindEditorEvents();
            this.renderBookSelector();
            this.renderList();
            this.updateHeaderInfo();
        }
    },
    
    // 【新】获取单面板HTML
    getSingleViewHTML() {
        return `
            <div class="wb-editor-panel single-panel">
                <div class="wb-book-bar">
                    <select id="wb-book-selector" style="flex:1;"></select>
                    <div class="wb-menu-wrapper">
                        <button class="wb-btn-circle" title="分析与统计" id="btn-wb-analysis">
                            <i class="fa-solid fa-coins"></i>
                        </button>
                        <div class="wb-menu-dropdown" id="wb-analysis-menu">
                             <div class="wb-menu-item" data-type="stats"><i class="fa-solid fa-chart-pie"></i> 世界书统计与分析</div>
                             <div class="wb-menu-item" data-type="context"><i class="fa-solid fa-align-left"></i> 世界书实际上下文</div>
                             <div class="wb-menu-item" data-type="export_txt"><i class="fa-solid fa-file-lines"></i> 导出世界书为TXT</div>
                        </div>
                    </div>
                    <div class="wb-menu-wrapper">
                        <button class="wb-btn-circle" title="更多操作" id="btn-wb-menu-trigger">
                            <i class="fa-solid fa-magic-wand-sparkles interactable"></i>
                        </button>
                        <div class="wb-menu-dropdown" id="wb-main-menu">
                            <div class="wb-menu-item" data-action="import"><i class="fa-solid fa-file-import"></i> 导入</div>
                            <div class="wb-menu-item" data-action="export"><i class="fa-solid fa-file-export"></i> 导出</div>
                            <div class="wb-menu-item" data-action="create"><i class="fa-solid fa-plus"></i> 新建</div>
                            <div class="wb-menu-item" data-action="rename"><i class="fa-solid fa-pen"></i> 重命名</div>
                            <div class="wb-menu-item danger" data-action="delete"><i class="fa-solid fa-trash"></i> 删除</div>
                        </div>
                    </div>
                    <input type="file" id="wb-import-file" accept=".json,.wb" style="display:none">
                </div>
                <div class="wb-stat-line">
                    <div class="wb-stat-group">
                        <div id="wb-warning-stat" class="wb-warning-badge hidden" title="点击查看问题条目">
                            <i class="fa-solid fa-circle-exclamation"></i> <span id="wb-warning-count">0</span>
                        </div>
                        <div class="wb-stat-item" id="wb-display-count">0 条目</div>
                    </div>
                </div>
                <div class="wb-tool-bar">
                    <input class="wb-input-dark" id="wb-search-entry" style="flex:1;" placeholder="搜索条目...">
                    <button class="wb-btn-circle" id="btn-select-all" title="全选"><i class="fa-solid fa-check-double"></i></button>
                    <button class="wb-btn-circle" id="btn-invert-selection" title="反选"><i class="fa-solid fa-rotate"></i></button>
                    <div class="wb-batch-op-divider hidden"></div>
                    <span id="wb-batch-counter" class="hidden"></span>
                    <button class="wb-btn-circle wb-batch-op hidden" id="btn-batch-enable" title="批量启用"><i class="fa-solid fa-play"></i></button>
                    <button class="wb-btn-circle wb-batch-op hidden" id="btn-batch-disable" title="批量禁用"><i class="fa-solid fa-pause"></i></button>
                    <button class="wb-btn-circle wb-batch-op hidden" id="btn-batch-toggle-const" title="批量切换常驻/非常驻"><i class="fa-solid fa-lightbulb"></i></button>
                    <button class="wb-btn-circle wb-batch-op hidden" id="btn-batch-reorder" title="批量调整"><i class="fa-solid fa-layer-group"></i></button>
                    <button class="wb-btn-circle wb-batch-op hidden danger" id="btn-batch-delete" title="批量删除"><i class="fa-solid fa-trash"></i></button>
                    <div class="wb-menu-wrapper">
                        <button class="wb-btn-circle" id="btn-entry-states" title="保存/加载条目状态">
                            <i class="fa-solid fa-bookmark"></i>
                        </button>
                        <div class="wb-menu-dropdown" id="wb-entry-states-menu"></div>
                    </div>
                    <button class="wb-btn-circle interactable" id="btn-group-sort" title="分组排序"><i class="fa-solid fa-arrow-down-9-1"></i></button>
                    <button class="wb-btn-circle" id="btn-sort-priority" title="按上下文重排"><i class="fa-solid fa-filter"></i></button>
                    <button class="wb-btn-circle" id="btn-add-entry" title="新建条目"><i class="fa-solid fa-plus"></i></button>
                </div>
                <div class="wb-list" id="wb-entry-list"></div>
            </div>
        `;
    },

    // 【新功能】获取双面板HTML
    getSplitViewHTML() {
        const getPanelHTML = (panel) => `
            <div class="wb-editor-panel split-panel" id="wb-editor-panel-${panel}">
                <div class="wb-book-bar">
                    <select id="wb-book-selector-${panel}" style="flex:1;"></select>
                    <button class="wb-btn-circle" id="btn-add-entry-${panel}" title="新建条目"><i class="fa-solid fa-plus"></i></button>
                </div>
                <div class="wb-stat-line">
                    <div class="wb-stat-item" id="wb-display-count-${panel}">0 条目</div>
                </div>
                <div class="wb-tool-bar">
                    <input class="wb-input-dark" id="wb-search-entry-${panel}" style="flex:1;" placeholder="搜索...">
                </div>
                <div class="wb-list" id="wb-entry-list-${panel}"></div>
            </div>`;
        return `<div class="wb-split-container">${getPanelHTML('left')}${getPanelHTML('right')}</div>`;
    },
    
    // 【新功能】绑定编辑器事件
    bindEditorEvents(panel) {
        const prefix = panel ? `${panel}-` : '';
        const container = panel ? document.getElementById(`wb-editor-panel-${panel}`) : document.getElementById('wb-view-editor');
        if (!container) return;

        const $ = (sel) => container.querySelector(sel);
        const $$ = (sel) => container.querySelectorAll(sel);
        
        $(`#wb-book-selector${prefix ? `-${prefix.slice(0,-1)}` : ''}`).addEventListener('change', (e) => Actions.loadBook(e.target.value, panel));
        $(`#wb-search-entry${prefix ? `-${prefix.slice(0,-1)}` : ''}`).oninput = (e) => {
            if (panel) STATE.splitView[panel].searchTerm = e.target.value;
            this.renderList(e.target.value, panel);
        };
        $(`#btn-add-entry${prefix ? `-${prefix.slice(0,-1)}` : ''}`).onclick = () => Actions.addNewEntry(panel);

        // 单面板模式下的特定事件
        if (!panel) {
            $('#btn-group-sort').onclick = () => this.openSortingModal();
            $('#btn-sort-priority').onclick = () => Actions.sortByPriority();
            
            // 菜单
            const setupMenu = (triggerId, menuId, items) => {
                const trigger = $(triggerId);
                const menu = $(menuId);
                trigger.onclick = (e) => {
                    e.stopPropagation();
                    const isShow = menu.classList.contains('show');
                    document.querySelectorAll('.wb-menu-dropdown.show').forEach(el => el.classList.remove('show'));
                    if (!isShow) {
                        if (menuId === '#wb-entry-states-menu') this.renderEntryStatesMenu();
                        menu.classList.add('show');
                    }
                };
                items.forEach(({selector, action}) => {
                    $$(selector).forEach(item => item.onclick = (e) => {
                        e.stopPropagation();
                        menu.classList.remove('show');
                        action(item.dataset);
                    });
                });
            };

            setupMenu('#btn-wb-analysis', '#wb-analysis-menu', [
                { selector: '.wb-menu-item[data-type]', action: (ds) => {
                    if (ds.type === 'stats') this.openAnalysisModal();
                    else if (ds.type === 'context') this.openContextPreviewModal();
                    else if (ds.type === 'export_txt') Actions.actionExportTxt();
                }}
            ]);

            setupMenu('#btn-wb-menu-trigger', '#wb-main-menu', [
                 { selector: '.wb-menu-item[data-action]', action: async (ds) => {
                    const act = ds.action;
                    if (act === 'import') Actions.actionImport();
                    else if (act === 'export') Actions.actionExport();
                    else if (act === 'create') Actions.actionCreateNew();
                    else if (act === 'rename') Actions.actionRename();
                    else if (act === 'delete') Actions.actionDelete();
                 }}
            ]);

            document.getElementById('wb-import-file').onchange = (e) => {
                if (e.target.files.length > 0) {
                    Actions.actionHandleImport(e.target.files[0]);
                    e.target.value = '';
                }
            };

            // 批量操作
            $('#btn-select-all').onclick = () => Actions.batchSelect('all');
            $('#btn-invert-selection').onclick = () => Actions.batchSelect('invert');
            $('#btn-batch-enable').onclick = () => Actions.batchUpdate('enable');
            $('#btn-batch-disable').onclick = () => Actions.batchUpdate('disable');
            $('#btn-batch-toggle-const').onclick = () => Actions.batchUpdate('toggle-constant');
            $('#btn-batch-reorder').onclick = () => this.openBatchReorderModal();
            $('#btn-batch-delete').onclick = () => Actions.batchUpdate('delete');
            
            // 状态菜单
            $('#btn-entry-states').onclick = (e) => {
                 e.stopPropagation();
                 this.renderEntryStatesMenu();
                 const menu = $('#wb-entry-states-menu');
                 const isShow = menu.classList.contains('show');
                 document.querySelectorAll('.wb-menu-dropdown.show').forEach(el => el.classList.remove('show'));
                 if (!isShow) menu.classList.add('show');
            };
        }
    },


    renderBookSelector(filter, panel) {
        const selectorId = panel ? `wb-book-selector-${panel}` : 'wb-book-selector';
        const selector = document.getElementById(selectorId);
        if (!selector) return;
        const { char, global, chat } = STATE.bindings;
        const allNames = STATE.allBookNames;

        let html = '<option value="">选择世界书...</option>'; // 默认提示
        let optgroups = {};

        const addToGroup = (group, name) => {
            if (!optgroups[group]) optgroups[group] = [];
            if (!optgroups[group].includes(name)) optgroups[group].push(name);
        };

        if (char.primary) addToGroup('主要世界书', char.primary);
        char.additional.forEach(name => addToGroup('附加世界书', name));
        global.forEach(name => addToGroup('全局启用', name));
        if (chat) addToGroup('当前聊天', chat);
        
        allNames.forEach(name => {
            let isInGroup = false;
            for (const group in optgroups) {
                if (optgroups[group].includes(name)) {
                    isInGroup = true;
                    break;
                }
            }
            if (!isInGroup) addToGroup('其他', name);
        });

        const groupOrder = ['主要世界书', '附加世界书', '全局启用', '当前聊天', '其他'];
        groupOrder.forEach(groupName => {
            if (optgroups[groupName]) {
                html += `<optgroup label="${groupName}">`;
                optgroups[groupName].forEach(name => html += `<option value="${name}">${name}</option>`);
                html += `</optgroup>`;
            }
        });
        
        selector.innerHTML = html;
        const bookName = panel ? STATE.splitView[panel].bookName : STATE.currentBookName;
        if (bookName) selector.value = bookName;

        this.applyCustomDropdown(selectorId);
    },
    
    renderBindingView() {
        const allNames = STATE.allBookNames;
        const { char, global, chat } = STATE.bindings;
        const view = document.getElementById('wb-view-binding');
        if (!view) return;

        // ... (内容与之前相同，省略)
    },
    
    updateHeaderInfo(panel) {
        this.renderGlobalStats(panel);
        const selectorId = panel ? `wb-book-selector-${panel}` : 'wb-book-selector';
        const selector = document.getElementById(selectorId);
        const bookName = panel ? STATE.splitView[panel].bookName : STATE.currentBookName;
        if (selector && bookName) selector.value = bookName;

        // 页脚信息只在非分割视图显示
        const footerEl = document.getElementById('wb-footer-info');
        if (footerEl) {
             if (STATE.isSplitView) {
                 footerEl.innerHTML = '';
                 return;
             }
             const context = getContext();
             const charId = context.characterId;
             const charName = (context.characters && context.characters[charId]) ? context.characters[charId].name : '无';
             const avatarImgEl = document.getElementById('avatar_load_preview');
             const avatarHtml = (avatarImgEl && avatarImgEl.src) ? `<img src="${avatarImgEl.src}" class="wb-footer-avatar">` : '';
             const chatName = context.chatId ? String(context.chatId).replace(/\.json$/i, '') : '无';
             footerEl.innerHTML = `<div>当前角色: ${avatarHtml}<strong>${charName}</strong></div><div>当前聊天: <strong>${chatName}</strong></div>`;
        }
    },
    
    getWarningList(panel) {
        const entries = panel ? STATE.splitView[panel].entries : STATE.entries;
        return entries.filter(entry => entry.disable === false && entry.constant === false && !(entry.key?.length > 0));
    },

    renderGlobalStats(panel) {
        const prefix = panel ? `-${panel}` : '';
        const entries = panel ? STATE.splitView[panel].entries : STATE.entries;
        
        const countEl = document.getElementById(`wb-display-count${prefix}`);
        const warningEl = document.getElementById(`wb-warning-stat${prefix}`);
        const warningNumEl = document.getElementById(`wb-warning-count${prefix}`);
        if (countEl) {
            let blueTokens = 0, greenTokens = 0;
            entries.forEach(entry => {
                if (entry.disable === false) {
                    const t = Actions.getTokenCount(entry.content);
                    if (entry.constant === true) blueTokens += t;
                    else greenTokens += t;
                }
            });
            countEl.innerHTML = `<span>${entries.length} 条目 | ${blueTokens + greenTokens} Tokens</span><span class="wb-token-breakdown">( <span class="wb-text-blue" title="常驻">${blueTokens}</span> + <span class="wb-text-green" title="非常驻">${greenTokens}</span> )</span>`;
        }
        if (warningEl && warningNumEl) {
            const warnings = this.getWarningList(panel);
            if (warnings.length > 0) {
                warningEl.classList.remove('hidden');
                warningNumEl.textContent = warnings.length;
                warningEl.onclick = () => this.openWarningListModal(panel);
            } else warningEl.classList.add('hidden');
        }
    },

    updateCardStatus(uid, panel) {
        const prefix = panel ? `-${panel}` : '';
        const entries = panel ? STATE.splitView[panel].entries : STATE.entries;
        const entry = entries.find(e => e.uid === uid);
        const card = document.querySelector(`#wb-entry-list${prefix} .wb-card[data-uid="${uid}"]`);
        if (!entry || !card) return;

        card.classList.remove('disabled', 'type-green', 'type-blue');
        if (entry.disable) {
            card.classList.add('disabled');
        } else {
            card.classList.add(entry.constant ? 'type-blue' : 'type-green');
        }
        
        const tokenEl = card.querySelector('.wb-token-display');
        if (tokenEl) {
             tokenEl.textContent = Actions.getTokenCount(entry.content);
             // 【UI还原】根据常驻状态切换背景色
             tokenEl.classList.remove('wb-token-blue', 'wb-token-green', 'wb-token-disabled');
             if (entry.disable) {
                 tokenEl.classList.add('wb-token-disabled');
             } else {
                 tokenEl.classList.add(entry.constant ? 'wb-token-blue' : 'wb-token-green');
             }
        }
        
        const warnContainer = card.querySelector('.wb-warning-container');
        if (warnContainer) {
            const showWarning = entry.disable === false && entry.constant === false && !(entry.key?.length > 0);
            warnContainer.innerHTML = showWarning ? `<i class="fa-solid fa-circle-exclamation" style="color:#ef4444; margin-right:6px; cursor:help;" data-wb-tooltip="警告：绿灯条目已启用但未设置关键词，将无法触发"></i>` : '';
        }
    },

    renderList(filterText = '', panel) {
        const prefix = panel ? `-${panel}` : '';
        const list = document.getElementById(`wb-entry-list${prefix}`);
        if (!list) return;

        list.innerHTML = '';
        const entries = panel ? STATE.splitView[panel].entries : STATE.entries;

        entries.forEach((entry, index) => {
            const name = entry.comment || '';
            if (filterText && !name.toLowerCase().includes(filterText.toLowerCase())) return;
            const card = this.createCard(entry, index, panel);
            list.appendChild(card);
            this.applyCustomDropdown(`wb-pos-${entry.uid}${prefix}`);
        });
        
        if (panel) { // 缝合模式拖拽
            this.initDraggableList(list, panel);
        } else { // 单面板模式
            this.updateBatchControls();
        }
    },

    createCard(entry, index, panel) {
        const isEnabled = !entry.disable;
        const isConstant = !!entry.constant;
        const isSelected = !panel && STATE.selectedUids.has(entry.uid);
        const prefix = panel ? `-${panel}` : '';

        const card = document.createElement('div');
        let typeClass = '';
        if (isEnabled) typeClass = isConstant ? 'type-blue' : 'type-green';
        card.className = `wb-card ${isEnabled ? '' : 'disabled'} ${typeClass}`;
        card.dataset.uid = entry.uid;
        card.dataset.index = index;
        card.dataset.panel = panel || '';
        card.draggable = true; // 总是可拖动

        const escapeHtml = (str) => (str || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#039;'}[m]));
        const curPosInt = typeof entry.position === 'number' ? entry.position : 1;
        const curPosStr = WI_POSITION_MAP[curPosInt] || 'after_character_definition';
        const allPosOptions = [
            { v: 'before_character_definition', t: '角色定义之前' }, { v: 'after_character_definition', t: '角色定义之后' },
            { v: 'before_example_messages', t: '示例消息之前' }, { v: 'after_example_messages', t: '示例消息之后' },
            { v: 'before_author_note', t: '作者注释之前' }, { v: 'after_author_note', t: '作者注释之后' },
            { v: 'at_depth', t: '@D' }
        ];
        let optionsHtml = '';
        allPosOptions.forEach(opt => {
            optionsHtml += `<option value="${opt.v}" ${opt.v === curPosStr ? 'selected' : ''}>${opt.t}</option>`;
        });

        const showWarning = isEnabled && !isConstant && !(entry.key?.length > 0);
        const warningIcon = showWarning ? `<i class="fa-solid fa-circle-exclamation" style="color:#ef4444;" data-wb-tooltip="警告：绿灯条目已启用但未设置关键词，将无法触发"></i>` : '';

        const tokenClass = isEnabled ? (isConstant ? 'wb-token-blue' : 'wb-token-green') : 'wb-token-disabled';

        card.innerHTML = `
            <div class="wb-card-drag-handle"><i class="fa-solid fa-grip-vertical"></i></div>
            <div class="wb-card-main">
                ${!panel ? `<input type="checkbox" class="inp-select-entry" title="选择" ${isSelected ? 'checked' : ''}>` : ''}
                <div class="wb-card-content">
                    <div class="wb-card-row-1">
                        <input class="wb-inp-title inp-name" value="${escapeHtml(entry.comment)}" placeholder="条目名称 (Comment)">
                        <div class="wb-warning-container">${warningIcon}</div>
                        <i class="fa-solid fa-eye btn-preview" title="编辑内容"></i>
                        <i class="fa-solid fa-trash btn-delete" title="删除条目"></i>
                    </div>
                    <div class="wb-card-row-2">
                        <div class="wb-ctrl-group"><label class="wb-switch"><input type="checkbox" class="inp-enable" ${isEnabled ? 'checked' : ''}><span class="wb-slider purple"></span></label></div>
                        <div class="wb-ctrl-group"><label class="wb-switch"><input type="checkbox" class="inp-type" ${isConstant ? 'checked' : ''}><span class="wb-slider blue"></span></label></div>
                        <div class="wb-pos-wrapper">
                            <select id="wb-pos-${entry.uid}${prefix}" class="wb-input-dark inp-pos">${optionsHtml}</select>
                            <input type="number" class="wb-inp-num inp-pos-depth" style="display: ${curPosStr === 'at_depth' ? 'block' : 'none'};" value="${entry.depth ?? 4}">
                        </div>
                        <div class="wb-ctrl-group order-group" title="顺序"><span>顺序</span><input type="number" class="wb-inp-num inp-order" value="${entry.order ?? 0}"></div>
                        <div class="wb-token-display ${tokenClass}" title="Tokens">${Actions.getTokenCount(entry.content)}</div>
                    </div>
                </div>
            </div>`;

        const bind = (sel, evt, fn) => { const el = card.querySelector(sel); if(el) el.addEventListener(evt, fn); };

        if (!panel) bind('.inp-select-entry', 'change', () => Actions.toggleEntrySelection(entry.uid));
        bind('.inp-name', 'input', (e) => Actions.updateEntry(entry.uid, d => d.comment = e.target.value, panel));
        bind('.inp-enable', 'change', (e) => Actions.updateEntry(entry.uid, d => d.disable = !e.target.checked, panel));
        bind('.inp-type', 'change', (e) => Actions.updateEntry(entry.uid, d => { d.constant = e.target.checked; d.selective = !d.constant; }, panel));
        bind('.inp-pos', 'change', (e) => {
            const val = e.target.value;
            card.querySelector('.inp-pos-depth').style.display = val === 'at_depth' ? 'block' : 'none';
            Actions.updateEntry(entry.uid, d => d.position = WI_POSITION_MAP_REV[val] ?? 1, panel);
        });
        bind('.inp-pos-depth', 'input', (e) => Actions.updateEntry(entry.uid, d => d.depth = Number(e.target.value), panel));
        bind('.inp-order', 'input', (e) => Actions.updateEntry(entry.uid, d => d.order = Number(e.target.value), panel));
        bind('.btn-delete', 'click', () => Actions.deleteEntry(entry.uid, panel));
        bind('.btn-preview', 'click', () => this.openContentPopup(entry, panel));

        return card;
    },

    // 【新功能】初始化拖拽列表
    initDraggableList(listEl, panel) {
        let draggedItem = null;
        
        listEl.addEventListener('dragstart', (e) => {
            draggedItem = e.target.closest('.wb-card');
            if (draggedItem) {
                e.dataTransfer.setData('text/plain', draggedItem.dataset.uid);
                e.dataTransfer.setData('source-panel', panel);
                setTimeout(() => draggedItem.classList.add('dragging'), 0);
            }
        });

        listEl.addEventListener('dragend', () => {
            if (draggedItem) {
                draggedItem.classList.remove('dragging');
                draggedItem = null;
            }
        });
        
        listEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            const targetList = e.target.closest('.wb-list');
            if (targetList) targetList.classList.add('drag-over');
        });

        listEl.addEventListener('dragleave', (e) => {
            const targetList = e.target.closest('.wb-list');
            if (targetList) targetList.classList.remove('drag-over');
        });

        listEl.addEventListener('drop', (e) => {
            e.preventDefault();
            listEl.classList.remove('drag-over');
            const sourcePanel = e.dataTransfer.getData('source-panel');
            const entryUid = parseInt(e.dataTransfer.getData('text/plain'));
            const isCopy = e.altKey;

            if (sourcePanel && entryUid) {
                Actions.handleDrop(sourcePanel, panel, entryUid, isCopy);
            }
        });
    },

    openContentPopup(entry, panel) {
        // ... (内容与之前相同，但在updateEntry时需要传入panel) ...
    },
    
    // ... 其他UI函数保持不变或做微小适配 ...
};
// 全局事件监听器，用于关闭菜单
document.addEventListener('click', (e) => {
    const activeMenu = document.querySelector('.wb-menu-dropdown.show');
    if (activeMenu && !activeMenu.parentElement.contains(e.target)) {
        activeMenu.classList.remove('show');
    }
});


jQuery(async () => {
    const injectButton = () => {
        if (document.getElementById(CONFIG.btnId)) return;
        const container = document.querySelector('#options .options-content');
        if (container) {
            const html = `
                <a id="${CONFIG.btnId}" class="interactable" title="世界书管理" tabindex="0">
                    <i class="fa-lg fa-solid fa-book-journal-whills"></i>
                    <span>世界书</span>
                </a>
            `;
            $(container).append(html);
            $(`#${CONFIG.btnId}`).on('click', (e) => {
                e.preventDefault();
                $('#options').hide();
                UI.open();
            });
            console.log("[Worldbook Editor] Button injected.");
        }
    };
    injectButton();
    const performInit = async () => {
        try {
            await Actions.init();
        } catch (e) {
            console.error("[Worldbook Editor] Pre-loading failed:", e);
        }
    };
    if (typeof world_names === 'undefined') {
        eventSource.on(event_types.APP_READY, performInit);
    } else {
        performInit();
    }
    console.log("Worldbook Editor Enhanced Script Loaded");
});