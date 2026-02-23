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

function safeContent(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/\u0000/g, '');
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
        return v.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return [];
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
    out.comment = safeText(out.comment ?? out.title ?? out.name ?? out.keyString ?? `条目 ${out.uid}`);
    out.content = safeContent(out.content ?? out.text ?? out.value ?? '');
    out.key = ensureArray(out.key ?? out.keys ?? out.keyword ?? out.keywords).map((k) => safeText(k)).filter(Boolean);

    out.position = normalizePosition(out.position);
    out.depth = Math.max(0, toNum(out.depth, 4));
    out.order = toNum(out.order, idx);
    out.probability = toNum(out.probability, 100);

    if (typeof out.disable === 'boolean') out.disable = out.disable;
    else if (out.enabled !== undefined) out.disable = !toBool(out.enabled, true);
    else out.disable = false;

    out.constant = toBool(out.constant, false);
    if (typeof out.selective !== 'boolean') out.selective = !out.constant;

    return out;
}

function fallbackEntry(rawEntry, uidFallback, idx) {
    const uid = toNum(rawEntry?.uid, toNum(uidFallback, idx));
    const constant = toBool(rawEntry?.constant, false);
    return {
        uid,
        comment: safeText(rawEntry?.comment ?? rawEntry?.name ?? rawEntry?.title ?? `条目 ${uid}`),
        content: safeContent(rawEntry?.content ?? ''),
        key: ensureArray(rawEntry?.key).map((k) => safeText(k)).filter(Boolean),
        position: normalizePosition(rawEntry?.position),
        depth: Math.max(0, toNum(rawEntry?.depth, 4)),
        order: toNum(rawEntry?.order, idx),
        probability: toNum(rawEntry?.probability, 100),
        disable: toBool(rawEntry?.disable, false),
        constant,
        selective: rawEntry?.selective ?? !constant,
    };
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
        if (enabled && worldName) context.chatMetadata.world_info = worldName;
        else delete context.chatMetadata.world_info;
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
        const pairs = Array.isArray(rawEntries)
            ? rawEntries.map((e, i) => [String(e?.uid ?? i), e])
            : Object.entries(rawEntries);

        const arr = [];
        pairs.forEach(([uidKey, rawEntry], idx) => {
            try {
                arr.push(normalizeEntry(rawEntry, uidKey, idx));
            } catch (_e) {
                arr.push(fallbackEntry(rawEntry, uidKey, idx));
            }
        });

        const used = new Set();
        arr.forEach((e, i) => {
            let uid = toNum(e.uid, i);
            while (used.has(uid)) uid += 1;
            e.uid = uid;
            used.add(uid);
        });

        sortEntriesInPlace(arr);
        normalizeOrder(arr);
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

        es.on(et.SETTINGS_UPDATED, () => this.refreshContext().catch(console.error));
        es.on(et.CHAT_CHANGED, () => this.refreshContext().catch(console.error));
        es.on(et.CHARACTER_SELECTED, () => setTimeout(() => this.refreshContext().catch(console.error), 120));

        es.on(et.WORLDINFO_UPDATED, async (name) => {
            if (name && name === STATE.currentBookName) {
                await this.loadBook(name);
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
                API.saveBookEntries(targetName, targetEntries).catch(console.error);
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
            console.error(e);
            STATE.entries = [];
            toastr.error(`加载失败: ${name}`);
        }

        UI.renderBookSelector();
        UI.renderPresetBar();
        UI.renderEntryList('');
        UI.renderStats();
        UI.updateSelectionInfo();
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
        if (!STATE.currentBookName) return toastr.warning('请先选择一本世界书');
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
        if (!STATE.selectedUids.size) return;
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
        if (!STATE.currentBookName) return toastr.warning('请先选择世界书');

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

        const idx = list.findIndex((p) => p.name === name);
        const preset = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name,
            snapshot: snap,
            updatedAt: Date.now(),
        };

        if (idx >= 0) list[idx] = preset;
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
        const charAddTags = view.querySelectorAll('.wb-ms-tag[data-bind-type="wb-bind-char-add"]');
        const globalTags = view.querySelectorAll('.wb-ms-tag[data-bind-type="wb-bind-global"]');
        const chat = view.querySelector('#wb-bind-chat')?.value || '';

        const additional = Array.from(charAddTags).map((el) => el.dataset.val).filter(Boolean);
        const globalBooks = Array.from(globalTags).map((el) => el.dataset.val).filter(Boolean);

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
            await setBinding('global', n, false);
        }
        for (const n of toAdd) {
            await setBinding('global', n, true);
        }

        await setBinding('chat', chat, !!chat);

        await this.refreshContext();
        UI.renderBindingView();
        UI.renderBookSelector();
    },

    async createBook() {
        const name = prompt('请输入新世界书名称：');
        if (!name) return;
        if (STATE.allBookNames.includes(name)) return toastr.warning('名称已存在');
        await API.createWorldbook(name);
        await this.refreshContext();
        await this.loadBook(name);
    },

    async renameBook() {
        if (!STATE.currentBookName) return;
        const newName = prompt('重命名为：', STATE.currentBookName);
        if (!newName || newName === STATE.currentBookName) return;
        if (STATE.allBookNames.includes(newName)) return toastr.warning('目标名称已存在');

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
        if (!name || !STATE.allBookNames.includes(name)) return;
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
                    <div class="wb-tab" data-tab="stitch">缝合世界书</div>
                    <div class="wb-tab" data-tab="binding">绑定世界书</div>
                    <div class="wb-tab" data-tab="manage">管理世界书</div>
                </div>
                <div id="wb-close" class="wb-header-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>

            <div class="wb-content">
                <div id="wb-view-editor" class="wb-view-section">
                    <div class="wb-book-bar">
                        <div style="position:relative;flex:1;">
                            <select id="wb-book-selector" style="width:100%;"></select>
                        </div>
                        <button class="wb-btn-circle" id="wb-btn-new" title="新建世界书"><i class="fa-solid fa-plus"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-rename" title="重命名"><i class="fa-solid fa-pen"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-delete" title="删除世界书"><i class="fa-solid fa-trash"></i></button>
                    </div>

                    <div class="wb-stat-line">
                        <div id="wb-stat">0 条目 | 0 Tokens (0 + 0)</div>
                    </div>

                    <div class="wb-preset-strip" id="wb-preset-strip">
                        <select id="wb-preset-selector" style="flex:1"></select>
                        <button class="wb-btn-rect" id="wb-preset-save">保存当前状态</button>
                        <button class="wb-btn-rect" id="wb-preset-apply">应用</button>
                        <button class="wb-btn-rect danger" id="wb-preset-delete">删除</button>
                    </div>

                    <div class="wb-tool-bar">
                        <input id="wb-search-entry" class="wb-input-dark" style="flex:1" placeholder="搜索条目...">
                        <button class="wb-btn-circle" id="wb-btn-add-entry" title="新增条目"><i class="fa-solid fa-plus"></i></button>
                    </div>

                    <div id="wb-batch-toolbar" class="wb-batch-toolbar wb-hidden">
                        <span id="wb-selection-info">已选 0/0</span>
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

                    <div id="wb-entry-list" class="wb-list"></div>
                </div>

                <div id="wb-view-binding" class="wb-view-section wb-hidden">
                    <div class="wb-bind-grid">
                        <div class="wb-bind-card">
                            <div class="wb-bind-title">角色世界书</div>
                            <div class="wb-bind-label">主要世界书</div>
                            <div style="position:relative;"><select id="wb-bind-char-primary" style="width:100%"></select></div>
                            <div class="wb-bind-label">附加世界书</div>
                            <div class="wb-scroll-list" id="wb-bind-char-list"></div>
                        </div>

                        <div class="wb-bind-card">
                            <div class="wb-bind-title">全局世界书</div>
                            <div class="wb-scroll-list" id="wb-bind-global-list"></div>
                        </div>

                        <div class="wb-bind-card">
                            <div class="wb-bind-title">聊天世界书</div>
                            <div style="position:relative;"><select id="wb-bind-chat" style="width:100%"></select></div>
                        </div>
                    </div>
                    <div class="wb-bind-actions">
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
            t.onclick = () => {
                const tab = t.dataset.tab;
                if (tab === 'stitch') {
                    this.openStitchModal();
                    return;
                }
                this.switchView(tab);
            };
        });

        $('#wb-book-selector').addEventListener('change', (e) => Actions.loadBook(e.target.value));
        $('#wb-btn-new').onclick = () => Actions.createBook();
        $('#wb-btn-rename').onclick = () => Actions.renameBook();
        $('#wb-btn-delete').onclick = () => Actions.deleteBook();
        $('#wb-btn-add-entry').onclick = () => Actions.addEntry();

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

        $('#wb-bind-save').onclick = async () => {
            await Actions.saveBindings();
            toastr.success('绑定已保存');
        };

        $('#wb-manage-search').oninput = (e) => this.renderManageView(e.target.value || '');

        this.renderBookSelector();
        this.renderPresetBar();
        this.renderEntryList('');
        this.renderBindingView();
        this.renderManageView('');
        this.renderStats();
        this.updateSelectionInfo();
        this.switchView('editor');

        const prefer = STATE.bindings.char.primary || STATE.bindings.chat || STATE.allBookNames[0];
        if (prefer) {
            Actions.loadBook(prefer).catch((err) => {
                console.error(err);
                toastr.error('加载世界书失败');
            });
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
            this.updateSelectionInfo();
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
            html += '<optgroup label="主要世界书">';
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

        html += '<optgroup label="其他">';
        STATE.allBookNames.forEach((n) => {
            html += `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`;
        });
        html += '</optgroup>';

        selector.innerHTML = html;
        if (STATE.currentBookName) selector.value = STATE.currentBookName;
        this.applyCustomDropdown('wb-book-selector');
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
            empty.className = 'wb-empty';
            empty.textContent = STATE.entries.length ? '没有匹配条目' : '当前世界书没有条目';
            list.appendChild(empty);
            this.updateSelectionInfo();
            return;
        }

        data.forEach((entry) => {
            try {
                list.appendChild(this.createCard(entry));
            } catch (err) {
                const broken = document.createElement('div');
                broken.className = 'wb-card';
                broken.innerHTML = `<div class="wb-card-header">条目渲染失败 uid=${escapeHtml(entry?.uid)} | ${escapeHtml(err?.message || 'unknown')}</div>`;
                list.appendChild(broken);
            }
        });

        this.updateSelectionInfo();
    },

    updateSelectionInfo() {
        const info = document.getElementById('wb-selection-info');
        const bar = document.getElementById('wb-batch-toolbar');
        if (!info || !bar) return;

        info.textContent = `已选 ${STATE.selectedUids.size}/${STATE.entries.length}`;
        bar.classList.toggle('wb-hidden', STATE.selectedUids.size === 0);
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

        card.innerHTML = `
            <div class="wb-card-header">
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <div class="wb-row">
                        <input type="checkbox" class="wb-select-entry" ${selected ? 'checked' : ''} title="选择">
                        <input class="wb-inp-title inp-name" value="${escapeHtml(entry.comment || '')}" placeholder="条目名称">
                        <span class="wb-token-display">${tokenCount(entry.content || '')}</span>
                        <i class="fa-solid fa-eye btn-edit" title="编辑内容"></i>
                        <i class="fa-solid fa-trash btn-delete" title="删除条目"></i>
                    </div>
                    <div class="wb-row">
                        <label class="wb-switch" title="启用/禁用">
                            <input type="checkbox" class="inp-enable" ${enabled ? 'checked' : ''}>
                            <span class="wb-slider purple"></span>
                        </label>
                        <label class="wb-switch" title="常驻/非常驻">
                            <input type="checkbox" class="inp-constant" ${constant ? 'checked' : ''}>
                            <span class="wb-slider blue"></span>
                        </label>
                        <select class="wb-input-dark inp-pos">
                            ${posOptions.map(([v, t]) => `<option value="${v}" ${v === (WI_POSITION_MAP[toNum(entry.position, 1)] || 'after_character_definition') ? 'selected' : ''}>${t}</option>`).join('')}
                        </select>
                        <input type="number" class="wb-inp-num inp-depth" value="${toNum(entry.depth, 4)}" title="深度">
                        <input type="number" class="wb-inp-num inp-order" value="${toNum(entry.order, 0)}" title="顺序">
                        <span class="wb-pos-label">${escapeHtml(getPosLabel(entry))}</span>
                    </div>
                </div>
            </div>
        `;

        const bind = (selector, evt, fn) => {
            const el = card.querySelector(selector);
            if (el) el.addEventListener(evt, fn);
        };

        bind('.wb-select-entry', 'change', (e) => Actions.select(entry.uid, e.target.checked));
        bind('.inp-name', 'input', (e) => Actions.updateEntry(entry.uid, (d) => { d.comment = e.target.value; }));

        bind('.inp-enable', 'change', (e) => {
            Actions.updateEntry(entry.uid, (d) => { d.disable = !e.target.checked; });
            this.renderEntryList(STATE.searchText);
        });

        bind('.inp-constant', 'change', (e) => {
            Actions.updateEntry(entry.uid, (d) => {
                d.constant = !!e.target.checked;
                d.selective = !d.constant;
            });
            this.renderEntryList(STATE.searchText);
        });

        bind('.inp-pos', 'change', (e) => {
            Actions.updateEntry(entry.uid, (d) => {
                d.position = WI_POSITION_MAP_REV[e.target.value] ?? 1;
            });
            const label = card.querySelector('.wb-pos-label');
            if (label) label.textContent = getPosLabel(Actions.getEntry(entry.uid) || entry);
        });

        bind('.inp-depth', 'input', (e) => {
            Actions.updateEntry(entry.uid, (d) => { d.depth = Math.max(0, toNum(e.target.value, 0)); });
            const label = card.querySelector('.wb-pos-label');
            if (label) label.textContent = getPosLabel(Actions.getEntry(entry.uid) || entry);
        });

        bind('.inp-order', 'input', (e) => {
            Actions.updateEntry(entry.uid, (d) => { d.order = toNum(e.target.value, 0); });
        });

        bind('.btn-delete', 'click', () => Actions.deleteEntry(entry.uid));
        bind('.btn-edit', 'click', () => this.openContentPopup(entry));

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
                <div class="wb-popup-header">${escapeHtml(entry.comment || '条目')}</div>
                <input class="wb-popup-input-keys" placeholder="关键词（英文逗号分隔）" value="${escapeHtml(ensureArray(entry.key).join(','))}">
                <textarea class="wb-popup-textarea" placeholder="内容...">${escapeHtml(entry.content || '')}</textarea>
                <div class="wb-popup-footer">
                    <button class="wb-btn-black btn-cancel">取消</button>
                    <button class="wb-btn-black btn-save">保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const keyInput = overlay.querySelector('.wb-popup-input-keys');
        const textarea = overlay.querySelector('.wb-popup-textarea');

        const close = () => overlay.remove();

        overlay.querySelector('.btn-cancel').onclick = close;
        overlay.querySelector('.btn-save').onclick = () => {
            Actions.updateEntry(entry.uid, (d) => {
                d.content = textarea.value;
                d.key = keyInput.value.split(',').map((v) => v.trim()).filter(Boolean);
            });
            this.renderEntryList(STATE.searchText);
            this.renderStats();
            close();
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) close();
        };
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
                html += `<option value="${escapeHtml(name)}" ${sel}>${escapeHtml(name)}</option>`;
            });
            return html;
        };

        const createMultiSelect = (containerSelector, initialSelectedArray, dataClass) => {
            const container = view.querySelector(containerSelector);
            if (!container) return;

            container.innerHTML = '';
            container.className = 'wb-multi-select';

            const selectedSet = new Set((initialSelectedArray || []).filter((n) => allNames.includes(n)));
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
                const lower = String(term || '').toLowerCase();
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
                        tag.innerHTML = `<span>${escapeHtml(name)}</span><span class="wb-ms-tag-close">x</span>`;

                        tag.ondblclick = () => {
                            Actions.jumpToEditor(name);
                        };

                        tag.querySelector('.wb-ms-tag-close').onclick = (e) => {
                            e.stopPropagation();
                            selectedSet.delete(name);
                            refresh();
                            Actions.saveBindings().catch(console.error);
                        };

                        tagsEl.appendChild(tag);
                    });
                }

                listEl.innerHTML = '';
                const available = allNames.filter((n) => !selectedSet.has(n));
                if (!available.length) {
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
                            Actions.saveBindings().catch(console.error);
                        };
                        item.ondblclick = () => Actions.jumpToEditor(name);
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
                    const isTouch = window.matchMedia('(pointer: coarse)').matches;
                    if (!isTouch) inputEl.focus();
                }
            };

            inputEl.oninput = (e) => filterList(e.target.value);

            document.addEventListener('click', (e) => {
                if (!dom.contains(e.target)) dropEl.classList.remove('show');
            });

            refresh();
        };

        const primarySel = view.querySelector('#wb-bind-char-primary');
        const chatSel = view.querySelector('#wb-bind-chat');

        primarySel.innerHTML = createOpts(char.primary);
        chatSel.innerHTML = createOpts(chat);

        primarySel.onchange = () => Actions.saveBindings().catch(console.error);
        chatSel.onchange = () => Actions.saveBindings().catch(console.error);

        primarySel.ondblclick = () => {
            if (primarySel.value) Actions.jumpToEditor(primarySel.value);
        };
        chatSel.ondblclick = () => {
            if (chatSel.value) Actions.jumpToEditor(chatSel.value);
        };

        this.applyCustomDropdown('wb-bind-char-primary');
        this.applyCustomDropdown('wb-bind-chat');

        createMultiSelect('#wb-bind-char-list', char.additional, 'wb-bind-char-add');
        createMultiSelect('#wb-bind-global-list', global, 'wb-bind-global');
    },

    renderManageView(filterText = '') {
        const container = document.getElementById('wb-manage-content');
        if (!container) return;
        container.innerHTML = '';

        const term = String(filterText || '').toLowerCase();
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

        const isTouch = window.matchMedia('(pointer: coarse)').matches;
        if (!isTouch) searchInput.focus();

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

    openStitchModal() {
        if (!STATE.allBookNames.length) return toastr.warning('没有可用世界书');

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
                    <button class="wb-btn-rect mini" data-copy="${key}">复制到${key === 'left' ? '右' : '左'}</button>
                    <button class="wb-btn-rect mini" data-move="${key}">移动到${key === 'left' ? '右' : '左'}</button>
                </div>
                <div style="display:flex;gap:8px;margin-top:8px;">
                    <input class="wb-input-dark" data-search="${key}" placeholder="搜索条目..." value="${escapeHtml(side.keyword)}" style="flex:1">
                    <button class="wb-btn-rect mini" data-all="${key}">全选</button>
                    <button class="wb-btn-rect mini" data-invert="${key}">反选</button>
                    <button class="wb-btn-rect mini" data-clear="${key}">清空</button>
                </div>
                <div class="wb-scroll-list wb-stitch-list" data-drop="${key}" style="margin-top:8px;min-height:360px;">${htmlItems || '<div class="wb-ms-empty">暂无条目</div>'}</div>
                <div style="display:flex;justify-content:center;gap:8px;margin-top:8px;">
                    <button class="wb-btn-rect mini" data-edit="${key}">编辑</button>
                    <button class="wb-btn-rect mini danger" data-del="${key}">删除</button>
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

                const copy = cloneData(src);
                copy.uid = getNextUid(other.entries);
                other.entries.push(copy);
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
                if (!ids.length) return toastr.warning('请先选择条目');

                for (const id of ids) {
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
                if (side.selected.size !== 1) return toastr.warning('编辑时请只选择一个条目');
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
                if (!side.selected.size) return toastr.warning('请先选择条目');
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
            console.error(err);
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
    await Actions.init();
    console.log('[Enhanced WB] loaded');
});
