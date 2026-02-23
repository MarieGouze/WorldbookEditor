import { getContext } from '../../../extensions.js';
import { event_types, eventSource } from '../../../../script.js';
import { getCharaFilename } from '../../../utils.js';
import { world_info, world_names, selected_world_info } from '../../../world-info.js';

const CONFIG = {
    id: 'enhanced-wb-panel-v6',
    btnId: 'wb-menu-btn-v6',
    settingsKey: 'WorldbookEditor_Metadata',
    colors: {
        accent: '#66ccff', // 浅天蓝
        bgSecondary: '#fff8dc', // 浅奶黄
    }
};

const STATE = {
    currentView: 'editor',
    currentBookName: null,
    entries: [],
    allBookNames: [],
    metadata: {}, // 包含 presets, groups 等
    
    // 缝合器状态
    stitcher: {
        leftBook: null,
        rightBook: null,
        leftEntries: [],
        rightEntries: [],
        clipboard: null // 用于复制/移动
    },

    // 批量操作状态
    selectedUids: new Set(),
    lastSelectedUid: null, // 用于Shift多选

    bindings: { char: { primary: null, additional: [] }, global: [], chat: null },
    debouncer: null,
    isInitialized: false,
};

// 工具函数：获取条目排序分数
function getEntrySortScore(entry) {
    const context = getContext();
    const anDepth = (context.chatMetadata?.note_depth) ?? (context.extensionSettings?.note?.defaultDepth) ?? 4;
    const pos = typeof entry.position === 'number' ? entry.position : 1;
    if (pos === 0) return 100000;
    if (pos === 1) return 90000;
    if (pos === 5) return 80000;
    if (pos === 6) return 70000;
    if (pos === 4) return entry.depth ?? 4;
    if (pos === 2) return anDepth + 0.6;
    if (pos === 3) return anDepth + 0.4;
    return -9999;
}

const API = {
    async getAllBookNames() { return [...(world_names || [])].sort((a, b) => a.localeCompare(b)); },
    
    async loadBook(name) {
        if (!name) return [];
        const data = await getContext().loadWorldInfo(name);
        if (!data || !data.entries) return [];
        return Object.values(structuredClone(data.entries)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },

    async saveBookEntries(name, entriesArray) {
        if (!name) return;
        const oldData = await getContext().loadWorldInfo(name) || { entries: {} };
        const newEntriesObj = {};
        entriesArray.forEach(entry => {
            const oldEntry = (oldData.entries && oldData.entries[entry.uid]) ? oldData.entries[entry.uid] : {};
            newEntriesObj[entry.uid] = { ...oldEntry, ...structuredClone(entry) };
        });
        await getContext().saveWorldInfo(name, { ...oldData, entries: newEntriesObj }, false);
    },

    // 元数据/预设管理
    getMetadata() { return getContext().extensionSettings[CONFIG.settingsKey] || {}; },
    async saveMetadata(data) {
        getContext().extensionSettings[CONFIG.settingsKey] = data;
        getContext().saveSettingsDebounced();
    },

    // 绑定相关
    async getCharBindings() {
        const context = getContext();
        const charId = context.characterId;
        if (charId === undefined || charId === null) return { primary: null, additional: [] };
        const character = context.characters[charId];
        const primary = character.data?.extensions?.world || null;
        const fileName = character.avatar.replace(/\.[^/.]+$/, "");
        const entry = (world_info.charLore || []).find(e => e.name === fileName);
        return { primary, additional: entry ? [...entry.extraBooks] : [] };
    }
};

const Actions = {
    async init() {
        if (STATE.isInitialized) return;
        STATE.isInitialized = true;
        
        // 初始化数据
        await this.refreshAllContext();
        
        // 监听事件
        eventSource.on(event_types.SETTINGS_UPDATED, () => this.refreshAllContext());
        eventSource.on(event_types.CHARACTER_SELECTED, () => setTimeout(() => this.refreshAllContext(), 100));
        
        // 注册快捷键 (Ctrl+A 全选等)
        document.addEventListener('keydown', (e) => {
            if (!document.getElementById(CONFIG.id)) return;
            if (STATE.currentView === 'editor' && (e.ctrlKey || e.metaKey) && e.key === 'a') {
                e.preventDefault();
                this.batchSelectAll();
            }
        });
    },

    async refreshAllContext() {
        STATE.allBookNames = await API.getAllBookNames();
        STATE.metadata = API.getMetadata();
        STATE.bindings.char = await API.getCharBindings();
        STATE.bindings.global = [...(selected_world_info || [])];
        STATE.bindings.chat = getContext().chatMetadata?.world_info || null;
        if (document.getElementById(CONFIG.id)) UI.renderBookSelector();
    },

    async loadBook(name) {
        if (STATE.currentBookName === name) return;
        // 保存旧书
        if (STATE.currentBookName && STATE.entries.length) {
            await API.saveBookEntries(STATE.currentBookName, STATE.entries);
        }
        STATE.currentBookName = name;
        STATE.selectedUids.clear(); // 切换书清空选择
        STATE.entries = await API.loadBook(name);
        
        // 排序
        STATE.entries.sort((a, b) => {
            const sA = getEntrySortScore(a), sB = getEntrySortScore(b);
            if (sA !== sB) return sB - sA;
            return (a.order ?? 0) - (b.order ?? 0);
        });

        UI.renderList();
        UI.renderBatchBar();
        const selector = document.getElementById('wb-book-selector');
        if (selector) selector.value = name;
    },

    updateEntry(uid, updater) {
        const entry = STATE.entries.find(e => e.uid === uid);
        if (entry) {
            updater(entry);
            // 重新渲染该卡片或局部更新
            UI.updateCardDOM(uid); 
            // 防抖保存
            if (STATE.debouncer) clearTimeout(STATE.debouncer);
            STATE.debouncer = setTimeout(() => API.saveBookEntries(STATE.currentBookName, STATE.entries), 500);
        }
    },

    // --- 批量操作 ---
    toggleSelection(uid, multiSelect = false) {
        if (multiSelect && STATE.lastSelectedUid) {
            // Shift 连选逻辑
            const idx1 = STATE.entries.findIndex(e => e.uid === STATE.lastSelectedUid);
            const idx2 = STATE.entries.findIndex(e => e.uid === uid);
            const start = Math.min(idx1, idx2);
            const end = Math.max(idx1, idx2);
            for (let i = start; i <= end; i++) {
                STATE.selectedUids.add(STATE.entries[i].uid);
            }
        } else {
            if (STATE.selectedUids.has(uid)) STATE.selectedUids.delete(uid);
            else STATE.selectedUids.add(uid);
        }
        STATE.lastSelectedUid = uid;
        UI.updateSelectionVisuals();
    },

    batchSelectAll(invert = false) {
        if (invert) {
            STATE.entries.forEach(e => {
                if (STATE.selectedUids.has(e.uid)) STATE.selectedUids.delete(e.uid);
                else STATE.selectedUids.add(e.uid);
            });
        } else {
            const allSelected = STATE.entries.length > 0 && STATE.selectedUids.size === STATE.entries.length;
            if (allSelected) STATE.selectedUids.clear();
            else STATE.entries.forEach(e => STATE.selectedUids.add(e.uid));
        }
        UI.updateSelectionVisuals();
    },

    async batchAction(action, value) {
        if (STATE.selectedUids.size === 0) return toastr.warning("未选择条目");
        const uids = Array.from(STATE.selectedUids);
        
        if (action === 'delete') {
            if (!confirm(`确定删除选中的 ${uids.length} 个条目吗？`)) return;
            STATE.entries = STATE.entries.filter(e => !STATE.selectedUids.has(e.uid));
            STATE.selectedUids.clear();
        } else if (action === 'enable') {
            STATE.entries.forEach(e => { if(STATE.selectedUids.has(e.uid)) e.disable = !value; });
        } else if (action === 'constant') {
            STATE.entries.forEach(e => { if(STATE.selectedUids.has(e.uid)) e.constant = value; });
        } else if (action === 'move_top') {
            // 移动到顶部 (order = 0, others shift)
            const selected = STATE.entries.filter(e => STATE.selectedUids.has(e.uid));
            const others = STATE.entries.filter(e => !STATE.selectedUids.has(e.uid));
            selected.forEach(e => e.order = 0); // Reset order logic needed realistically
            STATE.entries = [...selected, ...others];
        }

        UI.renderList();
        await API.saveBookEntries(STATE.currentBookName, STATE.entries);
        toastr.success("批量操作完成");
    },

    // --- 预设 (Presets) ---
    async savePreset(name) {
        if (!STATE.currentBookName) return;
        const bookName = STATE.currentBookName;
        if (!STATE.metadata[bookName]) STATE.metadata[bookName] = {};
        if (!STATE.metadata[bookName].presets) STATE.metadata[bookName].presets = [];

        const enabledUids = STATE.entries.filter(e => !e.disable).map(e => e.uid);
        
        // 覆盖同名或追加
        const existingIdx = STATE.metadata[bookName].presets.findIndex(p => p.name === name);
        const presetObj = { name, enabled: enabledUids, date: Date.now() };
        
        if (existingIdx >= 0) STATE.metadata[bookName].presets[existingIdx] = presetObj;
        else STATE.metadata[bookName].presets.push(presetObj);

        await API.saveMetadata(STATE.metadata);
        toastr.success(`预设 "${name}" 已保存`);
        UI.renderPresetMenu();
    },

    async loadPreset(preset) {
        const enabledSet = new Set(preset.enabled);
        let changed = false;
        STATE.entries.forEach(e => {
            const shouldEnable = enabledSet.has(e.uid);
            if (e.disable === shouldEnable) { // disable=false 意味着 enable
                e.disable = !shouldEnable;
                changed = true;
            }
        });
        if (changed) {
            UI.renderList();
            await API.saveBookEntries(STATE.currentBookName, STATE.entries);
            toastr.success(`已应用预设: ${preset.name}`);
        } else {
            toastr.info("状态未发生变化");
        }
    },

    // --- 缝合器 (Stitcher) ---
    async loadStitcherBook(side, name) {
        const entries = await API.loadBook(name);
        STATE.stitcher[`${side}Book`] = name;
        STATE.stitcher[`${side}Entries`] = entries;
        UI.renderStitchList(side);
    },

    async stitchTransfer(uids, fromSide, toSide, mode = 'copy') {
        const sourceEntries = STATE.stitcher[`${fromSide}Entries`];
        const targetEntries = STATE.stitcher[`${toSide}Entries`];
        const targetBook = STATE.stitcher[`${toSide}Book`];
        
        if (!targetBook) return toastr.warning("目标侧未加载世界书");

        const itemsToTransfer = sourceEntries.filter(e => uids.includes(e.uid));
        
        // 生成新 UID 防止冲突
        const maxUid = targetEntries.reduce((max, e) => Math.max(max, Number(e.uid)||0), -1);
        
        const newItems = itemsToTransfer.map((item, idx) => {
            const newItem = structuredClone(item);
            newItem.uid = maxUid + 1 + idx;
            return newItem;
        });

        STATE.stitcher[`${toSide}Entries`] = [...newItems, ...targetEntries]; // 插入到顶部
        
        if (mode === 'move') {
            STATE.stitcher[`${fromSide}Entries`] = sourceEntries.filter(e => !uids.includes(e.uid));
            await API.saveBookEntries(STATE.stitcher[`${fromSide}Book`], STATE.stitcher[`${fromSide}Entries`]);
            UI.renderStitchList(fromSide);
        }

        await API.saveBookEntries(targetBook, STATE.stitcher[`${toSide}Entries`]);
        UI.renderStitchList(toSide);
        
        // 如果缝合影响了当前编辑器打开的书，刷新编辑器
        if (STATE.currentBookName === targetBook || (mode === 'move' && STATE.currentBookName === STATE.stitcher[`${fromSide}Book`])) {
             if (STATE.currentBookName) {
                 STATE.entries = await API.loadBook(STATE.currentBookName);
                 UI.renderList();
             }
        }
        
        toastr.success(`成功${mode === 'copy' ? '复制' : '移动'} ${newItems.length} 个条目`);
    }
};

const UI = {
    // ... 原有的 open, updateGlider 等基础方法保持不变 ...
    
    open() {
        if (document.getElementById(CONFIG.id)) return;
        const panel = document.createElement('div');
        panel.id = CONFIG.id;
        // ... 构建 HTML ...
        // 在 tabs 后面添加 Stitcher tab
        panel.innerHTML = `
            <div class="wb-header-bar">
                <div class="wb-tabs">
                    <div class="wb-tab-glider"></div>
                    <div class="wb-tab active" data-tab="editor"><i class="fa-solid fa-pen-to-square"></i> 编辑</div>
                    <div class="wb-tab" data-tab="binding"><i class="fa-solid fa-link"></i> 绑定</div>
                    <div class="wb-tab" data-tab="stitch"><i class="fa-solid fa-people-arrows"></i> 缝合</div>
                    <div class="wb-tab" data-tab="manage"><i class="fa-solid fa-list-check"></i> 管理</div>
                </div>
                <div id="wb-close" class="wb-header-close"><i class="fa-solid fa-xmark"></i></div>
            </div>
            
            <div class="wb-content">
                <!-- 视图1: 编辑器 (增加批量栏和预设按钮) -->
                <div id="wb-view-editor" class="wb-view-section">
                    <div class="wb-book-bar">
                        <select id="wb-book-selector" style="flex:1;"></select>
                        <div style="position:relative">
                            <button class="wb-btn-circle" id="btn-presets" title="条目状态预设"><i class="fa-solid fa-floppy-disk"></i></button>
                            <div class="wb-preset-menu" id="wb-preset-menu"></div>
                        </div>
                        <!-- 原有菜单按钮... -->
                    </div>
                    <div class="wb-tool-bar">
                        <!-- 搜索和工具按钮... -->
                        <input class="wb-input-dark" id="wb-search-entry" style="flex:1" placeholder="搜索条目...">
                        <button class="wb-btn-circle" id="btn-select-mode" title="批量选择模式"><i class="fa-solid fa-check-double"></i></button>
                        <button class="wb-btn-circle" id="btn-add-entry"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    <div class="wb-list" id="wb-entry-list"></div>
                    <!-- 批量操作栏 -->
                    <div id="wb-batch-bar">
                        <span class="wb-batch-info">已选 0 项</span>
                        <div class="wb-btn-circle" title="全选/反选" id="btn-batch-all"><i class="fa-solid fa-square-check"></i></div>
                        <div class="wb-batch-divider"></div>
                        <div class="wb-btn-circle" title="启用" onclick="Actions.batchAction('enable', true)"><i class="fa-solid fa-toggle-on"></i></div>
                        <div class="wb-btn-circle" title="禁用" onclick="Actions.batchAction('enable', false)"><i class="fa-solid fa-toggle-off"></i></div>
                        <div class="wb-btn-circle danger" title="删除" onclick="Actions.batchAction('delete')"><i class="fa-solid fa-trash"></i></div>
                    </div>
                </div>

                <!-- 视图2: 绑定 -->
                <div id="wb-view-binding" class="wb-view-section wb-hidden">
                    <!-- 原有绑定内容，但给 global list 增加特定 ID -->
                    <div class="wb-bind-grid">
                         <!-- ... structure similar to before ... -->
                         <div class="wb-bind-card">
                            <div class="wb-bind-title">角色世界书</div>
                            <select id="wb-bind-char-primary" style="width:100%"></select>
                            <div class="wb-bind-label">附加 (双击跳转编辑)</div>
                            <div class="wb-scroll-list" id="wb-bind-char-list"></div>
                         </div>
                         <div class="wb-bind-card">
                            <div class="wb-bind-title">全局世界书 (双击跳转编辑)</div>
                            <!-- 需求2: Global只显示选中的, 用 tags 实现 -->
                            <div class="wb-scroll-list" id="wb-bind-global-list"></div>
                         </div>
                    </div>
                    <div style="margin-top:20px; text-align:right">
                         <button class="wb-btn-rect" id="btn-save-bindings">保存绑定</button>
                    </div>
                </div>

                <!-- 视图3: 缝合 (Stitcher) -->
                <div id="wb-view-stitch" class="wb-view-section wb-hidden">
                    <div class="wb-stitch-panel" id="wb-stitch-left">
                        <div class="wb-stitch-header">
                            <select class="wb-stitch-select" data-side="left"></select>
                            <div class="wb-tool-bar" style="margin:0; padding:5px; background:none; border:none">
                                <input placeholder="搜索..." class="wb-stitch-search" data-side="left">
                            </div>
                        </div>
                        <div class="wb-stitch-list" data-side="left"></div>
                    </div>
                    <div style="display:flex; flex-direction:column; justify-content:center; gap:10px;">
                        <i class="fa-solid fa-arrow-right-arrow-left" style="color:#66ccff; font-size:1.5em"></i>
                    </div>
                    <div class="wb-stitch-panel" id="wb-stitch-right">
                        <div class="wb-stitch-header">
                            <select class="wb-stitch-select" data-side="right"></select>
                            <div class="wb-tool-bar" style="margin:0; padding:5px; background:none; border:none">
                                <input placeholder="搜索..." class="wb-stitch-search" data-side="right">
                            </div>
                        </div>
                        <div class="wb-stitch-list" data-side="right"></div>
                    </div>
                </div>

                <!-- 视图4: 管理 -->
                <div id="wb-view-manage" class="wb-view-section wb-hidden">
                     <div class="wb-manage-container" id="wb-manage-content"></div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        
        // 绑定事件
        panel.querySelector('#wb-close').onclick = () => panel.remove();
        panel.querySelectorAll('.wb-tab').forEach(el => el.onclick = () => this.switchView(el.dataset.tab));
        
        // Editor Events
        document.getElementById('wb-book-selector').onchange = (e) => Actions.loadBook(e.target.value);
        document.getElementById('btn-presets').onclick = () => this.renderPresetMenu();
        document.getElementById('btn-batch-all').onclick = () => Actions.batchSelectAll(STATE.selectedUids.size > 0);
        document.getElementById('btn-select-mode').onclick = () => { 
            const list = document.getElementById('wb-entry-list');
            list.classList.toggle('select-mode'); // CSS可配合显隐复选框
        };

        // Stitcher Events
        panel.querySelectorAll('.wb-stitch-select').forEach(el => {
            el.innerHTML = '<option value="">选择世界书...</option>' + 
                STATE.allBookNames.map(n => `<option value="${n}">${n}</option>`).join('');
            el.onchange = async (e) => await Actions.loadStitcherBook(el.dataset.side, e.target.value);
        });
        
        // Initial data update
        this.updateHeaderInfo();
        this.renderList();
        
        // 双击绑定逻辑
        const bindListGlobal = document.getElementById('wb-bind-global-list');
        bindListGlobal.ondblclick = (e) => {
            const item = e.target.closest('.wb-check-item');
            if(item && item.dataset.bookName) {
                Actions.loadBook(item.dataset.bookName);
                this.switchView('editor');
            }
        };
    },

    // 渲染编辑器列表 (增加多选框)
    createCard(entry, index) {
        const isSelected = STATE.selectedUids.has(entry.uid);
        const card = document.createElement('div');
        card.className = `wb-card ${entry.disable ? 'disabled' : ''} ${entry.constant ? 'type-blue' : 'type-green'} ${isSelected ? 'selected' : ''}`;
        card.dataset.uid = entry.uid;

        const checkbox = document.createElement('div');
        checkbox.className = 'wb-check-container';
        checkbox.innerHTML = `<div class="wb-checkbox"></div>`;
        checkbox.onclick = (e) => {
            e.stopPropagation();
            Actions.toggleSelection(entry.uid, e.shiftKey);
        };

        const header = document.createElement('div');
        header.className = 'wb-card-header';
        
        // 核心信息
        const title = document.createElement('div');
        title.className = 'wb-card-main';
        title.innerHTML = `
            <div class="wb-row">
                <input class="wb-inp-title" value="${entry.comment || ''}" placeholder="条目备注">
                <span class="wb-token-display">${this.getTokenCount(entry.content)}</span>
            </div>
            <div class="wb-row" style="font-size:0.85em; color:#94a3b8">
                <span>Key: ${(entry.key || []).join(', ')}</span>
            </div>
        `;

        // 绑定事件
        const titleInput = title.querySelector('input');
        titleInput.oninput = (e) => Actions.updateEntry(entry.uid, d => d.comment = e.target.value);

        header.appendChild(checkbox);
        header.appendChild(title);
        card.appendChild(header);

        return card;
    },

    renderList() {
        const list = document.getElementById('wb-entry-list');
        list.innerHTML = '';
        STATE.entries.forEach((entry, idx) => {
            list.appendChild(this.createCard(entry, idx));
        });
        this.updateSelectionVisuals();
    },

    updateSelectionVisuals() {
        const count = STATE.selectedUids.size;
        const bar = document.getElementById('wb-batch-bar');
        const list = document.getElementById('wb-entry-list');
        
        if (count > 0) bar.classList.add('show');
        else bar.classList.remove('show');
        
        bar.querySelector('.wb-batch-info').innerText = `已选 ${count} 项`;
        
        // 更新卡片选中态
        Array.from(list.children).forEach(card => {
            const uid = parseInt(card.dataset.uid);
            if (STATE.selectedUids.has(uid)) card.classList.add('selected');
            else card.classList.remove('selected');
        });
    },

    // 预设菜单
    renderPresetMenu() {
        const menu = document.getElementById('wb-preset-menu');
        if (!menu) return;
        
        // Toggle display
        if (menu.classList.contains('show')) {
            menu.classList.remove('show');
            return;
        }
        
        const bookName = STATE.currentBookName;
        const presets = (STATE.metadata[bookName]?.presets || []);
        
        let html = `<div class="wb-preset-header"><span>保存的快照</span><i class="fa-solid fa-xmark" style="cursor:pointer" onclick="this.parentElement.parentElement.classList.remove('show')"></i></div>`;
        
        if (presets.length === 0) html += `<div style="color:#94a3b8; font-size:0.85em; padding:10px; text-align:center">暂无预设</div>`;
        else {
            presets.forEach(p => {
                const dateStr = new Date(p.date).toLocaleDateString();
                html += `<div class="wb-preset-item" data-name="${p.name}">
                    <span>${p.name} <span style="font-size:0.8em; color:#cbd5e1">(${p.enabled.length} ON)</span></span>
                    <i class="fa-solid fa-play" title="应用此状态"></i>
                </div>`;
            });
        }
        
        html += `<div style="border-top:1px solid #f1f5f9; margin-top:8px; padding-top:8px;">
            <input id="wb-preset-new-name" placeholder="新预设名称..." style="width:100%; margin-bottom:5px">
            <button class="wb-btn-rect" style="width:100%; padding:5px; font-size:0.9em" id="wb-preset-save-btn">保存当前状态</button>
        </div>`;
        
        menu.innerHTML = html;
        menu.classList.add('show');
        
        menu.querySelectorAll('.wb-preset-item').forEach(el => {
            el.onclick = () => Actions.loadPreset(presets.find(p => p.name === el.dataset.name));
        });
        
        document.getElementById('wb-preset-save-btn').onclick = () => {
            const name = document.getElementById('wb-preset-new-name').value;
            if(name) Actions.savePreset(name);
        };
    },

    // 缝合视图渲染
    renderStitchList(side) {
        const list = document.querySelector(`.wb-stitch-list[data-side="${side}"]`);
        const entries = STATE.stitcher[`${side}Entries`] || [];
        list.innerHTML = '';
        
        entries.forEach(entry => {
            const card = document.createElement('div');
            card.className = `wb-stitch-card ${entry.disable?'disabled':''} ${entry.constant?'type-blue':'type-green'}`;
            card.draggable = true;
            card.dataset.uid = entry.uid;
            card.innerHTML = `
                <span>${entry.comment || '无标题'}</span>
                <span style="font-size:0.8em; color:#94a3b8">#${entry.uid}</span>
            `;
            
            // 拖拽逻辑
            card.ondragstart = (e) => {
                e.dataTransfer.setData('text/plain', JSON.stringify({ uid: entry.uid, side }));
                e.dataTransfer.effectAllowed = 'copyMove';
                card.classList.add('dragging');
            };
            card.ondragend = () => card.classList.remove('dragging');
            
            list.appendChild(card);
        });
        
        // 放置区域逻辑
        list.ondragover = (e) => { e.preventDefault(); list.classList.add('drag-over'); };
        list.ondragleave = () => list.classList.remove('drag-over');
        list.ondrop = (e) => {
            e.preventDefault();
            list.classList.remove('drag-over');
            try {
                const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                if (data.side === side) return; // 同侧忽略
                // 移动还是复制？按住Ctrl为复制，否则移动 (或反之，此处默认复制)
                const mode = e.ctrlKey ? 'move' : 'copy';
                Actions.stitchTransfer([data.uid], data.side, side, mode);
            } catch (err) { console.error(err); }
        };
    }
};

// ... 保持原有 jQuery 注入代码 ...
jQuery(async () => {
    // 注入按钮逻辑与原版相同，确保 id 一致
    const injectButton = () => {
        if (document.getElementById(CONFIG.btnId)) return;
        const container = document.querySelector('#options .options-content');
        if (container) {
            $(container).append(`<a id="${CONFIG.btnId}" class="interactable" title="世界书编辑器"><i class="fa-lg fa-solid fa-book-journal-whills"></i><span>世界书Pro</span></a>`);
            $(`#${CONFIG.btnId}`).on('click', (e) => { e.preventDefault(); $('#options').hide(); UI.open(); });
        }
    };
    injectButton();
    if (typeof world_names === 'undefined') eventSource.on(event_types.APP_READY, Actions.init);
    else Actions.init();
});
