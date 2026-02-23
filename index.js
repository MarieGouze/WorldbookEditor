import { getContext } from '../../../extensions.js';
import { event_types, eventSource } from '../../../../script.js';
import { getCharaFilename } from '../../../utils.js';
import { world_info, world_names, selected_world_info } from '../../../world-info.js';

const CONFIG = {
    id: 'enhanced-wb-panel-v6',
    btnId: 'wb-menu-btn-v6',
    settingsKey: 'WorldbookEditor_Metadata',
    presetKey: '__ENTRY_STATE_PRESETS__',
};

const STATE = {
    initialized: false,
    currentView: 'editor',
    currentBookName: '',
    allBookNames: [],
    entries: [],
    metadata: {},
    debouncer: null,
    currentFilter: '',
    selectedEntryUids: new Set(),

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

function uid() {
    return `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    }[m]));
}

function getPositionLabel(entry) {
    const pos = Number(entry.position ?? 1);
    if (pos === 4) return `@D ${entry.depth ?? 4}`;
    if (pos === 0) return '角色定义前';
    if (pos === 1) return '角色定义后';
    if (pos === 2) return 'AN前';
    if (pos === 3) return 'AN后';
    if (pos === 5) return '示例前';
    if (pos === 6) return '示例后';
    return '未知';
}

function normalizeOrders(entries) {
    entries.forEach((e, i) => {
        e.order = i;
    });
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
    const name = worldName || '';

    if (type === 'primary') {
        await charUpdatePrimaryWorld(enabled ? name : '');
        return;
    }

    if (type === 'auxiliary') {
        const charId = context.characterId;
        if (charId === undefined || charId === null) return;

        const avatar = context.characters?.[charId]?.avatar;
        const fileName = getCharaFilename(null, { manualAvatarKey: avatar });

        const current = world_info.charLore?.find((e) => e.name === fileName)?.extraBooks || [];
        let next = [...current];

        if (enabled) {
            if (!next.includes(name)) next.push(name);
        } else {
            next = next.filter((v) => v !== name);
        }

        charSetAuxWorlds(fileName, next);
        return;
    }

    if (type === 'chat') {
        if (enabled) {
            context.chatMetadata.world_info = name;
        } else if (context.chatMetadata.world_info === name) {
            delete context.chatMetadata.world_info;
        }
        context.saveMetadataDebounced?.();
        return;
    }

    if (type === 'global') {
        const command = enabled
            ? `/world silent=true "${name}"`
            : `/world state=off silent=true "${name}"`;
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
        if (charId === undefined || charId === null) {
            return { primary: null, additional: [] };
        }

        const character = context.characters?.[charId];
        if (!character) return { primary: null, additional: [] };

        const primary = character.data?.extensions?.world || null;

        const fileName = character.avatar?.replace(/\.[^/.]+$/, '') || '';
        const entry = world_info.charLore?.find((e) => e.name === fileName);
        const additional = Array.isArray(entry?.extraBooks) ? [...entry.extraBooks] : [];

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
        if (!data) throw new Error(`世界书不存在: ${name}`);
        const obj = structuredClone(data.entries || {});
        const entries = Object.values(obj).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        return entries;
    },

    async saveBookEntries(name, entries) {
        if (!name || !Array.isArray(entries)) return;

        const oldData = (await getContext().loadWorldInfo(name)) || { entries: {} };
        const nextEntries = {};

        entries.forEach((entry) => {
            if (entry.uid === undefined || entry.uid === null) return;
            const oldEntry = oldData.entries?.[entry.uid] || {};
            nextEntries[entry.uid] = { ...oldEntry, ...structuredClone(entry) };
        });

        await getContext().saveWorldInfo(name, { ...oldData, entries: nextEntries }, false);
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

    getMetadata() {
        return getContext().extensionSettings[CONFIG.settingsKey] || {};
    },

    async saveMetadata(meta) {
        const ctx = getContext();
        ctx.extensionSettings[CONFIG.settingsKey] = meta;
        ctx.saveSettingsDebounced?.();
    },
};

const Actions = {
    async init() {
        if (STATE.initialized) return;

        this.bindCoreEvents();
        await this.refreshContext();

        STATE.initialized = true;
    },

    bindCoreEvents() {
        const es = eventSource;
        const et = event_types;

        es.on(et.SETTINGS_UPDATED, () => {
            if (document.getElementById(CONFIG.id)) this.refreshContext();
        });

        es.on(et.CHARACTER_SELECTED, () => {
            setTimeout(() => {
                this.refreshContext();
                if (STATE.currentView === 'binding') UI.renderBindingView();
                if (STATE.currentView === 'manage') UI.renderManageView();
            }, 120);
        });

        es.on(et.CHAT_CHANGED, () => {
            this.refreshContext();
            if (STATE.currentView === 'binding') UI.renderBindingView();
        });

        es.on(et.WORLDINFO_UPDATED, async (name) => {
            if (name && name === STATE.currentBookName) {
                await this.loadBook(name);
            }
        });
    },

    async refreshContext() {
        const [books, char, global, chat] = await Promise.all([
            API.getAllBookNames(),
            API.getCharBindings(),
            API.getGlobalBindings(),
            API.getChatBinding(),
        ]);

        STATE.allBookNames = books;
        STATE.bindings.char = char;
        STATE.bindings.global = global;
        STATE.bindings.chat = chat;
        STATE.metadata = API.getMetadata();

        if (document.getElementById(CONFIG.id)) {
            UI.renderBookSelector();
            UI.renderPresetBar();
            if (STATE.currentView === 'binding') UI.renderBindingView();
            if (STATE.currentView === 'manage') UI.renderManageView();
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
        const name = STATE.currentBookName;
        const entriesRef = STATE.entries;
        STATE.debouncer = setTimeout(() => {
            STATE.debouncer = null;
            if (name && entriesRef) API.saveBookEntries(name, entriesRef);
        }, 280);
    },

    async loadBook(name) {
        if (!name) return;
        await this.flushPendingSave();

        STATE.currentBookName = name;
        STATE.selectedEntryUids.clear();
        STATE.currentFilter = '';

        const entries = await API.loadBook(name);
        normalizeOrders(entries);
        STATE.entries = entries;

        UI.renderBookSelector();
        UI.renderPresetBar();
        UI.renderEntryList('');
    },

    getEntryByUid(uidVal) {
        const uidNum = Number(uidVal);
        return STATE.entries.find((e) => Number(e.uid) === uidNum);
    },

    updateEntry(uidVal, updater) {
        const entry = this.getEntryByUid(uidVal);
        if (!entry) return;
        updater(entry);
        this.queueSave();
    },

    async addEntry() {
        if (!STATE.currentBookName) {
            toastr.warning('请先选择一本世界书');
            return;
        }
        const maxUid = STATE.entries.reduce((m, e) => Math.max(m, Number(e.uid) || 0), -1);
        const newEntry = {
            uid: maxUid + 1,
            comment: '新建条目',
            content: '',
            disable: false,
            constant: false,
            key: [],
            order: 0,
            position: 1,
            depth: 4,
            probability: 100,
            selective: true,
        };
        STATE.entries.unshift(newEntry);
        normalizeOrders(STATE.entries);
        UI.renderEntryList(STATE.currentFilter);
        this.queueSave();
    },

    async deleteEntry(uidVal) {
        const uidNum = Number(uidVal);
        if (!confirm('确定删除该条目吗？')) return;
        STATE.entries = STATE.entries.filter((e) => Number(e.uid) !== uidNum);
        STATE.selectedEntryUids.delete(uidNum);
        normalizeOrders(STATE.entries);
        UI.renderEntryList(STATE.currentFilter);
        this.queueSave();
    },

    selectEntry(uidVal, checked) {
        const uidNum = Number(uidVal);
        if (checked) STATE.selectedEntryUids.add(uidNum);
        else STATE.selectedEntryUids.delete(uidNum);
        UI.updateSelectionInfo();
    },

    clearSelection() {
        STATE.selectedEntryUids.clear();
        UI.renderEntryList(STATE.currentFilter);
    },

    selectAllVisible() {
        const cards = document.querySelectorAll('#wb-entry-list .wb-card[data-uid]');
        cards.forEach((c) => STATE.selectedEntryUids.add(Number(c.dataset.uid)));
        UI.renderEntryList(STATE.currentFilter);
    },

    invertVisibleSelection() {
        const cards = document.querySelectorAll('#wb-entry-list .wb-card[data-uid]');
        cards.forEach((c) => {
            const v = Number(c.dataset.uid);
            if (STATE.selectedEntryUids.has(v)) STATE.selectedEntryUids.delete(v);
            else STATE.selectedEntryUids.add(v);
        });
        UI.renderEntryList(STATE.currentFilter);
    },

    batchUpdateSelected(updater) {
        if (!STATE.selectedEntryUids.size) {
            toastr.warning('请先勾选条目');
            return;
        }
        STATE.entries.forEach((e) => {
            if (STATE.selectedEntryUids.has(Number(e.uid))) updater(e);
        });
        UI.renderEntryList(STATE.currentFilter);
        this.queueSave();
    },

    batchEnable(v) {
        this.batchUpdateSelected((e) => {
            e.disable = !v;
        });
    },

    batchConstant(v) {
        this.batchUpdateSelected((e) => {
            e.constant = !!v;
            e.selective = !v;
        });
    },

    batchOrderAdjust(delta) {
        const d = Number(delta);
        if (!d) return;
        this.batchUpdateSelected((e) => {
            e.order = Number(e.order ?? 0) + d;
        });
        STATE.entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        normalizeOrders(STATE.entries);
        UI.renderEntryList(STATE.currentFilter);
    },

    batchDepthAdjust(delta) {
        const d = Number(delta);
        if (!d) return;
        this.batchUpdateSelected((e) => {
            const now = Number(e.depth ?? 4);
            e.depth = Math.max(0, now + d);
        });
    },

    batchDepthSet(depthVal) {
        const d = Number(depthVal);
        if (Number.isNaN(d)) return;
        this.batchUpdateSelected((e) => {
            e.depth = Math.max(0, d);
        });
    },

    getPresetStore() {
        const meta = STATE.metadata || {};
        if (!meta[CONFIG.presetKey]) meta[CONFIG.presetKey] = {};
        return meta[CONFIG.presetKey];
    },

    getBookPresets(bookName) {
        const store = this.getPresetStore();
        return Array.isArray(store[bookName]) ? store[bookName] : [];
    },

    async saveCurrentStatePreset() {
        if (!STATE.currentBookName) {
            toastr.warning('请先选择世界书');
            return;
        }

        const defaultName = `预设_${new Date().toLocaleTimeString().replace(/:/g, '-')}`;
        const name = prompt('请输入预设名称：', defaultName);
        if (!name) return;

        const store = this.getPresetStore();
        const list = this.getBookPresets(STATE.currentBookName);
        const exists = list.findIndex((p) => p.name === name);

        if (exists !== -1) {
            const ok = confirm(`预设 "${name}" 已存在，是否覆盖？`);
            if (!ok) return;
        }

        const snapshot = {};
        STATE.entries.forEach((e) => {
            snapshot[e.uid] = {
                disable: !!e.disable,
                constant: !!e.constant,
                order: Number(e.order ?? 0),
                depth: Number(e.depth ?? 4),
                position: Number(e.position ?? 1),
            };
        });

        const preset = {
            id: uid(),
            name,
            createdAt: Date.now(),
            snapshot,
        };

        if (exists !== -1) list.splice(exists, 1, preset);
        else list.push(preset);

        store[STATE.currentBookName] = list;
        STATE.metadata[CONFIG.presetKey] = store;

        await API.saveMetadata(STATE.metadata);
        UI.renderPresetBar();
        toastr.success(`预设已保存：${name}`);
    },

    async applyStatePreset(presetId) {
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
            e.order = Number(s.order ?? 0);
            e.depth = Number(s.depth ?? 4);
            e.position = Number(s.position ?? 1);
        });

        STATE.entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        normalizeOrders(STATE.entries);

        UI.renderEntryList(STATE.currentFilter);
        await API.saveBookEntries(STATE.currentBookName, STATE.entries);
        toastr.success(`已应用预设：${preset.name}`);
    },

    async deleteStatePreset(presetId) {
        if (!STATE.currentBookName || !presetId) return;
        const store = this.getPresetStore();
        const list = this.getBookPresets(STATE.currentBookName);
        const index = list.findIndex((p) => p.id === presetId);
        if (index === -1) return;

        const p = list[index];
        if (!confirm(`删除预设 "${p.name}"？`)) return;

        list.splice(index, 1);
        store[STATE.currentBookName] = list;
        STATE.metadata[CONFIG.presetKey] = store;

        await API.saveMetadata(STATE.metadata);
        UI.renderPresetBar();
        toastr.success('预设已删除');
    },

    async saveBindingsFromView() {
        const view = document.getElementById('wb-view-binding');
        if (!view) return;

        const primary = view.querySelector('#wb-bind-char-primary')?.value || '';
        const chat = view.querySelector('#wb-bind-chat')?.value || '';

        const add = Array.from(view.querySelectorAll('.wb-bind-extra-item input:checked')).map((e) => e.value);
        const global = Array.from(view.querySelectorAll('.wb-bind-global-item input:checked')).map((e) => e.value);

        await setBinding('primary', primary, !!primary);

        const context = getContext();
        const charId = context.characterId;
        if (charId !== undefined && charId !== null) {
            const avatar = context.characters?.[charId]?.avatar;
            const fileName = getCharaFilename(null, { manualAvatarKey: avatar });
            charSetAuxWorlds(fileName, add);
        }

        const currentGlobal = await API.getGlobalBindings();
        const removeList = currentGlobal.filter((n) => !global.includes(n));
        const addList = global.filter((n) => !currentGlobal.includes(n));

        for (const n of removeList) await setBinding('global', n, false);
        for (const n of addList) await setBinding('global', n, true);

        await setBinding('chat', chat, !!chat);

        await this.refreshContext();
        UI.renderBindingView();
        toastr.success('绑定已保存');
    },

    async createBook() {
        const name = prompt('新世界书名称：');
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
        const oldName = STATE.currentBookName;
        const data = await getContext().loadWorldInfo(oldName);
        await getContext().saveWorldInfo(newName, data || { entries: {} }, true);
        await API.deleteWorldbook(oldName);

        await this.refreshContext();
        await this.loadBook(newName);
    },

    async deleteBook() {
        if (!STATE.currentBookName) return;
        if (!confirm(`删除世界书 "${STATE.currentBookName}" ?`)) return;

        if (STATE.debouncer) {
            clearTimeout(STATE.debouncer);
            STATE.debouncer = null;
        }

        await API.deleteWorldbook(STATE.currentBookName);
        STATE.currentBookName = '';
        STATE.entries = [];
        STATE.selectedEntryUids.clear();
        await this.refreshContext();
        UI.renderEntryList('');
    },

    async jumpToEditor(bookName) {
        if (!bookName) return;
        if (!STATE.allBookNames.includes(bookName)) return;
        await this.loadBook(bookName);
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
                <div id="wb-view-editor" class="wb-view-section">
                    <div class="wb-book-bar">
                        <select id="wb-book-selector" style="flex:1"></select>
                        <button class="wb-btn-circle" id="wb-btn-new" title="新建"><i class="fa-solid fa-plus"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-rename" title="重命名"><i class="fa-solid fa-pen"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-delete" title="删除"><i class="fa-solid fa-trash"></i></button>
                        <button class="wb-btn-circle" id="wb-btn-stitch" title="缝合世界书"><i class="fa-solid fa-object-group"></i></button>
                    </div>

                    <div class="wb-preset-strip" id="wb-preset-strip">
                        <select id="wb-preset-selector" style="flex:1"></select>
                        <button class="wb-btn-rect" id="wb-preset-save" style="padding:6px 14px;font-size:0.85em">保存当前状态</button>
                        <button class="wb-btn-rect" id="wb-preset-apply" style="padding:6px 14px;font-size:0.85em">应用</button>
                        <button class="wb-btn-rect" id="wb-preset-delete" style="padding:6px 14px;font-size:0.85em;background:#ef4444">删除</button>
                    </div>

                    <div class="wb-tool-bar">
                        <input id="wb-search-entry" class="wb-input-dark" style="flex:1" placeholder="搜索条目...">
                        <button class="wb-btn-circle" id="wb-btn-add-entry" title="新建条目"><i class="fa-solid fa-plus"></i></button>
                    </div>

                    <div class="wb-batch-toolbar" id="wb-batch-toolbar">
                        <span id="wb-selection-info">已选 0/0</span>
                        <button class="wb-btn-rect" id="wb-select-all" style="padding:4px 12px;font-size:0.8em">全选</button>
                        <button class="wb-btn-rect" id="wb-select-invert" style="padding:4px 12px;font-size:0.8em">反选</button>
                        <button class="wb-btn-rect" id="wb-select-clear" style="padding:4px 12px;font-size:0.8em">清空</button>
                        <button class="wb-btn-rect" id="wb-batch-enable" style="padding:4px 12px;font-size:0.8em">批量开启</button>
                        <button class="wb-btn-rect" id="wb-batch-disable" style="padding:4px 12px;font-size:0.8em">批量关闭</button>
                        <button class="wb-btn-rect" id="wb-batch-const-on" style="padding:4px 12px;font-size:0.8em">常驻</button>
                        <button class="wb-btn-rect" id="wb-batch-const-off" style="padding:4px 12px;font-size:0.8em">非常驻</button>
                        <button class="wb-btn-rect" id="wb-batch-order-up" style="padding:4px 12px;font-size:0.8em">顺序+1</button>
                        <button class="wb-btn-rect" id="wb-batch-order-down" style="padding:4px 12px;font-size:0.8em">顺序-1</button>
                        <button class="wb-btn-rect" id="wb-batch-depth-up" style="padding:4px 12px;font-size:0.8em">深度+1</button>
                        <button class="wb-btn-rect" id="wb-batch-depth-down" style="padding:4px 12px;font-size:0.8em">深度-1</button>
                    </div>

                    <div id="wb-entry-list" class="wb-list"></div>
                </div>

                <div id="wb-view-binding" class="wb-view-section wb-hidden">
                    <div class="wb-bind-grid">
                        <div class="wb-bind-card">
                            <div class="wb-bind-title">角色主世界书</div>
                            <select id="wb-bind-char-primary"></select>
                            <div style="font-size:0.8em;color:#6b7280;">双击当前选择可直接跳转编辑</div>
                        </div>

                        <div class="wb-bind-card">
                            <div class="wb-bind-title">角色附加世界书</div>
                            <div class="wb-scroll-list" id="wb-bind-extra-list"></div>
                        </div>

                        <div class="wb-bind-card">
                            <div class="wb-bind-title">全局世界书</div>
                            <div class="wb-scroll-list" id="wb-bind-global-list"></div>
                        </div>

                        <div class="wb-bind-card">
                            <div class="wb-bind-title">聊天世界书</div>
                            <select id="wb-bind-chat"></select>
                            <div style="font-size:0.8em;color:#6b7280;">双击当前选择可直接跳转编辑</div>
                        </div>
                    </div>
                    <div style="margin-top:12px;display:flex;justify-content:center;">
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

        panel.querySelector('#wb-close').onclick = async () => {
            await Actions.flushPendingSave();
            panel.remove();
        };

        panel.querySelectorAll('.wb-tab').forEach((tab) => {
            tab.onclick = () => this.switchView(tab.dataset.tab);
        });

        panel.querySelector('#wb-book-selector').onchange = (e) => Actions.loadBook(e.target.value);
        panel.querySelector('#wb-btn-new').onclick = () => Actions.createBook();
        panel.querySelector('#wb-btn-rename').onclick = () => Actions.renameBook();
        panel.querySelector('#wb-btn-delete').onclick = () => Actions.deleteBook();
        panel.querySelector('#wb-btn-add-entry').onclick = () => Actions.addEntry();
        panel.querySelector('#wb-btn-stitch').onclick = () => this.openStitchModal();

        panel.querySelector('#wb-search-entry').oninput = (e) => this.renderEntryList(e.target.value || '');

        panel.querySelector('#wb-select-all').onclick = () => Actions.selectAllVisible();
        panel.querySelector('#wb-select-invert').onclick = () => Actions.invertVisibleSelection();
        panel.querySelector('#wb-select-clear').onclick = () => Actions.clearSelection();
        panel.querySelector('#wb-batch-enable').onclick = () => Actions.batchEnable(true);
        panel.querySelector('#wb-batch-disable').onclick = () => Actions.batchEnable(false);
        panel.querySelector('#wb-batch-const-on').onclick = () => Actions.batchConstant(true);
        panel.querySelector('#wb-batch-const-off').onclick = () => Actions.batchConstant(false);
        panel.querySelector('#wb-batch-order-up').onclick = () => Actions.batchOrderAdjust(1);
        panel.querySelector('#wb-batch-order-down').onclick = () => Actions.batchOrderAdjust(-1);
        panel.querySelector('#wb-batch-depth-up').onclick = () => Actions.batchDepthAdjust(1);
        panel.querySelector('#wb-batch-depth-down').onclick = () => Actions.batchDepthAdjust(-1);

        panel.querySelector('#wb-preset-save').onclick = () => Actions.saveCurrentStatePreset();
        panel.querySelector('#wb-preset-apply').onclick = () => {
            const id = panel.querySelector('#wb-preset-selector').value;
            Actions.applyStatePreset(id);
        };
        panel.querySelector('#wb-preset-delete').onclick = () => {
            const id = panel.querySelector('#wb-preset-selector').value;
            Actions.deleteStatePreset(id);
        };

        panel.querySelector('#wb-bind-save').onclick = () => Actions.saveBindingsFromView();
        panel.querySelector('#wb-manage-search').oninput = (e) => this.renderManageView(e.target.value || '');

        this.renderBookSelector();
        this.renderPresetBar();
        this.renderEntryList('');
        this.renderBindingView();
        this.renderManageView();

        const preferred = STATE.bindings.char.primary
            || STATE.bindings.chat
            || STATE.allBookNames[0]
            || '';

        if (preferred) Actions.loadBook(preferred);
    },

    switchView(viewName) {
        STATE.currentView = viewName;

        const panel = document.getElementById(CONFIG.id);
        if (!panel) return;

        panel.querySelectorAll('.wb-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === viewName));
        panel.querySelectorAll('.wb-view-section').forEach((v) => v.classList.add('wb-hidden'));

        const target = panel.querySelector(`#wb-view-${viewName}`);
        if (target) target.classList.remove('wb-hidden');

        if (viewName === 'binding') this.renderBindingView();
        if (viewName === 'manage') this.renderManageView();
        if (viewName === 'editor') {
            this.renderBookSelector();
            this.renderPresetBar();
            this.renderEntryList(STATE.currentFilter || '');
        }
    },

    renderBookSelector() {
        const selector = document.getElementById('wb-book-selector');
        if (!selector) return;

        const { char, global, chat } = STATE.bindings;
        const charBooks = new Set([char.primary, ...(char.additional || [])].filter(Boolean));
        const globalBooks = new Set(global || []);
        const chatBook = chat || '';

        let html = '';

        if (char.primary) {
            html += '<optgroup label="主要世界书">';
            html += `<option value="${escapeHtml(char.primary)}">${escapeHtml(char.primary)}</option>`;
            html += '</optgroup>';
        }

        const charAdditional = (char.additional || []).filter((n) => n && n !== char.primary);
        if (charAdditional.length) {
            html += '<optgroup label="附加世界书">';
            charAdditional.forEach((n) => {
                html += `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`;
            });
            html += '</optgroup>';
        }

        if (globalBooks.size) {
            html += '<optgroup label="全局启用">';
            [...globalBooks].sort((a, b) => a.localeCompare(b)).forEach((n) => {
                html += `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`;
            });
            html += '</optgroup>';
        }

        if (chatBook) {
            html += '<optgroup label="当前聊天">';
            html += `<option value="${escapeHtml(chatBook)}">${escapeHtml(chatBook)}</option>`;
            html += '</optgroup>';
        }

        const others = STATE.allBookNames.filter(
            (n) => !charBooks.has(n) && !globalBooks.has(n) && n !== chatBook,
        );
        html += '<optgroup label="其他世界书">';
        others.forEach((n) => {
            html += `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`;
        });
        html += '</optgroup>';

        selector.innerHTML = html;
        if (STATE.currentBookName) selector.value = STATE.currentBookName;
    },

    renderPresetBar() {
        const select = document.getElementById('wb-preset-selector');
        if (!select) return;

        if (!STATE.currentBookName) {
            select.innerHTML = '<option value="">先选择世界书</option>';
            return;
        }

        const presets = Actions.getBookPresets(STATE.currentBookName);
        let html = '<option value="">选择状态预设...</option>';
        presets.forEach((p) => {
            html += `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`;
        });
        select.innerHTML = html;
    },

    renderEntryList(filterText = '') {
        STATE.currentFilter = filterText || '';
        const list = document.getElementById('wb-entry-list');
        if (!list) return;

        const term = (filterText || '').trim().toLowerCase();
        list.innerHTML = '';

        const entries = STATE.entries.filter((e) => {
            if (!term) return true;
            return String(e.comment || '').toLowerCase().includes(term);
        });

        entries.forEach((entry) => {
            list.appendChild(this.createEntryCard(entry));
        });

        this.updateSelectionInfo();
    },

    updateSelectionInfo() {
        const info = document.getElementById('wb-selection-info');
        if (!info) return;
        info.textContent = `已选 ${STATE.selectedEntryUids.size}/${STATE.entries.length}`;
    },

    createEntryCard(entry) {
        const enabled = !entry.disable;
        const constant = !!entry.constant;
        const selected = STATE.selectedEntryUids.has(Number(entry.uid));
        const posStr = WI_POSITION_MAP[Number(entry.position ?? 1)] || 'after_character_definition';

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
        card.dataset.uid = entry.uid;

        card.innerHTML = `
            <div class="wb-card-header">
                <div style="flex:1;display:flex;flex-direction:column;gap:8px;">
                    <div class="wb-row">
                        <input type="checkbox" class="wb-select-entry" ${selected ? 'checked' : ''} title="多选条目">
                        <input class="wb-inp-title inp-name" value="${escapeHtml(entry.comment || '')}" placeholder="条目标题">
                        <span class="wb-token-display">${Math.ceil((entry.content || '').length / 3)}</span>
                        <i class="fa-solid fa-pen btn-edit" title="编辑内容" style="cursor:pointer"></i>
                        <i class="fa-solid fa-trash btn-delete" title="删除" style="cursor:pointer"></i>
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
                            ${posOptions.map(([v, t]) => `<option value="${v}" ${v === posStr ? 'selected' : ''}>${t}</option>`).join('')}
                        </select>
                        <input type="number" class="wb-inp-num inp-depth" value="${Number(entry.depth ?? 4)}" title="深度">
                        <input type="number" class="wb-inp-num inp-order" value="${Number(entry.order ?? 0)}" title="顺序">
                        <span style="font-size:0.8em;color:#6b7280;min-width:70px;text-align:right;">${getPositionLabel(entry)}</span>
                    </div>
                </div>
            </div>
        `;

        const bind = (selector, evt, fn) => {
            const el = card.querySelector(selector);
            if (el) el.addEventListener(evt, fn);
        };

        bind('.wb-select-entry', 'change', (e) => Actions.selectEntry(entry.uid, e.target.checked));
        bind('.inp-name', 'input', (e) => Actions.updateEntry(entry.uid, (d) => { d.comment = e.target.value; }));
        bind('.inp-enable', 'change', (e) => {
            Actions.updateEntry(entry.uid, (d) => { d.disable = !e.target.checked; });
            this.renderEntryList(STATE.currentFilter);
        });
        bind('.inp-constant', 'change', (e) => {
            Actions.updateEntry(entry.uid, (d) => {
                d.constant = !!e.target.checked;
                d.selective = !d.constant;
            });
            this.renderEntryList(STATE.currentFilter);
        });
        bind('.inp-pos', 'change', (e) => {
            const v = WI_POSITION_MAP_REV[e.target.value] ?? 1;
            Actions.updateEntry(entry.uid, (d) => { d.position = v; });
        });
        bind('.inp-depth', 'input', (e) => Actions.updateEntry(entry.uid, (d) => { d.depth = Number(e.target.value || 0); }));
        bind('.inp-order', 'input', (e) => Actions.updateEntry(entry.uid, (d) => { d.order = Number(e.target.value || 0); }));
        bind('.btn-delete', 'click', () => Actions.deleteEntry(entry.uid));
        bind('.btn-edit', 'click', () => this.openEntryContentModal(entry));

        return card;
    },

    openEntryContentModal(entry) {
        const old = document.getElementById('wb-content-popup-overlay');
        if (old) old.remove();

        let tempContent = entry.content || '';
        let tempKeys = (entry.key || []).join(',');

        const overlay = document.createElement('div');
        overlay.id = 'wb-content-popup-overlay';
        overlay.className = 'wb-modal-overlay';
        overlay.innerHTML = `
            <div class="wb-content-popup">
                <div class="wb-popup-header">${escapeHtml(entry.comment || '条目编辑')}</div>
                <input class="wb-popup-input-keys" placeholder="关键词，英文逗号分隔" value="${escapeHtml(tempKeys)}">
                <textarea class="wb-popup-textarea" placeholder="条目内容...">${escapeHtml(tempContent)}</textarea>
                <div class="wb-popup-footer">
                    <button class="wb-btn-black btn-cancel">取消</button>
                    <button class="wb-btn-black btn-save">保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const ta = overlay.querySelector('.wb-popup-textarea');
        const keys = overlay.querySelector('.wb-popup-input-keys');

        ta.oninput = (e) => { tempContent = e.target.value; };
        keys.oninput = (e) => { tempKeys = e.target.value; };

        overlay.querySelector('.btn-cancel').onclick = () => overlay.remove();
        overlay.querySelector('.btn-save').onclick = () => {
            Actions.updateEntry(entry.uid, (d) => {
                d.content = tempContent;
                d.key = tempKeys.split(',').map((v) => v.trim()).filter(Boolean);
            });
            overlay.remove();
            this.renderEntryList(STATE.currentFilter);
        };
        overlay.onclick = (e) => {
            if (e.target === overlay) overlay.remove();
        };
    },

    renderBindingView() {
        const view = document.getElementById('wb-view-binding');
        if (!view) return;

        const all = STATE.allBookNames;
        const { char, global, chat } = STATE.bindings;

        const primary = view.querySelector('#wb-bind-char-primary');
        const chatSel = view.querySelector('#wb-bind-chat');

        let selectHtml = '<option value="">(无)</option>';
        all.forEach((n) => {
            selectHtml += `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`;
        });
        primary.innerHTML = selectHtml;
        chatSel.innerHTML = selectHtml;
        primary.value = char.primary || '';
        chatSel.value = chat || '';

        primary.ondblclick = () => {
            if (primary.value) Actions.jumpToEditor(primary.value);
        };
        chatSel.ondblclick = () => {
            if (chatSel.value) Actions.jumpToEditor(chatSel.value);
        };

        const extraList = view.querySelector('#wb-bind-extra-list');
        const globalList = view.querySelector('#wb-bind-global-list');

        extraList.innerHTML = '';
        globalList.innerHTML = '';

        all.forEach((name) => {
            const exChecked = (char.additional || []).includes(name);
            const glChecked = (global || []).includes(name);

            const ex = document.createElement('label');
            ex.className = 'wb-check-item wb-bind-extra-item';
            ex.innerHTML = `<input type="checkbox" value="${escapeHtml(name)}" ${exChecked ? 'checked' : ''}><span>${escapeHtml(name)}</span>`;
            ex.ondblclick = () => Actions.jumpToEditor(name);
            extraList.appendChild(ex);

            const gl = document.createElement('label');
            gl.className = 'wb-check-item wb-bind-global-item';
            gl.innerHTML = `<input type="checkbox" value="${escapeHtml(name)}" ${glChecked ? 'checked' : ''}><span>${escapeHtml(name)}</span>`;
            gl.ondblclick = () => Actions.jumpToEditor(name);
            globalList.appendChild(gl);
        });
    },

    renderManageView(filterText = '') {
        const list = document.getElementById('wb-manage-content');
        if (!list) return;

        const term = (filterText || '').toLowerCase();
        const names = STATE.allBookNames.filter((n) => !term || n.toLowerCase().includes(term));

        list.innerHTML = '';
        names.forEach((name) => {
            const card = document.createElement('div');
            card.className = 'wb-manage-card';
            card.innerHTML = `
                <div class="wb-card-top">
                    <div class="wb-card-info">
                        <span class="wb-card-title">${escapeHtml(name)}</span>
                    </div>
                    <div class="wb-manage-icons">
                        <div class="wb-icon-action" data-action="open" title="打开编辑"><i class="fa-solid fa-eye"></i></div>
                        <div class="wb-icon-action" data-action="bind" title="绑定到当前角色主世界书"><i class="fa-solid fa-link"></i></div>
                        <div class="wb-icon-action btn-del" data-action="delete" title="删除"><i class="fa-solid fa-trash"></i></div>
                    </div>
                </div>
            `;
            card.querySelector('[data-action="open"]').onclick = () => Actions.jumpToEditor(name);
            card.querySelector('[data-action="bind"]').onclick = async () => {
                await setBinding('primary', name, true);
                await Actions.refreshContext();
                toastr.success(`已绑定主世界书: ${name}`);
            };
            card.querySelector('[data-action="delete"]').onclick = async () => {
                if (!confirm(`删除 "${name}" ?`)) return;
                await API.deleteWorldbook(name);
                await Actions.refreshContext();
                if (STATE.currentBookName === name) {
                    STATE.currentBookName = '';
                    STATE.entries = [];
                }
                this.renderManageView(filterText);
                this.renderBookSelector();
                this.renderEntryList(STATE.currentFilter);
            };
            list.appendChild(card);
        });
    },

    openStitchModal() {
        if (!STATE.allBookNames.length) {
            toastr.warning('没有可用世界书');
            return;
        }

        const sideState = {
            left: { book: STATE.currentBookName || STATE.allBookNames[0], entries: [], selected: new Set(), filter: '' },
            right: { book: STATE.allBookNames.find((n) => n !== (STATE.currentBookName || '')) || STATE.allBookNames[0], entries: [], selected: new Set(), filter: '' },
            mode: 'copy',
        };

        const overlay = document.createElement('div');
        overlay.className = 'wb-sort-modal-overlay';
        overlay.style.zIndex = '24000';
        overlay.innerHTML = `
            <div class="wb-sort-modal" style="width:95vw;max-width:1480px;height:90vh;">
                <div class="wb-sort-header">
                    <span>缝合世界书工具</span>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <label style="font-size:0.85em;color:#6b7280;">
                            拖拽模式
                            <select id="wb-stitch-mode">
                                <option value="copy">复制</option>
                                <option value="move">移动</option>
                            </select>
                        </label>
                        <div id="wb-stitch-close" style="cursor:pointer;"><i class="fa-solid fa-xmark"></i></div>
                    </div>
                </div>
                <div class="wb-sort-body" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;background:#f3f4f6;">
                    <div class="wb-bind-card" id="wb-stitch-left"></div>
                    <div class="wb-bind-card" id="wb-stitch-right"></div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.querySelector('#wb-stitch-close').onclick = close;
        overlay.onclick = (e) => { if (e.target === overlay) close(); };

        overlay.querySelector('#wb-stitch-mode').onchange = (e) => {
            sideState.mode = e.target.value;
        };

        const getSide = (k) => sideState[k];
        const otherSide = (k) => (k === 'left' ? 'right' : 'left');

        const nextUid = (entries) => entries.reduce((m, e) => Math.max(m, Number(e.uid) || 0), -1) + 1;

        const transferEntry = async (fromKey, toKey, uidVal, mode) => {
            const from = getSide(fromKey);
            const to = getSide(toKey);

            const source = from.entries.find((e) => Number(e.uid) === Number(uidVal));
            if (!source) return;

            const copy = structuredClone(source);
            copy.uid = nextUid(to.entries);
            to.entries.push(copy);
            normalizeOrders(to.entries);

            if (mode === 'move') {
                from.entries = from.entries.filter((e) => Number(e.uid) !== Number(uidVal));
                from.selected.delete(Number(uidVal));
                normalizeOrders(from.entries);
            }

            await Promise.all([
                API.saveBookEntries(from.book, from.entries),
                API.saveBookEntries(to.book, to.entries),
            ]);

            renderSide(fromKey);
            renderSide(toKey);
            toastr.success(mode === 'move' ? '条目已移动' : '条目已复制');
        };

        const transferSelected = async (fromKey, toKey, mode) => {
            const from = getSide(fromKey);
            const ids = [...from.selected];
            if (!ids.length) {
                toastr.warning('请先选择条目');
                return;
            }
            for (const id of ids) {
                // eslint-disable-next-line no-await-in-loop
                await transferEntry(fromKey, toKey, id, mode);
            }
            from.selected.clear();
            renderSide(fromKey);
            renderSide(toKey);
        };

        const removeSelected = async (sideKey) => {
            const side = getSide(sideKey);
            if (!side.selected.size) return toastr.warning('请先选择条目');
            if (!confirm(`删除${side.selected.size}个条目？`)) return;

            side.entries = side.entries.filter((e) => !side.selected.has(Number(e.uid)));
            side.selected.clear();
            normalizeOrders(side.entries);
            await API.saveBookEntries(side.book, side.entries);
            renderSide(sideKey);
        };

        const editSingleSelected = async (sideKey) => {
            const side = getSide(sideKey);
            if (side.selected.size !== 1) {
                toastr.warning('编辑时请只选择1个条目');
                return;
            }
            const id = [...side.selected][0];
            const entry = side.entries.find((e) => Number(e.uid) === Number(id));
            if (!entry) return;

            const title = prompt('条目标题：', entry.comment || '');
            if (title === null) return;
            const content = prompt('条目内容：', entry.content || '');
            if (content === null) return;

            entry.comment = title;
            entry.content = content;
            await API.saveBookEntries(side.book, side.entries);
            renderSide(sideKey);
        };

        const renderSide = (key) => {
            const side = getSide(key);
            const root = overlay.querySelector(`#wb-stitch-${key}`);
            if (!root) return;

            let options = '';
            STATE.allBookNames.forEach((n) => {
                options += `<option value="${escapeHtml(n)}" ${n === side.book ? 'selected' : ''}>${escapeHtml(n)}</option>`;
            });

            const term = side.filter.toLowerCase();
            const listItems = side.entries
                .filter((e) => !term || String(e.comment || '').toLowerCase().includes(term))
                .map((e) => {
                    const checked = side.selected.has(Number(e.uid));
                    return `
                        <div class="wb-stitch-item" draggable="true" data-side="${key}" data-uid="${e.uid}">
                            <input type="checkbox" ${checked ? 'checked' : ''} data-check="${e.uid}">
                            <div style="flex:1;min-width:0;">
                                <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(e.comment || '(无标题)')}</div>
                                <div style="font-size:0.78em;color:#6b7280;">${escapeHtml(getPositionLabel(e))} · order ${Number(e.order ?? 0)} · ${e.disable ? '关闭' : '开启'}</div>
                            </div>
                        </div>
                    `;
                }).join('');

            root.innerHTML = `
                <div class="wb-bind-title">${key === 'left' ? '左侧' : '右侧'}世界书</div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <select class="wb-stitch-book" data-side-book="${key}" style="flex:1">${options}</select>
                    <button class="wb-btn-rect" data-side-copy="${key}" style="padding:6px 12px;font-size:0.8em">复制到${key === 'left' ? '右' : '左'}</button>
                    <button class="wb-btn-rect" data-side-move="${key}" style="padding:6px 12px;font-size:0.8em">移动到${key === 'left' ? '右' : '左'}</button>
                </div>
                <div style="display:flex;gap:8px;align-items:center;margin-top:8px;">
                    <input class="wb-input-dark wb-stitch-search" data-side-search="${key}" placeholder="搜索条目..." value="${escapeHtml(side.filter)}" style="flex:1">
                    <button class="wb-btn-rect" data-side-all="${key}" style="padding:6px 12px;font-size:0.8em">全选</button>
                    <button class="wb-btn-rect" data-side-invert="${key}" style="padding:6px 12px;font-size:0.8em">反选</button>
                    <button class="wb-btn-rect" data-side-clear="${key}" style="padding:6px 12px;font-size:0.8em">清空</button>
                </div>
                <div class="wb-scroll-list wb-stitch-list" data-drop-side="${key}" style="margin-top:8px;min-height:380px;">
                    ${listItems || '<div style="color:#9ca3af;padding:12px;text-align:center;">暂无条目</div>'}
                </div>
                <div style="display:flex;gap:8px;justify-content:center;margin-top:8px;">
                    <button class="wb-btn-rect" data-side-edit="${key}" style="padding:6px 18px;font-size:0.85em">编辑</button>
                    <button class="wb-btn-rect" data-side-delete="${key}" style="padding:6px 18px;font-size:0.85em;background:#ef4444">删除</button>
                </div>
                <div style="font-size:0.8em;color:#6b7280;text-align:center;margin-top:6px;">
                    已选 ${side.selected.size}/${side.entries.length} · 支持拖拽到另一侧${sideState.mode === 'copy' ? '复制' : '移动'}
                </div>
            `;

            const on = (selector, fn) => {
                const el = root.querySelector(selector);
                if (el) fn(el);
            };

            on(`[data-side-book="${key}"]`, (el) => {
                el.onchange = async (e) => {
                    side.book = e.target.value;
                    side.entries = await API.loadBook(side.book);
                    normalizeOrders(side.entries);
                    side.selected.clear();
                    renderSide(key);
                };
            });

            on(`[data-side-search="${key}"]`, (el) => {
                el.oninput = (e) => {
                    side.filter = e.target.value || '';
                    renderSide(key);
                };
            });

            on(`[data-side-copy="${key}"]`, (el) => {
                el.onclick = () => transferSelected(key, otherSide(key), 'copy');
            });

            on(`[data-side-move="${key}"]`, (el) => {
                el.onclick = () => transferSelected(key, otherSide(key), 'move');
            });

            on(`[data-side-all="${key}"]`, (el) => {
                el.onclick = () => {
                    side.entries.forEach((e) => side.selected.add(Number(e.uid)));
                    renderSide(key);
                };
            });

            on(`[data-side-invert="${key}"]`, (el) => {
                el.onclick = () => {
                    side.entries.forEach((e) => {
                        const id = Number(e.uid);
                        if (side.selected.has(id)) side.selected.delete(id);
                        else side.selected.add(id);
                    });
                    renderSide(key);
                };
            });

            on(`[data-side-clear="${key}"]`, (el) => {
                el.onclick = () => {
                    side.selected.clear();
                    renderSide(key);
                };
            });

            on(`[data-side-edit="${key}"]`, (el) => {
                el.onclick = () => editSingleSelected(key);
            });

            on(`[data-side-delete="${key}"]`, (el) => {
                el.onclick = () => removeSelected(key);
            });

            root.querySelectorAll('[data-check]').forEach((cb) => {
                cb.onchange = (e) => {
                    const id = Number(e.target.dataset.check);
                    if (e.target.checked) side.selected.add(id);
                    else side.selected.delete(id);
                    renderSide(key);
                };
            });

            const list = root.querySelector(`[data-drop-side="${key}"]`);
            if (list) {
                list.addEventListener('dragover', (e) => {
                    e.preventDefault();
                });
                list.addEventListener('drop', async (e) => {
                    e.preventDefault();
                    const fromSide = e.dataTransfer.getData('text/fromSide');
                    const uidStr = e.dataTransfer.getData('text/uid');
                    if (!fromSide || !uidStr || fromSide === key) return;
                    await transferEntry(fromSide, key, uidStr, sideState.mode);
                });
            }

            root.querySelectorAll('.wb-stitch-item[draggable="true"]').forEach((item) => {
                item.addEventListener('dragstart', (e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/fromSide', item.dataset.side || '');
                    e.dataTransfer.setData('text/uid', item.dataset.uid || '');
                });
            });
        };

        const initLoad = async () => {
            sideState.left.entries = await API.loadBook(sideState.left.book);
            sideState.right.entries = await API.loadBook(sideState.right.book);
            normalizeOrders(sideState.left.entries);
            normalizeOrders(sideState.right.entries);
            renderSide('left');
            renderSide('right');
        };

        initLoad();
    },
};

jQuery(async () => {
    const injectButton = () => {
        if (document.getElementById(CONFIG.btnId)) return;

        const container = document.querySelector('#options .options-content');
        if (!container) return;

        const a = document.createElement('a');
        a.id = CONFIG.btnId;
        a.className = 'interactable';
        a.title = '世界书管理器';
        a.innerHTML = '<i class="fa-lg fa-solid fa-book-journal-whills"></i><span>世界书</span>';
        a.onclick = (e) => {
            e.preventDefault();
            $('#options').hide();
            UI.open();
        };
        container.appendChild(a);
    };

    injectButton();
    await Actions.init();
    console.log('[Enhanced WB] loaded');
});
