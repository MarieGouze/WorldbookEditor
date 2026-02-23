import { getContext } from '../../../extensions.js';
import { event_types, eventSource } from '../../../../script.js';
import { getCharaFilename } from '../../../utils.js';
import { world_info, world_names, selected_world_info } from '../../../world-info.js';

const CONFIG = {
    id: 'enhanced-wb-panel-v6',
    btnId: 'wb-menu-btn-v6',
    settingsKey: 'WorldbookEditor_Metadata',
};

const STATE = {
    isInitialized: false,
    currentView: 'editor', // editor | stitch | binding | manage
    currentBookName: null,
    entries: [],
    allBookNames: [],
    metadata: {},
    boundBooksSet: {},
    bindings: {
        char: { primary: null, additional: [] },
        global: [],
        chat: null,
    },
    debouncer: null,
    selectedUids: new Set(),
    stitch: {
        left: { book: null, entries: [], selected: new Set(), search: '' },
        right: { book: null, entries: [], selected: new Set(), search: '' },
    },
};

const WI_POSITION_MAP = {
    0: 'before_character_definition',
    1: 'after_character_definition',
    2: 'before_author_note',
    3: 'after_author_note',
    4: 'at_depth',
    5: 'before_example_messages',
    6: 'after_example_messages',
};
const WI_POSITION_MAP_REV = Object.fromEntries(
    Object.entries(WI_POSITION_MAP).map(([k, v]) => [v, parseInt(k, 10)]),
);

function safeClone(v) {
    try {
        return structuredClone(v);
    } catch (_e) {
        return JSON.parse(JSON.stringify(v));
    }
}

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    }[m]));
}

function toNum(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * 兼容旧版：更新角色主世界书
 */
async function charUpdatePrimaryWorld(name) {
    const context = getContext();
    const charId = context.characterId;
    if (charId === undefined || charId === null) return;

    const character = context.characters[charId];
    if (!character) return;

    if (!character.data.extensions) character.data.extensions = {};
    character.data.extensions.world = name || '';

    const uiSelect = document.getElementById('character_world');
    if (uiSelect) {
        uiSelect.value = name || '';
        uiSelect.dispatchEvent(new Event('change'));
    }

    const setWorldBtn = document.getElementById('set_character_world');
    if (setWorldBtn) {
        if (name) setWorldBtn.classList.add('world_set');
        else setWorldBtn.classList.remove('world_set');
    }

    if (context.saveCharacterDebounced) context.saveCharacterDebounced();
}

/**
 * 兼容旧版：设置角色附加世界书
 */
function charSetAuxWorlds(fileName, books) {
    const context = getContext();

    if (!world_info.charLore) world_info.charLore = [];
    const idx = world_info.charLore.findIndex((e) => e.name === fileName);

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
        return;
    }

    if (type === 'auxiliary') {
        const charId = context.characterId;
        if (charId === undefined || charId === null) return;

        const charAvatar = context.characters[charId].avatar;
        const charFileName = getCharaFilename(null, { manualAvatarKey: charAvatar });

        const charLoreEntry = world_info.charLore?.find((e) => e.name === charFileName);
        let currentBooks = charLoreEntry ? [...charLoreEntry.extraBooks] : [];

        if (isEnabled) {
            if (!currentBooks.includes(worldName)) currentBooks.push(worldName);
        } else {
            currentBooks = currentBooks.filter((name) => name !== worldName);
        }

        charSetAuxWorlds(charFileName, currentBooks);
        return;
    }

    if (type === 'chat') {
        if (isEnabled) context.chatMetadata.world_info = worldName;
        else if (context.chatMetadata.world_info === worldName) delete context.chatMetadata.world_info;
        context.saveMetadataDebounced?.();
        return;
    }

    if (type === 'global') {
        const command = isEnabled
            ? `/world silent=true "${worldName}"`
            : `/world state=off silent=true "${worldName}"`;
        await context.executeSlashCommands(command);
    }
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
        const fileName = character.avatar.replace(/\.[^/.]+$/, '');

        const charLore = world_info.charLore || [];
        const entry = charLore.find((e) => e.name === fileName);
        const additional = entry && Array.isArray(entry.extraBooks) ? [...entry.extraBooks] : [];

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

        const safeEntries = data.entries ? safeClone(data.entries) : {};
        const entries = Object.entries(safeEntries).map(([uid, e]) => {
            if (e.uid === undefined || e.uid === null) e.uid = Number(uid);
            if (e.comment === undefined) e.comment = '';
            if (e.content === undefined) e.content = '';
            if (!Array.isArray(e.key)) e.key = [];
            if (typeof e.disable !== 'boolean') e.disable = false;
            if (typeof e.constant !== 'boolean') e.constant = false;
            if (typeof e.order !== 'number') e.order = 0;
            if (typeof e.depth !== 'number') e.depth = 4;
            if (typeof e.position !== 'number') e.position = 1;
            return e;
        });

        return entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.uid ?? 0) - (b.uid ?? 0));
    },

    async saveBookEntries(name, entriesArray) {
        if (!name || !Array.isArray(entriesArray)) return;

        const oldData = (await getContext().loadWorldInfo(name)) || { entries: {} };
        const newEntriesObj = {};

        entriesArray.forEach((entry) => {
            const uid = entry.uid;
            const oldEntry = oldData.entries?.[uid] ? oldData.entries[uid] : {};
            const safeEntry = safeClone(entry);
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
        currentEntries = currentEntries.filter((e) => !uidsToDelete.includes(e.uid));
        await this.saveBookEntries(name, currentEntries);
    },

    async getAllBoundBookNames() {
        const context = getContext();
        const characters = context.characters || [];
        const boundMap = {};

        characters.forEach((char) => {
            if (!char || !char.data) return;
            const primary = char.data.extensions?.world;
            if (!primary) return;
            if (!boundMap[primary]) boundMap[primary] = [];
            boundMap[primary].push(char.name);
        });

        return boundMap;
    },

    getMetadata() {
        const context = getContext();
        return context.extensionSettings[CONFIG.settingsKey] || {};
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
        if (!data) return;

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
            console.error('绑定迁移失败:', e);
            toastr.warning('重命名成功，但绑定迁移遇到错误');
        }

        await this.deleteWorldbook(oldName);
    },
};

const Actions = {
    getEntrySortScore(entry) {
        const context = getContext();
        const anDepth = context.chatMetadata?.note_depth
            ?? context.extensionSettings?.note?.defaultDepth
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

    async flushPendingSave() {
        if (!STATE.debouncer) return;

        clearTimeout(STATE.debouncer);
        STATE.debouncer = null;

        if (STATE.currentBookName && Array.isArray(STATE.entries)) {
            await API.saveBookEntries(STATE.currentBookName, STATE.entries);
        }
    },

    async init() {
        if (STATE.isInitialized) return;

        this.registerCoreEvents();
        await this.refreshAllContext();

        STATE.isInitialized = true;
        console.log('[Worldbook Editor] Initialization complete.');
    },

    registerCoreEvents() {
        const es = eventSource;
        const et = event_types;

        es.on(et.SETTINGS_UPDATED, () => {
            if (document.getElementById(CONFIG.id)) this.refreshAllContext();
        });

        es.on(et.WORLDINFO_UPDATED, (name) => {
            if (STATE.currentBookName === name) this.loadBook(name);
            if (STATE.currentView === 'stitch') this.refreshStitchBooks();
        });

        es.on(et.CHAT_CHANGED, () => {
            if (document.getElementById(CONFIG.id)) this.refreshAllContext();
        });

        es.on(et.CHARACTER_SELECTED, () => {
            setTimeout(() => {
                this.refreshAllContext();
            }, 100);
        });

        es.on(et.CHARACTER_EDITED, () => {
            if (document.getElementById(CONFIG.id)) this.refreshAllContext();
        });
    },

    async refreshAllContext() {
        try {
            const [all, char, glob, chat, boundSet] = await Promise.all([
                API.getAllBookNames(),
                API.getCharBindings(),
                API.getGlobalBindings(),
                API.getChatBinding(),
                API.getAllBoundBookNames(),
            ]);

            STATE.allBookNames = all.sort((a, b) => a.localeCompare(b));
            STATE.bindings.char = char;
            STATE.bindings.global = glob;
            STATE.bindings.chat = chat;
            STATE.boundBooksSet = boundSet;
            STATE.metadata = API.getMetadata();

            UI.renderBookSelector();

            if (STATE.currentView === 'binding') UI.renderBindingView();
            if (STATE.currentView === 'manage') UI.renderManageView();
            if (STATE.currentView === 'stitch') this.refreshStitchBooks();
        } catch (e) {
            console.error('refreshAllContext failed:', e);
        }
    },

    switchView(viewName) {
        STATE.currentView = viewName;
        UI.switchView(viewName);

        if (viewName === 'binding') {
            UI.renderBindingView();
        } else if (viewName === 'manage') {
            UI.renderManageView();
        } else if (viewName === 'stitch') {
            this.ensureStitchReady();
        } else {
            UI.renderBookSelector();
            UI.renderGlobalStats();
            UI.renderList(document.getElementById('wb-search-entry')?.value || '');
            UI.updateSelectionBar();
        }
    },

    async loadBook(name) {
        if (!name) return;

        await this.flushPendingSave();
        STATE.currentBookName = name;

        try {
            const loadedEntries = await API.loadBook(name);
            if (STATE.currentBookName !== name) return;

            STATE.entries = loadedEntries;

            STATE.entries.sort((a, b) => {
                const scoreA = this.getEntrySortScore(a);
                const scoreB = this.getEntrySortScore(b);
                if (scoreA !== scoreB) return scoreB - scoreA;
                return (a.order ?? 0) - (b.order ?? 0) || (a.uid ?? 0) - (b.uid ?? 0);
            });

            UI.renderGlobalStats();
            UI.renderList();
            UI.updateSelectionBar();

            const selector = document.getElementById('wb-book-selector');
            if (selector) selector.value = name;
        } catch (e) {
            if (STATE.currentBookName === name) {
                console.error('Load book failed', e);
                toastr.error(`无法加载世界书 "${name}"`);
            }
        }
    },

    updateEntry(uid, updater) {
        const entry = STATE.entries.find((e) => e.uid === uid);
        if (!entry) return;

        updater(entry);
        UI.updateCardStatus(uid);
        UI.renderGlobalStats();

        if (STATE.debouncer) clearTimeout(STATE.debouncer);

        const targetBookName = STATE.currentBookName;
        const targetEntries = STATE.entries;

        STATE.debouncer = setTimeout(() => {
            STATE.debouncer = null;
            if (targetBookName && targetEntries) {
                API.saveBookEntries(targetBookName, targetEntries);
            }
        }, 280);
    },

    async addNewEntry() {
        if (!STATE.currentBookName) return toastr.warning('请先选择一本世界书');

        const maxUid = STATE.entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1);
        const newUid = maxUid + 1;

        const newEntry = {
            uid: newUid,
            comment: '新建条目',
            disable: false,
            content: '',
            constant: false,
            key: [],
            order: 0,
            position: 0,
            depth: 4,
            probability: 100,
            selective: true,
        };

        await API.createEntry(STATE.currentBookName, [newEntry]);
        await this.loadBook(STATE.currentBookName);
    },

    async deleteEntry(uid) {
        if (!confirm('确定要删除此条目吗？')) return;
        await API.deleteEntries(STATE.currentBookName, [uid]);
        STATE.selectedUids.delete(uid);
        await this.loadBook(STATE.currentBookName);
        UI.updateSelectionBar();
    },

    sortByPriority() {
        STATE.entries.sort((a, b) => {
            const scoreA = this.getEntrySortScore(a);
            const scoreB = this.getEntrySortScore(b);
            if (scoreA !== scoreB) return scoreB - scoreA;

            const orderA = a.order ?? 0;
            const orderB = b.order ?? 0;
            if (orderA !== orderB) return orderA - orderB;

            return (a.uid ?? 0) - (b.uid ?? 0);
        });

        UI.renderList();
        API.saveBookEntries(STATE.currentBookName, STATE.entries);
        toastr.success('已重新按上下文逻辑重排');
    },

    toggleSelect(uid, checked) {
        if (checked) STATE.selectedUids.add(uid);
        else STATE.selectedUids.delete(uid);
        UI.updateSelectionBar();
    },

    clearSelection() {
        STATE.selectedUids.clear();
        UI.renderList(document.getElementById('wb-search-entry')?.value || '');
        UI.updateSelectionBar();
    },

    selectAllVisible() {
        const cards = document.querySelectorAll('#wb-entry-list .wb-card[data-uid]');
        cards.forEach((card) => STATE.selectedUids.add(Number(card.dataset.uid)));
        UI.renderList(document.getElementById('wb-search-entry')?.value || '');
        UI.updateSelectionBar();
    },

    invertVisibleSelection() {
        const cards = document.querySelectorAll('#wb-entry-list .wb-card[data-uid]');
        cards.forEach((card) => {
            const uid = Number(card.dataset.uid);
            if (STATE.selectedUids.has(uid)) STATE.selectedUids.delete(uid);
            else STATE.selectedUids.add(uid);
        });
        UI.renderList(document.getElementById('wb-search-entry')?.value || '');
        UI.updateSelectionBar();
    },

    batchUpdate(updater) {
        if (!STATE.selectedUids.size) return;
        STATE.entries.forEach((entry) => {
            if (STATE.selectedUids.has(entry.uid)) updater(entry);
        });
        UI.renderList(document.getElementById('wb-search-entry')?.value || '');
        UI.renderGlobalStats();
        API.saveBookEntries(STATE.currentBookName, STATE.entries);
    },

    async saveBindings() {
        const view = document.getElementById('wb-view-binding');
        if (!view) return;

        const charPrimary = view.querySelector('#wb-bind-char-primary').value;
        const charAddTags = view.querySelectorAll('.wb-ms-tag[data-bind-type="wb-bind-char-add"]');
        const charAdditional = Array.from(charAddTags).map((el) => el.dataset.val);

        const globalTags = view.querySelectorAll('.wb-ms-tag[data-bind-type="wb-bind-global"]');
        const globalBooks = Array.from(globalTags).map((el) => el.dataset.val);

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
            const toRemove = currentGlobal.filter((b) => !globalBooks.includes(b));
            const toAdd = globalBooks.filter((b) => !currentGlobal.includes(b));

            for (const book of toRemove) {
                await setCharBindings('global', book, false);
            }
            for (const book of toAdd) {
                await setCharBindings('global', book, true);
            }

            await setCharBindings('chat', chatBook || '', !!chatBook);

            await this.refreshAllContext();
            toastr.success('绑定设置已保存');
        } catch (e) {
            console.error(e);
            toastr.error(`保存失败: ${e.message}`);
        }
    },

    getTokenCount(text) {
        if (!text) return 0;
        try {
            const ctx = getContext();
            if (ctx.getTokenCount) return ctx.getTokenCount(text);
        } catch (_e) {}
        return Math.ceil(String(text).length / 3);
    },

    async actionImport() {
        document.getElementById('wb-import-file')?.click();
    },

    async actionHandleImport(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const content = JSON.parse(e.target.result);
                let entries = content.entries ? Object.values(content.entries) : content;
                if (!Array.isArray(entries)) entries = [];

                const defaultName = file.name.replace(/\.(json|wb)$/i, '');
                const name = prompt('请输入导入后的世界书名称:', defaultName);
                if (!name) return;

                if (STATE.allBookNames.includes(name)) {
                    if (!confirm(`世界书 "${name}" 已存在，是否覆盖？`)) return;
                } else {
                    await API.createWorldbook(name);
                }

                await API.saveBookEntries(name, entries);
                toastr.success(`导入成功: ${name}`);
                await this.refreshAllContext();
                await this.loadBook(name);
            } catch (err) {
                console.error(err);
                toastr.error(`导入失败: ${err.message}`);
            }
        };
        reader.readAsText(file);
    },

    async actionExport() {
        if (!STATE.currentBookName) return toastr.warning('请先选择一本世界书');

        try {
            const entries = await API.loadBook(STATE.currentBookName);
            const entriesObj = {};
            entries.forEach((entry) => { entriesObj[entry.uid] = entry; });
            const exportData = { entries: entriesObj };

            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${STATE.currentBookName}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            toastr.error(`导出失败: ${e.message}`);
        }
    },

    async actionCreateNew() {
        const name = prompt('请输入新世界书名称:');
        if (!name) return;
        if (STATE.allBookNames.includes(name)) return toastr.warning('该名称已存在');

        try {
            await API.createWorldbook(name);
            await this.refreshAllContext();
            await this.loadBook(name);
        } catch (e) {
            toastr.error(`创建失败: ${e.message}`);
        }
    },

    async actionDelete() {
        if (!STATE.currentBookName) return;
        if (!confirm(`确定要永久删除世界书 "${STATE.currentBookName}" 吗？`)) return;

        try {
            if (STATE.debouncer) {
                clearTimeout(STATE.debouncer);
                STATE.debouncer = null;
            }

            await API.deleteWorldbook(STATE.currentBookName);
            STATE.currentBookName = null;
            STATE.entries = [];
            STATE.selectedUids.clear();
            await this.refreshAllContext();
            UI.renderList();
            UI.updateSelectionBar();
        } catch (e) {
            toastr.error(`删除失败: ${e.message}`);
        }
    },

    async actionRename() {
        if (!STATE.currentBookName) return;
        const newName = prompt('重命名世界书为:', STATE.currentBookName);
        if (!newName || newName === STATE.currentBookName) return;
        if (STATE.allBookNames.includes(newName)) return toastr.warning('目标名称已存在');

        try {
            await this.flushPendingSave();
            await API.renameWorldbook(STATE.currentBookName, newName);
            await this.refreshAllContext();
            await this.loadBook(newName);
        } catch (e) {
            toastr.error(`重命名失败: ${e.message}`);
        }
    },

    async jumpToEditor(bookName) {
        await this.loadBook(bookName);
        this.switchView('editor');
    },

    // -------------------- Stitch --------------------
    async ensureStitchReady() {
        if (!STATE.allBookNames.length) {
            UI.renderStitchView();
            return;
        }

        const leftBook = STATE.stitch.left.book && STATE.allBookNames.includes(STATE.stitch.left.book)
            ? STATE.stitch.left.book
            : (STATE.currentBookName && STATE.allBookNames.includes(STATE.currentBookName)
                ? STATE.currentBookName
                : STATE.allBookNames[0]);

        const rightDefault = STATE.allBookNames.find((n) => n !== leftBook) || leftBook;
        const rightBook = STATE.stitch.right.book && STATE.allBookNames.includes(STATE.stitch.right.book)
            ? STATE.stitch.right.book
            : rightDefault;

        STATE.stitch.left.book = leftBook;
        STATE.stitch.right.book = rightBook;

        await Promise.all([
            this.loadStitchBook('left', leftBook),
            this.loadStitchBook('right', rightBook),
        ]);

        UI.renderStitchView();
    },

    async refreshStitchBooks() {
        if (STATE.currentView !== 'stitch') return;
        if (!STATE.stitch.left.book || !STATE.stitch.right.book) return;
        await Promise.all([
            this.loadStitchBook('left', STATE.stitch.left.book),
            this.loadStitchBook('right', STATE.stitch.right.book),
        ]);
        UI.renderStitchView();
    },

    async loadStitchBook(side, name) {
        if (!name) return;
        STATE.stitch[side].book = name;
        STATE.stitch[side].selected.clear();

        try {
            const entries = await API.loadBook(name);
            STATE.stitch[side].entries = entries;
        } catch (e) {
            console.error(e);
            toastr.error(`缝合面板加载失败: ${name}`);
            STATE.stitch[side].entries = [];
        }
    },

    toggleStitchSelect(side, uid, checked) {
        if (checked) STATE.stitch[side].selected.add(uid);
        else STATE.stitch[side].selected.delete(uid);
        UI.renderStitchSide(side);
    },

    selectAllStitch(side) {
        const visible = UI.getStitchVisible(side);
        visible.forEach((entry) => STATE.stitch[side].selected.add(entry.uid));
        UI.renderStitchSide(side);
    },

    invertStitch(side) {
        const visible = UI.getStitchVisible(side);
        visible.forEach((entry) => {
            if (STATE.stitch[side].selected.has(entry.uid)) STATE.stitch[side].selected.delete(entry.uid);
            else STATE.stitch[side].selected.add(entry.uid);
        });
        UI.renderStitchSide(side);
    },

    clearStitch(side) {
        STATE.stitch[side].selected.clear();
        UI.renderStitchSide(side);
    },

    async deleteStitchSelected(side) {
        const panel = STATE.stitch[side];
        if (!panel.selected.size) return toastr.warning('请先选择条目');
        if (!confirm(`确定删除 ${panel.selected.size} 个条目吗？`)) return;

        const ids = new Set(panel.selected);
        panel.entries = panel.entries.filter((e) => !ids.has(e.uid));
        panel.selected.clear();

        await API.saveBookEntries(panel.book, panel.entries);
        UI.renderStitchSide(side);
        toastr.success('删除完成');
    },

    async transferStitch(fromSide, toSide, move = false) {
        const from = STATE.stitch[fromSide];
        const to = STATE.stitch[toSide];

        if (!from.selected.size) return toastr.warning('请先选择条目');
        if (!from.book || !to.book) return;
        if (from.book === to.book && move) return toastr.warning('同一本书不能移动');

        const selectedEntries = from.entries.filter((e) => from.selected.has(e.uid));
        if (!selectedEntries.length) return;

        let maxUid = to.entries.reduce((m, e) => Math.max(m, Number(e.uid) || 0), -1);

        selectedEntries.forEach((entry) => {
            const copied = safeClone(entry);
            maxUid += 1;
            copied.uid = maxUid;
            copied.order = (to.entries[to.entries.length - 1]?.order ?? -1) + 1;
            to.entries.push(copied);
        });

        if (move) {
            const selectedSet = new Set(from.selected);
            from.entries = from.entries.filter((e) => !selectedSet.has(e.uid));
        }

        from.selected.clear();

        await Promise.all([
            API.saveBookEntries(from.book, from.entries),
            API.saveBookEntries(to.book, to.entries),
        ]);

        UI.renderStitchSide(fromSide);
        UI.renderStitchSide(toSide);
        toastr.success(move ? '移动完成' : '复制完成');
    },
};

const UI = {
    open() {
        if (document.getElementById(CONFIG.id)) return;

        const panel = document.createElement('div');
        panel.id = CONFIG.id;
        panel.innerHTML = `
            <div class="wb-header-bar">
                <div class="wb-tabs">
                    <div class="wb-tab active" data-tab="editor">编辑世界书</div>
                    <div class="wb-tab" data-tab="stitch">缝合世界书</div>
                    <div class="wb-tab" data-tab="binding">绑定世界书</div>
                    <div class="wb-tab" data-tab="manage">管理世界书</div>
                </div>
                <div id="wb-close" class="wb-header-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>

            <div class="wb-content">
                <!-- 编辑 -->
                <div id="wb-view-editor" class="wb-view-section">
                    <div class="wb-book-bar">
                        <div style="position:relative;flex:1">
                            <select id="wb-book-selector" style="width:100%">
                                <option>加载中...</option>
                            </select>
                        </div>
                        <button class="wb-btn-circle" id="wb-btn-import" title="导入"><i class="fa-solid fa-file-import"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-export" title="导出"><i class="fa-solid fa-file-export"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-create" title="新建"><i class="fa-solid fa-plus"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-rename" title="重命名"><i class="fa-solid fa-pen"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-delete" title="删除"><i class="fa-solid fa-trash"></i></button>
                        <input type="file" id="wb-import-file" accept=".json,.wb" style="display:none">
                    </div>

                    <div class="wb-stat-line">
                        <div class="wb-stat-group">
                            <div class="wb-stat-item" id="wb-display-count">0 条目</div>
                        </div>
                    </div>

                    <div class="wb-tool-bar">
                        <input class="wb-input-dark" id="wb-search-entry" style="flex:1" placeholder="搜索条目...">
                        <button class="wb-btn-circle" id="btn-sort-priority" title="按优先级重排"><i class="fa-solid fa-filter"></i></button>
                        <button class="wb-btn-circle" id="btn-add-entry" title="新建条目"><i class="fa-solid fa-plus"></i></button>
                    </div>

                    <div id="wb-batch-bar" class="wb-batch-bar wb-hidden">
                        <span id="wb-batch-count">已选 0/0</span>
                        <button class="wb-btn-rect mini" id="wb-select-all">全选</button>
                        <button class="wb-btn-rect mini" id="wb-select-invert">反选</button>
                        <button class="wb-btn-rect mini" id="wb-select-clear">清空</button>
                        <button class="wb-btn-rect mini" id="wb-batch-enable">批量开启</button>
                        <button class="wb-btn-rect mini" id="wb-batch-disable">批量关闭</button>
                        <button class="wb-btn-rect mini" id="wb-batch-const-on">常驻</button>
                        <button class="wb-btn-rect mini" id="wb-batch-const-off">非常驻</button>
                        <button class="wb-btn-rect mini" id="wb-batch-order-up">顺序+1</button>
                        <button class="wb-btn-rect mini" id="wb-batch-order-down">顺序-1</button>
                        <button class="wb-btn-rect mini" id="wb-batch-depth-up">深度+1</button>
                        <button class="wb-btn-rect mini" id="wb-batch-depth-down">深度-1</button>
                    </div>

                    <div class="wb-list" id="wb-entry-list"></div>
                </div>

                <!-- 缝合（双面板） -->
                <div id="wb-view-stitch" class="wb-view-section wb-hidden">
                    <div class="wb-stitch-shell">
                        <div class="wb-stitch-panels">
                            <div class="wb-stitch-panel" id="wb-stitch-left">
                                <div class="wb-stitch-top">
                                    <label>左侧世界书</label>
                                    <div style="position:relative;">
                                        <select id="wb-stitch-left-book"></select>
                                    </div>
                                </div>
                                <input class="wb-input-dark" id="wb-stitch-left-search" placeholder="搜索左侧条目...">
                                <div class="wb-stitch-mini-actions">
                                    <button class="wb-btn-rect mini" id="wb-stitch-left-all">全选</button>
                                    <button class="wb-btn-rect mini" id="wb-stitch-left-invert">反选</button>
                                    <button class="wb-btn-rect mini" id="wb-stitch-left-clear">清空</button>
                                    <button class="wb-btn-rect mini danger" id="wb-stitch-left-del">删除选中</button>
                                </div>
                                <div class="wb-stitch-list" id="wb-stitch-left-list"></div>
                                <div class="wb-stitch-foot" id="wb-stitch-left-foot"></div>
                            </div>

                            <div class="wb-stitch-mid">
                                <button class="wb-btn-rect" id="wb-copy-l2r">复制 →</button>
                                <button class="wb-btn-rect" id="wb-move-l2r">移动 →</button>
                                <button class="wb-btn-rect" id="wb-copy-r2l">← 复制</button>
                                <button class="wb-btn-rect" id="wb-move-r2l">← 移动</button>
                            </div>

                            <div class="wb-stitch-panel" id="wb-stitch-right">
                                <div class="wb-stitch-top">
                                    <label>右侧世界书</label>
                                    <div style="position:relative;">
                                        <select id="wb-stitch-right-book"></select>
                                    </div>
                                </div>
                                <input class="wb-input-dark" id="wb-stitch-right-search" placeholder="搜索右侧条目...">
                                <div class="wb-stitch-mini-actions">
                                    <button class="wb-btn-rect mini" id="wb-stitch-right-all">全选</button>
                                    <button class="wb-btn-rect mini" id="wb-stitch-right-invert">反选</button>
                                    <button class="wb-btn-rect mini" id="wb-stitch-right-clear">清空</button>
                                    <button class="wb-btn-rect mini danger" id="wb-stitch-right-del">删除选中</button>
                                </div>
                                <div class="wb-stitch-list" id="wb-stitch-right-list"></div>
                                <div class="wb-stitch-foot" id="wb-stitch-right-foot"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 绑定 -->
                <div id="wb-view-binding" class="wb-view-section wb-hidden">
                    <div class="wb-bind-grid">
                        <div class="wb-bind-card">
                            <div class="wb-bind-title">角色世界书</div>
                            <div class="wb-bind-label">主要世界书</div>
                            <div style="position:relative"><select id="wb-bind-char-primary" style="width:100%"></select></div>
                            <div class="wb-bind-label">附加世界书</div>
                            <div class="wb-scroll-list" id="wb-bind-char-list"></div>
                        </div>
                        <div class="wb-bind-card">
                            <div class="wb-bind-title">全局世界书</div>
                            <div class="wb-scroll-list" id="wb-bind-global-list"></div>
                        </div>
                        <div class="wb-bind-card">
                            <div class="wb-bind-title">聊天世界书</div>
                            <div style="position:relative"><select id="wb-bind-chat" style="width:100%"></select></div>
                        </div>
                    </div>
                </div>

                <!-- 管理 -->
                <div id="wb-view-manage" class="wb-view-section wb-hidden">
                    <div class="wb-manage-container">
                        <div class="wb-tool-bar">
                            <input class="wb-input-dark" id="wb-manage-search" style="width:100%" placeholder="搜索世界书...">
                        </div>
                        <div class="wb-manage-content" id="wb-manage-content"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        const $ = (sel) => panel.querySelector(sel);
        const $$ = (sel) => panel.querySelectorAll(sel);

        $('#wb-close').onclick = () => panel.remove();

        $$('.wb-tab').forEach((el) => {
            el.onclick = () => Actions.switchView(el.dataset.tab);
        });

        $('#wb-book-selector').addEventListener('change', (e) => Actions.loadBook(e.target.value));
        $('#wb-search-entry').oninput = (e) => UI.renderList(e.target.value);
        $('#btn-add-entry').onclick = () => Actions.addNewEntry();
        $('#btn-sort-priority').onclick = () => Actions.sortByPriority();

        $('#wb-btn-import').onclick = () => Actions.actionImport();
        $('#wb-btn-export').onclick = () => Actions.actionExport();
        $('#wb-btn-create').onclick = () => Actions.actionCreateNew();
        $('#wb-btn-rename').onclick = () => Actions.actionRename();
        $('#wb-btn-delete').onclick = () => Actions.actionDelete();

        const fileInput = $('#wb-import-file');
        fileInput.onchange = (e) => {
            if (e.target.files.length > 0) {
                Actions.actionHandleImport(e.target.files[0]);
                fileInput.value = '';
            }
        };

        $('#wb-select-all').onclick = () => Actions.selectAllVisible();
        $('#wb-select-invert').onclick = () => Actions.invertVisibleSelection();
        $('#wb-select-clear').onclick = () => Actions.clearSelection();

        $('#wb-batch-enable').onclick = () => Actions.batchUpdate((d) => { d.disable = false; });
        $('#wb-batch-disable').onclick = () => Actions.batchUpdate((d) => { d.disable = true; });
        $('#wb-batch-const-on').onclick = () => Actions.batchUpdate((d) => { d.constant = true; d.selective = false; });
        $('#wb-batch-const-off').onclick = () => Actions.batchUpdate((d) => { d.constant = false; d.selective = true; });
        $('#wb-batch-order-up').onclick = () => Actions.batchUpdate((d) => { d.order = (d.order ?? 0) + 1; });
        $('#wb-batch-order-down').onclick = () => Actions.batchUpdate((d) => { d.order = (d.order ?? 0) - 1; });
        $('#wb-batch-depth-up').onclick = () => Actions.batchUpdate((d) => { d.depth = (d.depth ?? 4) + 1; });
        $('#wb-batch-depth-down').onclick = () => Actions.batchUpdate((d) => { d.depth = Math.max(0, (d.depth ?? 4) - 1); });

        $('#wb-manage-search').oninput = (e) => UI.renderManageView(e.target.value);

        // stitch events
        $('#wb-stitch-left-book').addEventListener('change', async (e) => {
            await Actions.loadStitchBook('left', e.target.value);
            UI.renderStitchView();
        });
        $('#wb-stitch-right-book').addEventListener('change', async (e) => {
            await Actions.loadStitchBook('right', e.target.value);
            UI.renderStitchView();
        });

        $('#wb-stitch-left-search').oninput = (e) => {
            STATE.stitch.left.search = e.target.value || '';
            UI.renderStitchSide('left');
        };
        $('#wb-stitch-right-search').oninput = (e) => {
            STATE.stitch.right.search = e.target.value || '';
            UI.renderStitchSide('right');
        };

        $('#wb-stitch-left-all').onclick = () => Actions.selectAllStitch('left');
        $('#wb-stitch-left-invert').onclick = () => Actions.invertStitch('left');
        $('#wb-stitch-left-clear').onclick = () => Actions.clearStitch('left');
        $('#wb-stitch-left-del').onclick = () => Actions.deleteStitchSelected('left');

        $('#wb-stitch-right-all').onclick = () => Actions.selectAllStitch('right');
        $('#wb-stitch-right-invert').onclick = () => Actions.invertStitch('right');
        $('#wb-stitch-right-clear').onclick = () => Actions.clearStitch('right');
        $('#wb-stitch-right-del').onclick = () => Actions.deleteStitchSelected('right');

        $('#wb-copy-l2r').onclick = () => Actions.transferStitch('left', 'right', false);
        $('#wb-move-l2r').onclick = () => Actions.transferStitch('left', 'right', true);
        $('#wb-copy-r2l').onclick = () => Actions.transferStitch('right', 'left', false);
        $('#wb-move-r2l').onclick = () => Actions.transferStitch('right', 'left', true);

        Actions.refreshAllContext().then(async () => {
            let targetBook = null;
            const charPrimary = STATE.bindings.char.primary;
            const chatBook = STATE.bindings.chat;

            if (charPrimary && STATE.allBookNames.includes(charPrimary)) targetBook = charPrimary;
            else if (chatBook && STATE.allBookNames.includes(chatBook)) targetBook = chatBook;
            else if (STATE.allBookNames.length > 0) targetBook = STATE.allBookNames[0];

            UI.renderBookSelector();
            UI.renderGlobalStats();

            if (targetBook) await Actions.loadBook(targetBook);
            else UI.renderList();

            Actions.switchView('editor');
        }).catch((e) => {
            console.error(e);
            toastr.error('初始化面板失败');
        });
    },

    switchView(viewName) {
        document.querySelectorAll('.wb-tab').forEach((el) => {
            el.classList.toggle('active', el.dataset.tab === viewName);
        });

        document.querySelectorAll('.wb-view-section').forEach((el) => el.classList.add('wb-hidden'));
        const targetView = document.getElementById(`wb-view-${viewName}`);
        if (targetView) targetView.classList.remove('wb-hidden');
    },

    renderBookSelector() {
        const selector = document.getElementById('wb-book-selector');
        if (!selector) return;

        const { char, global, chat } = STATE.bindings;
        const allNames = STATE.allBookNames;
        const globalBooks = new Set(global);

        let html = '';

        if (char.primary) {
            html += '<optgroup label="主要世界书">';
            html += `<option value="${esc(char.primary)}">${esc(char.primary)}</option>`;
            html += '</optgroup>';
        }

        const additionalBooks = char.additional.filter((name) => name && name !== char.primary);
        if (additionalBooks.length > 0) {
            html += '<optgroup label="附加世界书">';
            additionalBooks.forEach((name) => { html += `<option value="${esc(name)}">${esc(name)}</option>`; });
            html += '</optgroup>';
        }

        if (globalBooks.size > 0) {
            html += '<optgroup label="全局启用">';
            [...globalBooks].forEach((name) => { html += `<option value="${esc(name)}">${esc(name)}</option>`; });
            html += '</optgroup>';
        }

        if (chat) {
            html += `<optgroup label="当前聊天"><option value="${esc(chat)}">${esc(chat)}</option></optgroup>`;
        }

        html += '<optgroup label="其他">';
        allNames.forEach((name) => { html += `<option value="${esc(name)}">${esc(name)}</option>`; });
        html += '</optgroup>';

        selector.innerHTML = html;
        if (STATE.currentBookName) selector.value = STATE.currentBookName;

        this.applyCustomDropdown('wb-book-selector');
    },

    renderGlobalStats() {
        const countEl = document.getElementById('wb-display-count');
        if (!countEl) return;

        let blueTokens = 0;
        let greenTokens = 0;

        STATE.entries.forEach((entry) => {
            if (entry.disable === false) {
                const t = Actions.getTokenCount(entry.content);
                if (entry.constant === true) blueTokens += t;
                else greenTokens += t;
            }
        });

        countEl.innerHTML = `${STATE.entries.length} 条目 | ${blueTokens + greenTokens} Tokens (<span class="wb-text-blue">${blueTokens}</span> + <span class="wb-text-green">${greenTokens}</span>)`;
    },

    updateSelectionBar() {
        const bar = document.getElementById('wb-batch-bar');
        const cnt = document.getElementById('wb-batch-count');
        if (!bar || !cnt) return;

        cnt.textContent = `已选 ${STATE.selectedUids.size}/${STATE.entries.length}`;
        bar.classList.toggle('wb-hidden', STATE.selectedUids.size === 0);
    },

    renderList(filterText = '') {
        const list = document.getElementById('wb-entry-list');
        if (!list) return;
        list.innerHTML = '';

        const term = String(filterText || '').toLowerCase();

        STATE.entries.forEach((entry, index) => {
            const name = entry.comment || '';
            if (term && !name.toLowerCase().includes(term)) return;

            const card = this.createCard(entry, index);
            list.appendChild(card);
            this.applyCustomDropdown(`wb-pos-${entry.uid}`);
        });

        if (!list.children.length) {
            list.innerHTML = '<div class="wb-empty">没有可显示条目</div>';
        }

        this.updateSelectionBar();
    },

    updateCardStatus(uid) {
        const entry = STATE.entries.find((e) => e.uid === uid);
        const card = document.querySelector(`.wb-card[data-uid="${uid}"]`);
        if (!entry || !card) return;

        card.classList.remove('disabled', 'type-green', 'type-blue');

        if (entry.disable) {
            card.classList.add('disabled');
        } else if (entry.constant) {
            card.classList.add('type-blue');
        } else {
            card.classList.add('type-green');
        }

        const tokenEl = card.querySelector('.wb-token-display');
        if (tokenEl) tokenEl.textContent = Actions.getTokenCount(entry.content);
    },

    createCard(entry, index) {
        const isEnabled = !entry.disable;
        const isConstant = !!entry.constant;
        const isSelected = STATE.selectedUids.has(entry.uid);
        const keys = entry.key || [];

        const card = document.createElement('div');
        card.className = `wb-card ${isEnabled ? '' : 'disabled'} ${isEnabled ? (isConstant ? 'type-blue' : 'type-green') : ''}`;
        card.dataset.uid = entry.uid;
        card.dataset.index = index;

        const curPosInt = typeof entry.position === 'number' ? entry.position : 1;
        const curPosStr = WI_POSITION_MAP[curPosInt] || 'after_character_definition';

        const corePositions = ['before_character_definition', 'after_character_definition', 'at_depth'];
        const allPosOptions = [
            { v: 'before_character_definition', t: '角色定义之前' },
            { v: 'after_character_definition', t: '角色定义之后' },
            { v: 'before_example_messages', t: '示例消息之前' },
            { v: 'after_example_messages', t: '示例消息之后' },
            { v: 'before_author_note', t: '作者注释之前' },
            { v: 'after_author_note', t: '作者注释之后' },
            { v: 'at_depth', t: '@D' },
        ];

        const showCoreOnly = corePositions.includes(curPosStr);

        let optionsHtml = '';
        allPosOptions.forEach((opt) => {
            if (showCoreOnly && !corePositions.includes(opt.v)) return;
            const selected = opt.v === curPosStr ? 'selected' : '';
            optionsHtml += `<option value="${opt.v}" ${selected}>${opt.t}</option>`;
        });

        const warningIcon = isEnabled && !isConstant && !(keys.length > 0)
            ? '<i class="fa-solid fa-circle-exclamation wb-warning-icon" title="绿灯条目已启用但未设置关键词"></i>'
            : '';

        card.innerHTML = `
            <div class="wb-card-header">
                <div class="wb-card-main">
                    <div class="wb-row">
                        <input type="checkbox" class="wb-inp-select" ${isSelected ? 'checked' : ''} title="选择条目">
                        <input class="wb-inp-title inp-name" value="${esc(entry.comment)}" placeholder="条目名称">
                        <div class="wb-warning-container">${warningIcon}</div>
                        <i class="fa-solid fa-eye btn-preview" title="编辑内容"></i>
                        <i class="fa-solid fa-trash btn-delete" title="删除条目"></i>
                    </div>
                    <div class="wb-row">
                        <div class="wb-ctrl-group">
                            <label class="wb-switch">
                                <input type="checkbox" class="inp-enable" ${isEnabled ? 'checked' : ''}>
                                <span class="wb-slider purple"></span>
                            </label>
                        </div>
                        <div class="wb-ctrl-group">
                            <label class="wb-switch">
                                <input type="checkbox" class="inp-type" ${isConstant ? 'checked' : ''}>
                                <span class="wb-slider blue"></span>
                            </label>
                        </div>
                        <div class="wb-pos-wrapper">
                            <select id="wb-pos-${entry.uid}" class="wb-input-dark inp-pos">${optionsHtml}</select>
                            <input type="number" class="wb-inp-num inp-pos-depth" style="display:${curPosStr === 'at_depth' ? 'block' : 'none'}" value="${entry.depth ?? 4}" placeholder="D">
                        </div>
                        <div class="wb-ctrl-group order-group" title="顺序">
                            <span>顺序</span>
                            <input type="number" class="wb-inp-num inp-order" value="${entry.order ?? 0}">
                        </div>
                        <div class="wb-input-dark wb-token-display" title="Tokens">${Actions.getTokenCount(entry.content)}</div>
                    </div>
                </div>
            </div>
        `;

        const bind = (sel, evt, fn) => {
            const el = card.querySelector(sel);
            if (el) el.addEventListener(evt, fn);
        };

        bind('.wb-inp-select', 'change', (e) => Actions.toggleSelect(entry.uid, e.target.checked));
        bind('.inp-name', 'input', (e) => Actions.updateEntry(entry.uid, (d) => { d.comment = e.target.value; }));
        bind('.inp-enable', 'change', (e) => Actions.updateEntry(entry.uid, (d) => { d.disable = !e.target.checked; }));
        bind('.inp-type', 'change', (e) => Actions.updateEntry(entry.uid, (d) => {
            d.constant = e.target.checked;
            d.selective = !d.constant;
        }));

        bind('.inp-pos', 'change', (e) => {
            const val = e.target.value;
            const depthInput = card.querySelector('.inp-pos-depth');
            if (depthInput) depthInput.style.display = val === 'at_depth' ? 'block' : 'none';
            const intVal = WI_POSITION_MAP_REV[val] ?? 1;
            Actions.updateEntry(entry.uid, (d) => { d.position = intVal; });
        });

        bind('.inp-pos-depth', 'input', (e) => Actions.updateEntry(entry.uid, (d) => { d.depth = Number(e.target.value); }));
        bind('.inp-order', 'input', (e) => Actions.updateEntry(entry.uid, (d) => { d.order = Number(e.target.value); }));

        bind('.btn-delete', 'click', () => Actions.deleteEntry(entry.uid));
        bind('.btn-preview', 'click', () => UI.openContentPopup(entry));

        return card;
    },

    openContentPopup(entry) {
        const old = document.getElementById('wb-content-popup-overlay');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'wb-content-popup-overlay';
        overlay.className = 'wb-modal-overlay';

        let tempContent = entry.content || '';
        let tempKeys = (entry.key || []).map((k) => String(k).replace(/，/g, ',')).join(',');

        overlay.innerHTML = `
            <div class="wb-content-popup">
                <div class="wb-popup-header">${esc(entry.comment || '未命名条目')}</div>
                <input class="wb-popup-input-keys" placeholder="关键词 (英文逗号分隔)" value="${esc(tempKeys)}">
                <textarea class="wb-popup-textarea" placeholder="在此编辑内容...">${esc(tempContent)}</textarea>
                <div class="wb-popup-footer">
                    <button class="wb-btn-black btn-cancel">取消</button>
                    <button class="wb-btn-black btn-save">保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const keysInput = overlay.querySelector('.wb-popup-input-keys');
        const textarea = overlay.querySelector('.wb-popup-textarea');

        textarea.oninput = (e) => { tempContent = e.target.value; };
        keysInput.oninput = (e) => { tempKeys = e.target.value; };

        const close = () => overlay.remove();
        overlay.querySelector('.btn-cancel').onclick = close;

        overlay.querySelector('.btn-save').onclick = () => {
            Actions.updateEntry(entry.uid, (d) => { d.content = tempContent; });
            const finalKeys = tempKeys.replace(/，/g, ',').split(',').map((s) => s.trim()).filter(Boolean);
            Actions.updateEntry(entry.uid, (d) => { d.key = finalKeys; });
            UI.updateCardStatus(entry.uid);
            UI.renderGlobalStats();
            close();
        };

        overlay.onclick = (e) => { if (e.target === overlay) close(); };
    },

    renderBindingView() {
        const allNames = STATE.allBookNames;
        const { char, global, chat } = STATE.bindings;
        const view = document.getElementById('wb-view-binding');
        if (!view) return;

        const createOpts = (selectedVal) => {
            let html = '<option value="">(无)</option>';
            allNames.forEach((name) => {
                const sel = name === selectedVal ? 'selected' : '';
                html += `<option value="${esc(name)}" ${sel}>${esc(name)}</option>`;
            });
            return html;
        };

        const createMultiSelect = (containerSelector, initialSelectedArray, dataClass) => {
            const container = view.querySelector(containerSelector);
            if (!container) return;
            container.innerHTML = '';
            container.className = 'wb-multi-select';

            const selectedSet = new Set(initialSelectedArray.filter((n) => allNames.includes(n)));
            const dom = document.createElement('div');
            dom.innerHTML = `
                <div class="wb-ms-tags"></div>
                <div class="wb-ms-dropdown">
                    <div class="wb-ms-search"><input type="text" placeholder="搜索选项..."></div>
                    <div class="wb-ms-list"></div>
                </div>
            `;
            container.appendChild(dom);

            const tagsEl = dom.querySelector('.wb-ms-tags');
            const dropEl = dom.querySelector('.wb-ms-dropdown');
            const inputEl = dom.querySelector('input');
            const listEl = dom.querySelector('.wb-ms-list');

            const filterList = (term) => {
                const lower = term.toLowerCase();
                listEl.querySelectorAll('.wb-ms-item').forEach((item) => {
                    item.classList.toggle('hidden', !item.textContent.toLowerCase().includes(lower));
                });
            };

            const refresh = () => {
                tagsEl.innerHTML = '';
                if (selectedSet.size === 0) {
                    tagsEl.innerHTML = '<div class="wb-ms-placeholder">点击选择世界书...</div>';
                } else {
                    selectedSet.forEach((name) => {
                        const tag = document.createElement('div');
                        tag.className = 'wb-ms-tag';
                        tag.dataset.val = name;
                        tag.dataset.bindType = dataClass;
                        tag.innerHTML = `<span>${esc(name)}</span><span class="wb-ms-tag-close">×</span>`;
                        tag.ondblclick = () => Actions.jumpToEditor(name);
                        tag.querySelector('.wb-ms-tag-close').onclick = (e) => {
                            e.stopPropagation();
                            selectedSet.delete(name);
                            refresh();
                            Actions.saveBindings();
                        };
                        tagsEl.appendChild(tag);
                    });
                }

                listEl.innerHTML = '';
                const available = allNames.filter((n) => !selectedSet.has(n));
                if (available.length === 0) {
                    listEl.innerHTML = '<div class="wb-ms-empty">没有更多选项</div>';
                } else {
                    available.forEach((name) => {
                        const item = document.createElement('div');
                        item.className = 'wb-ms-item';
                        item.textContent = name;
                        item.ondblclick = () => Actions.jumpToEditor(name);
                        item.onclick = () => {
                            selectedSet.add(name);
                            inputEl.value = '';
                            refresh();
                            Actions.saveBindings();
                        };
                        listEl.appendChild(item);
                    });
                    filterList(inputEl.value);
                }
            };

            tagsEl.onclick = () => {
                const isVisible = dropEl.classList.contains('show');
                document.querySelectorAll('.wb-ms-dropdown.show').forEach((el) => el.classList.remove('show'));
                if (!isVisible) {
                    dropEl.classList.add('show');
                    const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
                    if (!isTouchDevice) inputEl.focus();
                }
            };

            inputEl.oninput = (e) => filterList(e.target.value);
            document.addEventListener('click', (e) => { if (!dom.contains(e.target)) dropEl.classList.remove('show'); });

            refresh();
        };

        view.querySelector('#wb-bind-char-primary').innerHTML = createOpts(char.primary);
        view.querySelector('#wb-bind-chat').innerHTML = createOpts(chat);

        createMultiSelect('#wb-bind-char-list', char.additional, 'wb-bind-char-add');
        createMultiSelect('#wb-bind-global-list', global, 'wb-bind-global');

        ['wb-bind-char-primary', 'wb-bind-chat'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
                el.onchange = () => Actions.saveBindings();
                el.ondblclick = () => { if (el.value) Actions.jumpToEditor(el.value); };
                this.applyCustomDropdown(id);
            }
        });
    },

    renderManageView(filterText = '') {
        const container = document.getElementById('wb-manage-content');
        if (!container) return;

        const term = String(filterText || '').toLowerCase();
        const boundMap = STATE.boundBooksSet || {};

        container.innerHTML = '';
        STATE.allBookNames
            .filter((name) => !term || name.toLowerCase().includes(term))
            .forEach((bookName) => {
                const boundChars = boundMap[bookName] || [];
                const card = document.createElement('div');
                card.className = 'wb-manage-card';

                card.innerHTML = `
                    <div class="wb-card-top">
                        <div class="wb-card-info">
                            <span class="wb-card-title">${esc(bookName)}</span>
                            ${boundChars.length ? `<div class="wb-card-subtitle">${esc(boundChars.join(', '))}</div>` : ''}
                        </div>
                        <div class="wb-manage-icons">
                            <div class="wb-icon-action btn-open" title="跳转编辑"><i class="fa-solid fa-eye"></i></div>
                            <div class="wb-icon-action btn-bind" title="绑定到当前角色"><i class="fa-solid fa-link"></i></div>
                            <div class="wb-icon-action btn-del" title="删除"><i class="fa-solid fa-trash"></i></div>
                        </div>
                    </div>
                `;

                card.querySelector('.btn-open').onclick = () => Actions.jumpToEditor(bookName);
                card.querySelector('.btn-bind').onclick = async () => {
                    const context = getContext();
                    const currentChar = context.characters[context.characterId]?.name;
                    if (!currentChar) return toastr.warning('当前没有加载角色，无法绑定');
                    await setCharBindings('primary', bookName, true);
                    await Actions.refreshAllContext();
                    toastr.success(`已绑定为 ${currentChar} 的主世界书`);
                    this.renderManageView(filterText);
                };
                card.querySelector('.btn-del').onclick = async () => {
                    if (!confirm(`确定删除 "${bookName}" ?`)) return;
                    if (STATE.currentBookName === bookName && STATE.debouncer) {
                        clearTimeout(STATE.debouncer);
                        STATE.debouncer = null;
                    }
                    await API.deleteWorldbook(bookName);
                    if (STATE.currentBookName === bookName) {
                        STATE.currentBookName = null;
                        STATE.entries = [];
                    }
                    await Actions.refreshAllContext();
                    this.renderManageView(filterText);
                    this.renderList(document.getElementById('wb-search-entry')?.value || '');
                    this.renderGlobalStats();
                };

                container.appendChild(card);
            });
    },

    getStitchVisible(side) {
        const panel = STATE.stitch[side];
        const term = (panel.search || '').trim().toLowerCase();
        if (!term) return panel.entries;
        return panel.entries.filter((e) => String(e.comment || '').toLowerCase().includes(term));
    },

    renderStitchView() {
        const leftSel = document.getElementById('wb-stitch-left-book');
        const rightSel = document.getElementById('wb-stitch-right-book');
        if (!leftSel || !rightSel) return;

        const all = STATE.allBookNames;
        const leftBook = STATE.stitch.left.book;
        const rightBook = STATE.stitch.right.book;

        const optionsHtml = (current) => all.map((n) => `<option value="${esc(n)}" ${n === current ? 'selected' : ''}>${esc(n)}</option>`).join('');

        leftSel.innerHTML = optionsHtml(leftBook);
        rightSel.innerHTML = optionsHtml(rightBook);

        this.applyCustomDropdown('wb-stitch-left-book');
        this.applyCustomDropdown('wb-stitch-right-book');

        const leftSearch = document.getElementById('wb-stitch-left-search');
        const rightSearch = document.getElementById('wb-stitch-right-search');
        if (leftSearch) leftSearch.value = STATE.stitch.left.search || '';
        if (rightSearch) rightSearch.value = STATE.stitch.right.search || '';

        this.renderStitchSide('left');
        this.renderStitchSide('right');
    },

    renderStitchSide(side) {
        const listEl = document.getElementById(`wb-stitch-${side}-list`);
        const footEl = document.getElementById(`wb-stitch-${side}-foot`);
        if (!listEl || !footEl) return;

        const panel = STATE.stitch[side];
        const visible = this.getStitchVisible(side);

        listEl.innerHTML = '';
        visible.forEach((entry) => {
            const item = document.createElement('div');
            item.className = 'wb-stitch-item';
            item.innerHTML = `
                <label class="wb-stitch-item-check">
                    <input type="checkbox" ${panel.selected.has(entry.uid) ? 'checked' : ''}>
                </label>
                <div class="wb-stitch-item-body">
                    <div class="wb-stitch-item-title">${esc(entry.comment || '无标题条目')}</div>
                    <div class="wb-stitch-item-meta">${esc(WI_POSITION_MAP[entry.position] || 'pos?')} / O:${entry.order ?? 0} / D:${entry.depth ?? 4} / T:${Actions.getTokenCount(entry.content)}</div>
                </div>
            `;

            const chk = item.querySelector('input[type="checkbox"]');
            chk.onchange = (e) => Actions.toggleStitchSelect(side, entry.uid, e.target.checked);

            listEl.appendChild(item);
        });

        if (!visible.length) {
            listEl.innerHTML = '<div class="wb-empty">没有匹配条目</div>';
        }

        footEl.textContent = `已选 ${panel.selected.size} / 可见 ${visible.length} / 总计 ${panel.entries.length}`;
    },

    applyCustomDropdown(selectId) {
        const originalSelect = document.getElementById(selectId);
        if (!originalSelect) return;

        let trigger = document.getElementById(`wb-trigger-${selectId}`);
        if (originalSelect.style.display !== 'none') {
            originalSelect.style.display = 'none';
            if (trigger) trigger.remove();

            trigger = document.createElement('div');
            trigger.id = `wb-trigger-${selectId}`;
            trigger.className = 'wb-gr-trigger';

            originalSelect.parentNode.insertBefore(trigger, originalSelect.nextSibling);
            trigger.onclick = (e) => {
                e.stopPropagation();
                this.toggleCustomDropdown(selectId, trigger);
            };
        }

        const update = () => {
            const selectedOpt = originalSelect.options[originalSelect.selectedIndex];
            trigger.textContent = selectedOpt ? selectedOpt.text : '请选择...';
        };
        update();

        if (!originalSelect._wbBindedChangeUpdate) {
            originalSelect.addEventListener('change', update);
            originalSelect._wbBindedChangeUpdate = true;
        } else {
            update();
        }
    },

    toggleCustomDropdown(selectId, triggerElem) {
        const existing = document.getElementById('wb-active-dropdown');
        if (existing) {
            const isSame = existing.dataset.source === selectId;
            existing.remove();
            if (isSame) return;
        }

        const originalSelect = document.getElementById(selectId);
        if (!originalSelect) return;

        const dropdown = document.createElement('div');
        dropdown.id = 'wb-active-dropdown';
        dropdown.className = 'wb-gr-dropdown show';
        dropdown.dataset.source = selectId;

        const searchBox = document.createElement('div');
        searchBox.className = 'wb-gr-search-box';
        const searchInput = document.createElement('input');
        searchInput.className = 'wb-gr-search-input';
        searchInput.placeholder = '搜索选项...';
        searchInput.onclick = (e) => e.stopPropagation();
        searchBox.appendChild(searchInput);

        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'wb-gr-options-container';

        const createOption = (optNode) => {
            const div = document.createElement('div');
            div.className = 'wb-gr-option';
            div.textContent = optNode.text;
            if (optNode.selected) div.classList.add('selected');
            div.onclick = (e) => {
                e.stopPropagation();
                originalSelect.value = optNode.value;
                originalSelect.dispatchEvent(new Event('change'));
                dropdown.remove();
            };
            optionsContainer.appendChild(div);
        };

        Array.from(originalSelect.children).forEach((child) => {
            if (child.tagName === 'OPTGROUP') {
                const label = document.createElement('div');
                label.className = 'wb-gr-group-label';
                label.textContent = child.label;
                optionsContainer.appendChild(label);
                Array.from(child.children).forEach(createOption);
            } else if (child.tagName === 'OPTION') {
                createOption(child);
            }
        });

        if (originalSelect.options.length > 8) dropdown.appendChild(searchBox);
        dropdown.appendChild(optionsContainer);
        document.body.appendChild(dropdown);

        const rect = triggerElem.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + 5}px`;
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.width = `${rect.width}px`;

        const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
        if (!isTouchDevice) searchInput.focus();

        searchInput.oninput = (e) => {
            const term = e.target.value.toLowerCase();
            optionsContainer.querySelectorAll('.wb-gr-option').forEach((o) => {
                o.classList.toggle('hidden', !o.textContent.toLowerCase().includes(term));
            });
        };

        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== triggerElem) {
                dropdown.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    },
};

jQuery(async () => {
    const injectButton = () => {
        if (document.getElementById(CONFIG.btnId)) return;

        const container = document.querySelector('#options .options-content');
        if (!container) return;

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
    };

    injectButton();

    const performInit = async () => {
        try {
            await Actions.init();
            console.log('[Worldbook Editor] Pre-loading complete.');
        } catch (e) {
            console.error('[Worldbook Editor] Pre-loading failed:', e);
        }
    };

    if (typeof world_names === 'undefined') {
        eventSource.on(event_types.APP_READY, performInit);
    } else {
        performInit();
    }

    console.log('Worldbook Editor Enhanced Script Loaded');
});
