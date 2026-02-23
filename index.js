import { getContext } from '../../../extensions.js';
import { event_types, eventSource } from '../../../../script.js';
import { getCharaFilename } from '../../../utils.js';
import {
    world_info,
    world_names,
    selected_world_info
} from '../../../world-info.js';

const CONFIG = {
    id: 'enhanced-wb-panel-v3',
    btnId: 'wb-menu-btn-v3',
    settingsKey: 'WorldbookEditor_Metadata',
    colors: { accent: '#7c5cbd' }
};

const STATE = {
    currentView: 'editor', // 'editor' | 'binding' | 'manage' | 'merger'
    currentBookName: null,
    isInitialized: false,
    isManageDirty: true,
    
    entries: [], // 当前编辑器条目
    allBookNames: [],
    metadata: {},
    boundBooksSet: {},
    
    bindings: { char: { primary: null, additional: [] }, global: [], chat: null },
    
    // --- 新增功能状态 ---
    selectedUids: new Set(), // 批量选择
    merger: { // 缝合模式状态
        left: { name: null, entries: [], filter: '' },
        right: { name: null, entries: [], filter: '' }
    },
    debouncer: null
};

// --- API & Core Logic ---
const API = {
    async getAllBookNames() { return [...(world_names || [])].sort((a, b) => a.localeCompare(b)); },
    
    // 基础加载 (返回数据副本，不影响全局)
    async loadBookDataRaw(name) {
        if (!name) return [];
        const data = await getContext().loadWorldInfo(name);
        if (!data || !data.entries) return [];
        // [修复] 使用 JSON 深拷贝替代 structuredClone 以避免 DataCloneError
        return Object.values(JSON.parse(JSON.stringify(data.entries))).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },

    // 核心保存
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

    // 获取/保存 预设 (存储在 Metadata 中)
    getPresets(bookName) {
        if (!STATE.metadata[bookName]) STATE.metadata[bookName] = {};
        return STATE.metadata[bookName].presets || {};
    },
    async savePreset(bookName, presetName, presetData) {
        if (!STATE.metadata[bookName]) STATE.metadata[bookName] = {};
        if (!STATE.metadata[bookName].presets) STATE.metadata[bookName].presets = {};
        STATE.metadata[bookName].presets[presetName] = presetData;
        await this.saveMetadata(STATE.metadata);
    },
    async deletePreset(bookName, presetName) {
        if (STATE.metadata[bookName]?.presets?.[presetName]) {
            delete STATE.metadata[bookName].presets[presetName];
            await this.saveMetadata(STATE.metadata);
        }
    },

    // 元数据通用
    getMetadata() { return getContext().extensionSettings[CONFIG.settingsKey] || {}; },
    async saveMetadata(data) {
        const context = getContext();
        context.extensionSettings[CONFIG.settingsKey] = data;
        context.saveSettingsDebounced();
    },

    // 绑定相关 (简化版)
    async getCharBindings() {
        const context = getContext();
        const charId = context.characterId;
        if (charId === undefined || charId === null) return { primary: null, additional: [] };
        const character = context.characters[charId];
        const primary = character.data?.extensions?.world || null;
        
        // [修复] 增加空值判断，防止 avatar 为 undefined 时导致崩溃
        const fileName = (character.avatar || "").replace(/\.[^/.]+$/, "");
        
        const entry = (world_info.charLore || []).find(e => e.name === fileName);
        const additional = entry ? [...entry.extraBooks] : [];
        return { primary, additional };
    },
    
    async setBindings(type, name, enable) {
        const context = getContext();
        if (type === 'primary') {
            const charId = context.characterId;
            if (charId === undefined) return;
            context.characters[charId].data.extensions.world = enable ? name : '';
            if (document.getElementById('character_world')) document.getElementById('character_world').value = enable ? name : '';
            context.saveCharacterDebounced();
        } else if (type === 'global') {
            const cmd = enable ? `/world silent=true "${name}"` : `/world state=off silent=true "${name}"`;
            await context.executeSlashCommands(cmd);
        }
    }
};

const Actions = {
    async init() {
        if (STATE.isInitialized) return;
        const es = eventSource;
        const et = event_types;
        es.on(et.SETTINGS_UPDATED, () => this.refreshContext());
        es.on(et.WORLDINFO_UPDATED, (name) => {
            if (STATE.currentBookName === name) this.loadBook(name); 
            // 如果在缝合模式，刷新对应面板
            if (STATE.currentView === 'merger') {
                if (STATE.merger.left.name === name) this.loadMergerSide('left', name);
                if (STATE.merger.right.name === name) this.loadMergerSide('right', name);
            }
        });
        es.on(et.CHARACTER_SELECTED, () => setTimeout(() => this.refreshContext(), 100));
        STATE.isInitialized = true;
        await this.refreshContext();
    },

    async refreshContext() {
        const [all, char, glob] = await Promise.all([
            API.getAllBookNames(), API.getCharBindings(), API.getAllBookNames().then(() => [...(selected_world_info || [])])
        ]);
        STATE.allBookNames = all;
        STATE.bindings.char = char;
        STATE.bindings.global = glob;
        STATE.metadata = API.getMetadata();
        UI.renderBookSelector();
    },

    switchView(viewName) {
        STATE.currentView = viewName;
        document.querySelectorAll('.wb-view').forEach(el => el.classList.add('hidden'));
        const target = document.getElementById(`wb-view-${viewName}`);
        if (target) target.classList.remove('hidden');
        
        document.querySelectorAll('.wb-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === viewName));
        
        if (viewName === 'editor') {
            UI.renderBookSelector();
            UI.renderList(); // Refresh list to update check status
        } else if (viewName === 'binding') {
            UI.renderBindingView();
        } else if (viewName === 'merger') {
            UI.renderMergerView();
        }
    },

    // --- 编辑器逻辑 ---
    async loadBook(name) {
        if (!name) return;
        if (STATE.currentBookName && STATE.currentBookName !== name) {
            // 保存旧书 (防抖立即执行)
            if (STATE.debouncer) clearTimeout(STATE.debouncer);
            await API.saveBookEntries(STATE.currentBookName, STATE.entries);
        }
        STATE.currentBookName = name;
        STATE.selectedUids.clear(); // 切换书时清空选择
        UI.updateBulkBar(); // 隐藏批量操作栏
        STATE.entries = await API.loadBookDataRaw(name);
        UI.renderList();
        UI.renderBookSelector();
    },

    updateEntry(uid, updater) {
        const entry = STATE.entries.find(e => e.uid === uid);
        if (!entry) return;
        updater(entry);
        UI.updateCard(uid);
        
        if (STATE.debouncer) clearTimeout(STATE.debouncer);
        STATE.debouncer = setTimeout(() => {
            API.saveBookEntries(STATE.currentBookName, STATE.entries);
        }, 500);
    },

    // --- 预设逻辑 ---
    async savePreset() {
        if (!STATE.currentBookName) return toastr.warning('请先选择世界书');
        const name = prompt("请输入预设名称 (例如: '战斗模式', '日常模式')");
        if (!name) return;
        
        // 只保存开关状态 (disable)
        const presetData = {};
        STATE.entries.forEach(e => {
            // 记录所有条目的 disable 状态
            presetData[e.uid] = !!e.disable; 
        });
        
        await API.savePreset(STATE.currentBookName, name, presetData);
        toastr.success(`预设 "${name}" 已保存`);
    },

    async loadPreset(presetName) {
        const presets = API.getPresets(STATE.currentBookName);
        const data = presets[presetName];
        if (!data) return;

        let changed = false;
        STATE.entries.forEach(e => {
            // 如果预设中有该UID的状态，则应用
            if (data.hasOwnProperty(e.uid)) {
                const newDisable = data[e.uid];
                if (e.disable !== newDisable) {
                    e.disable = newDisable;
                    changed = true;
                }
            }
        });

        if (changed) {
            UI.renderList();
            await API.saveBookEntries(STATE.currentBookName, STATE.entries);
            toastr.success(`预设 "${presetName}" 已应用`);
        } else {
            toastr.info("状态未发生变化");
        }
    },

    // --- 批量操作逻辑 ---
    toggleSelection(uid, forcedState) {
        if (forcedState !== undefined) {
            if (forcedState) STATE.selectedUids.add(uid);
            else STATE.selectedUids.delete(uid);
        } else {
            if (STATE.selectedUids.has(uid)) STATE.selectedUids.delete(uid);
            else STATE.selectedUids.add(uid);
        }
        
        // 更新 UI 选中态
        const card = document.querySelector(`.wb-card[data-uid="${uid}"]`);
        if (card) {
            const cb = card.querySelector('.wb-entry-checkbox');
            if (cb) cb.checked = STATE.selectedUids.has(uid);
            card.classList.toggle('selected', STATE.selectedUids.has(uid));
        }
        UI.updateBulkBar();
    },

    batchSelectAll(invert = false) {
        if (invert) {
            const newSet = new Set();
            STATE.entries.forEach(e => {
                if (!STATE.selectedUids.has(e.uid)) newSet.add(e.uid);
            });
            STATE.selectedUids = newSet;
        } else {
            const allSelected = STATE.entries.every(e => STATE.selectedUids.has(e.uid));
            if (allSelected) STATE.selectedUids.clear();
            else STATE.entries.forEach(e => STATE.selectedUids.add(e.uid));
        }
        UI.renderList(); // 重绘以更新Checkbox
        UI.updateBulkBar();
    },

    async batchAction(action, value) {
        if (STATE.selectedUids.size === 0) return;
        const uids = Array.from(STATE.selectedUids);
        
        let changed = false;
        if (action === 'enable') {
            STATE.entries.forEach(e => {
                if (uids.includes(e.uid)) { e.disable = !value; changed = true; }
            });
        } else if (action === 'constant') {
            STATE.entries.forEach(e => {
                if (uids.includes(e.uid)) { e.constant = value; changed = true; }
            });
        } else if (action === 'delete') {
            if (!confirm(`确定删除选中的 ${uids.length} 个条目吗？`)) return;
            STATE.entries = STATE.entries.filter(e => !uids.includes(e.uid));
            STATE.selectedUids.clear();
            changed = true;
        }

        if (changed) {
            UI.renderList();
            UI.updateBulkBar();
            await API.saveBookEntries(STATE.currentBookName, STATE.entries);
        }
    },

    // --- 缝合模式逻辑 ---
    async loadMergerSide(side, bookName) {
        STATE.merger[side].name = bookName;
        STATE.merger[side].entries = await API.loadBookDataRaw(bookName);
        UI.renderMergerList(side);
    },

    async mergerMoveEntry(uid, fromSide, toSide, isCopy) {
        const sourceBook = STATE.merger[fromSide].name;
        const targetBook = STATE.merger[toSide].name;
        if (!sourceBook || !targetBook) return;
        if (sourceBook === targetBook && isCopy) return toastr.warning("同书不能复制");

        const entryIndex = STATE.merger[fromSide].entries.findIndex(e => e.uid == uid);
        if (entryIndex === -1) return;
        
        // [修复] 使用 JSON 深拷贝替代 structuredClone
        const entryData = JSON.parse(JSON.stringify(STATE.merger[fromSide].entries[entryIndex]));

        // 1. 准备新条目
        // 重新生成 UID 以防冲突 (简单取最大值+1)
        const targetEntries = STATE.merger[toSide].entries;
        const maxUid = targetEntries.reduce((max, e) => Math.max(max, e.uid || 0), -1);
        entryData.uid = maxUid + 1;
        // 放到最前面
        entryData.order = 0; 
        
        // 2. 写入目标
        targetEntries.unshift(entryData); // 更新本地缓存
        await API.saveBookEntries(targetBook, targetEntries); // 保存目标书

        // 3. 如果是移动，删除源
        if (!isCopy && sourceBook !== targetBook) {
            STATE.merger[fromSide].entries.splice(entryIndex, 1);
            // 保存源书 (全量保存以确保删除生效)
            await API.saveBookEntries(sourceBook, STATE.merger[fromSide].entries);
        }

        // 4. 刷新
        UI.renderMergerList(fromSide);
        UI.renderMergerList(toSide);
        toastr.success(isCopy ? "条目已复制" : "条目已移动");
    }
};

// --- UI Logic ---
const UI = {
    open() {
        if (document.getElementById(CONFIG.id)) return;
        const panel = document.createElement('div');
        panel.id = CONFIG.id;
        panel.innerHTML = `
        <div class="wb-container">
            <div class="wb-header">
                <div class="wb-tabs">
                    <div class="wb-tab active" data-tab="editor"><i class="fa-solid fa-pen-to-square"></i> 编辑</div>
                    <div class="wb-tab" data-tab="merger"><i class="fa-solid fa-columns"></i> 缝合</div>
                    <div class="wb-tab" data-tab="binding"><i class="fa-solid fa-link"></i> 绑定</div>
                </div>
                <div class="wb-close"><i class="fa-solid fa-xmark"></i></div>
            </div>

            <!-- Editor View -->
            <div id="wb-view-editor" class="wb-view">
                <div class="wb-toolbar">
                    <select id="wb-book-selector" class="wb-select"></select>
                    <div class="wb-actions">
                        <div class="wb-dropdown-wrapper">
                            <button class="wb-btn-icon" title="预设管理"><i class="fa-solid fa-floppy-disk"></i></button>
                            <div class="wb-dropdown-menu" id="wb-preset-menu">
                                <div class="wb-menu-header">当前状态预设</div>
                                <div id="wb-preset-list"></div>
                                <div class="wb-menu-item" id="btn-save-preset"><i class="fa-solid fa-plus"></i> 保存当前状态</div>
                            </div>
                        </div>
                        <button class="wb-btn-icon" id="btn-add-entry" title="新建条目"><i class="fa-solid fa-plus"></i></button>
                    </div>
                </div>
                <div class="wb-list-container">
                    <div id="wb-entry-list" class="wb-list"></div>
                </div>
                <!-- 批量操作栏 (浮动) -->
                <div id="wb-bulk-bar" class="wb-bulk-bar hidden">
                    <div class="wb-bulk-info">已选 <span id="wb-sel-count">0</span> 项</div>
                    <div class="wb-bulk-actions">
                        <button data-action="enable" data-val="true" title="启用"><i class="fa-solid fa-check"></i></button>
                        <button data-action="enable" data-val="false" title="禁用"><i class="fa-solid fa-ban"></i></button>
                        <button data-action="constant" data-val="true" title="设为常驻"><i class="fa-solid fa-thumbtack"></i></button>
                        <button data-action="delete" title="删除" class="danger"><i class="fa-solid fa-trash"></i></button>
                        <div class="wb-bulk-sep"></div>
                        <button id="btn-sel-all" title="全选/反选"><i class="fa-solid fa-check-double"></i></button>
                    </div>
                </div>
            </div>

            <!-- Merger View -->
            <div id="wb-view-merger" class="wb-view hidden">
                <div class="wb-merger-container">
                    <!-- Left Panel -->
                    <div class="wb-merger-panel" data-side="left">
                        <div class="wb-panel-head">
                            <select class="wb-merger-select"></select>
                            <input type="text" class="wb-search" placeholder="搜索..." />
                        </div>
                        <div class="wb-merger-list-wrap">
                            <div class="wb-merger-list"></div>
                        </div>
                    </div>
                    <!-- Center Controls (Visual only, drag supports interaction) -->
                    <div class="wb-merger-middle">
                        <i class="fa-solid fa-arrow-right-arrow-left"></i>
                        <div class="wb-hint">拖拽条目以移动<br>按住 Ctrl 复制</div>
                    </div>
                    <!-- Right Panel -->
                    <div class="wb-merger-panel" data-side="right">
                        <div class="wb-panel-head">
                            <select class="wb-merger-select"></select>
                            <input type="text" class="wb-search" placeholder="搜索..." />
                        </div>
                        <div class="wb-merger-list-wrap">
                            <div class="wb-merger-list"></div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Binding View -->
            <div id="wb-view-binding" class="wb-view hidden">
                <div class="wb-bind-section">
                    <h3><i class="fa-solid fa-globe"></i> 全局启用</h3>
                    <div class="wb-desc">仅显示已启用的世界书。双击列表可快速跳转编辑。</div>
                    <div id="wb-bind-global-list"></div>
                </div>
                <!-- Other bindings omitted for brevity, logic follows same pattern -->
            </div>
        </div>`;
        
        document.body.appendChild(panel);
        
        // Listeners
        panel.querySelector('.wb-close').onclick = () => panel.remove();
        panel.querySelectorAll('.wb-tab').forEach(t => t.onclick = () => Actions.switchView(t.dataset.tab));
        
        // Editor
        const sel = panel.querySelector('#wb-book-selector');
        sel.onchange = (e) => Actions.loadBook(e.target.value);
        panel.querySelector('#btn-add-entry').onclick = () => { /* Add entry logic */ };
        
        // Presets
        const presetBtn = panel.querySelector('.wb-btn-icon[title="预设管理"]');
        const presetMenu = panel.querySelector('#wb-preset-menu');
        presetBtn.onclick = (e) => { e.stopPropagation(); presetMenu.classList.toggle('show'); UI.renderPresetList(); };
        panel.querySelector('#btn-save-preset').onclick = () => Actions.savePreset();
        document.addEventListener('click', (e) => {
            if (!presetMenu.contains(e.target) && !presetBtn.contains(e.target)) presetMenu.classList.remove('show');
        });

        // Bulk
        const bulkBar = panel.querySelector('#wb-bulk-bar');
        bulkBar.querySelectorAll('button[data-action]').forEach(b => {
            b.onclick = () => Actions.batchAction(b.dataset.action, b.dataset.val === 'true');
        });
        bulkBar.querySelector('#btn-sel-all').onclick = () => Actions.batchSelectAll();

        // Init
        Actions.init().then(() => {
            if (STATE.allBookNames.length > 0) Actions.loadBook(STATE.allBookNames[0]);
        });
    },

    renderBookSelector() {
        // ... (Same logic as V2, populating options)
        const renderOpts = (el) => {
            el.innerHTML = STATE.allBookNames.map(n => `<option value="${n}">${n}</option>`).join('');
            if (STATE.currentBookName) el.value = STATE.currentBookName;
        };
        const el = document.getElementById('wb-book-selector');
        if (el) renderOpts(el);
    },

    renderList() {
        const list = document.getElementById('wb-entry-list');
        if (!list) return;
        list.innerHTML = '';
        STATE.entries.forEach(entry => {
            const card = this.createCard(entry);
            list.appendChild(card);
        });
        this.updateBulkBar();
    },

    createCard(entry) {
        const card = document.createElement('div');
        const isSel = STATE.selectedUids.has(entry.uid);
        card.className = `wb-card ${entry.disable ? 'disabled' : ''} ${isSel ? 'selected' : ''}`;
        card.dataset.uid = entry.uid;
        
        // Checkbox Logic
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'wb-entry-checkbox';
        cb.checked = isSel;
        cb.onclick = (e) => { e.stopPropagation(); Actions.toggleSelection(entry.uid, e.target.checked); };

        const content = document.createElement('div');
        content.className = 'wb-card-content';
        content.innerHTML = `<div class="wb-card-title">${entry.comment || '无标题'}</div>`;

        // ... Add other controls (Toggle, Constant, Input fields) ...
        // [Simplified for brevity - keep original logic here]

        card.appendChild(cb);
        card.appendChild(content);
        return card;
    },

    updateBulkBar() {
        const bar = document.getElementById('wb-bulk-bar');
        const count = document.getElementById('wb-sel-count');
        if (!bar) return;
        if (STATE.selectedUids.size > 0) {
            bar.classList.remove('hidden');
            count.textContent = STATE.selectedUids.size;
        } else {
            bar.classList.add('hidden');
        }
    },

    renderPresetList() {
        const list = document.getElementById('wb-preset-list');
        list.innerHTML = '';
        const presets = API.getPresets(STATE.currentBookName);
        Object.keys(presets).forEach(name => {
            const item = document.createElement('div');
            item.className = 'wb-menu-item';
            item.innerHTML = `<span>${name}</span> <i class="fa-solid fa-trash del-preset"></i>`;
            item.onclick = () => Actions.loadPreset(name);
            item.querySelector('.del-preset').onclick = (e) => {
                e.stopPropagation();
                if(confirm('删除此预设?')) API.deletePreset(STATE.currentBookName, name).then(UI.renderPresetList);
            };
            list.appendChild(item);
        });
        if (Object.keys(presets).length === 0) list.innerHTML = `<div style="padding:10px;color:#999">无预设</div>`;
    },

    // --- Merger View UI ---
    renderMergerView() {
        const view = document.getElementById('wb-view-merger');
        if (!view) return;
        
        ['left', 'right'].forEach(side => {
            const panel = view.querySelector(`.wb-merger-panel[data-side="${side}"]`);
            const select = panel.querySelector('.wb-merger-select');
            
            // Populate Select
            select.innerHTML = `<option value="">选择世界书...</option>` + 
                STATE.allBookNames.map(n => `<option value="${n}">${n}</option>`).join('');
            
            // Bind Change
            // Avoid adding multiple listeners
            select.onchange = (e) => Actions.loadMergerSide(side, e.target.value);
            
            // Set current value if exists
            if (STATE.merger[side].name) select.value = STATE.merger[side].name;
            else if (side === 'left' && STATE.currentBookName) {
                 select.value = STATE.currentBookName;
                 Actions.loadMergerSide('left', STATE.currentBookName);
            }
        });
    },

    renderMergerList(side) {
        const panel = document.querySelector(`.wb-merger-panel[data-side="${side}"]`);
        const list = panel.querySelector('.wb-merger-list');
        list.innerHTML = '';
        const entries = STATE.merger[side].entries;

        entries.forEach(entry => {
            const item = document.createElement('div');
            item.className = 'wb-merge-item';
            item.draggable = true;
            item.dataset.uid = entry.uid;
            item.textContent = entry.comment || `Entry #${entry.uid}`;
            
            // Drag Start
            item.ondragstart = (e) => {
                e.dataTransfer.setData('text/uid', entry.uid);
                e.dataTransfer.setData('text/side', side);
                e.dataTransfer.effectAllowed = e.ctrlKey ? 'copy' : 'move';
            };
            
            list.appendChild(item);
        });

        // Drop Zone Logic on the List itself
        list.ondragover = (e) => e.preventDefault();
        list.ondrop = (e) => {
            e.preventDefault();
            const uid = e.dataTransfer.getData('text/uid');
            const fromSide = e.dataTransfer.getData('text/side');
            if (fromSide && fromSide !== side) { // Only allow cross-panel drops
                 const isCopy = e.ctrlKey;
                 Actions.mergerMoveEntry(uid, fromSide, side, isCopy);
            }
        };
    },

    // --- Binding View Enhanced ---
    renderBindingView() {
        const container = document.getElementById('wb-bind-global-list');
        if (!container) return;
        container.innerHTML = '';
        
        // "Global world book still only displays selected enabled"
        // Here we render ONLY enabled global books, but provide an "Add" button/dropdown
        const activeGlobals = STATE.bindings.global || [];
        
        if (activeGlobals.length === 0) {
            container.innerHTML = `<div style="color:#999">无全局启用世界书</div>`;
        } else {
            activeGlobals.forEach(name => {
                const item = document.createElement('div');
                item.className = 'wb-bind-item';
                item.innerHTML = `<span class="name">${name}</span> <i class="fa-solid fa-xmark remove-bind"></i>`;
                
                // Double click to jump
                item.ondblclick = () => {
                    Actions.loadBook(name);
                    Actions.switchView('editor');
                };
                
                // Remove
                item.querySelector('.remove-bind').onclick = () => API.setBindings('global', name, false).键，然后(操作。refreshContext).键，然后(UI.renderBindingView);
                
                container.appendChild(item);
            });
        }
        
        // Add Button (Simplified)
        const addDiv = document.createElement('div');
        addDiv.innerHTML = `<select style="margin-top:10px;width:100%"><option>+ 添加全局世界书...</option>${STATE.allBookNames.map(n=>`<option value="${n}">${n}</option>`).join('')}</select>`;
        addDiv.querySelector('select').onchange = (e) => {
             if (e.target.value) API.setBindings('global', e.target.value, true).键，然后(操作.refreshContext).键，然后(UI.renderBindingView);
        };
        container.appendChild(addDiv);
    }
};

jQuery(async () => {
    const btn = document.createElement('div'); // Simplified injection
    $('#options .options-content').append(`<a id="${CONFIG.btnId}" class="interactable" title="世界书 Pro"><i class="fa-solid fa-book-atlas"></i> 世界书 Pro</a>`);
    $(`#${CONFIG.btnId}`).click(() => UI.open());
});
