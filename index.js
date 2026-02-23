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
    initialized: false,
    currentView: 'editor',
    currentBookName: '',
    allBookNames: [],
    entries: [],
    metadata: {},
    searchText: '',
    debouncer: null,
    selectedUids: new Set(),
    bindings: {
        char: { primary: null, additional: [] },
        global: [],
        chat: null,
    },
    debugMessages: [],
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
    Object.entries(WI_POSITION_MAP).map(([k, v]) => [v, Number(k)]),
);

function cloneData(data) {
    try {
        return structuredClone(data);
    } catch (_e) {
        return JSON.parse(JSON.stringify(data));
    }
}

function safeText(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function escapeHtml(str) {
    return safeText(str).replace(/[&<>"']/g, (m) => ({
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

function toBool(v, fallback = false) {
    if (typeof v === 'boolean') return v;
    if (v === 1 || v === '1' || v === 'true') return true;
    if (v === 0 || v === '0' || v === 'false') return false;
    return fallback;
}

function ensureArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        return v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return [];
}

function pushDebug(message, errorObj = null) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}${errorObj ? ` | ${errorObj.message || String(errorObj)}` : ''}`;
    STATE.debugMessages.push(line);
    if (STATE.debugMessages.length > 200) {
        STATE.debugMessages = STATE.debugMessages.slice(-120);
    }
    console.warn('[Enhanced WB]', line, errorObj || '');
    UI.renderDebug();
}

function normalizePosition(rawPos) {
    if (typeof rawPos === 'string') {
        if (WI_POSITION_MAP_REV[rawPos] !== undefined) return WI_POSITION_MAP_REV[rawPos];
        if (/^\d+$/.test(rawPos)) return toNum(rawPos, 1);
        return 1;
    }
    const p = toNum(rawPos, 1);
    return p >= 0 && p <= 6 ? p : 1;
}

function normalizeEntry(rawEntry, uidFallback, idx) {
    const src = cloneData(rawEntry || {});
    const out = { ...src };

    out.uid = toNum(out.uid, toNum(uidFallback, idx));

    out.comment = safeText(
        out.comment
        ?? out.title
        ?? out.name
        ?? out.keyString
        ?? `条目 ${out.uid}`,
    );

    out.content = safeText(
        out.content
        ?? out.text
        ?? out.value
        ?? '',
    );

    const keyList = ensureArray(out.key ?? out.keys ?? out.keyword ?? out.keywords);
    out.key = keyList.map((k) => safeText(k)).filter(Boolean);

    out.position = normalizePosition(out.position);
    out.depth = Math.max(0, toNum(out.depth, 4));
    out.order = toNum(out.order, idx);
    out.probability = toNum(out.probability, 100);

    if (typeof out.disable === 'boolean') {
        out.disable = out.disable;
    } else if (out.enabled !== undefined) {
        out.disable = !toBool(out.enabled, true);
    } else {
        out.disable = false;
    }

    out.constant = toBool(out.constant, false);

    if (typeof out.selective !== 'boolean') {
        out.selective = !out.constant;
    }

    return out;
}

function sortEntriesInPlace(entries) {
    entries.sort((a, b) => {
        const oa = toNum(a.order, 0);
        const ob = toNum(b.order, 0);
        if (oa !== ob) return oa - ob;
        return toNum(a.uid, 0) - toNum(b.uid, 0);
    });
}

function normalizeOrder(entries) {
    entries.forEach((e, i) => {
        e.order = i;
    });
}

function tokenCount(text) {
    if (!text) return 0;
    try {
        const c = getContext();
        if (typeof c?.getTokenCount === 'function') return c.getTokenCount(text);
    } catch (_e) {
        // noop
    }
    return Math.ceil(String(text).length / 3);
}

function getPosLabel(entry) {
    const p = Number(entry.position ?? 1);
    if (p === 0) return '角色定义前';
    if (p === 1) return '角色定义后';
    if (p === 2) return 'AN前';
    if (p === 3) return 'AN后';
    if (p === 4) return `@D ${Number(entry.depth ?? 4)}`;
    if (p === 5) return '示例前';
    if (p === 6) return '示例后';
    return '未知';
}

async function charUpdatePrimaryWorld(name) {
    const context = getContext();
    const charId = context.characterId;
    if (charId === undefined || charId === null) return;

    const character = context.characters?.[charId];
    if (!character) return;

    character.data = character.data || {};
    character.data.extensions = character.data.extensions || {};
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

    context.saveCharacterDebounced?.();
}

function charSetAuxWorlds(fileName, books) {
    const context = getContext();

    if (!world_info.charLore) world_info.charLore = [];
    const idx = world_info.charLore.findIndex((e) => e.name === fileName);

    if (!books.length) {
        if (idx !== -1) world_info.charLore.splice(idx, 1);
    } else if (idx === -1) {
        world_info.charLore.push({ name: fileName, extraBooks: books });
    } else {
        world_info.charLore[idx].extraBooks = books;
    }

    context.saveSettingsDebounced?.();
}

async function setBinding(type, worldName, enabled) {
    const context = getContext();

    if (type === 'primary') {
        await charUpdatePrimaryWorld(enabled ? worldName : '');
        return;
    }

    if (type === 'auxiliary') {
        const charId = context.characterId;
        if (charId === undefined || charId === null) return;
        const avatar = context.characters?.[charId]?.avatar;
        const fileName = getCharaFilename(null, { manualAvatarKey: avatar });
        const curr = world_info.charLore?.find((e) => e.name === fileName)?.extraBooks || [];
        let next = [...curr];

        if (enabled) {
            if (!next.includes(worldName)) next.push(worldName);
        } else {
            next = next.filter((n) => n !== worldName);
        }

        charSetAuxWorlds(fileName, next);
        return;
    }

    if (type === 'chat') {
        if (enabled && worldName) {
            context.chatMetadata.world_info = worldName;
        } else {
            delete context.chatMetadata.world_info;
        }
        context.saveMetadataDebounced?.();
        return;
    }

    if (type === 'global') {
        const cmd = enabled
            ? `/world silent=true "${worldName}"`
            : `/world state=off silent=true "${worldName}"`;
        await context.executeSlashCommands(cmd);
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

        const character = context.characters?.[charId];
        if (!character) return { primary: null, additional: [] };

        const primary = character.data?.extensions?.world || null;
        const fileName = (character.avatar || '').replace(/\.[^/.]+$/, '');
        const extra = world_info.charLore?.find((e) => e.name === fileName)?.extraBooks || [];
        return { primary, additional: [...extra] };
    },

    async getGlobalBindings() {
        return [...(selected_world_info || [])];
    },

    async getChatBinding() {
        return getContext().chatMetadata?.world_info || null;
    },

    async loadBook(name) {
        const data = await getContext().loadWorldInfo(name);
        if (!data) throw new Error(`世界书不存在: ${name}`);

        const rawEntries = data.entries || {};
        const arr = [];

        Object.entries(rawEntries).forEach(([uidKey, rawEntry], idx) => {
            try {
                arr.push(normalizeEntry(rawEntry, uidKey, idx));
            } catch (e) {
                pushDebug(`条目解析失败 book=${name} uid=${uidKey}`, e);
            }
        });

        // UID 去重，避免重复 UID 导致操作错乱
        const used = new Set();
        arr.forEach((e, i) => {
            let uid = toNum(e.uid, i);
            while (used.has(uid)) uid += 1;
            e.uid = uid;
            used.add(uid);
        });

        sortEntriesInPlace(arr);
        normalizeOrder(arr);

        if (Object.keys(rawEntries).length && arr.length === 0) {
            pushDebug(`世界书 ${name} 有条目，但解析结果为空（可能字段格式异常）`);
        }

        return arr;
    },

    async saveBookEntries(name, entriesArray) {
        if (!name || !Array.isArray(entriesArray)) return;

        const oldData = (await getContext().loadWorldInfo(name)) || { entries: {} };
        const oldEntries = oldData.entries || {};
        const nextObj = {};

        entriesArray.forEach((entry) => {
            const uid = toNum(entry.uid, null);
            if (uid === null || uid === undefined) return;
            const oldEntry = oldEntries[uid] || {};
            nextObj[uid] = { ...oldEntry, ...cloneData(entry) };
        });

        await getContext().saveWorldInfo(name, { ...oldData, entries: nextObj }, false);
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
        await this.deleteWorldbook(oldName);
    },

    getMetadata() {
        return getContext().extensionSettings[CONFIG.settingsKey] || {};
    },

    async saveMetadata(meta) {
        const c = getContext();
        c.extensionSettings[CONFIG.settingsKey] = meta;
        c.saveSettingsDebounced?.();
    },
};

const Actions = {
    async init() {
        if (STATE.initialized) return;
        this.bindEvents();
        await this.refreshContext();
        STATE.initialized = true;
    },

    bindEvents() {
        const es = eventSource;
        const et = event_types;

        es.on(et.SETTINGS_UPDATED, () => {
            this.refreshContext().catch((e) => pushDebug('SETTINGS_UPDATED 刷新失败', e));
        });

        es.on(et.CHARACTER_SELECTED, () => {
            setTimeout(() => {
                this.refreshContext().catch((e) => pushDebug('CHARACTER_SELECTED 刷新失败', e));
            }, 100);
        });

        es.on(et.CHAT_CHANGED, () => {
            this.refreshContext().catch((e) => pushDebug('CHAT_CHANGED 刷新失败', e));
        });

        es.on(et.WORLDINFO_UPDATED, async (name) => {
            if (name && name === STATE.currentBookName) {
                try {
                    await this.loadBook(name);
                } catch (e) {
                    pushDebug(`WORLDINFO_UPDATED 加载失败: ${name}`, e);
                }
            }
        });
    },

    async refreshContext() {
        const [allBookNames, char, global, chat] = await Promise.all([
            API.getAllBookNames(),
            API.getCharBindings(),
            API.getGlobalBindings(),
            API.getChatBinding(),
        ]);

        STATE.allBookNames = allBookNames;
        STATE.bindings.char = char;
        STATE.bindings.global = global;
        STATE.bindings.chat = chat;
        STATE.metadata = API.getMetadata();

        if (document.getElementById(CONFIG.id)) {
            UI.renderBookSelector();
            UI.renderBindingView();
            UI.renderManageView(document.getElementById('wb-manage-search')?.value || '');
            UI.renderPresetBar();
            UI.renderDebug();
        }
    },

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

        const targetName = STATE.currentBookName;
        const targetEntries = STATE.entries;

        STATE.debouncer = setTimeout(() => {
            STATE.debouncer = null;
            if (targetName && Array.isArray(targetEntries)) {
                API.saveBookEntries(targetName, targetEntries).catch((e) => {
                    pushDebug(`保存失败: ${targetName}`, e);
                    toastr.error(`保存失败: ${targetName}`);
                });
            }
        }, 260);
    },

    async loadBook(name) {
        if (!name) return;
        await this.flushPendingSave();

        STATE.currentBookName = name;
        STATE.selectedUids.clear();
        STATE.searchText = '';

        try {
            STATE.entries = await API.loadBook(name);
        } catch (e) {
            pushDebug(`加载世界书失败: ${name}`, e);
            STATE.entries = [];
            toastr.error(`加载失败: ${name}`);
        }

        UI.renderBookSelector();
        UI.renderPresetBar();
        UI.renderEntryList('');
        UI.renderStats();
        UI.renderDebug();
    },

    getEntry(uidVal) {
        const uidNum = Number(uidVal);
        return STATE.entries.find((e) => Number(e.uid) === uidNum);
    },

    updateEntry(uidVal, updater) {
        const entry = this.getEntry(uidVal);
        if (!entry) return;
        updater(entry);
        this.queueSave();
        UI.renderStats();
    },

    async addEntry() {
        if (!STATE.currentBookName) {
            toastr.warning('请先选择一本世界书');
            return;
        }
        const maxUid = STATE.entries.reduce((m, e) => Math.max(m, Number(e.uid) || 0), -1);
        const item = normalizeEntry({
            uid: maxUid + 1,
            comment: '新建条目',
            disable: false,
            constant: false,
            content: '',
            key: [],
            order: 0,
            position: 1,
            depth: 4,
            probability: 100,
            selective: true,
        }, maxUid + 1, STATE.entries.length);

        STATE.entries.unshift(item);
        normalizeOrder(STATE.entries);
        UI.renderEntryList(STATE.searchText);
        UI.renderStats();
        this.queueSave();
    },

    async deleteEntry(uidVal) {
        if (!confirm('确定删除这个条目吗？')) return;
        const uidNum = Number(uidVal);
        STATE.entries = STATE.entries.filter((e) => Number(e.uid) !== uidNum);
        STATE.selectedUids.delete(uidNum);
        normalizeOrder(STATE.entries);
        UI.renderEntryList(STATE.searchText);
        UI.renderStats();
        this.queueSave();
    },

    select(uidVal, checked) {
        const uidNum = Number(uidVal);
        if (checked) STATE.selectedUids.add(uidNum);
        else STATE.selectedUids.delete(uidNum);
        UI.updateSelectionInfo();
    },

    selectAllVisible() {
        document.querySelectorAll('#wb-entry-list .wb-card[data-uid]').forEach((el) => {
            STATE.selectedUids.add(Number(el.dataset.uid));
        });
        UI.renderEntryList(STATE.searchText);
    },

    invertVisibleSelection() {
        document.querySelectorAll('#wb-entry-list .wb-card[data-uid]').forEach((el) => {
            const uidNum = Number(el.dataset.uid);
            if (STATE.selectedUids.has(uidNum)) STATE.selectedUids.delete(uidNum);
            else STATE.selectedUids.add(uidNum);
        });
        UI.renderEntryList(STATE.searchText);
    },

    clearSelection() {
        STATE.selectedUids.clear();
        UI.renderEntryList(STATE.searchText);
    },

    batchUpdate(fn) {
        if (!STATE.selectedUids.size) {
            toastr.warning('请先勾选条目');
            return;
        }
        STATE.entries.forEach((e) => {
            if (STATE.selectedUids.has(Number(e.uid))) fn(e);
        });
        UI.renderEntryList(STATE.searchText);
        UI.renderStats();
        this.queueSave();
    },

    batchEnable(v) {
        this.batchUpdate((e) => { e.disable = !v; });
    },

    batchConstant(v) {
        this.batchUpdate((e) => {
            e.constant = !!v;
            e.selective = !v;
        });
    },

    batchOrder(delta) {
        const d = Number(delta);
        if (!d) return;
        this.batchUpdate((e) => { e.order = toNum(e.order, 0) + d; });
        sortEntriesInPlace(STATE.entries);
        normalizeOrder(STATE.entries);
        UI.renderEntryList(STATE.searchText);
    },

    batchDepth(delta) {
        const d = Number(delta);
        if (!d) return;
        this.batchUpdate((e) => {
            e.depth = Math.max(0, toNum(e.depth, 4) + d);
        });
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
        if (!STATE.currentBookName) {
            toastr.warning('请先选择世界书');
            return;
        }

        const defaultName = `预设_${new Date().toLocaleTimeString().replace(/:/g, '-')}`;
        const name = prompt('输入预设名称：', defaultName);
        if (!name) return;

        const store = this.getPresetStore();
        const list = this.getBookPresets(STATE.currentBookName);

        const snap = {};
        STATE.entries.forEach((e) => {
            snap[e.uid] = {
                disable: !!e.disable,
                constant: !!e.constant,
                order: toNum(e.order, 0),
                depth: toNum(e.depth, 4),
                position: toNum(e.position, 1),
            };
        });

        const index = list.findIndex((p) => p.name === name);
        const preset = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name,
            snapshot: snap,
            updatedAt: Date.now(),
        };

        if (index >= 0) list[index] = preset;
        else list.push(preset);

        store[STATE.currentBookName] = list;
        STATE.metadata[CONFIG.presetStoreKey] = store;
        await API.saveMetadata(STATE.metadata);

        UI.renderPresetBar();
        toastr.success(`已保存预设：${name}`);
    },

    async applyPreset(presetId) {
        if (!STATE.currentBookName || !presetId) return;
        const list = this.getBookPresets(STATE.currentBookName);
        const preset = list.find((p) => p.id === presetId);
        if (!preset) return;

        const snap = preset.snapshot || {};
        STATE.entries.forEach((e) => {
            const s = snap[e.uid];
            if (!s) return;
            e.disable = !!s.disable;
            e.constant = !!s.constant;
            e.order = toNum(s.order, 0);
            e.depth = toNum(s.depth, 4);
            e.position = toNum(s.position, 1);
        });

        sortEntriesInPlace(STATE.entries);
        normalizeOrder(STATE.entries);

        UI.renderEntryList(STATE.searchText);
        UI.renderStats();
        await API.saveBookEntries(STATE.currentBookName, STATE.entries);
        toastr.success(`已应用预设：${preset.name}`);
    },

    async deletePreset(presetId) {
        if (!STATE.currentBookName || !presetId) return;
        const store = this.getPresetStore();
        const list = this.getBookPresets(STATE.currentBookName);
        const idx = list.findIndex((p) => p.id === presetId);
        if (idx < 0) return;
        if (!confirm(`删除预设 "${list[idx].name}" ?`)) return;

        list.splice(idx, 1);
        store[STATE.currentBookName] = list;
        STATE.metadata[CONFIG.presetStoreKey] = store;
        await API.saveMetadata(STATE.metadata);
        UI.renderPresetBar();
        toastr.success('预设已删除');
    },

    async saveBindings() {
        const view = document.getElementById('wb-view-binding');
        if (!view) return;

        const primary = view.querySelector('#wb-bind-char-primary')?.value || '';
        const chat = view.querySelector('#wb-bind-chat')?.value || '';

        const additional = Array.from(
            view.querySelectorAll('#wb-bind-char-selected .wb-bind-selected-item'),
        ).map((el) => el.dataset.val).filter(Boolean);

        const globalBooks = Array.from(
            view.querySelectorAll('#wb-bind-global-selected .wb-bind-selected-item'),
        ).map((el) => el.dataset.val).filter(Boolean);

        await setBinding('primary', primary, !!primary);

        const context = getContext();
        const charId = context.characterId;
        if (charId === 0 || charId) {
            const avatar = context.characters?.[charId]?.avatar;
            const fileName = getCharaFilename(null, { manualAvatarKey: avatar });
            charSetAuxWorlds(fileName, additional);
        }

        const currentGlobal = await API.getGlobalBindings();
        const toRemove = currentGlobal.filter((n) => !globalBooks.includes(n));
        const toAdd = globalBooks.filter((n) => !currentGlobal.includes(n));

        for (const n of toRemove) {
            // eslint-disable-next-line no-await-in-loop
            await setBinding('global', n, false);
        }
        for (const n of toAdd) {
            // eslint-disable-next-line no-await-in-loop
            await setBinding('global', n, true);
        }

        await setBinding('chat', chat, !!chat);

        await this.refreshContext();
        UI.renderBindingView();
        UI.renderBookSelector();
        toastr.success('绑定已保存');
    },

    async createBook() {
        const name = prompt('请输入新世界书名称：');
        if (!name) return;
        if (STATE.allBookNames.includes(name)) {
            toastr.warning('名称已存在');
            return;
        }
        await API.createWorldbook(name);
        await this.refreshContext();
        await this.loadBook(name);
    },

    async renameBook() {
        if (!STATE.currentBookName) return;
        const newName = prompt('重命名为：', STATE.currentBookName);
        if (!newName || newName === STATE.currentBookName) return;
        if (STATE.allBookNames.includes(newName)) {
            toastr.warning('目标名称已存在');
            return;
        }

        await this.flushPendingSave();
        const old = STATE.currentBookName;
        await API.renameWorldbook(old, newName);

        await this.refreshContext();
        await this.loadBook(newName);
    },

    async deleteBook() {
        if (!STATE.currentBookName) return;
        if (!confirm(`确定删除世界书 "${STATE.currentBookName}" 吗？`)) return;

        if (STATE.debouncer) {
            clearTimeout(STATE.debouncer);
            STATE.debouncer = null;
        }

        await API.deleteWorldbook(STATE.currentBookName);
        STATE.currentBookName = '';
        STATE.entries = [];
        STATE.selectedUids.clear();

        await this.refreshContext();
        UI.renderEntryList('');
        UI.renderStats();
    },

    async jumpToEditor(name) {
        if (!name) return;
        if (!STATE.allBookNames.includes(name)) return;
        await this.loadBook(name);
        UI.switchView('editor');
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
                    <div class="wb-tab" data-tab="binding">绑定世界书</div>
                    <div class="wb-tab" data-tab="manage">管理世界书</div>
                </div>
                <div id="wb-close" class="wb-header-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>

            <div class="wb-content">
                <div id="wb-debug-box" class="wb-hidden" style="margin-bottom:8px;border:1px solid #f1c6a8;background:#fff6ef;color:#7a3f18;border-radius:10px;padding:8px;"></div>

                <div id="wb-view-editor" class="wb-view-section">
                    <div class="wb-book-bar">
                        <select id="wb-book-selector" style="flex:1"></select>
                        <button class="wb-btn-circle" id="wb-btn-new" title="新建世界书"><i class="fa-solid fa-plus"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-rename" title="重命名"><i class="fa-solid fa-pen"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-delete" title="删除世界书"><i class="fa-solid fa-trash"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-stitch" title="缝合世界书"><i class="fa-solid fa-object-group"></i></button>
                    </div>

                    <div class="wb-stat-line" style="display:flex;justify-content:flex-end;margin-bottom:8px;">
                        <div id="wb-stat" style="font-size:12px;color:#5b708a;font-weight:700;">0 条目 | 0 Tokens (0 + 0)</div>
                    </div>

                    <div class="wb-preset-strip" id="wb-preset-strip">
                        <select id="wb-preset-selector" style="flex:1"></select>
                        <button class="wb-btn-rect" id="wb-preset-save" style="padding:6px 12px;font-size:12px;">保存当前状态</button>
                        <button class="wb-btn-rect" id="wb-preset-apply" style="padding:6px 12px;font-size:12px;">应用</button>
                        <button class="wb-btn-rect" id="wb-preset-delete" style="padding:6px 12px;font-size:12px;background:#e35151;">删除</button>
                    </div>

                    <div class="wb-tool-bar">
                        <input id="wb-search-entry" class="wb-input-dark" style="flex:1" placeholder="搜索条目...">
                        <button class="wb-btn-circle" id="wb-btn-add-entry" title="新增条目"><i class="fa-solid fa-plus"></i></button>
                    </div>

                    <div class="wb-batch-toolbar">
                        <span id="wb-selection-info">已选 0/0</span>
                        <button class="wb-btn-rect" id="wb-select-all" style="padding:5px 10px;font-size:12px;">全选</button>
                        <button class="wb-btn-rect" id="wb-select-invert" style="padding:5px 10px;font-size:12px;">反选</button>
                        <button class="wb-btn-rect" id="wb-select-clear" style="padding:5px 10px;font-size:12px;">清空</button>
                        <button class="wb-btn-rect" id="wb-batch-enable" style="padding:5px 10px;font-size:12px;">批量开启</button>
                        <button class="wb-btn-rect" id="wb-batch-disable" style="padding:5px 10px;font-size:12px;">批量关闭</button>
                        <button class="wb-btn-rect" id="wb-batch-const-on" style="padding:5px 10px;font-size:12px;">常驻</button>
                        <button class="wb-btn-rect" id="wb-batch-const-off" style="padding:5px 10px;font-size:12px;">非常驻</button>
                        <button class="wb-btn-rect" id="wb-batch-order-up" style="padding:5px 10px;font-size:12px;">顺序+1</button>
                        <button class="wb-btn-rect" id="wb-batch-order-down" style="padding:5px 10px;font-size:12px;">顺序-1</button>
                        <button class="wb-btn-rect" id="wb-batch-depth-up" style="padding:5px 10px;font-size:12px;">深度+1</button>
                        <button class="wb-btn-rect" id="wb-batch-depth-down" style="padding:5px 10px;font-size:12px;">深度-1</button>
                    </div>

                    <div id="wb-entry-list" class="wb-list"></div>
                </div>

                <div id="wb-view-binding" class="wb-view-section wb-hidden">
                    <div class="wb-bind-grid">
                        <div class="wb-bind-card">
                            <div class="wb-bind-title">角色主世界书</div>
                            <select id="wb-bind-char-primary"></select>
                            <div style="font-size:12px;color:#6a7f98;">双击当前选择可直接跳转编辑</div>
                        </div>

                        <div class="wb-bind-card">
                            <div class="wb-bind-title">角色附加世界书（仅显示已启用）</div>
                            <div id="wb-bind-char-selected" class="wb-scroll-list"></div>
                            <div style="font-size:12px;color:#6a7f98;">从下方下拉添加（支持搜索）</div>
                            <input id="wb-bind-char-add-search" class="wb-input-dark" placeholder="搜索要添加的世界书...">
                            <select id="wb-bind-char-add-selector"></select>
                        </div>

                        <div class="wb-bind-card">
                            <div class="wb-bind-title">全局世界书（仅显示已启用）</div>
                            <div id="wb-bind-global-selected" class="wb-scroll-list"></div>
                            <div style="font-size:12px;color:#6a7f98;">从下方下拉添加（支持搜索）</div>
                            <input id="wb-bind-global-add-search" class="wb-input-dark" placeholder="搜索要添加的世界书...">
                            <select id="wb-bind-global-add-selector"></select>
                        </div>

                        <div class="wb-bind-card">
                            <div class="wb-bind-title">聊天世界书</div>
                            <select id="wb-bind-chat"></select>
                            <div style="font-size:12px;color:#6a7f98;">双击当前选择可直接跳转编辑</div>
                        </div>
                    </div>
                    <div style="display:flex;justify-content:center;margin-top:12px;">
                        <button class="wb-btn-rect" id="wb-bind-save">保存绑定</button>
                    </div>
                </div>

                <div id="wb-view-manage" class="wb-view-section wb-hidden">
                    <div class="wb-tool-bar">
                        <input id="wb-manage-search" class="wb-input-dark" style="flex:1" placeholder="搜索世界书...">
                    </div>
                    <div id="wb-manage-content" class="wb-manage-content"></div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        const $ = (s) => panel.querySelector(s);
        const $$ = (s) => panel.querySelectorAll(s);

        $('#wb-close').onclick = async () => {
            await Actions.flushPendingSave();
            panel.remove();
        };

        $$('.wb-tab').forEach((t) => {
            t.onclick = () => this.switchView(t.dataset.tab);
        });

        $('#wb-book-selector').onchange = (e) => Actions.loadBook(e.target.value);
        $('#wb-btn-new').onclick = () => Actions.createBook();
        $('#wb-btn-rename').onclick = () => Actions.renameBook();
        $('#wb-btn-delete').onclick = () => Actions.deleteBook();
        $('#wb-btn-add-entry').onclick = () => Actions.addEntry();
        $('#wb-btn-stitch').onclick = () => this.openStitchModal();

        $('#wb-search-entry').oninput = (e) => this.renderEntryList(e.target.value || '');

        $('#wb-select-all').onclick = () => Actions.selectAllVisible();
        $('#wb-select-invert').onclick = () => Actions.invertVisibleSelection();
        $('#wb-select-clear').onclick = () => Actions.clearSelection();
        $('#wb-batch-enable').onclick = () => Actions.batchEnable(true);
        $('#wb-batch-disable').onclick = () => Actions.batchEnable(false);
        $('#wb-batch-const-on').onclick = () => Actions.batchConstant(true);
        $('#wb-batch-const-off').onclick = () => Actions.batchConstant(false);
        $('#wb-batch-order-up').onclick = () => Actions.batchOrder(1);
        $('#wb-batch-order-down').onclick = () => Actions.batchOrder(-1);
        $('#wb-batch-depth-up').onclick = () => Actions.batchDepth(1);
        $('#wb-batch-depth-down').onclick = () => Actions.batchDepth(-1);

        $('#wb-preset-save').onclick = () => Actions.saveCurrentPreset();
        $('#wb-preset-apply').onclick = () => Actions.applyPreset($('#wb-preset-selector').value);
        $('#wb-preset-delete').onclick = () => Actions.deletePreset($('#wb-preset-selector').value);

        $('#wb-bind-save').onclick = () => Actions.saveBindings();

        $('#wb-manage-search').oninput = (e) => this.renderManageView(e.target.value || '');

        this.renderBookSelector();
        this.renderPresetBar();
        this.renderEntryList('');
        this.renderBindingView();
        this.renderManageView('');
        this.renderStats();
        this.renderDebug();

        const prefer = STATE.bindings.char.primary || STATE.bindings.chat || STATE.allBookNames[0];
        if (prefer) {
            Actions.loadBook(prefer).catch((err) => {
                pushDebug(`初始加载失败: ${prefer}`, err);
                toastr.error('加载世界书失败');
            });
        }
    },

    renderDebug() {
        const box = document.getElementById('wb-debug-box');
        if (!box) return;

        if (!STATE.debugMessages.length) {
            box.classList.add('wb-hidden');
            box.innerHTML = '';
            return;
        }

        const latest = STATE.debugMessages.slice(-6);
        box.classList.remove('wb-hidden');
        box.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <strong>解析警告（${STATE.debugMessages.length}）</strong>
                <div style="display:flex;gap:6px;">
                    <button id="wb-debug-copy" class="wb-btn-rect" style="padding:4px 10px;font-size:12px;">复制日志</button>
                    <button id="wb-debug-clear" class="wb-btn-rect" style="padding:4px 10px;font-size:12px;background:#b76a36;">清空</button>
                </div>
            </div>
            <div style="margin-top:6px;font-size:12px;line-height:1.45;max-height:120px;overflow:auto;white-space:pre-wrap;">${escapeHtml(latest.join('\n'))}</div>
        `;

        const copyBtn = document.getElementById('wb-debug-copy');
        const clearBtn = document.getElementById('wb-debug-clear');

        if (copyBtn) {
            copyBtn.onclick = async () => {
                const text = STATE.debugMessages.join('\n');
                try {
                    await navigator.clipboard.writeText(text);
                    toastr.success('日志已复制');
                } catch (_e) {
                    prompt('复制失败，请手动复制：', text);
                }
            };
        }

        if (clearBtn) {
            clearBtn.onclick = () => {
                STATE.debugMessages = [];
                this.renderDebug();
            };
        }
    },

    switchView(viewName) {
        STATE.currentView = viewName;
        const panel = document.getElementById(CONFIG.id);
        if (!panel) return;

        panel.querySelectorAll('.wb-tab').forEach((t) => {
            t.classList.toggle('active', t.dataset.tab === viewName);
        });
        panel.querySelectorAll('.wb-view-section').forEach((v) => v.classList.add('wb-hidden'));
        panel.querySelector(`#wb-view-${viewName}`)?.classList.remove('wb-hidden');

        if (viewName === 'binding') this.renderBindingView();
        if (viewName === 'manage') this.renderManageView(panel.querySelector('#wb-manage-search')?.value || '');
        if (viewName === 'editor') {
            this.renderBookSelector();
            this.renderPresetBar();
            this.renderEntryList(STATE.searchText || '');
            this.renderStats();
        }
    },

    renderBookSelector() {
        const selector = document.getElementById('wb-book-selector');
        if (!selector) return;

        const { char, global, chat } = STATE.bindings;
        const charSet = new Set([char.primary, ...(char.additional || [])].filter(Boolean));
        const globalSet = new Set(global || []);

        let html = '';

        if (char.primary) {
            html += '<optgroup label="主世界书">';
            html += `<option value="${escapeHtml(char.primary)}">${escapeHtml(char.primary)}</option>`;
            html += '</optgroup>';
        }

        const extra = (char.additional || []).filter((n) => n && n !== char.primary);
        if (extra.length) {
            html += '<optgroup label="附加世界书">';
            extra.forEach((n) => {
                html += `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`;
            });
            html += '</optgroup>';
        }

        if (globalSet.size) {
            html += '<optgroup label="全局启用">';
            [...globalSet].sort((a, b) => a.localeCompare(b)).forEach((n) => {
                html += `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`;
            });
            html += '</optgroup>';
        }

        if (chat) {
            html += '<optgroup label="聊天世界书">';
            html += `<option value="${escapeHtml(chat)}">${escapeHtml(chat)}</option>`;
            html += '</optgroup>';
        }

        const others = STATE.allBookNames.filter((n) => !charSet.has(n) && !globalSet.has(n) && n !== chat);
        html += '<optgroup label="其他">';
        others.forEach((n) => {
            html += `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`;
        });
        html += '</optgroup>';

        selector.innerHTML = html;
        if (STATE.currentBookName) selector.value = STATE.currentBookName;
    },

    renderStats() {
        const stat = document.getElementById('wb-stat');
        if (!stat) return;

        let blue = 0;
        let green = 0;
        STATE.entries.forEach((e) => {
            if (e.disable) return;
            const t = tokenCount(e.content || '');
            if (e.constant) blue += t;
            else green += t;
        });

        stat.innerHTML = `${STATE.entries.length} 条目 | ${blue + green} Tokens (<span style="color:#2e73b7;">${blue}</span> + <span style="color:#3b9b5f;">${green}</span>)`;
    },

    renderPresetBar() {
        const sel = document.getElementById('wb-preset-selector');
        if (!sel) return;

        if (!STATE.currentBookName) {
            sel.innerHTML = '<option value="">先选择世界书</option>';
            return;
        }

        const presets = Actions.getBookPresets(STATE.currentBookName);
        let html = '<option value="">选择状态预设...</option>';
        presets.forEach((p) => {
            html += `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`;
        });
        sel.innerHTML = html;
    },

    renderEntryList(filterText = '') {
        STATE.searchText = filterText;
        const list = document.getElementById('wb-entry-list');
        if (!list) return;
        list.innerHTML = '';

        const term = String(filterText || '').toLowerCase().trim();

        const data = STATE.entries.filter((e) => {
            if (!term) return true;
            return safeText(e.comment).toLowerCase().includes(term);
        });

        if (!data.length) {
            const empty = document.createElement('div');
            empty.style.padding = '14px';
            empty.style.color = '#7c90a7';
            empty.style.fontSize = '13px';
            empty.textContent = STATE.entries.length ? '没有匹配条目' : '当前世界书没有条目';
            list.appendChild(empty);
            this.updateSelectionInfo();
            return;
        }

        data.forEach((entry) => {
            try {
                list.appendChild(this.createCard(entry));
            } catch (e) {
                pushDebug(`渲染条目失败 uid=${entry?.uid}`, e);
                list.appendChild(this.createBrokenCard(entry, e));
            }
        });

        this.updateSelectionInfo();
    },

    createBrokenCard(entry, err) {
        const card = document.createElement('div');
        card.className = 'wb-card';
        card.style.borderLeft = '4px solid #df8d4f';
        card.innerHTML = `
            <div class="wb-card-header">
                <div style="font-size:12px;color:#b15e2c;font-weight:700;">条目渲染失败</div>
                <div style="font-size:12px;color:#6c7d92;margin-top:4px;">uid: ${escapeHtml(entry?.uid ?? 'unknown')}</div>
                <div style="font-size:12px;color:#6c7d92;margin-top:2px;">${escapeHtml(err?.message || String(err))}</div>
            </div>
        `;
        return card;
    },

    updateSelectionInfo() {
        const el = document.getElementById('wb-selection-info');
        if (!el) return;
        el.textContent = `已选 ${STATE.selectedUids.size}/${STATE.entries.length}`;
    },

    createCard(entry) {
        const enabled = !entry.disable;
        const constant = !!entry.constant;
        const selected = STATE.selectedUids.has(Number(entry.uid));

        const posOptions = [
            ['before_character_definition', '角色定义之前'],
            ['after_character_definition', '角色定义之后'],
            ['before_author_note', '作者注释之前'],
            ['after_author_note', '作者注释之后'],
            ['at_depth', '@D'],
            ['before_example_messages', '示例消息之前'],
            ['after_example_messages', '示例消息之后'],
        ];

        const card = document.createElement('div');
        card.className = `wb-card ${enabled ? '' : 'disabled'} ${constant ? 'type-blue' : 'type-green'}`;
        card.dataset.uid = String(entry.uid);
        card.style.display = 'block';
        card.style.minHeight = '82px';

        card.innerHTML = `
            <div class="wb-card-header">
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <div class="wb-row">
                        <input type="checkbox" class="wb-select-entry" title="多选">
                        <input class="wb-inp-title inp-name" placeholder="条目名称">
                        <span class="wb-token-display"></span>
                        <i class="fa-solid fa-eye btn-edit" title="编辑内容"></i>
                        <i class="fa-solid fa-trash btn-delete" title="删除条目"></i>
                    </div>
                    <div class="wb-row">
                        <label class="wb-switch" title="启用/禁用">
                            <input type="checkbox" class="inp-enable">
                            <span class="wb-slider purple"></span>
                        </label>
                        <label class="wb-switch" title="常驻/非常驻">
                            <input type="checkbox" class="inp-constant">
                            <span class="wb-slider blue"></span>
                        </label>
                        <select class="wb-input-dark inp-pos"></select>
                        <input type="number" class="wb-inp-num inp-depth" title="深度">
                        <input type="number" class="wb-inp-num inp-order" title="顺序">
                        <span class="wb-pos-label" style="font-size:12px;color:#6b7f98;min-width:95px;text-align:right;"></span>
                    </div>
                </div>
            </div>
        `;

        const inpSelect = card.querySelector('.wb-select-entry');
        const inpName = card.querySelector('.inp-name');
        const tokenEl = card.querySelector('.wb-token-display');
        const inpEnable = card.querySelector('.inp-enable');
        const inpConstant = card.querySelector('.inp-constant');
        const inpPos = card.querySelector('.inp-pos');
        const inpDepth = card.querySelector('.inp-depth');
        const inpOrder = card.querySelector('.inp-order');
        const posLabel = card.querySelector('.wb-pos-label');

        inpSelect.checked = selected;
        inpName.value = safeText(entry.comment || '');
        tokenEl.textContent = String(tokenCount(entry.content || ''));
        inpEnable.checked = enabled;
        inpConstant.checked = constant;

        posOptions.forEach(([v, t]) => {
            const op = document.createElement('option');
            op.value = v;
            op.textContent = t;
            inpPos.appendChild(op);
        });

        const posStr = WI_POSITION_MAP[toNum(entry.position, 1)] || 'after_character_definition';
        inpPos.value = posStr;

        inpDepth.value = String(toNum(entry.depth, 4));
        inpOrder.value = String(toNum(entry.order, 0));
        posLabel.textContent = getPosLabel(entry);

        inpSelect.addEventListener('change', (e) => Actions.select(entry.uid, e.target.checked));

        inpName.addEventListener('input', (e) => {
            Actions.updateEntry(entry.uid, (d) => {
                d.comment = e.target.value;
            });
        });

        inpEnable.addEventListener('change', (e) => {
            Actions.updateEntry(entry.uid, (d) => {
                d.disable = !e.target.checked;
            });
            this.renderEntryList(STATE.searchText);
        });

        inpConstant.addEventListener('change', (e) => {
            Actions.updateEntry(entry.uid, (d) => {
                d.constant = !!e.target.checked;
                d.selective = !d.constant;
            });
            this.renderEntryList(STATE.searchText);
        });

        inpPos.addEventListener('change', (e) => {
            Actions.updateEntry(entry.uid, (d) => {
                d.position = WI_POSITION_MAP_REV[e.target.value] ?? 1;
            });
            posLabel.textContent = getPosLabel(Actions.getEntry(entry.uid) || entry);
        });

        inpDepth.addEventListener('input', (e) => {
            Actions.updateEntry(entry.uid, (d) => {
                d.depth = Math.max(0, toNum(e.target.value, 0));
            });
            posLabel.textContent = getPosLabel(Actions.getEntry(entry.uid) || entry);
        });

        inpOrder.addEventListener('input', (e) => {
            Actions.updateEntry(entry.uid, (d) => {
                d.order = toNum(e.target.value, 0);
            });
        });

        card.querySelector('.btn-delete').addEventListener('click', () => Actions.deleteEntry(entry.uid));
        card.querySelector('.btn-edit').addEventListener('click', () => this.openContentPopup(entry));

        return card;
    },

    openContentPopup(entry) {
        const old = document.getElementById('wb-content-popup-overlay');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'wb-content-popup-overlay';
        overlay.className = 'wb-modal-overlay';
        overlay.innerHTML = `
            <div class="wb-content-popup">
                <div class="wb-popup-header"></div>
                <input class="wb-popup-input-keys" placeholder="关键词（英文逗号分隔）">
                <textarea class="wb-popup-textarea" placeholder="内容..."></textarea>
                <div class="wb-popup-footer">
                    <button class="wb-btn-black btn-cancel">取消</button>
                    <button class="wb-btn-black btn-save">保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const header = overlay.querySelector('.wb-popup-header');
        const keyInput = overlay.querySelector('.wb-popup-input-keys');
        const textarea = overlay.querySelector('.wb-popup-textarea');

        header.textContent = safeText(entry.comment || '条目');
        keyInput.value = ensureArray(entry.key).join(',');
        textarea.value = safeText(entry.content || '');

        const close = () => overlay.remove();

        overlay.querySelector('.btn-cancel').onclick = close;
        overlay.querySelector('.btn-save').onclick = () => {
            Actions.updateEntry(entry.uid, (d) => {
                d.content = textarea.value;
                d.key = keyInput.value
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean);
            });
            this.renderEntryList(STATE.searchText);
            this.renderStats();
            close();
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) close();
        };
    },

    buildSelectOptions(all, selectedValue = '', includeEmpty = true) {
        let html = includeEmpty ? '<option value="">(无)</option>' : '';
        all.forEach((name) => {
            const sel = name === selectedValue ? 'selected' : '';
            html += `<option value="${escapeHtml(name)}" ${sel}>${escapeHtml(name)}</option>`;
        });
        return html;
    },

    filterAddSelector(selectEl, allNames, selectedSet, keyword) {
        const k = safeText(keyword).toLowerCase().trim();
        const candidates = allNames.filter((name) => !selectedSet.has(name));
        const finalList = k ? candidates.filter((n) => n.toLowerCase().includes(k)) : candidates;

        let html = '<option value="">选择要添加的世界书...</option>';
        finalList.forEach((n) => {
            html += `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`;
        });
        selectEl.innerHTML = html;
    },

    renderBindingSelectedList(container, names, onRemove, onJump) {
        container.innerHTML = '';
        if (!names.length) {
            container.innerHTML = '<div style="font-size:12px;color:#8599b3;padding:8px;">暂无启用项</div>';
            return;
        }

        names.forEach((name) => {
            const row = document.createElement('div');
            row.className = 'wb-bind-selected-item';
            row.dataset.val = name;
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.gap = '8px';
            row.style.padding = '7px 8px';
            row.style.marginBottom = '6px';
            row.style.borderRadius = '8px';
            row.style.background = '#ffffff';
            row.style.border = '1px solid #dfe8f4';
            row.style.cursor = 'pointer';

            const text = document.createElement('span');
            text.style.whiteSpace = 'nowrap';
            text.style.overflow = 'hidden';
            text.style.textOverflow = 'ellipsis';
            text.style.flex = '1';
            text.textContent = name;

            const actions = document.createElement('span');
            actions.style.display = 'flex';
            actions.style.alignItems = 'center';
            actions.style.gap = '6px';

            const jump = document.createElement('i');
            jump.className = 'fa-solid fa-eye wb-bind-jump';
            jump.title = '双击打开';

            const remove = document.createElement('i');
            remove.className = 'fa-solid fa-xmark wb-bind-remove';
            remove.title = '移除';

            actions.appendChild(jump);
            actions.appendChild(remove);
            row.appendChild(text);
            row.appendChild(actions);

            row.ondblclick = () => onJump(name);
            jump.ondblclick = (e) => {
                e.stopPropagation();
                onJump(name);
            };
            remove.onclick = (e) => {
                e.stopPropagation();
                onRemove(name);
            };

            container.appendChild(row);
        });
    },

    renderBindingView() {
        const view = document.getElementById('wb-view-binding');
        if (!view) return;

        const all = STATE.allBookNames;
        const { char, global, chat } = STATE.bindings;

        const primarySel = view.querySelector('#wb-bind-char-primary');
        const chatSel = view.querySelector('#wb-bind-chat');
        const charSelectedWrap = view.querySelector('#wb-bind-char-selected');
        const globalSelectedWrap = view.querySelector('#wb-bind-global-selected');
        const charAddSelector = view.querySelector('#wb-bind-char-add-selector');
        const globalAddSelector = view.querySelector('#wb-bind-global-add-selector');
        const charAddSearch = view.querySelector('#wb-bind-char-add-search');
        const globalAddSearch = view.querySelector('#wb-bind-global-add-search');

        primarySel.innerHTML = this.buildSelectOptions(all, char.primary || '', true);
        chatSel.innerHTML = this.buildSelectOptions(all, chat || '', true);

        primarySel.ondblclick = () => {
            if (primarySel.value) Actions.jumpToEditor(primarySel.value);
        };
        chatSel.ondblclick = () => {
            if (chatSel.value) Actions.jumpToEditor(chatSel.value);
        };

        let selectedCharAdditional = [...(char.additional || [])];
        let selectedGlobal = [...(global || [])];

        const rerender = () => {
            this.renderBindingSelectedList(
                charSelectedWrap,
                selectedCharAdditional,
                (name) => {
                    selectedCharAdditional = selectedCharAdditional.filter((n) => n !== name);
                    rerender();
                },
                (name) => Actions.jumpToEditor(name),
            );

            this.renderBindingSelectedList(
                globalSelectedWrap,
                selectedGlobal,
                (name) => {
                    selectedGlobal = selectedGlobal.filter((n) => n !== name);
                    rerender();
                },
                (name) => Actions.jumpToEditor(name),
            );

            this.filterAddSelector(
                charAddSelector,
                all,
                new Set(selectedCharAdditional),
                charAddSearch.value || '',
            );
            this.filterAddSelector(
                globalAddSelector,
                all,
                new Set(selectedGlobal),
                globalAddSearch.value || '',
            );
        };

        charAddSearch.oninput = () => {
            this.filterAddSelector(charAddSelector, all, new Set(selectedCharAdditional), charAddSearch.value || '');
        };
        globalAddSearch.oninput = () => {
            this.filterAddSelector(globalAddSelector, all, new Set(selectedGlobal), globalAddSearch.value || '');
        };

        charAddSelector.onchange = () => {
            const v = charAddSelector.value;
            if (!v) return;
            if (!selectedCharAdditional.includes(v)) selectedCharAdditional.push(v);
            charAddSelector.value = '';
            rerender();
        };

        globalAddSelector.onchange = () => {
            const v = globalAddSelector.value;
            if (!v) return;
            if (!selectedGlobal.includes(v)) selectedGlobal.push(v);
            globalAddSelector.value = '';
            rerender();
        };

        // 把当前选择写回 DOM，saveBindings 直接从 DOM 读
        const syncSelectedToDom = () => {
            charSelectedWrap.innerHTML = '';
            selectedCharAdditional.forEach((n) => {
                const el = document.createElement('div');
                el.className = 'wb-bind-selected-item wb-hidden-sync';
                el.dataset.val = n;
                el.style.display = 'none';
                charSelectedWrap.appendChild(el);
            });

            globalSelectedWrap.innerHTML = '';
            selectedGlobal.forEach((n) => {
                const el = document.createElement('div');
                el.className = 'wb-bind-selected-item wb-hidden-sync';
                el.dataset.val = n;
                el.style.display = 'none';
                globalSelectedWrap.appendChild(el);
            });
        };

        const originalRenderBindingSelectedList = this.renderBindingSelectedList.bind(this);
        this.renderBindingSelectedList = (container, names, onRemove, onJump) => {
            originalRenderBindingSelectedList(container, names, onRemove, onJump);
            if (container === charSelectedWrap || container === globalSelectedWrap) {
                // 保证有可见项的同时，也有标准 class + data-val 节点给 saveBindings 读取
                names.forEach((n) => {
                    const exists = Array.from(container.querySelectorAll('.wb-bind-selected-item')).some((el) => el.dataset.val === n);
                    if (!exists) {
                        const h = document.createElement('div');
                        h.className = 'wb-bind-selected-item';
                        h.dataset.val = n;
                        h.style.display = 'none';
                        container.appendChild(h);
                    }
                });
            }
        };

        rerender();
        syncSelectedToDom();

        // 恢复函数，避免影响其它地方
        this.renderBindingSelectedList = originalRenderBindingSelectedList;
    },

    renderManageView(filterText = '') {
        const container = document.getElementById('wb-manage-content');
        if (!container) return;
        container.innerHTML = '';

        const term = safeText(filterText).toLowerCase();
        const list = STATE.allBookNames.filter((n) => !term || n.toLowerCase().includes(term));

        list.forEach((name) => {
            const card = document.createElement('div');
            card.className = 'wb-manage-card';
            card.innerHTML = `
                <div class="wb-card-top">
                    <div class="wb-card-info">
                        <span class="wb-card-title">${escapeHtml(name)}</span>
                    </div>
                    <div class="wb-manage-icons">
                        <div class="wb-icon-action" data-action="open" title="打开编辑"><i class="fa-solid fa-eye"></i></div>
                        <div class="wb-icon-action" data-action="bind" title="设为当前角色主世界书"><i class="fa-solid fa-link"></i></div>
                        <div class="wb-icon-action btn-del" data-action="delete" title="删除"><i class="fa-solid fa-trash"></i></div>
                    </div>
                </div>
            `;

            card.querySelector('[data-action="open"]').onclick = () => Actions.jumpToEditor(name);
            card.querySelector('[data-action="bind"]').onclick = async () => {
                await setBinding('primary', name, true);
                await Actions.refreshContext();
                toastr.success(`已绑定主世界书：${name}`);
            };
            card.querySelector('[data-action="delete"]').onclick = async () => {
                if (!confirm(`删除 "${name}" ?`)) return;
                await API.deleteWorldbook(name);
                if (STATE.currentBookName === name) {
                    STATE.currentBookName = '';
                    STATE.entries = [];
                    STATE.selectedUids.clear();
                }
                await Actions.refreshContext();
                this.renderManageView(filterText);
                this.renderEntryList(STATE.searchText);
                this.renderStats();
            };

            container.appendChild(card);
        });
    },

    openStitchModal() {
        if (!STATE.allBookNames.length) {
            toastr.warning('没有可用世界书');
            return;
        }

        const sideState = {
            mode: 'copy',
            left: {
                book: STATE.currentBookName || STATE.allBookNames[0],
                entries: [],
                selected: new Set(),
                keyword: '',
            },
            right: {
                book: STATE.allBookNames.find((n) => n !== (STATE.currentBookName || '')) || STATE.allBookNames[0],
                entries: [],
                selected: new Set(),
                keyword: '',
            },
        };

        const overlay = document.createElement('div');
        overlay.className = 'wb-sort-modal-overlay';
        overlay.style.zIndex = '24000';
        overlay.innerHTML = `
            <div class="wb-sort-modal" style="width:95vw;max-width:1500px;height:90vh;">
                <div class="wb-sort-header">
                    <span>缝合世界书工具</span>
                    <div style="display:flex;align-items:center;gap:8px;">
                        <label style="font-size:12px;color:#6a7f98;">
                            拖拽模式
                            <select id="wb-stitch-mode">
                                <option value="copy">复制</option>
                                <option value="move">移动</option>
                            </select>
                        </label>
                        <div id="wb-stitch-close" style="cursor:pointer;"><i class="fa-solid fa-xmark"></i></div>
                    </div>
                </div>
                <div class="wb-sort-body" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        const body = overlay.querySelector('.wb-sort-body');
        const close = () => overlay.remove();

        overlay.querySelector('#wb-stitch-close').onclick = close;
        overlay.onclick = (e) => { if (e.target === overlay) close(); };
        overlay.querySelector('#wb-stitch-mode').onchange = (e) => {
            sideState.mode = e.target.value;
        };

        const getSide = (key) => sideState[key];
        const otherKey = (k) => (k === 'left' ? 'right' : 'left');
        const getNextUid = (arr) => arr.reduce((m, e) => Math.max(m, toNum(e.uid, 0)), -1) + 1;

        const renderSide = (key) => {
            const side = getSide(key);
            const other = getSide(otherKey(key));

            let options = '';
            STATE.allBookNames.forEach((n) => {
                options += `<option value="${escapeHtml(n)}" ${n === side.book ? 'selected' : ''}>${escapeHtml(n)}</option>`;
            });

            const term = safeText(side.keyword).toLowerCase().trim();
            const visible = side.entries.filter((e) => !term || safeText(e.comment).toLowerCase().includes(term));

            const htmlItems = visible.map((e) => {
                const checked = side.selected.has(Number(e.uid));
                return `
                    <div class="wb-stitch-item" draggable="true" data-side="${key}" data-uid="${e.uid}">
                        <input type="checkbox" data-check="${e.uid}" ${checked ? 'checked' : ''}>
                        <div style="min-width:0;flex:1;">
                            <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(e.comment || '(无标题)')}</div>
                            <div style="font-size:12px;color:#6b7f98;">${escapeHtml(getPosLabel(e))} · order ${toNum(e.order, 0)} · ${e.disable ? '关闭' : '开启'}</div>
                        </div>
                    </div>
                `;
            }).join('');

            const panel = body.querySelector(`#wb-stitch-${key}`) || document.createElement('div');
            panel.id = `wb-stitch-${key}`;
            panel.className = 'wb-bind-card';
            panel.innerHTML = `
                <div class="wb-bind-title">${key === 'left' ? '左侧' : '右侧'}世界书</div>
                <div style="display:flex;gap:8px;">
                    <select data-book="${key}" style="flex:1">${options}</select>
                    <button class="wb-btn-rect" data-copy="${key}" style="padding:6px 10px;font-size:12px;">复制到${key === 'left' ? '右' : '左'}</button>
                    <button class="wb-btn-rect" data-move="${key}" style="padding:6px 10px;font-size:12px;">移动到${key === 'left' ? '右' : '左'}</button>
                </div>
                <div style="display:flex;gap:8px;margin-top:8px;">
                    <input class="wb-input-dark" data-search="${key}" placeholder="搜索条目..." value="${escapeHtml(side.keyword)}" style="flex:1">
                    <button class="wb-btn-rect" data-all="${key}" style="padding:6px 10px;font-size:12px;">全选</button>
                    <button class="wb-btn-rect" data-invert="${key}" style="padding:6px 10px;font-size:12px;">反选</button>
                    <button class="wb-btn-rect" data-clear="${key}" style="padding:6px 10px;font-size:12px;">清空</button>
                </div>
                <div class="wb-scroll-list wb-stitch-list" data-drop="${key}" style="margin-top:8px;min-height:360px;">${htmlItems || '<div style="font-size:12px;color:#8ca0b9;padding:8px;text-align:center;">暂无条目</div>'}</div>
                <div style="display:flex;justify-content:center;gap:8px;margin-top:8px;">
                    <button class="wb-btn-rect" data-edit="${key}" style="padding:6px 14px;font-size:12px;">编辑</button>
                    <button class="wb-btn-rect" data-del="${key}" style="padding:6px 14px;font-size:12px;background:#d75252;">删除</button>
                </div>
                <div style="text-align:center;font-size:12px;color:#7188a3;margin-top:6px;">已选 ${side.selected.size}/${side.entries.length} · 拖拽到另一侧${sideState.mode === 'copy' ? '复制' : '移动'}</div>
            `;

            if (!body.querySelector(`#wb-stitch-${key}`)) body.appendChild(panel);

            panel.querySelector(`[data-book="${key}"]`).onchange = async (e) => {
                side.book = e.target.value;
                side.entries = await API.loadBook(side.book);
                side.selected.clear();
                renderSide(key);
            };

            panel.querySelector(`[data-search="${key}"]`).oninput = (e) => {
                side.keyword = e.target.value || '';
                renderSide(key);
            };

            panel.querySelector(`[data-all="${key}"]`).onclick = () => {
                side.entries.forEach((e) => side.selected.add(Number(e.uid)));
                renderSide(key);
            };

            panel.querySelector(`[data-invert="${key}"]`).onclick = () => {
                side.entries.forEach((e) => {
                    const id = Number(e.uid);
                    if (side.selected.has(id)) side.selected.delete(id);
                    else side.selected.add(id);
                });
                renderSide(key);
            };

            panel.querySelector(`[data-clear="${key}"]`).onclick = () => {
                side.selected.clear();
                renderSide(key);
            };

            panel.querySelectorAll('[data-check]').forEach((cb) => {
                cb.onchange = (e) => {
                    const id = Number(e.target.dataset.check);
                    if (e.target.checked) side.selected.add(id);
                    else side.selected.delete(id);
                    renderSide(key);
                };
            });

            const transferOne = async (uidNum, mode) => {
                const src = side.entries.find((e) => Number(e.uid) === Number(uidNum));
                if (!src) return;

                const clone = cloneData(src);
                clone.uid = getNextUid(other.entries);
                other.entries.push(clone);
                normalizeOrder(other.entries);

                if (mode === 'move') {
                    side.entries = side.entries.filter((e) => Number(e.uid) !== Number(uidNum));
                    side.selected.delete(Number(uidNum));
                    normalizeOrder(side.entries);
                }

                await Promise.all([
                    API.saveBookEntries(side.book, side.entries),
                    API.saveBookEntries(other.book, other.entries),
                ]);
            };

            const transferSelected = async (mode) => {
                const ids = [...side.selected];
                if (!ids.length) {
                    toastr.warning('请先选择条目');
                    return;
                }

                for (const id of ids) {
                    // eslint-disable-next-line no-await-in-loop
                    await transferOne(id, mode);
                }

                side.selected.clear();
                renderSide(key);
                renderSide(otherKey(key));
                toastr.success(mode === 'move' ? '移动完成' : '复制完成');
            };

            panel.querySelector(`[data-copy="${key}"]`).onclick = () => transferSelected('copy');
            panel.querySelector(`[data-move="${key}"]`).onclick = () => transferSelected('move');

            panel.querySelector(`[data-edit="${key}"]`).onclick = async () => {
                if (side.selected.size !== 1) {
                    toastr.warning('编辑时请只选择一个条目');
                    return;
                }
                const id = [...side.selected][0];
                const item = side.entries.find((e) => Number(e.uid) === Number(id));
                if (!item) return;

                const title = prompt('条目标题：', item.comment || '');
                if (title === null) return;
                const content = prompt('条目内容：', item.content || '');
                if (content === null) return;

                item.comment = title;
                item.content = content;
                await API.saveBookEntries(side.book, side.entries);
                renderSide(key);
            };

            panel.querySelector(`[data-del="${key}"]`).onclick = async () => {
                if (!side.selected.size) {
                    toastr.warning('请先选择条目');
                    return;
                }
                if (!confirm(`删除 ${side.selected.size} 个条目？`)) return;

                side.entries = side.entries.filter((e) => !side.selected.has(Number(e.uid)));
                side.selected.clear();
                normalizeOrder(side.entries);
                await API.saveBookEntries(side.book, side.entries);
                renderSide(key);
            };

            const dropArea = panel.querySelector(`[data-drop="${key}"]`);
            dropArea.addEventListener('dragover', (e) => e.preventDefault());
            dropArea.addEventListener('drop', async (e) => {
                e.preventDefault();
                const fromSide = e.dataTransfer.getData('text/from-side');
                const uid = e.dataTransfer.getData('text/uid');
                if (!fromSide || !uid || fromSide === key) return;

                const from = getSide(fromSide);
                const to = getSide(key);
                const src = from.entries.find((it) => String(it.uid) === String(uid));
                if (!src) return;

                const copy = cloneData(src);
                copy.uid = getNextUid(to.entries);
                to.entries.push(copy);
                normalizeOrder(to.entries);

                if (sideState.mode === 'move') {
                    from.entries = from.entries.filter((it) => String(it.uid) !== String(uid));
                    from.selected.delete(Number(uid));
                    normalizeOrder(from.entries);
                }

                await Promise.all([
                    API.saveBookEntries(from.book, from.entries),
                    API.saveBookEntries(to.book, to.entries),
                ]);

                renderSide(fromSide);
                renderSide(key);
                toastr.success(sideState.mode === 'move' ? '已移动' : '已复制');
            });

            panel.querySelectorAll('.wb-stitch-item[draggable="true"]').forEach((itemEl) => {
                itemEl.addEventListener('dragstart', (e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/from-side', itemEl.dataset.side || '');
                    e.dataTransfer.setData('text/uid', itemEl.dataset.uid || '');
                });
            });
        };

        const initLoad = async () => {
            sideState.left.entries = await API.loadBook(sideState.left.book);
            sideState.right.entries = await API.loadBook(sideState.right.book);
            normalizeOrder(sideState.left.entries);
            normalizeOrder(sideState.right.entries);
            renderSide('left');
            renderSide('right');
        };

        initLoad().catch((err) => {
            pushDebug('加载缝合面板失败', err);
            toastr.error('加载缝合面板失败');
        });
    },
};

jQuery(async () => {
    const injectButton = () => {
        if (document.getElementById(CONFIG.btnId)) return;
        const container = document.querySelector('#options .options-content');
        if (!container) return;

        const btn = document.createElement('a');
        btn.id = CONFIG.btnId;
        btn.className = 'interactable';
        btn.title = '世界书管理';
        btn.innerHTML = `
            <i class="fa-lg fa-solid fa-book-journal-whills"></i>
            <span>世界书</span>
        `;
        btn.onclick = (e) => {
            e.preventDefault();
            $('#options').hide();
            UI.open();
        };
        container.appendChild(btn);
    };

    injectButton();
    try {
        await Actions.init();
        console.log('[Enhanced WB] loaded');
    } catch (e) {
        pushDebug('初始化失败', e);
    }
});
