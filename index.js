import { getContext } from '../../../extensions.js';
import { event_types, eventSource } from '../../../../script.js';
import { getCharaFilename } from '../../../utils.js';
import {
    world_info,
    world_names,
    selected_world_info,
} from '../../../world-info.js';

const CONFIG = {
    id: 'enhanced-wb-panel-v6',
    btnId: 'wb-menu-btn-v6',
    settingsKey: 'WorldbookEditor_Metadata',
    presetStoreKey: '__ENTRY_STATE_PRESETS__',
};

const STATE = {
    currentView: 'editor',
    currentBookName: null,
    isInitialized: false,
    entries: [],
    allBookNames: [],
    metadata: {},
    boundBooksSet: {},
    editorSearch: '',
    selectedUids: new Set(),
    batchEditMode: false,
    bindings: {
        char: { primary: null, additional: [] },
        global: [],
        chat: null,
    },
    debouncer: null,
    stitch: {
        mode: 'copy',
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

function cloneData(data) {
    try {
        return structuredClone(data);
    } catch (_e) {
        return JSON.parse(JSON.stringify(data));
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

function normalizeEntry(raw, uidKey, index) {
    const entry = cloneData(raw || {});
    const uidFallback = Number(uidKey);
    entry.uid = Number.isFinite(Number(entry.uid)) ? Number(entry.uid) : (Number.isFinite(uidFallback) ? uidFallback : index);
    entry.comment = String(entry.comment ?? entry.name ?? entry.title ?? `条目 ${entry.uid}`);
    entry.content = String(entry.content ?? '');
    entry.key = Array.isArray(entry.key) ? entry.key : [];
    entry.disable = !!entry.disable;
    entry.constant = !!entry.constant;
    entry.position = typeof entry.position === 'number' ? entry.position : 1;
    entry.depth = Number.isFinite(Number(entry.depth)) ? Number(entry.depth) : 4;
    entry.order = Number.isFinite(Number(entry.order)) ? Number(entry.order) : index;
    entry.selective = typeof entry.selective === 'boolean' ? entry.selective : !entry.constant;
    return entry;
}

function getCharLoreFileName(character) {
    const avatar = character?.avatar || '';
    if (!avatar) return '';
    const byCore = getCharaFilename(null, { manualAvatarKey: avatar });
    if (byCore) return byCore;
    return avatar.replace(/\.[^/.]+$/, '');
}

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
        const targetName = isEnabled ? worldName : '';
        await charUpdatePrimaryWorld(targetName);
        return;
    }

    if (type === 'auxiliary') {
        const charId = context.characterId;
        if (!charId && charId !== 0) return;

        const character = context.characters[charId];
        const charFileName = getCharLoreFileName(character);
        if (!charFileName) return;

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
        if (isEnabled) {
            context.chatMetadata.world_info = worldName;
        } else if (context.chatMetadata.world_info === worldName) {
            delete context.chatMetadata.world_info;
        }
        context.saveMetadataDebounced();
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
        let additional = [];

        const fileName = getCharLoreFileName(character);
        if (fileName) {
            const charLore = world_info.charLore || [];
            const entry = charLore.find((e) => e.name === fileName);
            if (entry && Array.isArray(entry.extraBooks)) additional = [...entry.extraBooks];
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

        const safeEntries = data.entries ? cloneData(data.entries) : {};
        const arr = [];

        Object.entries(safeEntries).forEach(([uidKey, entry], idx) => {
            arr.push(normalizeEntry(entry, uidKey, idx));
        });

        return arr.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },

    async saveBookEntries(name, entriesArray) {
        if (!name || !Array.isArray(entriesArray)) return;

        const oldData = await getContext().loadWorldInfo(name) || { entries: {} };
        const newEntriesObj = {};

        entriesArray.forEach((entry) => {
            const uid = entry.uid;
            const oldEntry = (oldData.entries && oldData.entries[uid]) ? oldData.entries[uid] : {};
            newEntriesObj[uid] = { ...oldEntry, ...cloneData(entry) };
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
            if (chatBinding === oldName) {
                await setCharBindings('chat', newName, true);
            }
        } catch (_e) {
            toastr.warning('重命名成功，但绑定迁移遇到错误');
        }

        await this.deleteWorldbook(oldName);
    },
};

const Actions = {
    async flushPendingSave() {
        if (!STATE.debouncer) return;
        clearTimeout(STATE.debouncer);
        STATE.debouncer = null;
        if (STATE.currentBookName && Array.isArray(STATE.entries)) {
            await API.saveBookEntries(STATE.currentBookName, STATE.entries);
        }
    },

    queueSave() {
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

    getEntrySortScore(entry) {
        const context = getContext();
        const anDepth = (context.chatMetadata && context.chatMetadata.note_depth)
            ?? (context.extensionSettings?.note?.defaultDepth)
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
        this.registerEvents();
        await this.refreshAllContext();
        STATE.isInitialized = true;
    },

    registerEvents() {
        const es = eventSource;
        const et = event_types;

        es.on(et.SETTINGS_UPDATED, () => {
            if (document.getElementById(CONFIG.id)) this.refreshAllContext();
        });

        es.on(et.WORLDINFO_UPDATED, (name) => {
            if (STATE.currentBookName === name) this.loadBook(name);
        });

        es.on(et.CHAT_CHANGED, () => {
            if (document.getElementById(CONFIG.id)) this.refreshAllContext();
        });

        es.on(et.CHARACTER_SELECTED, () => {
            setTimeout(() => this.refreshAllContext(), 100);
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
            UI.renderBindingView();
            UI.renderPresetBar();

            if (STATE.currentView === 'manage') UI.renderManageView();
            if (STATE.currentView === 'stitch') UI.renderStitchView();
        } catch (_e) {
            // noop
        }
    },

    switchView(viewName) {
        STATE.currentView = viewName;
        UI.switchView(viewName);
    },

    async loadBook(name) {
        if (!name) return;
        await this.flushPendingSave();

        STATE.currentBookName = name;
        STATE.selectedUids.clear();

        const loadedEntries = await API.loadBook(name);
        if (STATE.currentBookName !== name) return;

        STATE.entries = loadedEntries;
        STATE.entries.sort((a, b) => {
            const scoreA = this.getEntrySortScore(a);
            const scoreB = this.getEntrySortScore(b);
            if (scoreA !== scoreB) return scoreB - scoreA;
            return (a.order ?? 0) - (b.order ?? 0) || a.uid - b.uid;
        });

        UI.renderBookSelector();
        UI.renderPresetBar();
        UI.renderGlobalStats();
        UI.renderList(STATE.editorSearch || '');
        UI.updateSelectionInfo();
    },

    updateEntry(uid, updater) {
        const entry = STATE.entries.find((e) => e.uid === uid);
        if (!entry) return;
        updater(entry);
        UI.updateCardStatus(uid);
        UI.renderGlobalStats();
        this.queueSave();
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
        STATE.selectedUids.delete(Number(uid));
        await API.deleteEntries(STATE.currentBookName, [uid]);
        await this.loadBook(STATE.currentBookName);
    },

    sortByPriority() {
        STATE.entries.sort((a, b) => {
            const scoreA = this.getEntrySortScore(a);
            const scoreB = this.getEntrySortScore(b);
            if (scoreA !== scoreB) return scoreB - scoreA;
            const orderA = a.order ?? 0;
            const orderB = b.order ?? 0;
            if (orderA !== orderB) return orderA - orderB;
            return a.uid - b.uid;
        });

        UI.renderList(STATE.editorSearch);
        API.saveBookEntries(STATE.currentBookName, STATE.entries);
        toastr.success('已按优先级重排');
    },

    getVisibleEntries() {
        const term = String(STATE.editorSearch || '').toLowerCase().trim();
        return STATE.entries.filter((e) => {
            if (!term) return true;
            return String(e.comment || '').toLowerCase().includes(term);
        });
    },

    selectEntry(uid, checked) {
        const id = Number(uid);
        if (checked) STATE.selectedUids.add(id);
        else STATE.selectedUids.delete(id);
        UI.updateSelectionInfo();
        const card = document.querySelector(`.wb-card[data-uid="${id}"]`);
        if (card) card.classList.toggle('selected', checked);
    },

    selectAllVisible() {
        this.getVisibleEntries().forEach((e) => STATE.selectedUids.add(Number(e.uid)));
        UI.renderList(STATE.editorSearch);
    },

    invertVisibleSelection() {
        this.getVisibleEntries().forEach((e) => {
            const uid = Number(e.uid);
            if (STATE.selectedUids.has(uid)) STATE.selectedUids.delete(uid);
            else STATE.selectedUids.add(uid);
        });
        UI.renderList(STATE.editorSearch);
    },

    clearSelection() {
        STATE.selectedUids.clear();
        UI.renderList(STATE.editorSearch);
    },

    getSelectedEntries() {
        return STATE.entries.filter((e) => STATE.selectedUids.has(Number(e.uid)));
    },

    batchMutate(mutator) {
        const selected = this.getSelectedEntries();
        if (!selected.length) {
            toastr.warning('请先选择条目');
            return false;
        }

        selected.forEach((entry) => mutator(entry));
        UI.renderList(STATE.editorSearch);
        UI.renderGlobalStats();
        this.queueSave();
        return true;
    },

    batchEnable(value) {
        this.batchMutate((entry) => {
            entry.disable = !value;
        });
    },

    batchConstant(value) {
        this.batchMutate((entry) => {
            entry.constant = !!value;
            entry.selective = !entry.constant;
        });
    },

    batchSetPosition(posKey) {
        const posVal = WI_POSITION_MAP_REV[posKey];
        if (posVal === undefined) {
            toastr.warning('请选择有效位置');
            return;
        }
        this.batchMutate((entry) => {
            entry.position = posVal;
        });
    },

    batchSetDepth(depthValue) {
        const depth = Number(depthValue);
        if (!Number.isFinite(depth) || depth < 0) {
            toastr.warning('深度请输入 >= 0 的数字');
            return;
        }
        this.batchMutate((entry) => {
            entry.depth = depth;
        });
    },

    batchSetOrder(startOrderValue) {
        const start = Number(startOrderValue);
        if (!Number.isFinite(start)) {
            toastr.warning('顺序请输入数字');
            return;
        }

        const selected = this.getSelectedEntries();
        if (!selected.length) {
            toastr.warning('请先选择条目');
            return;
        }

        selected
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.uid - b.uid)
            .forEach((entry, idx) => {
                entry.order = start + idx;
            });

        STATE.entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.uid - b.uid);
        UI.renderList(STATE.editorSearch);
        UI.renderGlobalStats();
        this.queueSave();
    },

    getPresetStore() {
        if (!STATE.metadata[CONFIG.presetStoreKey]) STATE.metadata[CONFIG.presetStoreKey] = {};
        return STATE.metadata[CONFIG.presetStoreKey];
    },

    getBookPresets(bookName) {
        const store = this.getPresetStore();
        return Array.isArray(store[bookName]) ? store[bookName] : [];
    },

    async saveCurrentPreset() {
        if (!STATE.currentBookName) return toastr.warning('请先选择世界书');

        const defaultName = `状态_${new Date().toLocaleTimeString().replace(/:/g, '-')}`;
        const name = prompt('输入状态名称：', defaultName);
        if (!name) return;

        const list = this.getBookPresets(STATE.currentBookName);
        const snapshot = {};

        STATE.entries.forEach((entry) => {
            snapshot[entry.uid] = {
                disable: !!entry.disable,
                constant: !!entry.constant,
                position: Number(entry.position ?? 1),
                order: Number(entry.order ?? 0),
                depth: Number(entry.depth ?? 4),
            };
        });

        const existsIndex = list.findIndex((p) => p.name === name);
        const preset = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name,
            snapshot,
            updatedAt: Date.now(),
        };

        if (existsIndex >= 0) list[existsIndex] = preset;
        else list.push(preset);

        const store = this.getPresetStore();
        store[STATE.currentBookName] = list;
        STATE.metadata[CONFIG.presetStoreKey] = store;

        await API.saveMetadata(STATE.metadata);
        UI.renderPresetBar();
        toastr.success(`已保存状态：${name}`);
    },

    async applyPreset(presetId) {
        if (!STATE.currentBookName || !presetId) return toastr.warning('请选择一个状态');

        const list = this.getBookPresets(STATE.currentBookName);
        const preset = list.find((p) => p.id === presetId);
        if (!preset) return toastr.warning('状态不存在');

        const snapshot = preset.snapshot || {};
        STATE.entries.forEach((entry) => {
            const snap = snapshot[entry.uid];
            if (!snap) return;
            entry.disable = !!snap.disable;
            entry.constant = !!snap.constant;
            entry.selective = !entry.constant;
            entry.position = Number.isFinite(Number(snap.position)) ? Number(snap.position) : entry.position;
            entry.order = Number.isFinite(Number(snap.order)) ? Number(snap.order) : entry.order;
            entry.depth = Number.isFinite(Number(snap.depth)) ? Number(snap.depth) : entry.depth;
        });

        STATE.entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.uid - b.uid);
        UI.renderList(STATE.editorSearch);
        UI.renderGlobalStats();
        this.queueSave();
        toastr.success(`已切换到状态：${preset.name}`);
    },

    async deletePreset(presetId) {
        if (!STATE.currentBookName || !presetId) return toastr.warning('请选择要删除的状态');

        const list = this.getBookPresets(STATE.currentBookName);
        const idx = list.findIndex((p) => p.id === presetId);
        if (idx < 0) return;
        if (!confirm(`确定删除状态 "${list[idx].name}" 吗？`)) return;

        list.splice(idx, 1);
        const store = this.getPresetStore();
        store[STATE.currentBookName] = list;
        STATE.metadata[CONFIG.presetStoreKey] = store;

        await API.saveMetadata(STATE.metadata);
        UI.renderPresetBar();
        toastr.success('状态已删除');
    },

    async saveBindings() {
        const view = document.getElementById('wb-view-binding');
        if (!view) return;

        const charPrimary = view.querySelector('#wb-bind-char-primary').value;
        const charAddTags = view.querySelectorAll('.wb-ms-tag[data-bind-type="wb-bind-char-add"]');
        const charAdditionalRaw = Array.from(charAddTags).map((el) => el.dataset.val);
        const charAdditional = [...new Set(charAdditionalRaw)]
            .filter((n) => n && n !== charPrimary && STATE.allBookNames.includes(n));

        const globalTags = view.querySelectorAll('.wb-ms-tag[data-bind-type="wb-bind-global"]');
        const globalBooks = [...new Set(Array.from(globalTags).map((el) => el.dataset.val))]
            .filter((n) => n && STATE.allBookNames.includes(n));

        const chatBook = view.querySelector('#wb-bind-chat').value;

        const oldGlobal = await API.getGlobalBindings();
        const oldChat = await API.getChatBinding();

        await setCharBindings('primary', charPrimary || '', !!charPrimary);

        const context = getContext();
        const charId = context.characterId;
        if (charId || charId === 0) {
            const character = context.characters[charId];
            const charFileName = getCharLoreFileName(character);
            if (charFileName) charSetAuxWorlds(charFileName, charAdditional);
        }

        const toRemove = oldGlobal.filter((b) => !globalBooks.includes(b));
        const toAdd = globalBooks.filter((b) => !oldGlobal.includes(b));

        for (const book of toRemove) await setCharBindings('global', book, false);
        for (const book of toAdd) await setCharBindings('global', book, true);

        if (chatBook) {
            await setCharBindings('chat', chatBook, true);
        } else if (oldChat) {
            await setCharBindings('chat', oldChat, false);
        }

        await this.refreshAllContext();
        toastr.success('绑定设置已保存');
    },

    getTokenCount(text) {
        if (!text) return 0;
        try {
            const ctx = getContext();
            if (ctx.getTokenCount) return ctx.getTokenCount(text);
        } catch (_e) {
            // noop
        }
        return Math.ceil(text.length / 3);
    },

    async actionImport() {
        const input = document.getElementById('wb-import-file');
        if (input) input.click();
    },

    async actionHandleImport(file) {
        if (!file) return;
        const reader = new FileReader();

        reader.onload = async (e) => {
            try {
                const content = JSON.parse(e.target.result);
                let entries = content.entries ? Object.values(content.entries) : content;
                if (!Array.isArray(entries)) entries = [];

                const bookName = file.name.replace(/\.(json|wb)$/i, '');
                const name = prompt('请输入导入后的世界书名称:', bookName);
                if (!name) return;

                if (STATE.allBookNames.includes(name) && !confirm(`世界书 "${name}" 已存在，是否覆盖？`)) {
                    return;
                }

                if (!STATE.allBookNames.includes(name)) await API.createWorldbook(name);
                await API.saveBookEntries(name, entries);

                toastr.success(`导入成功: ${name}`);
                await this.refreshAllContext();
                await this.loadBook(name);
            } catch (err) {
                toastr.error(`导入失败: ${err.message}`);
            }
        };

        reader.readAsText(file);
    },

    async actionExport() {
        if (!STATE.currentBookName) return toastr.warning('请先选择一本世界书');

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
    },

    async actionCreateNew() {
        const name = prompt('请输入新世界书名称:');
        if (!name) return;
        if (STATE.allBookNames.includes(name)) return toastr.warning('该名称已存在');

        await API.createWorldbook(name);
        await this.refreshAllContext();
        await this.loadBook(name);
    },

    async actionDelete() {
        if (!STATE.currentBookName) return;
        if (!confirm(`确定要永久删除世界书 "${STATE.currentBookName}" 吗？`)) return;

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
        UI.renderGlobalStats();
        UI.updateSelectionInfo();
    },

    async actionRename() {
        if (!STATE.currentBookName) return;
        const newName = prompt('重命名世界书为:', STATE.currentBookName);
        if (!newName || newName === STATE.currentBookName) return;
        if (STATE.allBookNames.includes(newName)) return toastr.warning('目标名称已存在');

        await this.flushPendingSave();
        await API.renameWorldbook(STATE.currentBookName, newName);
        await this.refreshAllContext();
        await this.loadBook(newName);
    },

    stitchSide(side) {
        return side === 'left' ? STATE.stitch.left : STATE.stitch.right;
    },

    otherSide(side) {
        return side === 'left' ? 'right' : 'left';
    },

    async ensureStitchBooks() {
        const all = STATE.allBookNames;
        if (!all.length) return;

        if (!STATE.stitch.left.book || !all.includes(STATE.stitch.left.book)) {
            STATE.stitch.left.book = (STATE.currentBookName && all.includes(STATE.currentBookName))
                ? STATE.currentBookName
                : all[0];
        }

        if (!STATE.stitch.right.book || !all.includes(STATE.stitch.right.book)) {
            const candidate = all.find((n) => n !== STATE.stitch.left.book);
            STATE.stitch.right.book = candidate || STATE.stitch.left.book;
        }

        await Promise.all([
            this.stitchLoadSide('left', STATE.stitch.left.book, true),
            this.stitchLoadSide('right', STATE.stitch.right.book, true),
        ]);
    },

    async stitchLoadSide(side, bookName, force = false) {
        const target = this.stitchSide(side);
        if (!bookName) return;

        if (!force && target.book === bookName && target.entries.length) return;

        target.book = bookName;
        target.entries = await API.loadBook(bookName);
        target.selected = new Set();
    },

    getNextUid(entries) {
        return entries.reduce((m, e) => Math.max(m, Number(e.uid) || 0), -1) + 1;
    },

    normalizeOrders(entries) {
        entries.forEach((e, idx) => {
            e.order = idx;
        });
    },

    async stitchTransfer(fromSide, toSide, uidList, mode) {
        const source = this.stitchSide(fromSide);
        const target = this.stitchSide(toSide);

        if (!source.book || !target.book) return;
        if (source.book === target.book) {
            toastr.warning('左右是同一本世界书，无法跨书缝合');
            return;
        }

        const sourceMap = new Map(source.entries.map((e) => [Number(e.uid), e]));
        const movedUids = [];

        uidList.forEach((uid) => {
            const item = sourceMap.get(Number(uid));
            if (!item) return;

            const cloned = cloneData(item);
            cloned.uid = this.getNextUid(target.entries);
            target.entries.push(cloned);

            if (mode === 'move') movedUids.push(Number(uid));
        });

        if (mode === 'move' && movedUids.length) {
            source.entries = source.entries.filter((e) => !movedUids.includes(Number(e.uid)));
            movedUids.forEach((uid) => source.selected.delete(uid));
        }

        this.normalizeOrders(source.entries);
        this.normalizeOrders(target.entries);

        await API.saveBookEntries(source.book, source.entries);
        await API.saveBookEntries(target.book, target.entries);

        if (STATE.currentBookName === source.book) {
            STATE.entries = cloneData(source.entries);
        } else if (STATE.currentBookName === target.book) {
            STATE.entries = cloneData(target.entries);
        }

        if (STATE.currentView === 'editor') {
            UI.renderList(STATE.editorSearch);
            UI.renderGlobalStats();
        }
    },

    async stitchTransferSelected(fromSide, mode) {
        const source = this.stitchSide(fromSide);
        const targetSide = this.otherSide(fromSide);
        const selected = Array.from(source.selected);

        if (!selected.length) {
            toastr.warning('请先勾选条目');
            return;
        }

        await this.stitchTransfer(fromSide, targetSide, selected, mode);
        UI.renderStitchView();
        toastr.success(mode === 'move' ? '已移动' : '已复制');
    },
};

const UI = {
    _resizeHandler: null,

    forcePanelLayout(panel = document.getElementById(CONFIG.id)) {
        if (!panel) return;

        panel.style.position = 'fixed';
        panel.style.inset = '0';
        panel.style.width = '100%';
        panel.style.height = '100vh';
        panel.style.height = '100dvh';
        panel.style.display = 'flex';
        panel.style.flexDirection = 'column';
        panel.style.overflow = 'hidden';
        panel.style.zIndex = '20000';

        const content = panel.querySelector('.wb-content');
        if (content) {
            content.style.display = 'flex';
            content.style.flexDirection = 'column';
            content.style.flex = '1 1 auto';
            content.style.minHeight = '0';
            content.style.overflow = 'hidden';
        }

        panel.querySelectorAll('.wb-view-section').forEach((view) => {
            view.style.flex = '1 1 auto';
            view.style.minHeight = '0';
            view.style.minWidth = '0';
        });
    },

    closeBatchPopovers(panel = document.getElementById(CONFIG.id)) {
        if (!panel) return;
        panel.querySelectorAll('.wb-batch-popover').forEach((el) => el.classList.add('wb-hidden'));
        panel.querySelectorAll('.wb-batch-main-btn').forEach((el) => el.classList.remove('active'));
    },

    toggleBatchPopover(kind) {
        const panel = document.getElementById(CONFIG.id);
        if (!panel) return;

        const popId = `#wb-batch-pop-${kind}`;
        const btnId = `#wb-batch-pop-${kind}-btn`;
        const pop = panel.querySelector(popId);
        const btn = panel.querySelector(btnId);
        if (!pop || !btn) return;

        const willOpen = pop.classList.contains('wb-hidden');
        this.closeBatchPopovers(panel);

        if (willOpen) {
            pop.classList.remove('wb-hidden');
            btn.classList.add('active');
        }
    },

    async open() {
        if (document.getElementById(CONFIG.id)) return;

        const panel = document.createElement('div');
        panel.id = CONFIG.id;
        panel.innerHTML = `
            <div class="wb-header-bar">
                <div class="wb-tabs">
                    <div class="wb-tab active" data-tab="editor"><i class="fa-solid fa-pen-to-square"></i> 编辑世界书</div>
                    <div class="wb-tab" data-tab="stitch"><i class="fa-solid fa-table-columns"></i> 缝合世界书</div>
                    <div class="wb-tab" data-tab="binding"><i class="fa-solid fa-link"></i> 绑定世界书</div>
                    <div class="wb-tab" data-tab="manage"><i class="fa-solid fa-list-check"></i> 管理世界书</div>
                </div>
                <div id="wb-close" class="wb-header-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>

            <div class="wb-content">
                <div id="wb-view-editor" class="wb-view-section">
                    <div class="wb-book-bar">
                        <select id="wb-book-selector" style="flex:1"><option>加载中...</option></select>
                        <button class="wb-btn-circle" id="wb-btn-import" title="导入"><i class="fa-solid fa-file-import"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-export" title="导出"><i class="fa-solid fa-file-export"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-create" title="新建"><i class="fa-solid fa-plus"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-rename" title="重命名"><i class="fa-solid fa-pen"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-delete" title="删除"><i class="fa-solid fa-trash"></i></button>
                        <input type="file" id="wb-import-file" accept=".json,.wb" style="display:none">
                    </div>

                    <div class="wb-stat-line">
                        <div class="wb-stat-item" id="wb-display-count">0 条目</div>
                    </div>

                    <div class="wb-preset-strip">
                        <select id="wb-preset-selector" style="flex:1"></select>
                        <button class="wb-btn-rect mini" id="wb-preset-save">保存状态</button>
                        <button class="wb-btn-rect mini" id="wb-preset-apply">应用状态</button>
                        <button class="wb-btn-rect mini wb-btn-danger" id="wb-preset-delete">删除状态</button>
                    </div>

                    <div class="wb-tool-bar">
                        <input class="wb-input-dark" id="wb-search-entry" placeholder="搜索条目...">
                        <button class="wb-btn-circle" id="btn-sort-priority" title="按优先级重排"><i class="fa-solid fa-filter"></i></button>
                        <button class="wb-btn-circle" id="btn-toggle-batch-edit" title="批量编辑"><i class="fa-solid fa-pen-to-square"></i></button>
                        <button class="wb-btn-circle" id="btn-add-entry" title="新建条目"><i class="fa-solid fa-plus"></i></button>
                    </div>

                    <div class="wb-batch-toolbar wb-hidden" id="wb-batch-toolbar">
                        <span id="wb-selection-info">已选 0/0</span>

                        <button class="wb-btn-circle wb-batch-icon-btn wb-batch-main-btn" id="wb-batch-pop-select-btn" title="选择操作">
                            <i class="fa-solid fa-check-double"></i>
                        </button>
                        <button class="wb-btn-circle wb-batch-icon-btn wb-batch-main-btn" id="wb-batch-pop-state-btn" title="状态操作">
                            <i class="fa-solid fa-sliders"></i>
                        </button>
                        <button class="wb-btn-circle wb-batch-icon-btn wb-batch-main-btn" id="wb-batch-pop-advanced-btn" title="位置/顺序/深度">
                            <i class="fa-solid fa-wand-magic-sparkles"></i>
                        </button>

                        <div class="wb-batch-popover wb-hidden" id="wb-batch-pop-select">
                            <div class="wb-batch-pop-grid">
                                <button class="wb-btn-circle wb-batch-icon-btn" id="wb-select-all" title="全选可见">
                                    <i class="fa-solid fa-check-double"></i>
                                </button>
                                <button class="wb-btn-circle wb-batch-icon-btn" id="wb-select-invert" title="反选可见">
                                    <i class="fa-solid fa-arrows-rotate"></i>
                                </button>
                                <button class="wb-btn-circle wb-batch-icon-btn" id="wb-select-clear" title="清空选择">
                                    <i class="fa-solid fa-eraser"></i>
                                </button>
                            </div>
                        </div>

                        <div class="wb-batch-popover wb-hidden" id="wb-batch-pop-state">
                            <div class="wb-batch-pop-grid">
                                <button class="wb-btn-circle wb-batch-icon-btn" id="wb-batch-enable" title="批量开启">
                                    <i class="fa-solid fa-toggle-on"></i>
                                </button>
                                <button class="wb-btn-circle wb-batch-icon-btn" id="wb-batch-disable" title="批量关闭">
                                    <i class="fa-solid fa-toggle-off"></i>
                                </button>
                                <button class="wb-btn-circle wb-batch-icon-btn" id="wb-batch-constant-on" title="设常驻">
                                    <i class="fa-solid fa-thumbtack"></i>
                                </button>
                                <button class="wb-btn-circle wb-batch-icon-btn" id="wb-batch-constant-off" title="设非常驻">
                                    <i class="fa-regular fa-circle"></i>
                                </button>
                            </div>
                        </div>

                        <div class="wb-batch-popover wb-hidden" id="wb-batch-pop-advanced">
                            <div class="wb-batch-adv-row">
                                <select id="wb-batch-position" class="wb-batch-select">
                                    <option value="before_character_definition">角色定义之前</option>
                                    <option value="after_character_definition">角色定义之后</option>
                                    <option value="before_author_note">作者注释之前</option>
                                    <option value="after_author_note">作者注释之后</option>
                                    <option value="at_depth">@D</option>
                                    <option value="before_example_messages">示例消息之前</option>
                                    <option value="after_example_messages">示例消息之后</option>
                                </select>
                                <button class="wb-btn-circle wb-batch-icon-btn wb-batch-adv-apply" id="wb-batch-position-apply" title="应用位置">
                                    <i class="fa-solid fa-location-dot"></i>
                                </button>
                            </div>

                            <div class="wb-batch-adv-row">
                                <input type="number" id="wb-batch-order" class="wb-batch-num" placeholder="顺序起始值">
                                <button class="wb-btn-circle wb-batch-icon-btn wb-batch-adv-apply" id="wb-batch-order-apply" title="应用顺序">
                                    <i class="fa-solid fa-arrow-down-1-9"></i>
                                </button>
                            </div>

                            <div class="wb-batch-adv-row">
                                <input type="number" min="0" id="wb-batch-depth" class="wb-batch-num" placeholder="深度值">
                                <button class="wb-btn-circle wb-batch-icon-btn wb-batch-adv-apply" id="wb-batch-depth-apply" title="应用深度">
                                    <i class="fa-solid fa-layer-group"></i>
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="wb-list" id="wb-entry-list"></div>
                </div>

                <div id="wb-view-stitch" class="wb-view-section wb-hidden">
                    <div class="wb-stitch-topbar">
                        <div class="wb-stitch-mode-wrap">
                            <span>拖拽模式</span>
                            <select id="wb-stitch-mode">
                                <option value="copy">复制</option>
                                <option value="move">移动</option>
                            </select>
                        </div>
                        <div class="wb-stitch-hint">把条目拖到另一侧列表即可跨书缝合；移动端可用下方“复制/移动选中”按钮。</div>
                    </div>

                    <div class="wb-stitch-grid">
                        <div class="wb-stitch-pane" id="wb-stitch-left-pane">
                            <div class="wb-stitch-pane-head">
                                <div class="wb-stitch-pane-title">左侧世界书</div>
                                <select id="wb-stitch-left-book"></select>
                            </div>
                            <div class="wb-stitch-pane-tools">
                                <input class="wb-input-dark" id="wb-stitch-left-search" placeholder="搜索左侧条目...">
                                <button class="wb-btn-rect mini" id="wb-stitch-left-all">全选</button>
                                <button class="wb-btn-rect mini" id="wb-stitch-left-invert">反选</button>
                                <button class="wb-btn-rect mini" id="wb-stitch-left-clear">清空</button>
                            </div>
                            <div class="wb-stitch-list" id="wb-stitch-left-list" data-side="left"></div>
                            <div class="wb-stitch-pane-actions">
                                <button class="wb-btn-rect mini" id="wb-stitch-left-copy">复制选中到右侧</button>
                                <button class="wb-btn-rect mini" id="wb-stitch-left-move">移动选中到右侧</button>
                            </div>
                        </div>

                        <div class="wb-stitch-pane" id="wb-stitch-right-pane">
                            <div class="wb-stitch-pane-head">
                                <div class="wb-stitch-pane-title">右侧世界书</div>
                                <select id="wb-stitch-right-book"></select>
                            </div>
                            <div class="wb-stitch-pane-tools">
                                <input class="wb-input-dark" id="wb-stitch-right-search" placeholder="搜索右侧条目...">
                                <button class="wb-btn-rect mini" id="wb-stitch-right-all">全选</button>
                                <button class="wb-btn-rect mini" id="wb-stitch-right-invert">反选</button>
                                <button class="wb-btn-rect mini" id="wb-stitch-right-clear">清空</button>
                            </div>
                            <div class="wb-stitch-list" id="wb-stitch-right-list" data-side="right"></div>
                            <div class="wb-stitch-pane-actions">
                                <button class="wb-btn-rect mini" id="wb-stitch-right-copy">复制选中到左侧</button>
                                <button class="wb-btn-rect mini" id="wb-stitch-right-move">移动选中到左侧</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="wb-view-binding" class="wb-view-section wb-hidden">
                    <div class="wb-bind-grid">
                        <div class="wb-bind-card">
                            <div class="wb-bind-title"><span><i class="fa-solid fa-user-tag"></i> 角色世界书</span></div>
                            <div class="wb-bind-label">主要世界书</div>
                            <div style="position:relative"><select id="wb-bind-char-primary" style="width:100%"></select></div>
                            <div class="wb-bind-label">附加世界书（双击条目可直接进入编辑）</div>
                            <div class="wb-scroll-list" id="wb-bind-char-list"></div>
                        </div>
                        <div class="wb-bind-card">
                            <div class="wb-bind-title"><span><i class="fa-solid fa-globe"></i> 全局世界书</span></div>
                            <div class="wb-scroll-list" id="wb-bind-global-list"></div>
                        </div>
                        <div class="wb-bind-card">
                            <div class="wb-bind-title"><span><i class="fa-solid fa-comments"></i> 聊天世界书</span></div>
                            <div style="position:relative"><select id="wb-bind-chat" style="width:100%"></select></div>
                        </div>
                    </div>
                </div>

                <div id="wb-view-manage" class="wb-view-section wb-hidden">
                    <div class="wb-tool-bar">
                        <input class="wb-input-dark" id="wb-manage-search" placeholder="搜索世界书...">
                    </div>
                    <div class="wb-manage-content" id="wb-manage-content"></div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        this.forcePanelLayout(panel);

        this._resizeHandler = () => this.forcePanelLayout(panel);
        window.addEventListener('resize', this._resizeHandler);

        const $ = (sel) => panel.querySelector(sel);
        const $$ = (sel) => panel.querySelectorAll(sel);

        $('#wb-close').onclick = async () => {
            await Actions.flushPendingSave();
            if (this._resizeHandler) {
                window.removeEventListener('resize', this._resizeHandler);
                this._resizeHandler = null;
            }
            panel.remove();
        };

        $$('.wb-tab').forEach((el) => {
            el.onclick = () => Actions.switchView(el.dataset.tab);
        });

        $('#wb-book-selector').addEventListener('change', (e) => Actions.loadBook(e.target.value));
        $('#wb-search-entry').oninput = (e) => UI.renderList(e.target.value);
        $('#btn-sort-priority').onclick = () => Actions.sortByPriority();
        $('#btn-add-entry').onclick = () => Actions.addNewEntry();
        $('#btn-toggle-batch-edit').onclick = () => UI.toggleBatchEditMode();

        $('#wb-btn-import').onclick = () => Actions.actionImport();
        $('#wb-btn-export').onclick = () => Actions.actionExport();
        $('#wb-btn-create').onclick = () => Actions.actionCreateNew();
        $('#wb-btn-rename').onclick = () => Actions.actionRename();
        $('#wb-btn-delete').onclick = () => Actions.actionDelete();

        $('#wb-preset-save').onclick = () => Actions.saveCurrentPreset();
        $('#wb-preset-apply').onclick = () => Actions.applyPreset($('#wb-preset-selector').value);
        $('#wb-preset-delete').onclick = () => Actions.deletePreset($('#wb-preset-selector').value);

        $('#wb-select-all').onclick = () => Actions.selectAllVisible();
        $('#wb-select-invert').onclick = () => Actions.invertVisibleSelection();
        $('#wb-select-clear').onclick = () => Actions.clearSelection();

        $('#wb-batch-enable').onclick = () => Actions.batchEnable(true);
        $('#wb-batch-disable').onclick = () => Actions.batchEnable(false);
        $('#wb-batch-constant-on').onclick = () => Actions.batchConstant(true);
        $('#wb-batch-constant-off').onclick = () => Actions.batchConstant(false);

        $('#wb-batch-position-apply').onclick = () => Actions.batchSetPosition($('#wb-batch-position').value);
        $('#wb-batch-order-apply').onclick = () => Actions.batchSetOrder($('#wb-batch-order').value);
        $('#wb-batch-depth-apply').onclick = () => Actions.batchSetDepth($('#wb-batch-depth').value);

        $('#wb-batch-pop-select-btn').onclick = (e) => {
            e.stopPropagation();
            UI.toggleBatchPopover('select');
        };
        $('#wb-batch-pop-state-btn').onclick = (e) => {
            e.stopPropagation();
            UI.toggleBatchPopover('state');
        };
        $('#wb-batch-pop-advanced-btn').onclick = (e) => {
            e.stopPropagation();
            UI.toggleBatchPopover('advanced');
        };

        ['#wb-batch-pop-select', '#wb-batch-pop-state', '#wb-batch-pop-advanced'].forEach((sid) => {
            const el = panel.querySelector(sid);
            if (el) el.onclick = (e) => e.stopPropagation();
        });

        panel.addEventListener('click', () => {
            UI.closeBatchPopovers(panel);
        });

        const fileInput = $('#wb-import-file');
        fileInput.onchange = (e) => {
            if (e.target.files.length > 0) {
                Actions.actionHandleImport(e.target.files[0]);
                fileInput.value = '';
            }
        };

        $('#wb-manage-search').oninput = (e) => UI.renderManageView(e.target.value);

        await Actions.refreshAllContext();

        const targetBook = STATE.bindings.char.primary
            || STATE.bindings.chat
            || (STATE.allBookNames.length ? STATE.allBookNames[0] : null);

        if (targetBook) {
            await Actions.loadBook(targetBook);
        } else {
            UI.renderList();
            UI.renderGlobalStats();
            UI.renderPresetBar();
        }

        UI.switchView('editor');
        UI.applyBatchEditState();
    },

    switchView(viewName) {
        const panel = document.getElementById(CONFIG.id);
        if (!panel) return;

        if (viewName !== 'editor' && STATE.batchEditMode) {
            this.toggleBatchEditMode(false);
        }

        if (viewName !== 'editor') {
            this.closeBatchPopovers(panel);
        }

        panel.querySelectorAll('.wb-tab').forEach((el) => {
            el.classList.toggle('active', el.dataset.tab === viewName);
        });

        panel.querySelectorAll('.wb-view-section').forEach((el) => el.classList.add('wb-hidden'));
        const target = panel.querySelector(`#wb-view-${viewName}`);

        if (target) {
            target.classList.remove('wb-hidden');
        } else {
            const fallback = panel.querySelector('#wb-view-editor');
            if (fallback) fallback.classList.remove('wb-hidden');
        }

        if (viewName === 'binding') {
            this.renderBindingView();
        } else if (viewName === 'manage') {
            this.renderManageView();
        } else if (viewName === 'stitch') {
            Actions.ensureStitchBooks().then(() => this.renderStitchView());
        } else {
            this.renderBookSelector();
            this.renderPresetBar();
            this.renderGlobalStats();
            this.renderList(STATE.editorSearch || '');
            this.updateSelectionInfo();
            this.applyBatchEditState();
        }

        this.forcePanelLayout(panel);
    },

    toggleBatchEditMode(forceVal = null) {
        const next = typeof forceVal === 'boolean' ? forceVal : !STATE.batchEditMode;
        STATE.batchEditMode = next;
        this.applyBatchEditState();

        const panel = document.getElementById(CONFIG.id);
        const bar = document.getElementById('wb-batch-toolbar');

        if (!next) {
            this.closeBatchPopovers(panel);
            Actions.clearSelection();
        } else {
            this.updateSelectionInfo();
            const isMobile = window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
            if (isMobile && bar) bar.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
    },

    applyBatchEditState() {
        const panel = document.getElementById(CONFIG.id);
        if (!panel) return;

        const bar = panel.querySelector('#wb-batch-toolbar');
        const btn = panel.querySelector('#btn-toggle-batch-edit');

        if (bar) bar.classList.toggle('wb-hidden', !STATE.batchEditMode);
        if (btn) btn.classList.toggle('active', STATE.batchEditMode);
        panel.classList.toggle('wb-batch-editing', STATE.batchEditMode);

        if (!STATE.batchEditMode) {
            this.closeBatchPopovers(panel);
        }
    },

    renderBookSelector() {
        const selector = document.getElementById('wb-book-selector');
        if (!selector) return;

        const { char, global, chat } = STATE.bindings;
        const allNames = STATE.allBookNames;
        const globalBooks = new Set(global);
        const chatBook = chat;

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
            globalBooks.forEach((name) => { html += `<option value="${esc(name)}">${esc(name)}</option>`; });
            html += '</optgroup>';
        }

        if (chatBook) {
            html += `<optgroup label="当前聊天"><option value="${esc(chatBook)}">${esc(chatBook)}</option></optgroup>`;
        }

        html += '<optgroup label="其他">';
        allNames.forEach((name) => { html += `<option value="${esc(name)}">${esc(name)}</option>`; });
        html += '</optgroup>';

        selector.innerHTML = html;
        if (STATE.currentBookName) selector.value = STATE.currentBookName;
        this.applyCustomDropdown('wb-book-selector');
    },

    renderPresetBar() {
        const sel = document.getElementById('wb-preset-selector');
        if (!sel) return;

        if (!STATE.currentBookName) {
            sel.innerHTML = '<option value="">先选择世界书</option>';
            return;
        }

        const list = Actions.getBookPresets(STATE.currentBookName);
        let html = '<option value="">选择状态预设...</option>';
        list.forEach((p) => {
            html += `<option value="${esc(p.id)}">${esc(p.name)}</option>`;
        });
        sel.innerHTML = html;
    },

    async openBookByName(name) {
        if (!name || !STATE.allBookNames.includes(name)) return;
        await Actions.loadBook(name);
        Actions.switchView('editor');
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

            if (container._wbOutsideHandler) {
                document.removeEventListener('click', container._wbOutsideHandler);
                container._wbOutsideHandler = null;
            }

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

                        tag.querySelector('.wb-ms-tag-close').onclick = (e) => {
                            e.stopPropagation();
                            selectedSet.delete(name);
                            refresh();
                            Actions.saveBindings();
                        };

                        tag.ondblclick = async (e) => {
                            e.stopPropagation();
                            await this.openBookByName(name);
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
                        item.onclick = () => {
                            selectedSet.add(name);
                            inputEl.value = '';
                            refresh();
                            Actions.saveBindings();
                        };
                        item.ondblclick = async (e) => {
                            e.stopPropagation();
                            await this.openBookByName(name);
                        };
                        listEl.appendChild(item);
                    });
                    filterList(inputEl.value);
                }
            };

            tagsEl.onclick = () => {
                const isVisible = dropEl.classList.contains('show');
                document.querySelectorAll('.wb-ms-dropdown.show').forEach((el) => el.classList.remove('show'));
                if (!isVisible) dropEl.classList.add('show');
            };

            inputEl.oninput = (e) => filterList(e.target.value);

            const outsideHandler = (e) => {
                if (!dom.contains(e.target)) dropEl.classList.remove('show');
            };
            container._wbOutsideHandler = outsideHandler;
            document.addEventListener('click', outsideHandler);

            refresh();
        };

        view.querySelector('#wb-bind-char-primary').innerHTML = createOpts(char.primary);
        createMultiSelect('#wb-bind-char-list', char.additional, 'wb-bind-char-add');
        createMultiSelect('#wb-bind-global-list', global, 'wb-bind-global');
        view.querySelector('#wb-bind-chat').innerHTML = createOpts(chat);

        ['wb-bind-char-primary', 'wb-bind-chat'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
                el.onchange = () => Actions.saveBindings();
                this.applyCustomDropdown(id);
            }
        });
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

        countEl.innerHTML = `
            <span>${STATE.entries.length} 条目 | ${blueTokens + greenTokens} Tokens</span>
            <span class="wb-token-breakdown">( <span class="wb-text-blue">${blueTokens}</span> + <span class="wb-text-green">${greenTokens}</span> )</span>
        `;
    },

    renderList(filterText = '') {
        const list = document.getElementById('wb-entry-list');
        if (!list) return;
        list.innerHTML = '';

        STATE.editorSearch = filterText;
        const term = filterText.toLowerCase().trim();

        const filtered = STATE.entries.filter((entry) => {
            if (!term) return true;
            return String(entry.comment || '').toLowerCase().includes(term);
        });

        if (!filtered.length) {
            list.innerHTML = '<div class="wb-empty">没有匹配条目</div>';
            this.updateSelectionInfo();
            return;
        }

        filtered.forEach((entry, index) => {
            const card = this.createCard(entry, index);
            list.appendChild(card);
        });

        this.updateSelectionInfo();
        this.applyBatchEditState();
    },

    createCard(entry, index) {
        const isEnabled = !entry.disable;
        const isConstant = !!entry.constant;
        const selected = STATE.selectedUids.has(Number(entry.uid));
        const keys = entry.key || [];

        const card = document.createElement('div');
        let typeClass = '';
        if (isEnabled) typeClass = isConstant ? 'type-blue' : 'type-green';
        card.className = `wb-card ${isEnabled ? '' : 'disabled'} ${typeClass} ${selected ? 'selected' : ''}`;
        card.dataset.uid = entry.uid;
        card.dataset.index = index;

        const curPosInt = typeof entry.position === 'number' ? entry.position : 1;
        const curPosStr = WI_POSITION_MAP[curPosInt] || 'after_character_definition';

        const allPosOptions = [
            { v: 'before_character_definition', t: '角色定义之前' },
            { v: 'after_character_definition', t: '角色定义之后' },
            { v: 'before_example_messages', t: '示例消息之前' },
            { v: 'after_example_messages', t: '示例消息之后' },
            { v: 'before_author_note', t: '作者注释之前' },
            { v: 'after_author_note', t: '作者注释之后' },
            { v: 'at_depth', t: '@D' },
        ];

        let optionsHtml = '';
        allPosOptions.forEach((opt) => {
            const selectedOpt = opt.v === curPosStr ? 'selected' : '';
            optionsHtml += `<option value="${opt.v}" ${selectedOpt}>${opt.t}</option>`;
        });

        const showWarning = isEnabled && !isConstant && !(keys.length > 0);
        const warningIcon = showWarning
            ? '<i class="fa-solid fa-circle-exclamation wb-warning-icon" data-wb-tooltip="警告：绿灯条目已启用但未设置关键词，将无法触发"></i>'
            : '';

        card.innerHTML = `
            <div class="wb-card-header">
                <div class="wb-card-main">
                    <div class="wb-row">
                        <input type="checkbox" class="wb-select-dot inp-select" ${selected ? 'checked' : ''} title="选择条目">
                        <input class="wb-inp-title inp-name" value="${esc(entry.comment)}" placeholder="条目名称">
                        <div class="wb-warning-container">${warningIcon}</div>
                        <i class="fa-solid fa-eye btn-preview" title="编辑内容"></i>
                        <i class="fa-solid fa-trash btn-delete" title="删除条目"></i>
                    </div>
                    <div class="wb-row">
                        <div class="wb-ctrl-group">
                            <label class="wb-switch"><input type="checkbox" class="inp-enable" ${isEnabled ? 'checked' : ''}><span class="wb-slider purple"></span></label>
                        </div>
                        <div class="wb-ctrl-group">
                            <label class="wb-switch"><input type="checkbox" class="inp-type" ${isConstant ? 'checked' : ''}><span class="wb-slider blue"></span></label>
                        </div>
                        <div class="wb-pos-wrapper">
                            <select class="wb-input-dark inp-pos">${optionsHtml}</select>
                            <input type="number" class="wb-inp-num inp-pos-depth" style="display:${curPosStr === 'at_depth' ? 'block' : 'none'}" value="${entry.depth ?? 4}">
                        </div>
                        <div class="wb-ctrl-group order-group"><span>顺序</span><input type="number" class="wb-inp-num inp-order" value="${entry.order ?? 0}"></div>
                        <div class="wb-input-dark wb-token-display">${Actions.getTokenCount(entry.content)}</div>
                    </div>
                </div>
            </div>
        `;

        const bind = (sel, evt, fn) => {
            const el = card.querySelector(sel);
            if (el) el.addEventListener(evt, fn);
        };

        bind('.inp-select', 'change', (e) => Actions.selectEntry(entry.uid, e.target.checked));
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

    updateSelectionInfo() {
        const info = document.getElementById('wb-selection-info');
        if (!info) return;
        info.textContent = `已选 ${STATE.selectedUids.size}/${STATE.entries.length}`;
    },

    updateCardStatus(uid) {
        const entry = STATE.entries.find((e) => e.uid === uid);
        const card = document.querySelector(`.wb-card[data-uid="${uid}"]`);
        if (!entry || !card) return;

        card.classList.remove('disabled', 'type-green', 'type-blue');
        if (entry.disable) card.classList.add('disabled');
        else if (entry.constant) card.classList.add('type-blue');
        else card.classList.add('type-green');

        card.classList.toggle('selected', STATE.selectedUids.has(Number(uid)));

        const tokenEl = card.querySelector('.wb-token-display');
        if (tokenEl) tokenEl.textContent = Actions.getTokenCount(entry.content);
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
                <div class="wb-popup-header"><span>${esc(entry.comment || '未命名条目')}</span></div>
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

    renderManageView(filterText = '') {
        const container = document.getElementById('wb-manage-content');
        if (!container) return;

        const term = filterText.toLowerCase();
        const boundMap = STATE.boundBooksSet || {};
        const all = [...STATE.allBookNames].filter((name) => !term || name.toLowerCase().includes(term));
        all.sort((a, b) => a.localeCompare(b));

        container.innerHTML = '';

        all.forEach((bookName) => {
            const boundChars = boundMap[bookName] || [];
            const card = document.createElement('div');
            card.className = 'wb-manage-card';

            card.innerHTML = `
                <div class="wb-card-top">
                    <div class="wb-card-info">
                        <span class="wb-card-title">${esc(bookName)}</span>
                        ${boundChars.length ? `<div class="wb-card-subtitle"><i class="fa-solid fa-user-tag"></i> ${esc(boundChars.join(', '))}</div>` : ''}
                    </div>
                    <div class="wb-manage-icons">
                        <div class="wb-icon-action btn-view" title="跳转编辑"><i class="fa-solid fa-eye"></i></div>
                        <div class="wb-icon-action btn-bind" title="绑定当前角色主世界书"><i class="fa-solid fa-link"></i></div>
                        <div class="wb-icon-action btn-del" title="删除世界书"><i class="fa-solid fa-trash"></i></div>
                    </div>
                </div>
            `;

            card.ondblclick = () => {
                Actions.loadBook(bookName).then(() => Actions.switchView('editor'));
            };

            card.querySelector('.btn-view').onclick = () => {
                Actions.loadBook(bookName).then(() => Actions.switchView('editor'));
            };

            card.querySelector('.btn-bind').onclick = async () => {
                await setCharBindings('primary', bookName, true);
                await Actions.refreshAllContext();
                toastr.success(`已绑定: ${bookName}`);
            };

            card.querySelector('.btn-del').onclick = async () => {
                if (!confirm(`确定要删除世界书 "${bookName}" 吗？`)) return;

                if (STATE.currentBookName === bookName && STATE.debouncer) {
                    clearTimeout(STATE.debouncer);
                    STATE.debouncer = null;
                }

                await API.deleteWorldbook(bookName);

                if (STATE.currentBookName === bookName) {
                    STATE.currentBookName = null;
                    STATE.entries = [];
                    STATE.selectedUids.clear();
                    UI.renderList();
                    UI.renderGlobalStats();
                    UI.updateSelectionInfo();
                }

                await Actions.refreshAllContext();
                UI.renderManageView(filterText);
            };

            container.appendChild(card);
        });
    },

    renderStitchView() {
        const modeEl = document.getElementById('wb-stitch-mode');
        if (modeEl) {
            modeEl.value = STATE.stitch.mode;
            modeEl.onchange = (e) => { STATE.stitch.mode = e.target.value; };
        }

        this.renderStitchSide('left');
        this.renderStitchSide('right');
    },

    renderStitchSide(sideKey) {
        const side = sideKey === 'left' ? STATE.stitch.left : STATE.stitch.right;
        const all = STATE.allBookNames;

        const bookSel = document.getElementById(`wb-stitch-${sideKey}-book`);
        const searchInp = document.getElementById(`wb-stitch-${sideKey}-search`);
        const listEl = document.getElementById(`wb-stitch-${sideKey}-list`);
        const btnAll = document.getElementById(`wb-stitch-${sideKey}-all`);
        const btnInvert = document.getElementById(`wb-stitch-${sideKey}-invert`);
        const btnClear = document.getElementById(`wb-stitch-${sideKey}-clear`);
        const btnCopy = document.getElementById(`wb-stitch-${sideKey}-copy`);
        const btnMove = document.getElementById(`wb-stitch-${sideKey}-move`);

        if (!bookSel || !searchInp || !listEl) return;

        if (!all.length) {
            listEl.innerHTML = '<div class="wb-stitch-empty">暂无世界书</div>';
            return;
        }

        let options = '';
        all.forEach((name) => {
            const selected = name === side.book ? 'selected' : '';
            options += `<option value="${esc(name)}" ${selected}>${esc(name)}</option>`;
        });
        bookSel.innerHTML = options;

        bookSel.onchange = async (e) => {
            await Actions.stitchLoadSide(sideKey, e.target.value, true);
            this.renderStitchView();
        };

        searchInp.value = side.search || '';
        searchInp.oninput = (e) => {
            side.search = e.target.value || '';
            this.renderStitchSide(sideKey);
        };

        if (btnAll) {
            btnAll.onclick = () => {
                const filtered = side.entries.filter((entry) => {
                    const t = side.search.toLowerCase();
                    return !t || String(entry.comment || '').toLowerCase().includes(t);
                });
                filtered.forEach((e) => side.selected.add(Number(e.uid)));
                this.renderStitchSide(sideKey);
            };
        }

        if (btnInvert) {
            btnInvert.onclick = () => {
                const filtered = side.entries.filter((entry) => {
                    const t = side.search.toLowerCase();
                    return !t || String(entry.comment || '').toLowerCase().includes(t);
                });
                filtered.forEach((e) => {
                    const uid = Number(e.uid);
                    if (side.selected.has(uid)) side.selected.delete(uid);
                    else side.selected.add(uid);
                });
                this.renderStitchSide(sideKey);
            };
        }

        if (btnClear) {
            btnClear.onclick = () => {
                side.selected.clear();
                this.renderStitchSide(sideKey);
            };
        }

        if (btnCopy) btnCopy.onclick = () => Actions.stitchTransferSelected(sideKey, 'copy');
        if (btnMove) btnMove.onclick = () => Actions.stitchTransferSelected(sideKey, 'move');

        const term = side.search.toLowerCase();
        const filteredEntries = side.entries.filter((entry) => !term || String(entry.comment || '').toLowerCase().includes(term));

        if (!filteredEntries.length) {
            listEl.innerHTML = '<div class="wb-stitch-empty">无匹配条目</div>';
        } else {
            listEl.innerHTML = filteredEntries.map((entry) => {
                const selected = side.selected.has(Number(entry.uid)) ? 'checked' : '';
                const modeClass = entry.constant ? 'mode-blue' : 'mode-green';
                const mode = entry.constant ? '常驻' : '非常驻';
                const enabledText = entry.disable ? '关闭' : '启用';
                return `
                    <div class="wb-stitch-item" draggable="true" data-side="${sideKey}" data-uid="${entry.uid}">
                        <input type="checkbox" class="wb-stitch-check" data-uid="${entry.uid}" ${selected}>
                        <div class="wb-stitch-item-main">
                            <div class="wb-stitch-item-title">${esc(entry.comment || `条目 ${entry.uid}`)}</div>
                            <div class="wb-stitch-item-meta">
                                <span class="${modeClass}">${mode}</span>
                                <span>${enabledText}</span>
                                <span>@${esc(WI_POSITION_MAP[entry.position] || entry.position)}</span>
                                <span>uid:${entry.uid}</span>
                            </div>
                        </div>
                        <i class="fa-solid fa-grip-lines wb-stitch-grip"></i>
                    </div>
                `;
            }).join('');
        }

        listEl.querySelectorAll('.wb-stitch-check').forEach((cb) => {
            cb.onchange = (e) => {
                const uid = Number(e.target.dataset.uid);
                if (e.target.checked) side.selected.add(uid);
                else side.selected.delete(uid);
            };
        });

        listEl.querySelectorAll('.wb-stitch-item').forEach((item) => {
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/uid', item.dataset.uid);
                e.dataTransfer.setData('text/from-side', sideKey);
            });
        });

        listEl.ondragover = (e) => {
            e.preventDefault();
            listEl.classList.add('drag-over');
        };

        listEl.ondragleave = () => {
            listEl.classList.remove('drag-over');
        };

        listEl.ondrop = async (e) => {
            e.preventDefault();
            listEl.classList.remove('drag-over');

            const uid = Number(e.dataTransfer.getData('text/uid'));
            const fromSide = e.dataTransfer.getData('text/from-side');
            if (!uid || !fromSide || fromSide === sideKey) return;

            await Actions.stitchTransfer(fromSide, sideKey, [uid], STATE.stitch.mode);
            this.renderStitchView();
            toastr.success(STATE.stitch.mode === 'move' ? '已移动' : '已复制');
        };

        const pane = document.getElementById(`wb-stitch-${sideKey}-pane`);
        if (pane) {
            pane.querySelector('.wb-stitch-pane-title').textContent = `${sideKey === 'left' ? '左侧' : '右侧'}世界书（已选 ${side.selected.size}/${side.entries.length}）`;
        }
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
            trigger.onclick = (e) => { e.stopPropagation(); this.toggleCustomDropdown(selectId, trigger); };
        }

        const update = () => {
            const selectedOpt = originalSelect.options[originalSelect.selectedIndex];
            trigger.textContent = selectedOpt ? selectedOpt.text : '请选择...';
        };

        update();
        originalSelect.addEventListener('change', update);
    },

    toggleCustomDropdown(selectId, triggerElem) {
        const existing = document.getElementById('wb-active-dropdown');
        if (existing) {
            const isSame = existing.dataset.source === selectId;
            existing.remove();
            if (isSame) return;
        }

        const originalSelect = document.getElementById(selectId);
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

            if (selectId === 'wb-book-selector' || selectId === 'wb-bind-char-primary' || selectId === 'wb-bind-chat') {
                div.ondblclick = async (e) => {
                    e.stopPropagation();
                    const worldName = optNode.value;
                    if (!worldName) return;
                    dropdown.remove();
                    await this.openBookByName(worldName);
                };
            }

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

    initTooltips() {
        if (this._tooltipInited) return;
        this._tooltipInited = true;

        const tipEl = document.createElement('div');
        tipEl.className = 'wb-tooltip';
        document.body.appendChild(tipEl);

        const show = (text, x, y) => {
            tipEl.textContent = text;
            tipEl.classList.add('show');

            const rect = tipEl.getBoundingClientRect();
            let left = x + 15;
            let top = y + 15;
            if (left + rect.width > window.innerWidth) left = x - rect.width - 5;
            if (top + rect.height > window.innerHeight) top = y - rect.height - 5;

            tipEl.style.left = `${left}px`;
            tipEl.style.top = `${top}px`;
        };

        const hide = () => tipEl.classList.remove('show');

        document.body.addEventListener('mouseover', (e) => {
            const container = e.target.closest(`#${CONFIG.id}, .wb-modal-overlay`);
            if (!container) return;

            const target = e.target.closest('[title], [data-wb-tooltip]');
            if (!target) return;

            const text = target.getAttribute('title') || target.getAttribute('data-wb-tooltip');
            if (target.getAttribute('title')) {
                target.setAttribute('data-wb-tooltip', text);
                target.removeAttribute('title');
            }
            if (text) show(text, e.clientX, e.clientY);
        });

        document.body.addEventListener('mouseout', hide);
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
        } catch (_e) {
            // noop
        }
    };

    if (typeof world_names === 'undefined') {
        eventSource.on(event_types.APP_READY, performInit);
    } else {
        performInit();
    }
});
