/* Ops Monitor — Vue 3 + Naive UI SPA */
const { createApp, ref, reactive, computed, onMounted, onUnmounted, h, watch, nextTick, defineComponent, provide, inject } = Vue;
const { createRouter, createWebHashHistory } = VueRouter;
const {
    NConfigProvider, NLayout, NLayoutSider, NMenu, NButton, NIcon, NSpace,
    NCard, NStatistic, NGrid, NGi, NDataTable, NModal, NForm, NFormItem,
    NInput, NInputNumber, NSelect, NSwitch, NPopconfirm, NTag, NAvatar,
    NResult, NSpin, NBadge, NAlert, NEmpty, NText, NDivider, NScrollbar,
    NInputGroup, NTooltip, NDatePicker, NMessageProvider, useMessage, darkTheme,
    NDropdown, NPageHeader, NPagination, NDescriptions, NDescriptionsItem,
    NDrawer, NDrawerContent, NButtonGroup, zhCN, dateZhCN
} = naive;

// ============================================================
// Session cache
// ============================================================
let _sessionValid = false;

// ============================================================
// Global responsive state
// ============================================================
const _isMobile = ref(window.innerWidth < 768);
window.addEventListener('resize', () => { _isMobile.value = window.innerWidth < 768; });

// ============================================================
// Theme state (default light)
// ============================================================
const _isDark = ref(localStorage.getItem('theme') === 'dark');
watch(_isDark, v => {
    localStorage.setItem('theme', v ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', v ? 'dark' : 'light');
});
document.documentElement.setAttribute('data-theme', _isDark.value ? 'dark' : 'light');

function toggleTheme() { _isDark.value = !_isDark.value; }
function themeIcon() { return _isDark.value ? '\u2600' : '\u263e'; }

// ============================================================
// API Helper
// ============================================================
const api = {
    async request(method, url, body) {
        const opts = { method, headers: {} };
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        let res;
        try {
            res = await fetch(url, opts);
        } catch (e) {
            // Network error (server restart, offline) — don't logout
            throw new Error('network_error');
        }
        if (res.status === 401) {
            _sessionValid = false;
            // 会话失效（改管理员账号/服务重启）时主动踢回登录页——
            // 否则已打开的页面所有请求静默失败，看起来像"没有数据"
            if (!location.hash.startsWith('#/login')) location.hash = '#/login';
            throw new Error('unauthorized');
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'request failed');
        return data;
    },
    get(url) { return this.request('GET', url); },
    post(url, body) { return this.request('POST', url, body); },
    put(url, body) { return this.request('PUT', url, body); },
    del(url) { return this.request('DELETE', url); },
};

// ============================================================
// UI settings
// ============================================================
const UI_SETTINGS_CACHE_KEY = 'ops-sentinel.uiSettings';

// 空串表示"还没拿到设置"。不能像以前那样默认 '1'——那样刷新时会先把
// 被关掉的菜单渲染出来，等 /api/settings 回来再收回去，肉眼可见地闪一下。
const _uiSettings = reactive({
    show_rocketmq_menu: '',
    show_grafana_menu: '',
    show_cloud_logging_menu: '',
});

// 服务端的值是否已经拿到。缓存只是上一次的快照，可能已经过期。
const _uiSettingsLoaded = ref(false);

// 用上一次的结果起手，让刷新后的首帧尽量就是对的
try {
    const cached = JSON.parse(localStorage.getItem(UI_SETTINGS_CACHE_KEY) || 'null');
    if (cached && typeof cached === 'object') {
        for (const key of Object.keys(_uiSettings)) {
            if (typeof cached[key] === 'string') _uiSettings[key] = cached[key];
        }
    }
} catch {}

function applyUISettings(settings) {
    if (!settings) return;
    for (const key of Object.keys(_uiSettings)) {
        if (Object.prototype.hasOwnProperty.call(settings, key)) {
            _uiSettings[key] = settings[key] || '0';
        }
    }
    _uiSettingsLoaded.value = true;
    try {
        localStorage.setItem(UI_SETTINGS_CACHE_KEY, JSON.stringify({ ..._uiSettings }));
    } catch {}
}

function isUISettingEnabled(key) {
    // 对本地缓存做不对称信任，这样菜单在两个方向上都不会闪：
    //   缓存说"关" → 立刻隐藏。最坏情况是一个其实开着的菜单晚 100ms 出现。
    //   缓存说"开" → 先不显示，等服务端确认。否则服务端已经关掉、而缓存还是
    //                上次的"开"时，首帧会把它渲染出来再收回去——正是要修的那个闪烁。
    // 只有服务端确认过的"开"才显示。
    if (_uiSettings[key] === '0') return false;
    if (!_uiSettingsLoaded.value) return false;
    return _uiSettings[key] !== '0';
}

// ============================================================
// WebSocket composable
// ============================================================
function useWebSocket(path) {
    const connected = ref(false);
    const messages = ref([]);
    let ws = null;
    let retryDelay = 1000;
    let stopped = false;

    function connect() {
        if (stopped) return;
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(proto + '//' + location.host + path);
        ws.onopen = () => { connected.value = true; retryDelay = 1000; };
        ws.onclose = () => {
            connected.value = false;
            if (!stopped) setTimeout(connect, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30000);
        };
        ws.onmessage = (e) => {
            try { messages.value.push(JSON.parse(e.data)); } catch {}
        };
    }

    function stop() { stopped = true; if (ws) ws.close(); }
    function clear() { messages.value = []; }

    connect();
    return { connected, messages, stop, clear };
}

// ============================================================
// Helper: responsive columns
// ============================================================
function useColumns(allColumns) {
    return computed(() => {
        if (_isMobile.value) return allColumns.filter(c => !c._hideOnMobile);
        return allColumns;
    });
}

// ============================================================
// Global SQL detail modal
// ============================================================
const _sqlDetail = reactive({ show: false, sql: '', row: null });
function showSqlDetail(row) {
    _sqlDetail.sql = row.sql_text || '';
    _sqlDetail.row = row;
    _sqlDetail.show = true;
}
function renderSqlCell(row, maxLen) {
    return h('code', {
        style: 'font-family:var(--font-mono);font-size:11px;opacity:0.7;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px',
        onClick: () => showSqlDetail(row),
    }, truncate(row.sql_text, maxLen));
}
function SqlDetailModal() {
    const row = _sqlDetail.row;
    const ignoring = ref(false);
    async function handleIgnore() {
        if (!row || !row.database_id || !row.sql_text) return;
        ignoring.value = true;
        try {
            await api.post('/api/ignored-sql', { database_id: row.database_id, sql_text: row.sql_text });
            window.$message && window.$message.success('已忽略该SQL模式，后续相同SQL将不再通知');
            _sqlDetail.show = false;
        } catch (e) {
            window.$message && window.$message.error('忽略失败: ' + (e.message || e));
        }
        ignoring.value = false;
    }
    return h(NModal, {
        show: _sqlDetail.show, 'onUpdate:show': v => _sqlDetail.show = v,
        preset: 'card', title: 'SQL 详情',
        style: _isMobile.value ? 'width:95vw' : 'width:680px',
    }, () => h('div', [
        row ? h(NDescriptions, { bordered: true, column: 2, labelPlacement: _isMobile.value ? 'top' : 'left', size: 'small', style: 'margin-bottom:16px' }, () => [
            row.database_name ? h(NDescriptionsItem, { label: '数据库' }, () => row.database_name) : null,
            row.user ? h(NDescriptionsItem, { label: '用户' }, () => (row.user || '') + (row.host ? '@' + row.host : '')) : null,
            row.exec_sec != null ? h(NDescriptionsItem, { label: '执行耗时' }, () => h(NText, { type: 'error', strong: true }, () => row.exec_sec.toFixed(3) + 's')) : null,
            row.lock_sec != null ? h(NDescriptionsItem, { label: '锁等待' }, () => row.lock_sec.toFixed(3) + 's') : null,
            row.rows_examined != null ? h(NDescriptionsItem, { label: '扫描行数' }, () => String(row.rows_examined)) : null,
            row.db_name ? h(NDescriptionsItem, { label: '库名' }, () => row.db_name) : null,
            row.process_id ? h(NDescriptionsItem, { label: 'KILL 命令' }, () => h('code', { style: 'font-family:var(--font-mono);font-size:12px' }, 'KILL ' + row.process_id + ';')) : null,
            row.detected_at ? h(NDescriptionsItem, { label: '检测时间' }, () => formatTime(row.detected_at)) : null,
        ]) : null,
        h('div', { class: 'sql-detail-block' }, [
            h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' }, [
                h(NText, { depth: 3, style: 'font-size:12px' }, () => 'SQL 语句'),
                h('div', { style: 'display:flex;gap:8px' }, [
                    row && row.database_id ? h(NButton, { size: 'tiny', type: 'warning', secondary: true, loading: ignoring.value, onClick: handleIgnore }, () => '忽略此SQL') : null,
                    h(NButton, { size: 'tiny', secondary: true, onClick: () => { copyText(_sqlDetail.sql); } }, () => '复制'),
                ]),
            ]),
            h('pre', { class: 'sql-detail-code' }, _sqlDetail.sql),
        ]),
    ]));
}

// ============================================================
// Pages
// ============================================================

// --- Login ---
const LoginPage = defineComponent({
    setup() {
        const form = reactive({ username: '', password: '' });
        const loading = ref(false);
        const error = ref('');
        const authConfig = reactive({ github_enabled: false, password_login_enabled: true, github_client_id: '' });
        const message = useMessage();

        onMounted(async () => {
            try {
                const cfg = await api.get('/api/auth/config');
                Object.assign(authConfig, cfg);
            } catch {}
            const hash = window.location.hash;
            if (hash.includes('error=not_allowed')) error.value = '该 GitHub 账号未被授权登录';
            else if (hash.includes('error=oauth_failed')) error.value = 'GitHub 授权失败，请重试';
        });

        async function handleLogin() {
            loading.value = true;
            error.value = '';
            try {
                await api.post('/api/auth/login', form);
                window.location.hash = '#/overview';
            } catch (e) {
                error.value = e.message;
            } finally {
                loading.value = false;
            }
        }

        function githubLogin() {
            window.location.href = '/api/auth/github';
        }

        return () => h('div', { class: 'login-page' }, [
            // Theme toggle on login page
            h('div', { style: 'position:absolute;top:16px;right:16px;z-index:10' }, [
                h(NButton, { quaternary: true, circle: true, onClick: toggleTheme, style: 'font-size:18px' }, () => themeIcon()),
            ]),
            h('div', { class: 'login-card-wrapper' }, [
                h('div', { class: 'login-card' }, [
                    // Logo area
                    h('div', { class: 'login-header' }, [
                        h('h1', { class: 'login-title' }, 'Ops Monitor'),
                        h('p', { class: 'login-subtitle' }, '运维监控管理平台'),
                    ]),

                    // Error alert
                    error.value ? h(NAlert, { type: 'error', style: 'margin-bottom:20px', closable: true, onClose: () => error.value = '' }, { default: () => error.value }) : null,

                    // Password login form
                    authConfig.password_login_enabled ? h('div', { class: 'login-form' }, [
                        h('div', { class: 'login-field' }, [
                            h(NInput, { value: form.username, 'onUpdate:value': v => form.username = v, placeholder: '用户名', size: 'large', round: true }),
                        ]),
                        h('div', { class: 'login-field' }, [
                            h(NInput, { value: form.password, 'onUpdate:value': v => form.password = v, type: 'password', showPasswordOn: 'click', placeholder: '密码', size: 'large', round: true, onKeyup: e => e.key === 'Enter' && handleLogin() }),
                        ]),
                        h(NButton, { type: 'primary', block: true, loading: loading.value, onClick: handleLogin, size: 'large', round: true, style: 'margin-top:4px' }, () => '登 录'),
                    ]) : null,

                    // GitHub login
                    authConfig.github_enabled ? h('div', [
                        authConfig.password_login_enabled ? h('div', { class: 'login-divider' }, [
                            h('span', null, '其他登录方式'),
                        ]) : null,
                        h('button', { class: 'github-btn', onClick: githubLogin }, [
                            h('svg', { viewBox: '0 0 16 16', width: 20, height: 20, fill: 'currentColor' }, [
                                h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z' }),
                            ]),
                            'GitHub 登录'
                        ]),
                    ]) : null,

                    !authConfig.password_login_enabled && !authConfig.github_enabled ? h(NResult, { status: 'warning', title: '登录方式未配置', description: '请联系管理员' }) : null,
                ]),
            ]),
        ]);
    }
});

// --- Dashboard ---
const DashboardPage = defineComponent({
    setup() {
        const stats = ref(null);
        const loading = ref(true);
        const { connected, messages, stop } = useWebSocket('/ws/slow-queries');

        onMounted(async () => {
            try { stats.value = await api.get('/api/dashboard/stats'); } catch {}
            loading.value = false;
        });
        onUnmounted(stop);

        // Real-time: push new slow queries into dashboard
        watch(() => messages.value.length, () => {
            const latest = messages.value[messages.value.length - 1];
            if (!stats.value || !latest || latest.type !== 'slow_query' || !latest.data) return;
            stats.value.today_count++;
            stats.value.week_count++;
            if (!stats.value.recent_logs) stats.value.recent_logs = [];
            stats.value.recent_logs.unshift(latest.data);
            if (stats.value.recent_logs.length > 20) stats.value.recent_logs.length = 20;
            if (messages.value.length > 200) messages.value.splice(0, messages.value.length - 200);
        });

        const recentColumns = useColumns([
            { title: '时间', key: 'detected_at', width: 130, render: row => h('span', { style: 'font-size:12px;opacity:0.65' }, formatTime(row.detected_at)) },
            { title: '数据库', key: 'database_name', width: 120 },
            { title: '用户', key: 'user', width: 100, _hideOnMobile: true },
            { title: '耗时', key: 'exec_sec', width: 80, render: row => h(NText, { type: 'error', strong: true }, () => row.exec_sec.toFixed(1) + 's') },
            { title: 'SQL', key: 'sql_text', ellipsis: { tooltip: true }, _hideOnMobile: true, render: row => renderSqlCell(row, 80) },
        ]);

        function statCard(title, subtitle, items, link) {
            return h('div', {
                class: 'stat-card' + (link ? ' stat-card-clickable' : ''),
                onClick: link ? () => router.push(link) : undefined,
                style: link ? 'cursor:pointer' : '',
            }, [
                h('div', { class: 'stat-card-header' }, [
                    h('span', { class: 'stat-card-title' }, title),
                    subtitle ? h('span', { class: 'stat-card-subtitle' }, subtitle) : null,
                ]),
                h('div', { class: 'stat-card-body' }, items.map(item =>
                    h('div', {
                        class: 'stat-card-item' + (item.link ? ' stat-item-clickable' : ''),
                        onClick: item.link ? (e) => { e.stopPropagation(); router.push(item.link); } : undefined,
                        style: item.link ? 'cursor:pointer' : '',
                    }, [
                        h('div', { class: 'stat-card-value', style: item.color ? ('color:' + item.color) : '' }, String(item.value)),
                        h('div', { class: 'stat-card-label' }, item.label),
                    ])
                )),
            ]);
        }

        return () => h(NSpin, { show: loading.value }, () => stats.value ? h('div', { class: 'page-body' }, [
            h('div', { class: 'page-header' }, [
                h('h3', { class: 'page-title' }, '仪表盘'),
                h('div', { style: 'display:flex;align-items:center;gap:6px;font-size:12px;opacity:0.5' }, [
                    h('span', { class: connected.value ? 'ws-dot connected' : 'ws-dot disconnected' }),
                    connected.value ? '实时监控中' : '连接断开'
                ]),
            ]),
            h('div', { class: 'stat-grid' }, [
                statCard('MySQL', '慢SQL监控', [
                    { label: '运行中', value: stats.value.running_dbs, color: '#18a058', link: '/databases' },
                    { label: '已配置', value: stats.value.total_dbs, color: '#2080f0', link: '/databases' },
                    { label: '今日慢SQL', value: stats.value.today_count, color: stats.value.today_count > 0 ? '#d03050' : '#999', link: '/slow-queries' },
                ], '/databases'),
                isUISettingEnabled('show_rocketmq_menu') ? statCard('RocketMQ', '消息堆积监控', [
                    { label: '运行中', value: stats.value.rocketmq_running || 0, color: '#18a058', link: '/rocketmq' },
                    { label: '已配置', value: stats.value.rocketmq_configs || 0, color: '#2080f0', link: '/rocketmq' },
                    { label: '今日告警', value: stats.value.rocketmq_alerts_today || 0, color: (stats.value.rocketmq_alerts_today || 0) > 0 ? '#d03050' : '#999', link: '/rocketmq-alerts' },
                ], '/rocketmq') : null,
                statCard('指标监控', 'Prometheus 端点', [
                    { label: '采集目标', value: stats.value.prom_targets_running || 0, color: '#18a058', link: '/prom-targets' },
                    { label: '告警规则', value: stats.value.prom_checks || 0, color: '#2080f0', link: '/prom-checks' },
                    { label: '今日告警', value: stats.value.prom_alerts_today || 0, color: (stats.value.prom_alerts_today || 0) > 0 ? '#d03050' : '#999', link: '/prom-logs' },
                ], '/prom-targets'),
                statCard('证书检查', 'TLS 到期监控', [
                    { label: '运行中', value: stats.value.cert_running || 0, color: '#18a058', link: '/cert-checks' },
                    { label: '已配置', value: stats.value.cert_checks || 0, color: '#2080f0', link: '/cert-checks' },
                ], '/cert-checks'),
                statCard('健康检查', 'HTTP 端点监控', [
                    { label: '运行中', value: stats.value.health_checks_running || 0, color: '#18a058', link: '/health-checks' },
                    { label: '已配置', value: stats.value.health_checks || 0, color: '#2080f0', link: '/health-checks' },
                    { label: '今日异常', value: stats.value.health_check_errors_today || 0, color: (stats.value.health_check_errors_today || 0) > 0 ? '#d03050' : '#999', link: '/health-checks-logs' },
                ], '/health-checks'),
                isUISettingEnabled('show_grafana_menu') ? statCard('Grafana', '告警集成', [
                    { label: '运行中', value: stats.value.grafana_running || 0, color: '#18a058', link: '/grafana' },
                    { label: '已配置', value: stats.value.grafana_configs || 0, color: '#2080f0', link: '/grafana' },
                    { label: '今日告警', value: stats.value.grafana_alerts_today || 0, color: (stats.value.grafana_alerts_today || 0) > 0 ? '#d03050' : '#999', link: '/grafana-alerts' },
                ], '/grafana') : null,
                statCard('Cloud Logging', '日志查询监控', [
                    { label: '运行中', value: stats.value.cloud_logging_running || 0, color: '#18a058', link: '/cloud-logging-checks' },
                    { label: '已配置', value: stats.value.cloud_logging_configs || 0, color: '#2080f0', link: '/cloud-logging-configs' },
                    { label: '今日告警', value: stats.value.cloud_logging_alerts_today || 0, color: (stats.value.cloud_logging_alerts_today || 0) > 0 ? '#d03050' : '#999', link: '/cloud-logging-logs' },
                ], '/cloud-logging-configs'),
            ].filter(Boolean)),
            h('h4', { class: 'section-title' }, '最近慢SQL'),
            stats.value.recent_logs && stats.value.recent_logs.length > 0
                ? h(NDataTable, { columns: recentColumns.value, data: stats.value.recent_logs, bordered: false, size: 'small', maxHeight: 400, scrollX: _isMobile.value ? 400 : undefined, rowKey: row => row.id || row.detected_at })
                : h(NEmpty, { description: '暂无慢SQL记录' }),
        ]) : null);
    }
});

// --- Databases ---
const DatabasesPage = defineComponent({
    setup() {
        const databases = ref([]);
        const loading = ref(true);
        const showModal = ref(false);
        const editingId = ref(null);
        const form = reactive({ name: '', host: '', port: 3306, user: '', password: '', interval_sec: 10, threshold_sec: 10 });
        const saving = ref(false);
        const message = useMessage();

        async function load() {
            loading.value = true;
            try { databases.value = await api.get('/api/databases'); } catch {}
            loading.value = false;
        }
        onMounted(load);

        function openAdd() {
            editingId.value = null;
            Object.assign(form, { name: '', host: '', port: 3306, user: '', password: '', interval_sec: 10, threshold_sec: 10 });
            showModal.value = true;
        }

        function openEdit(row) {
            editingId.value = row.id;
            Object.assign(form, { name: row.name, host: row.host, port: row.port, user: row.user, password: '', interval_sec: row.interval_sec, threshold_sec: row.threshold_sec });
            showModal.value = true;
        }

        function openClone(row) {
            editingId.value = null;
            Object.assign(form, { name: row.name + ' (副本)', host: row.host, port: row.port, user: row.user, password: '', interval_sec: row.interval_sec, threshold_sec: row.threshold_sec });
            showModal.value = true;
        }

        async function save() {
            saving.value = true;
            try {
                if (editingId.value) {
                    await api.put('/api/databases/' + editingId.value, form);
                    message.success('更新成功');
                } else {
                    await api.post('/api/databases', form);
                    message.success('创建成功');
                }
                showModal.value = false;
                await load();
            } catch (e) { message.error(e.message); }
            saving.value = false;
        }

        async function toggle(row) {
            try { await api.post('/api/databases/' + row.id + '/toggle'); await load(); } catch (e) { message.error(e.message); }
        }
        async function del(row) {
            try { await api.del('/api/databases/' + row.id); message.success('已删除'); await load(); } catch (e) { message.error(e.message); }
        }
        async function test(row) {
            try {
                const res = await api.post('/api/databases/' + row.id + '/test');
                res.ok ? message.success(res.message) : message.error(res.message);
            } catch (e) { message.error(e.message); }
        }

        const columns = useColumns([
            { title: '名称', key: 'name', render: row => h(NText, { strong: true }, () => row.name) },
            { title: '地址', key: 'host', _hideOnMobile: true, render: row => h(NText, { depth: 3, style: 'font-size:12px' }, () => row.host + ':' + row.port) },
            { title: '用户', key: 'user', _hideOnMobile: true },
            { title: '间隔/阈值', key: 'interval', _hideOnMobile: true, render: row => h(NText, { depth: 3, style: 'font-size:12px' }, () => row.interval_sec + 's / ' + row.threshold_sec + 's') },
            { title: '状态', key: 'status', width: 90, render: row => row.running ? h(NTag, { type: 'success', size: 'small' }, () => '运行中') : row.enabled ? h(NTag, { type: 'warning', size: 'small' }, () => '已启用') : h(NTag, { size: 'small' }, () => '已禁用') },
            { title: '操作', key: 'actions', width: _isMobile.value ? 160 : 310, render: row => h(NSpace, { size: 'small', wrap: _isMobile.value }, () => {
                const btns = [
                    h(NButton, { size: 'small', secondary: true, onClick: () => toggle(row) }, () => row.enabled ? '禁用' : '启用'),
                    h(NButton, { size: 'small', secondary: true, onClick: () => openEdit(row) }, () => '编辑'),
                    h(NButton, { size: 'small', secondary: true, onClick: () => openClone(row) }, () => '复制'),
                ];
                if (!_isMobile.value) btns.push(h(NButton, { size: 'small', secondary: true, onClick: () => test(row) }, () => '测试'));
                btns.push(h(NPopconfirm, { onPositiveClick: () => del(row) }, { trigger: () => h(NButton, { size: 'small', secondary: true, type: 'error' }, () => '删除'), default: () => '确定删除？' }));
                return btns;
            }) },
        ]);

        const gridCols = computed(() => _isMobile.value ? 1 : 2);

        return () => h('div', { class: 'page-body' }, [
            h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px' }, [
                h('h3', { class: 'page-title' }, '数据库管理'),
                h(NButton, { type: 'primary', onClick: openAdd, size: _isMobile.value ? 'small' : 'medium' }, () => '+ 添加'),
            ]),
            h(NDataTable, { columns: columns.value, data: databases.value, bordered: false, size: 'small', loading: loading.value, maxHeight: 'calc(100vh - 200px)', scrollX: _isMobile.value ? 400 : undefined }),
            h(NModal, { show: showModal.value, 'onUpdate:show': v => showModal.value = v, preset: 'card', title: editingId.value ? '编辑数据库' : '添加数据库', style: _isMobile.value ? 'width:95vw' : 'width:620px', segmented: true }, () => h(NForm, { model: form, labelPlacement: _isMobile.value ? 'top' : 'left', labelWidth: _isMobile.value ? undefined : 110 }, [
                h(NFormItem, { label: '名称' }, () => h(NInput, { value: form.name, 'onUpdate:value': v => form.name = v, placeholder: '如: 生产数据库' })),
                h(NGrid, { cols: gridCols.value, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '主机' }, () => h(NInput, { value: form.host, 'onUpdate:value': v => form.host = v, placeholder: '127.0.0.1' }))),
                    h(NGi, null, () => h(NFormItem, { label: '端口' }, () => h(NInputNumber, { value: form.port, 'onUpdate:value': v => form.port = v, min: 1, max: 65535 }))),
                ]),
                h(NGrid, { cols: gridCols.value, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '用户名' }, () => h(NInput, { value: form.user, 'onUpdate:value': v => form.user = v }))),
                    h(NGi, null, () => h(NFormItem, { label: '密码' }, () => h(NInput, { value: form.password, 'onUpdate:value': v => form.password = v, type: 'password', placeholder: editingId.value ? '留空不修改' : '' }))),
                ]),
                h(NGrid, { cols: gridCols.value, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '监控间隔(秒)' }, () => h(NInputNumber, { value: form.interval_sec, 'onUpdate:value': v => form.interval_sec = v, min: 1 }))),
                    h(NGi, null, () => h(NFormItem, { label: '慢SQL阈值(秒)' }, () => h(NInputNumber, { value: form.threshold_sec, 'onUpdate:value': v => form.threshold_sec = v, min: 1 }))),
                ]),
                h(NButton, { type: 'primary', block: true, loading: saving.value, onClick: save, style: 'margin-top:8px' }, () => editingId.value ? '保存' : '创建'),
            ])),
        ]);
    }
});

// --- Notifications ---
const NotificationsPage = defineComponent({
    setup() {
        const list = ref([]);
        const scopes = ref({});
        const loading = ref(true);
        const showModal = ref(false);
        const editingId = ref(null);
        const form = reactive({ type: 'feishu', scope_type: 'all', database_id: null, webhook: '', secret: '', smtp_host: '', smtp_port: 587, smtp_username: '', smtp_password: '', email_from: '', email_to: '', dootask_base_url: '', dootask_token: '', dootask_dialog_id: '' });
        const saving = ref(false);
        const message = useMessage();

        async function load() {
            loading.value = true;
            try {
                list.value = await api.get('/api/notifications');
                scopes.value = await api.get('/api/notification-scopes');
            } catch {}
            loading.value = false;
        }
        onMounted(load);

        const typeOptions = [
            { label: 'Lark', value: 'feishu' },
            { label: '钉钉', value: 'dingtalk' },
            { label: 'DooTask', value: 'dootask' },
            { label: '邮件', value: 'email' },
        ];
        const scopeTypeOptions = [
            { label: '全局（所有告警）', value: 'all' },
            { label: '健康检查', value: 'health' },
            { label: 'MySQL', value: 'mysql' },
            { label: '自定义SQL', value: 'custom_sql' },
            { label: 'Cloud Logging', value: 'cloud_logging' },
            { label: 'RocketMQ', value: 'rocketmq' },
            { label: 'Grafana', value: 'grafana' },
        ];
        const scopeTypeLabels = { all: '全局', health: '健康检查', mysql: 'MySQL', custom_sql: '自定义SQL', cloud_logging: 'Cloud Logging', rocketmq: 'RocketMQ', grafana: 'Grafana' };
        const scopeItemOptions = computed(() => {
            const items = scopes.value[form.scope_type] || [];
            return items.map(d => ({ label: d.name, value: d.id }));
        });

        function openAdd() {
            editingId.value = null;
            Object.assign(form, { type: 'feishu', scope_type: 'all', database_id: null, webhook: '', secret: '', smtp_host: '', smtp_port: 587, smtp_username: '', smtp_password: '', email_from: '', email_to: '', dootask_base_url: '', dootask_token: '', dootask_dialog_id: '' });
            showModal.value = true;
        }
        function fillFormFromRow(row) {
            form.type = row.type;
            form.scope_type = row.scope_type || 'all';
            form.database_id = row.database_id;
            const cfg = typeof row.config_json === 'string' ? JSON.parse(row.config_json) : row.config_json;
            if (row.type === 'dingtalk' || row.type === 'feishu') {
                form.webhook = cfg.webhook || '';
                form.secret = cfg.secret || '';
            } else if (row.type === 'dootask') {
                form.dootask_base_url = cfg.base_url || '';
                form.dootask_token = cfg.token || '';
                form.dootask_dialog_id = cfg.dialog_id || '';
            } else if (row.type === 'email') {
                form.smtp_host = cfg.smtp_host || '';
                form.smtp_port = cfg.smtp_port || 587;
                form.smtp_username = cfg.username || '';
                form.smtp_password = cfg.password || '';
                form.email_from = cfg.from || '';
                form.email_to = cfg.to || '';
            }
        }
        function openEdit(row) {
            editingId.value = row.id;
            fillFormFromRow(row);
            showModal.value = true;
        }
        function openClone(row) {
            editingId.value = null;
            fillFormFromRow(row);
            showModal.value = true;
        }
        async function save() {
            saving.value = true;
            try {
                const payload = { ...form };
                if (payload.scope_type === 'all') payload.database_id = null;
                if (editingId.value) {
                    await api.put('/api/notifications/' + editingId.value, payload);
                    message.success('更新成功');
                } else {
                    await api.post('/api/notifications', payload);
                    message.success('创建成功');
                }
                showModal.value = false;
                await load();
            } catch (e) { message.error(e.message); }
            saving.value = false;
        }
        async function del(row) {
            try { await api.del('/api/notifications/' + row.id); message.success('已删除'); await load(); } catch (e) { message.error(e.message); }
        }
        async function test(row) {
            try {
                const res = await api.post('/api/notifications/' + row.id + '/test');
                res.ok ? message.success(res.message) : message.error(res.message);
            } catch (e) { message.error(e.message); }
        }

        const columns = useColumns([
            { title: '类型', key: 'type', width: 80, render: row => h(NTag, { type: 'info', size: 'small' }, () => ({ dingtalk: '钉钉', feishu: 'Lark', dootask: 'DooTask', email: '邮件' }[row.type] || row.type)) },
            { title: '关联配置', key: 'scope_name', render: row => {
                const label = scopeTypeLabels[row.scope_type] || '全局';
                if (row.scope_type === 'all') return h(NTag, { size: 'small' }, () => '全局');
                return h('span', [h(NTag, { size: 'small', type: 'info' }, () => label), row.scope_name ? h('span', { style: 'margin-left:4px;font-size:12px' }, row.scope_name) : null]);
            }, _hideOnMobile: true },
            { title: '配置摘要', key: 'config_summary', render: row => h(NText, { depth: 3, style: 'font-size:12px' }, () => row.config_summary) },
            { title: '状态', key: 'enabled', width: 90, _hideOnMobile: true, render: row => h(NSwitch, {
                value: !!row.enabled, size: 'small',
                onUpdateValue: async () => {
                    try { await api.post('/api/notifications/' + row.id + '/toggle'); await load(); }
                    catch (e) { window.$message && window.$message.error(e.message); }
                },
            }) },
            { title: '操作', key: 'actions', width: _isMobile.value ? 140 : 250, render: row => h(NSpace, { size: 'small' }, () => [
                h(NButton, { size: 'small', secondary: true, onClick: () => openEdit(row) }, () => '编辑'),
                h(NButton, { size: 'small', secondary: true, onClick: () => openClone(row) }, () => '复制'),
                !_isMobile.value ? h(NButton, { size: 'small', secondary: true, onClick: () => test(row) }, () => '测试') : null,
                h(NPopconfirm, { onPositiveClick: () => del(row) }, { trigger: () => h(NButton, { size: 'small', secondary: true, type: 'error' }, () => '删除'), default: () => '确定删除？' }),
            ].filter(Boolean)) },
        ]);

        const gridCols = computed(() => _isMobile.value ? 1 : 2);

        return () => h('div', { class: 'page-body' }, [
            h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px' }, [
                h('h3', { class: 'page-title' }, '通知配置'),
                h(NButton, { type: 'primary', onClick: openAdd, size: _isMobile.value ? 'small' : 'medium' }, () => '+ 添加'),
            ]),
            h(NDataTable, { columns: columns.value, data: list.value, bordered: false, size: 'small', loading: loading.value, maxHeight: 'calc(100vh - 200px)', scrollX: _isMobile.value ? 350 : undefined }),
            h(NModal, { show: showModal.value, 'onUpdate:show': v => showModal.value = v, preset: 'card', title: editingId.value ? '编辑通知' : '添加通知', style: _isMobile.value ? 'width:95vw' : 'width:680px', segmented: true }, () => h(NForm, { model: form, labelPlacement: _isMobile.value ? 'top' : 'left', labelWidth: _isMobile.value ? undefined : 100 }, [
                h(NGrid, { cols: gridCols.value, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '通知类型' }, () => h(NSelect, { value: form.type, 'onUpdate:value': v => form.type = v, options: typeOptions }))),
                    h(NGi, null, () => h(NFormItem, { label: '关联范围' }, () => h(NSelect, { value: form.scope_type, 'onUpdate:value': v => { form.scope_type = v; form.database_id = null; }, options: scopeTypeOptions }))),
                ]),
                form.scope_type !== 'all' ? h(NFormItem, { label: '关联配置' }, () => h(NSelect, { value: form.database_id, 'onUpdate:value': v => form.database_id = v, options: scopeItemOptions.value, clearable: true, placeholder: '选择具体配置（不选则该类型全部）' })) : null,
                (form.type === 'dingtalk' || form.type === 'feishu') ? h('div', [
                    h(NFormItem, { label: 'Webhook URL' }, () => h(NInput, { value: form.webhook, 'onUpdate:value': v => form.webhook = v, placeholder: 'https://...' })),
                    h(NFormItem, { label: '签名密钥' }, () => h(NInput, { value: form.secret, 'onUpdate:value': v => form.secret = v, placeholder: '可选' })),
                ]) : form.type === 'dootask' ? h('div', [
                    h(NFormItem, { label: '服务地址' }, () => h(NInput, { value: form.dootask_base_url, 'onUpdate:value': v => form.dootask_base_url = v, placeholder: 'https://t.hitosea.com' })),
                    h(NFormItem, { label: 'Token' }, () => h(NInput, { value: form.dootask_token, 'onUpdate:value': v => form.dootask_token = v, placeholder: '机器人Token' })),
                    h(NFormItem, { label: '对话ID' }, () => h(NInput, { value: form.dootask_dialog_id, 'onUpdate:value': v => form.dootask_dialog_id = v, placeholder: 'dialog_id' })),
                ]) : h('div', [
                    h(NGrid, { cols: gridCols.value, xGap: 12 }, () => [
                        h(NGi, null, () => h(NFormItem, { label: 'SMTP 主机' }, () => h(NInput, { value: form.smtp_host, 'onUpdate:value': v => form.smtp_host = v }))),
                        h(NGi, null, () => h(NFormItem, { label: 'SMTP 端口' }, () => h(NInputNumber, { value: form.smtp_port, 'onUpdate:value': v => form.smtp_port = v }))),
                    ]),
                    h(NGrid, { cols: gridCols.value, xGap: 12 }, () => [
                        h(NGi, null, () => h(NFormItem, { label: '用户名' }, () => h(NInput, { value: form.smtp_username, 'onUpdate:value': v => form.smtp_username = v }))),
                        h(NGi, null, () => h(NFormItem, { label: '密码' }, () => h(NInput, { value: form.smtp_password, 'onUpdate:value': v => form.smtp_password = v, type: 'password' }))),
                    ]),
                    h(NGrid, { cols: gridCols.value, xGap: 12 }, () => [
                        h(NGi, null, () => h(NFormItem, { label: '发件人' }, () => h(NInput, { value: form.email_from, 'onUpdate:value': v => form.email_from = v }))),
                        h(NGi, null, () => h(NFormItem, { label: '收件人' }, () => h(NInput, { value: form.email_to, 'onUpdate:value': v => form.email_to = v, placeholder: '逗号分隔' }))),
                    ]),
                ]),
                h(NButton, { type: 'primary', block: true, loading: saving.value, onClick: save, style: 'margin-top:8px' }, () => editingId.value ? '保存' : '创建'),
            ])),
        ]);
    }
});

// --- Slow Queries ---
const SlowQueriesPage = defineComponent({
    setup() {
        const data = ref({ logs: [], total: 0, page: 1, total_pages: 0 });
        const databases = ref([]);
        const loading = ref(true);
        const filterDB = ref(null);
        const page = ref(1);
        const clearing = ref(false);

        const { connected, messages, stop } = useWebSocket('/ws/slow-queries');
        onUnmounted(stop);

        watch(() => messages.value.length, () => {
            const latest = messages.value[messages.value.length - 1];
            if (latest && latest.type === 'slow_query' && latest.data) {
                if (!filterDB.value || latest.database_id === filterDB.value) {
                    data.value.logs.unshift(latest.data);
                    if (data.value.logs.length > 200) data.value.logs.length = 200;
                    data.value.total++;
                }
            }
            if (messages.value.length > 500) messages.value.splice(0, messages.value.length - 500);
        });

        async function load() {
            loading.value = true;
            try {
                let url = '/api/slow-queries?page=' + page.value;
                if (filterDB.value) url += '&database_id=' + filterDB.value;
                data.value = await api.get(url);
                databases.value = await api.get('/api/databases-simple');
            } catch {}
            loading.value = false;
        }
        onMounted(load);
        watch([page, filterDB], () => load());

        const dbOptions = computed(() => [
            { label: '全部', value: null },
            ...databases.value.map(d => ({ label: d.name, value: d.id }))
        ]);
        const selectedDBName = computed(() => {
            const item = databases.value.find(d => d.id === filterDB.value);
            return item ? item.name : '';
        });

        async function clearSlowLogs() {
            clearing.value = true;
            try {
                let url = '/api/slow-queries';
                if (filterDB.value) url += '?database_id=' + filterDB.value;
                const res = await api.del(url);
                window.$message && window.$message.success('已清空 ' + (res.deleted || 0) + ' 条慢SQL日志');
                page.value = 1;
                data.value = { logs: [], total: 0, page: 1, total_pages: 0 };
                await load();
            } catch (e) {
                window.$message && window.$message.error('清空失败: ' + (e.message || e));
            }
            clearing.value = false;
        }

        const columns = useColumns([
            { title: '检测时间', key: 'detected_at', width: 140, render: row => h(NText, { depth: 3, style: 'font-size:12px' }, () => formatTime(row.detected_at)) },
            { title: '数据库', key: 'database_name', width: 100 },
            { title: '用户@主机', key: 'user', width: 150, _hideOnMobile: true, render: row => h(NText, { depth: 3, style: 'font-size:12px' }, () => (row.user || '') + '@' + (row.host || '')) },
            { title: '库名', key: 'db_name', width: 160, _hideOnMobile: true, ellipsis: { tooltip: true } },
            { title: '耗时', key: 'exec_sec', width: 70, render: row => h(NText, { type: 'error', strong: true }, () => row.exec_sec.toFixed(1) + 's') },
            { title: '锁等待', key: 'lock_sec', width: 70, _hideOnMobile: true, render: row => row.lock_sec.toFixed(1) + 's' },
            { title: '扫描行', key: 'rows_examined', width: 80, _hideOnMobile: true },
            { title: 'SQL', key: 'sql_text', ellipsis: { tooltip: true }, render: row => renderSqlCell(row, _isMobile.value ? 30 : 60) },
            { title: 'KILL', key: 'kill', width: 100, _hideOnMobile: true, render: row => h('code', { style: 'font-family:var(--font-mono);font-size:11px;opacity:0.5' }, 'KILL ' + row.process_id + ';') },
        ]);

        return () => h('div', { class: 'page-body log-page-fit' }, [
            h('div', { class: 'log-page-header', style: _isMobile.value ? 'display:block;margin-bottom:12px' : undefined }, [
                h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:' + (_isMobile.value ? '8px' : '0') }, [
                    h('h3', { class: 'page-title' }, '慢SQL日志'),
                    h(NText, { depth: 3 }, () => '共 ' + data.value.total + ' 条'),
                    h('div', { style: 'display:flex;align-items:center;gap:4px;font-size:12px;opacity:0.5' }, [
                        h('span', { class: connected.value ? 'ws-dot connected' : 'ws-dot disconnected' }),
                        connected.value ? '实时' : '断开'
                    ]),
                ]),
                h('div', { style: _isMobile.value ? 'display:flex;gap:8px;width:100%' : 'display:flex;gap:8px;align-items:center' }, [
                    h(NPopconfirm, { onPositiveClick: clearSlowLogs }, {
                        trigger: () => h(NButton, { size: 'small', secondary: true, type: 'error', loading: clearing.value, disabled: loading.value || data.value.total === 0 }, () => '清空'),
                        default: () => filterDB.value ? '确定清空数据库「' + selectedDBName.value + '」的慢SQL日志？' : '确定清空全部慢SQL日志？'
                    }),
                    h(NSelect, { value: filterDB.value, 'onUpdate:value': v => { filterDB.value = v; page.value = 1; }, options: dbOptions.value, style: _isMobile.value ? 'flex:1;min-width:0' : 'width:180px', placeholder: '筛选数据库', clearable: true, size: 'small' }),
                ]),
            ]),
            h('div', { class: 'log-page-table' }, [
                h(NDataTable, { columns: columns.value, data: data.value.logs || [], bordered: false, size: 'small', loading: loading.value, flexHeight: true, style: 'height:100%', scrollX: _isMobile.value ? 500 : undefined }),
            ]),
            data.value.total_pages > 1 ? h('div', { class: 'log-page-pagination center' }, [
                h(NPagination, { page: page.value, 'onUpdate:page': v => page.value = v, pageCount: data.value.total_pages, size: 'small' }),
            ]) : null,
        ]);
    }
});

// --- Ignored SQL Patterns ---
const IgnoredSQLPage = defineComponent({
    setup() {
        const data = ref([]);
        const databases = ref([]);
        const loading = ref(true);
        const filterDB = ref(null);

        async function load() {
            loading.value = true;
            try {
                let url = '/api/ignored-sql';
                if (filterDB.value) url += '?database_id=' + filterDB.value;
                data.value = await api.get(url);
                databases.value = await api.get('/api/databases-simple');
            } catch {}
            loading.value = false;
        }
        onMounted(load);
        watch(filterDB, () => load());

        const dbOptions = computed(() => [
            { label: '全部', value: null },
            ...databases.value.map(d => ({ label: d.name, value: d.id }))
        ]);

        async function handleDelete(row) {
            try {
                await api.del('/api/ignored-sql/' + row.id);
                window.$message && window.$message.success('已取消忽略');
                load();
            } catch (e) {
                window.$message && window.$message.error('操作失败: ' + (e.message || e));
            }
        }

        const columns = useColumns([
            { title: '数据库', key: 'database_name', width: 120 },
            { title: 'SQL 指纹', key: 'fingerprint', ellipsis: { tooltip: true }, render: row => h('code', { style: 'font-family:var(--font-mono);font-size:11px;opacity:0.7;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px', onClick: () => showSqlDetail({ sql_text: row.fingerprint, database_name: row.database_name }) }, truncate(row.fingerprint, _isMobile.value ? 40 : 80)) },
            { title: '样例SQL', key: 'sample_sql', ellipsis: { tooltip: true }, _hideOnMobile: true, render: row => h('code', { style: 'font-family:var(--font-mono);font-size:11px;opacity:0.5;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px', onClick: () => showSqlDetail({ sql_text: row.sample_sql, database_name: row.database_name }) }, truncate(row.sample_sql, 60)) },
            { title: '添加时间', key: 'created_at', width: 140, _hideOnMobile: true, render: row => formatTime(row.created_at) },
            { title: '操作', key: 'actions', width: 80, render: row => h(NButton, { size: 'tiny', type: 'error', secondary: true, onClick: () => handleDelete(row) }, () => '取消忽略') },
        ]);

        return () => h('div', { class: 'page-body' }, [
            h('div', { style: _isMobile.value ? 'margin-bottom:12px' : 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px' }, [
                h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:' + (_isMobile.value ? '8px' : '0') }, [
                    h('h3', { class: 'page-title' }, '已忽略的SQL'),
                    h(NText, { depth: 3 }, () => '共 ' + (data.value || []).length + ' 条'),
                ]),
                h(NSelect, { value: filterDB.value, 'onUpdate:value': v => { filterDB.value = v; }, options: dbOptions.value, style: _isMobile.value ? 'width:100%' : 'width:180px', placeholder: '筛选数据库', clearable: true, size: 'small' }),
            ]),
            h(NDataTable, { columns: columns.value, data: data.value || [], bordered: false, size: 'small', loading: loading.value, maxHeight: 'calc(100vh - 200px)', scrollX: _isMobile.value ? 500 : undefined }),
        ]);
    }
});

// --- Custom SQL Checks ---

// ============================================================
// 自定义 SQL 预置模板
// 维度 C（数据库深度）与维度 H（配置漂移）不需要新采集器，
// 用 custom_sql 配 SQL 即可覆盖。这里把常用的固化成模板，
// 省去查 performance_schema / information_schema 字段名的功夫。
// ============================================================
const CUSTOM_SQL_TEMPLATES = [
    {
        group: 'C · 数据库深度（InnoDB 与连接）',
        items: [
            {
                name: 'InnoDB 缓冲池命中率 < 99%',
                sql_text: "SELECT ROUND(100 - (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_reads') * 100 / NULLIF((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_read_requests'), 0), 4) AS hit_ratio LIMIT 1",
                result_field: 'hit_ratio',
                condition: 'lt', expected_value: '99', alert_strategy: 'threshold',
                interval_sec: 60,
                message_template: '缓冲池命中率降至 {{value}}%，低于 99% 说明热数据放不下，磁盘读会显著增加',
            },
            {
                name: '缓冲池使用率 > 98%（容量已满）',
                sql_text: "SELECT ROUND((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_pages_data') * 100 / NULLIF((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_pages_total'), 0), 2) AS used_pct LIMIT 1",
                result_field: 'used_pct',
                condition: 'gt', expected_value: '98', alert_strategy: 'sustained', alert_consecutive: 5,
                interval_sec: 60,
                message_template: '缓冲池使用率 {{value}}%，已在持续淘汰页面，考虑扩容 innodb_buffer_pool_size',
            },
            {
                name: '连接数占 max_connections 超 70%',
                sql_text: "SELECT ROUND((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Threads_connected') * 100 / @@max_connections, 2) AS conn_pct LIMIT 1",
                result_field: 'conn_pct',
                condition: 'gt', expected_value: '70', alert_strategy: 'sustained', alert_consecutive: 3,
                interval_sec: 30,
                message_template: '连接数已占 max_connections 的 {{value}}%，接近上限会开始拒绝新连接',
            },
            {
                name: '连接被拒绝数增长（Aborted_connects）',
                sql_text: "SELECT VARIABLE_VALUE AS aborted FROM performance_schema.global_status WHERE VARIABLE_NAME='Aborted_connects' LIMIT 1",
                result_field: 'aborted',
                alert_strategy: 'increase', alert_delta_value: '10',
                interval_sec: 60,
                message_template: '连接被拒绝数增加，可能是达到连接上限或认证失败',
            },
            {
                name: '慢查询计数增长',
                sql_text: "SELECT VARIABLE_VALUE AS slow FROM performance_schema.global_status WHERE VARIABLE_NAME='Slow_queries' LIMIT 1",
                result_field: 'slow',
                alert_strategy: 'increase', alert_delta_value: '20',
                interval_sec: 60,
                message_template: '慢查询数量增长 {{value}}，检查是否有新的低效 SQL 上线',
            },
            {
                name: '行锁等待数增长',
                sql_text: "SELECT VARIABLE_VALUE AS lock_waits FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_row_lock_waits' LIMIT 1",
                result_field: 'lock_waits',
                alert_strategy: 'increase', alert_delta_value: '50',
                interval_sec: 60,
                message_template: '行锁等待增加，可能存在长事务或热点行竞争',
            },
            {
                name: '平均行锁等待时长 > 200ms',
                sql_text: "SELECT VARIABLE_VALUE AS avg_ms FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_row_lock_time_avg' LIMIT 1",
                result_field: 'avg_ms',
                condition: 'gt', expected_value: '200', alert_strategy: 'sustained', alert_consecutive: 3,
                interval_sec: 60,
                message_template: '平均行锁等待 {{value}}ms，事务在互相阻塞',
            },
            {
                name: '正在运行超过 60 秒的事务',
                sql_text: "SELECT COUNT(*) AS long_trx FROM information_schema.innodb_trx WHERE trx_started < NOW() - INTERVAL 60 SECOND",
                result_field: 'long_trx',
                condition: 'gt', expected_value: '0', alert_strategy: 'sustained', alert_consecutive: 2,
                interval_sec: 30,
                message_template: '有 {{value}} 个事务运行超过 60 秒，长事务会阻塞 purge 并撑大 undo',
            },
        ],
    },
    {
        group: 'C · 复制与集群',
        items: [
            {
                name: '组复制在线成员数 < 3',
                sql_text: "SELECT COUNT(*) AS online_members FROM performance_schema.replication_group_members WHERE MEMBER_STATE='ONLINE'",
                result_field: 'online_members',
                condition: 'lt', expected_value: '3', alert_strategy: 'threshold',
                interval_sec: 30,
                message_template: '组复制在线成员仅 {{value}} 个，掉到 2 个以下将失去多数派、集群不可写',
            },
            {
                name: '本节点不是 ONLINE 状态',
                sql_text: "SELECT COUNT(*) AS not_online FROM performance_schema.replication_group_members WHERE MEMBER_ID=@@server_uuid AND MEMBER_STATE<>'ONLINE'",
                result_field: 'not_online',
                condition: 'gt', expected_value: '0', alert_strategy: 'threshold',
                interval_sec: 30,
                message_template: '本节点已脱离组复制集群',
            },
            {
                name: '主从延迟 > 30 秒',
                sql_text: "SELECT IFNULL(MAX(TIMESTAMPDIFF(SECOND, LAST_APPLIED_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP, LAST_APPLIED_TRANSACTION_END_APPLY_TIMESTAMP)), 0) AS lag_sec FROM performance_schema.replication_applier_status_by_worker",
                result_field: 'lag_sec',
                condition: 'gt', expected_value: '30', alert_strategy: 'sustained', alert_consecutive: 3,
                interval_sec: 30,
                message_template: '复制延迟 {{value}} 秒，从库数据落后于主库',
            },
        ],
    },
    {
        group: 'C · 容量与增长',
        items: [
            {
                name: '数据库总容量（GB）',
                sql_text: "SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024 / 1024, 2) AS size_gb FROM information_schema.tables WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')",
                result_field: 'size_gb',
                alert_strategy: 'increase', alert_delta_value: '5',
                interval_sec: 3600,
                message_template: '数据库容量单轮增长超过 5GB，检查是否有异常写入',
            },
            {
                name: 'undo 表空间异常增长',
                sql_text: "SELECT ROUND(SUM(FILE_SIZE) / 1024 / 1024 / 1024, 2) AS undo_gb FROM information_schema.innodb_tablespaces WHERE SPACE_TYPE='Undo'",
                result_field: 'undo_gb',
                condition: 'gt', expected_value: '10', alert_strategy: 'threshold',
                interval_sec: 300,
                message_template: 'undo 表空间已达 {{value}}GB，通常由长事务阻塞 purge 导致',
            },
        ],
    },
    {
        group: 'H · 配置漂移检测',
        items: [
            {
                name: 'innodb_flush_method 偏离 O_DIRECT',
                sql_text: "SELECT CASE WHEN @@innodb_flush_method IN ('O_DIRECT','O_DIRECT_NO_FSYNC') THEN 0 ELSE 1 END AS drift",
                result_field: 'drift',
                condition: 'gt', expected_value: '0', alert_strategy: 'threshold',
                interval_sec: 3600,
                message_template: 'innodb_flush_method 不是 O_DIRECT，会与 InnoDB 缓冲池形成双重缓存、浪费内存',
            },
            {
                name: 'max_connections 被改小到 200 以下',
                sql_text: "SELECT @@max_connections AS max_conn",
                result_field: 'max_conn',
                condition: 'lt', expected_value: '200', alert_strategy: 'threshold',
                interval_sec: 3600,
                message_template: 'max_connections 当前为 {{value}}，低于应用连接池的聚合需求',
            },
            {
                name: 'read_only 被意外打开（主库）',
                sql_text: "SELECT CASE WHEN @@read_only = 1 OR @@super_read_only = 1 THEN 1 ELSE 0 END AS ro",
                result_field: 'ro',
                condition: 'gt', expected_value: '0', alert_strategy: 'threshold',
                interval_sec: 60,
                message_template: '本节点处于只读状态，若它应为主库则写入会全部失败',
            },
            {
                name: 'binlog 或 GTID 被关闭',
                sql_text: "SELECT CASE WHEN @@log_bin = 0 OR @@gtid_mode <> 'ON' THEN 1 ELSE 0 END AS drift",
                result_field: 'drift',
                condition: 'gt', expected_value: '0', alert_strategy: 'threshold',
                interval_sec: 3600,
                message_template: 'binlog 或 GTID 已关闭，组复制与主从复制的前提被破坏',
            },
            {
                name: '慢查询日志未开启',
                sql_text: "SELECT CASE WHEN @@slow_query_log = 1 THEN 0 ELSE 1 END AS drift",
                result_field: 'drift',
                condition: 'gt', expected_value: '0', alert_strategy: 'threshold',
                interval_sec: 3600,
                message_template: '慢查询日志未开启，无法从数据库侧定位慢 SQL',
            },
            {
                name: 'buffer pool 配置被改小',
                sql_text: "SELECT ROUND(@@innodb_buffer_pool_size / 1024 / 1024 / 1024, 2) AS pool_gb",
                result_field: 'pool_gb',
                condition: 'lt', expected_value: '8', alert_strategy: 'threshold',
                interval_sec: 3600,
                message_template: 'innodb_buffer_pool_size 当前 {{value}}GB，低于预期配置',
            },
        ],
    },
    {
        group: 'C · 权限与错误（排查用）',
        items: [
            {
                name: '账号可访问的 schema 数量',
                sql_text: "SELECT COUNT(DISTINCT table_schema) AS visible_schemas FROM information_schema.tables WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')",
                result_field: 'visible_schemas',
                condition: 'lt', expected_value: '10', alert_strategy: 'threshold',
                interval_sec: 3600,
                message_template: '当前账号只能看到 {{value}} 个业务库，可能存在授权缺失',
            },
            {
                name: '当前活跃连接数',
                sql_text: "SELECT COUNT(*) AS active FROM information_schema.processlist WHERE command <> 'Sleep'",
                result_field: 'active',
                condition: 'gt', expected_value: '50', alert_strategy: 'sustained', alert_consecutive: 3,
                interval_sec: 30,
                message_template: '活跃连接 {{value}} 个，可能有查询堆积',
            },
        ],
    },
];

const CustomSQLPage = defineComponent({
    setup() {
        const checks = ref([]);
        const databases = ref([]);
        const loading = ref(true);
        const showModal = ref(false);
        const editingId = ref(null);
        const saving = ref(false);
        const importing = ref(false);
        const importInputRef = ref(null);
        const form = reactive({
            database_id: null,
            name: '',
            db_name: '',
            sql_text: '',
            result_field: '',
            interval_sec: 30,
            timeout_sec: 10,
            alert_strategy: 'threshold',
            condition: 'gt',
            expected_value: '0',
            alert_delta_value: '',
            alert_delta_percent: '',
            alert_consecutive: 1,
            alert_rules: [],
            trigger_actions: [],
            notify_enabled: true,
            recovery_notify: true,
            message_template: '',
            diag_sql: '',
            diag_url: '',
        });
        const message = useMessage();

        const conditionOptions = [
            { label: '> 数值大于', value: 'gt' },
            { label: '>= 数值大于等于', value: 'gte' },
            { label: '< 数值小于', value: 'lt' },
            { label: '<= 数值小于等于', value: 'lte' },
            { label: '== 等于', value: 'eq' },
            { label: '!= 不等于', value: 'ne' },
            { label: '包含文本', value: 'contains' },
            { label: '不包含文本', value: 'not_contains' },
            { label: '为空', value: 'empty' },
            { label: '不为空', value: 'not_empty' },
            { label: '发生变化', value: 'changed' },
            { label: '每次都上报', value: 'always' },
        ];
        const conditionLabels = Object.fromEntries(conditionOptions.map(o => [o.value, o.label]));
        const strategyOptions = [
            { label: '单次阈值', value: 'threshold' },
            { label: '连续命中阈值', value: 'sustained' },
            { label: '突增', value: 'increase' },
            { label: '连续上升', value: 'continuous_increase' },
        ];
        const triggerActionTypeOptions = [
            { label: '命令', value: 'command' },
            { label: 'HTTP', value: 'http' },
        ];
        const triggerHTTPMethodOptions = [
            { label: 'GET', value: 'GET' },
            { label: 'POST', value: 'POST' },
            { label: 'PUT', value: 'PUT' },
            { label: 'HEAD', value: 'HEAD' },
        ];
        const strategyLabels = Object.fromEntries(strategyOptions.map(o => [o.value, o.label]));
        const ruleNeedsExpected = rule => !['empty', 'not_empty', 'changed', 'always'].includes(rule.condition);
        const ruleUsesDelta = rule => rule.alert_strategy === 'increase';
        const ruleUsesConsecutive = rule => ['sustained', 'continuous_increase'].includes(rule.alert_strategy);

        async function load() {
            loading.value = true;
            try {
                checks.value = await api.get('/api/custom-sql');
                databases.value = await api.get('/api/databases-simple');
            } catch {}
            loading.value = false;
        }
        onMounted(load);

        const dbOptions = computed(() => databases.value.map(d => ({ label: d.name, value: d.id })));
        const gridCols = computed(() => _isMobile.value ? 1 : 2);

        function resetForm() {
            Object.assign(form, {
                database_id: databases.value[0] ? databases.value[0].id : null,
                name: '',
                db_name: '',
                sql_text: 'SELECT COUNT(*) AS process_count FROM information_schema.PROCESSLIST',
                result_field: '',
                interval_sec: 30,
                timeout_sec: 10,
                alert_strategy: 'threshold',
                condition: 'gt',
                expected_value: '0',
                alert_delta_value: '',
                alert_delta_percent: '',
                alert_consecutive: 1,
                alert_rules: [],
                trigger_actions: [],
                notify_enabled: true,
                recovery_notify: true,
                message_template: '',
                diag_sql: '',
            diag_url: '',
            });
        }
        function openAdd() {
            editingId.value = null;
            resetForm();
            showModal.value = true;
        }
        function openEdit(row) {
            editingId.value = row.id;
            const rules = parseCustomSQLAlertRules(row.alert_rules, row);
            Object.assign(form, {
                database_id: row.database_id,
                name: row.name,
                db_name: row.db_name || '',
                sql_text: row.sql_text,
                result_field: row.result_field || '',
                interval_sec: row.interval_sec,
                timeout_sec: row.timeout_sec,
                alert_strategy: row.alert_strategy || 'threshold',
                condition: row.condition || 'gt',
                expected_value: row.expected_value || '',
                alert_delta_value: row.alert_delta_value || '',
                alert_delta_percent: row.alert_delta_percent || '',
                alert_consecutive: row.alert_consecutive || 1,
                alert_rules: rules,
                trigger_actions: parseCustomSQLTriggerActions(row.trigger_actions),
                notify_enabled: row.notify_enabled !== false,
                recovery_notify: row.recovery_notify !== false,
                message_template: row.message_template || '',
                diag_sql: row.diag_sql || '',
            });
            showModal.value = true;
        }
        function openClone(row) {
            editingId.value = null;
            openEdit(row);
            editingId.value = null;
            form.name = row.name + ' (副本)';
        }
        async function save() {
            saving.value = true;
            try {
                const payload = customSQLPayload();
                if (editingId.value) {
                    await api.put('/api/custom-sql/' + editingId.value, payload);
                    message.success('更新成功');
                } else {
                    await api.post('/api/custom-sql', payload);
                    message.success('创建成功');
                }
                showModal.value = false;
                await load();
            } catch (e) {
                message.error(e.message);
            }
            saving.value = false;
        }
        function normalizeCustomSQLAlertRule(rule = {}) {
            const strategy = rule.alert_strategy || rule.strategy || 'threshold';
            const expectedValue = rule.expected_value || rule.value || rule.alert_value || '';
            const deltaValue = rule.alert_delta_value || rule.delta_value || '';
            const deltaPercent = rule.alert_delta_percent || rule.delta_percent || '';
            const consecutive = rule.alert_consecutive || rule.consecutive || 1;
            return {
                name: rule.name || '',
                result_field: rule.result_field || rule.field || '',
                alert_strategy: strategy,
                strategy,
                condition: rule.condition || rule.alert_condition || 'gt',
                expected_value: expectedValue,
                value: expectedValue,
                alert_delta_value: deltaValue,
                delta_value: deltaValue,
                alert_delta_percent: deltaPercent,
                delta_percent: deltaPercent,
                alert_consecutive: consecutive,
                consecutive,
            };
        }
        function parseCustomSQLAlertRules(raw, row) {
            let parsed = [];
            if (Array.isArray(raw)) parsed = raw;
            else {
                try {
                    const value = JSON.parse(raw || '[]');
                    parsed = Array.isArray(value) ? value : [];
                } catch { parsed = []; }
            }
            parsed = parsed.map(normalizeCustomSQLAlertRule);
            if (parsed.length === 0 && row) {
                parsed.push(normalizeCustomSQLAlertRule({
                    name: row.result_field || '第一列',
                    result_field: row.result_field || '',
                    alert_strategy: row.alert_strategy || 'threshold',
                    condition: row.condition || 'gt',
                    expected_value: row.expected_value || '',
                    alert_delta_value: row.alert_delta_value || '',
                    alert_delta_percent: row.alert_delta_percent || '',
                    alert_consecutive: row.alert_consecutive || 1,
                }));
            }
            return parsed;
        }
        function normalizeCustomSQLTriggerAction(action = {}) {
            return {
                name: action.name || '',
                type: action.type || 'command',
                command: action.command || '',
                url: action.url || '',
                method: action.method || 'GET',
                headers_json: action.headers_json || '{}',
                body: action.body || '',
                timeout_sec: action.timeout_sec || 30,
                notify_max_chars: action.notify_max_chars || 2000,
                enabled: action.enabled !== false,
            };
        }
        function parseCustomSQLTriggerActions(raw) {
            if (Array.isArray(raw)) return raw.map(normalizeCustomSQLTriggerAction);
            try {
                const parsed = JSON.parse(raw || '[]');
                return Array.isArray(parsed) ? parsed.map(normalizeCustomSQLTriggerAction) : [];
            } catch { return []; }
        }
        function customSQLPayload() {
            const actions = (form.trigger_actions || []).map(normalizeCustomSQLTriggerAction).filter(a =>
                a.name || a.command || a.url
            );
            const rules = (form.alert_rules || []).map(normalizeCustomSQLAlertRule);
            const firstRule = rules[0] || normalizeCustomSQLAlertRule({
                result_field: form.result_field,
                alert_strategy: form.alert_strategy,
                condition: form.condition,
                expected_value: form.expected_value,
                alert_delta_value: form.alert_delta_value,
                alert_delta_percent: form.alert_delta_percent,
                alert_consecutive: form.alert_consecutive,
            });
            return {
                ...form,
                alert_rules: JSON.stringify(rules),
                result_field: firstRule.result_field || '',
                alert_strategy: firstRule.alert_strategy || 'threshold',
                condition: firstRule.condition || 'gt',
                expected_value: firstRule.expected_value || '',
                alert_delta_value: firstRule.alert_delta_value || '',
                alert_delta_percent: firstRule.alert_delta_percent || '',
                alert_consecutive: firstRule.alert_consecutive || 1,
                trigger_actions: JSON.stringify(actions),
                notify_enabled: !!form.notify_enabled,
                recovery_notify: !!form.recovery_notify,
                message_template: form.message_template || '',
                diag_url: form.diag_url || '',
            };
        }
        function customSQLExportItem(row) {
            return {
                database_name: row.database_name || '',
                database_id: row.database_id || null,
                name: row.name || '',
                db_name: row.db_name || '',
                sql_text: row.sql_text || '',
                result_field: row.result_field || '',
                interval_sec: row.interval_sec || 30,
                timeout_sec: row.timeout_sec || 10,
                alert_strategy: row.alert_strategy || 'threshold',
                condition: row.condition || 'gt',
                expected_value: row.expected_value || '',
                alert_delta_value: row.alert_delta_value || '',
                alert_delta_percent: row.alert_delta_percent || '',
                alert_consecutive: row.alert_consecutive || 1,
                alert_rules: row.alert_rules || '[]',
                trigger_actions: row.trigger_actions || '[]',
                notify_enabled: row.notify_enabled !== false,
                recovery_notify: row.recovery_notify !== false,
                message_template: row.message_template || '',
                enabled: row.enabled !== false,
            };
        }
        function exportCustomSQLChecks() {
            if (!checks.value.length) {
                message.warning('没有可导出的自定义 SQL 监控');
                return;
            }
            const payload = {
                type: 'ops-sentinel.custom_sql_checks',
                version: 1,
                exported_at: new Date().toISOString(),
                items: checks.value.map(customSQLExportItem),
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'ops-sentinel-custom-sql-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            message.success('已导出 ' + checks.value.length + ' 条配置');
        }
        function triggerImportCustomSQL() {
            if (importInputRef.value) importInputRef.value.click();
        }
        function parseCustomSQLImportItems(raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
            if (Array.isArray(parsed.items)) return parsed.items;
            if (Array.isArray(parsed.custom_sql_checks)) return parsed.custom_sql_checks;
            throw new Error('导入文件格式不正确');
        }
        function resolveImportDatabaseID(item) {
            const dbs = databases.value || [];
            const byName = item.database_name ? dbs.find(d => d.name === item.database_name) : null;
            if (byName) return byName.id;
            const byID = item.database_id ? dbs.find(d => d.id === item.database_id) : null;
            if (byID) return byID.id;
            if (dbs.length === 1) return dbs[0].id;
            throw new Error('找不到数据库连接: ' + (item.database_name || item.database_id || item.name || '未指定'));
        }
        function importCustomSQLPayload(item) {
            let alertRules = item.alert_rules;
            if (Array.isArray(alertRules)) alertRules = JSON.stringify(alertRules.map(normalizeCustomSQLAlertRule));
            if (typeof alertRules !== 'string') alertRules = '[]';
            let triggerActions = item.trigger_actions;
            if (Array.isArray(triggerActions)) triggerActions = JSON.stringify(triggerActions.map(normalizeCustomSQLTriggerAction));
            if (typeof triggerActions !== 'string') triggerActions = '[]';
            const rules = parseCustomSQLAlertRules(alertRules, item);
            const firstRule = rules[0] || normalizeCustomSQLAlertRule(item);
            return {
                database_id: resolveImportDatabaseID(item),
                name: item.name || '导入的自定义SQL',
                db_name: item.db_name || '',
                sql_text: item.sql_text || '',
                result_field: item.result_field || firstRule.result_field || '',
                interval_sec: item.interval_sec || 30,
                timeout_sec: item.timeout_sec || 10,
                alert_strategy: item.alert_strategy || firstRule.alert_strategy || 'threshold',
                condition: item.condition || firstRule.condition || 'gt',
                expected_value: item.expected_value || firstRule.expected_value || '',
                alert_delta_value: item.alert_delta_value || firstRule.alert_delta_value || '',
                alert_delta_percent: item.alert_delta_percent || firstRule.alert_delta_percent || '',
                alert_consecutive: item.alert_consecutive || firstRule.alert_consecutive || 1,
                alert_rules: JSON.stringify(rules),
                trigger_actions: JSON.stringify(parseCustomSQLTriggerActions(triggerActions)),
                notify_enabled: item.notify_enabled !== false,
                recovery_notify: item.recovery_notify !== false,
                message_template: item.message_template || '',
            };
        }
        async function importCustomSQLFile(event) {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (!file) return;
            importing.value = true;
            try {
                const text = await file.text();
                const items = parseCustomSQLImportItems(text);
                if (!items.length) {
                    message.warning('导入文件里没有配置');
                    return;
                }
                let ok = 0;
                const failures = [];
                for (const item of items) {
                    try {
                        const payload = importCustomSQLPayload(item);
                        const created = await api.post('/api/custom-sql', payload);
                        if (item.enabled === false && created && created.id) {
                            await api.post('/api/custom-sql/' + created.id + '/toggle');
                        }
                        ok++;
                    } catch (e) {
                        failures.push((item && item.name ? item.name : '未命名配置') + ': ' + (e.message || e));
                    }
                }
                await load();
                if (failures.length) {
                    message.warning('导入完成：成功 ' + ok + ' 条，失败 ' + failures.length + ' 条；第一条失败：' + failures[0]);
                } else {
                    message.success('导入成功：' + ok + ' 条');
                }
            } catch (e) {
                message.error(e.message || '导入失败');
            } finally {
                importing.value = false;
            }
        }
        function addCustomSQLAlertRule(rule = {}) {
            form.alert_rules.push(normalizeCustomSQLAlertRule(rule));
        }
        function removeCustomSQLAlertRule(index) {
            form.alert_rules.splice(index, 1);
        }
        function addCustomSQLTriggerAction(type = 'command') {
            form.trigger_actions.push(normalizeCustomSQLTriggerAction({
                name: type === 'http' ? '抓取诊断接口' : '执行诊断命令',
                type,
                timeout_sec: 30,
            }));
        }
        function removeCustomSQLTriggerAction(index) {
            form.trigger_actions.splice(index, 1);
        }
        function formatCustomSQLRule(rule) {
            const normalized = normalizeCustomSQLAlertRule(rule);
            const field = normalized.result_field || '第一列';
            const strategy = strategyLabels[normalized.alert_strategy] || normalized.alert_strategy;
            let text = field + ' / ' + strategy;
            if (normalized.alert_strategy === 'increase') {
                const parts = [];
                if (normalized.alert_delta_value) parts.push('变化量>=' + normalized.alert_delta_value);
                if (normalized.alert_delta_percent) parts.push('变化率>=' + normalized.alert_delta_percent + '%');
                if (normalized.expected_value) parts.push((conditionLabels[normalized.condition] || normalized.condition) + ' ' + normalized.expected_value);
                return text + ' / ' + (parts.join('，') || '比上次上升');
            }
            if (normalized.alert_strategy === 'continuous_increase') {
                text += ' / 连续 ' + (normalized.alert_consecutive || 1) + ' 次';
                if (normalized.expected_value) text += ' / ' + (conditionLabels[normalized.condition] || normalized.condition) + ' ' + normalized.expected_value;
                return text;
            }
            text += ' / ' + (conditionLabels[normalized.condition] || normalized.condition);
            if (normalized.expected_value) text += ' ' + normalized.expected_value;
            if (normalized.alert_strategy === 'sustained') text += ' / 连续 ' + (normalized.alert_consecutive || 1) + ' 次';
            return text;
        }
        function customSQLTriggerActionFields() {
            return h(NFormItem, { label: '触发操作' }, () => h('div', { style: 'width:100%;display:flex;flex-direction:column;gap:10px' }, [
                h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
                    h(NButton, { size: 'small', secondary: true, onClick: () => addCustomSQLTriggerAction('command') }, () => '+ 命令'),
                    h(NButton, { size: 'small', secondary: true, onClick: () => addCustomSQLTriggerAction('http') }, () => '+ HTTP'),
                ]),
                (form.trigger_actions || []).length === 0 ? h(NText, { depth: 3, style: 'font-size:12px' }, () => '异常首次命中时执行；恢复后再次异常会重新执行。') : null,
                ...(form.trigger_actions || []).map((action, index) => h('div', { style: 'border:1px solid rgba(128,128,128,.22);border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:8px' }, [
                    h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap' }, [
                        h('div', { style: _isMobile.value ? 'display:flex;flex-direction:column;gap:8px;flex:1 1 100%;min-width:0' : 'display:grid;grid-template-columns:minmax(150px,1fr) 132px 118px 150px;gap:8px;align-items:end;flex:1 1 auto;min-width:0' }, [
                            h(NInput, { value: action.name, 'onUpdate:value': v => action.name = v, placeholder: '动作名称' }),
                            h(NSelect, { value: action.type, 'onUpdate:value': v => action.type = v, options: triggerActionTypeOptions }),
                            h('div', { style: 'display:flex;flex-direction:column;gap:4px;min-width:0' }, [
                                h(NText, { depth: 3, style: 'font-size:12px;line-height:1' }, () => '超时(秒)'),
                                h(NInputNumber, { value: action.timeout_sec, 'onUpdate:value': v => action.timeout_sec = v, min: 1, max: 300, style: 'width:100%' }),
                            ]),
                            h('div', { style: 'display:flex;flex-direction:column;gap:4px;min-width:0' }, [
                                h(NText, { depth: 3, style: 'font-size:12px;line-height:1' }, () => '通知截断字数'),
                                h(NInputNumber, { value: action.notify_max_chars, 'onUpdate:value': v => action.notify_max_chars = v, min: 100, max: 50000, step: 100, style: 'width:100%' }),
                            ]),
                        ]),
                        h('div', { style: 'display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:0 0 auto;padding-bottom:2px' }, [
                            h(NSwitch, { value: action.enabled !== false, 'onUpdate:value': v => action.enabled = v, size: 'small' }),
                            h(NButton, { size: 'tiny', secondary: true, type: 'error', onClick: () => removeCustomSQLTriggerAction(index) }, () => '删除'),
                        ]),
                    ]),
                    action.type === 'http' ? h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, [
                        h(NInputGroup, null, () => [
                            h(NSelect, { value: action.method || 'GET', 'onUpdate:value': v => action.method = v, options: triggerHTTPMethodOptions, style: 'width:110px' }),
                            h(NInput, { value: action.url, 'onUpdate:value': v => action.url = v, placeholder: 'http://host/path' }),
                        ]),
                        h(NInput, { type: 'textarea', value: action.headers_json || '{}', 'onUpdate:value': v => action.headers_json = v, placeholder: '请求头 JSON', rows: 2 }),
                        action.method !== 'GET' && action.method !== 'HEAD' ? h(NInput, { type: 'textarea', value: action.body || '', 'onUpdate:value': v => action.body = v, placeholder: '请求体', rows: 2 }) : null,
                    ]) : h(NInput, { type: 'textarea', value: action.command, 'onUpdate:value': v => action.command = v, placeholder: '如: mysql -h host -e "SHOW ENGINE INNODB STATUS\\\\G"', rows: 3 }),
                ])),
            ]));
        }
        async function toggle(row) {
            try { await api.post('/api/custom-sql/' + row.id + '/toggle'); await load(); } catch (e) { message.error(e.message); }
        }
        async function del(row) {
            try { await api.del('/api/custom-sql/' + row.id); message.success('已删除'); await load(); } catch (e) { message.error(e.message); }
        }
        async function test(row) {
            try {
                const res = await api.post('/api/custom-sql/' + row.id + '/test');
                if (res.status === 'error') message.error(res.error || res.message);
                else message.success('当前值: ' + (res.value || '') + '，状态: ' + res.status);
            } catch (e) { message.error(e.message); }
        }

        const columns = useColumns([
            { title: '名称', key: 'name', width: 180, ellipsis: { tooltip: true }, render: row => h(NText, { strong: true, style: 'display:block;white-space:normal;word-break:break-word;line-height:1.35' }, () => row.name) },
            { title: '数据库', key: 'database_name', width: 120, _hideOnMobile: true },
            { title: '执行库', key: 'db_name', width: 150, _hideOnMobile: true, ellipsis: { tooltip: true }, render: row => row.db_name || 'performance_schema' },
            { title: '规则', key: 'alert_rules', width: 280, _hideOnMobile: true, render: row => {
                const rules = parseCustomSQLAlertRules(row.alert_rules, row);
                if (rules.length > 1) return h(NText, { depth: 3, style: 'font-size:12px;line-height:1.35;white-space:normal' }, () => rules.length + ' 条: ' + rules.map(r => r.name || r.result_field || '第一列').join(' / '));
                return h(NText, { depth: 3, style: 'font-size:12px;line-height:1.35;white-space:normal' }, () => formatCustomSQLRule(rules[0] || row));
            } },
            { title: '触发', key: 'trigger_actions', width: 80, _hideOnMobile: true, render: row => {
                const actions = parseCustomSQLTriggerActions(row.trigger_actions);
                return actions.length ? h(NTag, { size: 'small', type: 'warning', bordered: false }, () => actions.length + ' 个') : h(NText, { depth: 3 }, () => '-');
            } },
            { title: 'SQL', key: 'sql_text', width: 360, ellipsis: { tooltip: true }, render: row => h('code', { style: 'font-family:var(--font-mono);font-size:11px;opacity:0.7;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;white-space:nowrap', onClick: () => showSqlDetail({ sql_text: row.sql_text, database_name: row.database_name }) }, truncate(row.sql_text, _isMobile.value ? 36 : 90)) },
            { title: '状态', key: 'status', width: 90, render: row => row.running ? h(NTag, { type: 'success', size: 'small' }, () => '运行中') : row.enabled ? h(NTag, { type: 'warning', size: 'small' }, () => '已启用') : h(NTag, { size: 'small' }, () => '已禁用') },
            { title: '操作', key: 'actions', width: _isMobile.value ? 160 : 330, fixed: _isMobile.value ? undefined : 'right', render: row => h(NSpace, { size: 'small', wrap: false }, () => [
                h(NButton, { size: 'small', secondary: true, onClick: () => toggle(row) }, () => row.enabled ? '禁用' : '启用'),
                h(NButton, { size: 'small', secondary: true, onClick: () => openEdit(row) }, () => '编辑'),
                !_isMobile.value ? h(NButton, { size: 'small', secondary: true, onClick: () => openClone(row) }, () => '复制') : null,
                !_isMobile.value ? h(NButton, { size: 'small', secondary: true, onClick: () => test(row) }, () => '测试') : null,
                h(NPopconfirm, { onPositiveClick: () => del(row) }, { trigger: () => h(NButton, { size: 'small', secondary: true, type: 'error' }, () => '删除'), default: () => '确定删除？' }),
            ].filter(Boolean)) },
        ]);

        // 套用预置模板：只填规则内容，数据库连接仍由用户选
        const sqlTemplateOptions = CUSTOM_SQL_TEMPLATES.map(g => ({
            type: 'group', label: g.group, key: g.group,
            children: g.items.map((it, i) => ({ label: it.name, key: g.group + '::' + i })),
        }));
        function applySQLTemplate(key) {
            const sep = key.lastIndexOf('::');
            const g = CUSTOM_SQL_TEMPLATES.find(x => x.group === key.slice(0, sep));
            const tpl = g && g.items[Number(key.slice(sep + 2))];
            if (!tpl) return;
            form.name = tpl.name;
            form.sql_text = tpl.sql_text;
            form.result_field = tpl.result_field || '';
            form.interval_sec = tpl.interval_sec || 60;
            form.alert_strategy = tpl.alert_strategy || 'threshold';
            form.condition = tpl.condition || 'gt';
            form.expected_value = tpl.expected_value || '';
            form.alert_delta_value = tpl.alert_delta_value || '';
            form.alert_delta_percent = tpl.alert_delta_percent || '';
            form.alert_consecutive = tpl.alert_consecutive || 1;
            form.message_template = tpl.message_template || '';
            if (Array.isArray(form.alert_rules)) form.alert_rules = [];
            message.success('已套用模板：' + tpl.name);
        }

        return () => h('div', { class: 'page-body' }, [
            h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px' }, [
                h('h3', { class: 'page-title' }, '自定义SQL监控'),
                h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end' }, [
                    h('input', { ref: importInputRef, type: 'file', accept: '.json,application/json', style: 'display:none', onChange: importCustomSQLFile }),
                    h(NButton, { secondary: true, onClick: exportCustomSQLChecks, size: _isMobile.value ? 'small' : 'medium' }, () => '导出'),
                    h(NButton, { secondary: true, loading: importing.value, onClick: triggerImportCustomSQL, size: _isMobile.value ? 'small' : 'medium' }, () => '导入'),
                    h(NButton, { type: 'primary', onClick: openAdd, size: _isMobile.value ? 'small' : 'medium' }, () => '+ 添加'),
                ]),
            ]),
            h(NDataTable, { columns: columns.value, data: checks.value, bordered: false, size: 'small', loading: loading.value, maxHeight: 'calc(100vh - 200px)', scrollX: _isMobile.value ? 620 : 1670 }),
            h(NModal, { show: showModal.value, 'onUpdate:show': v => showModal.value = v, preset: 'card', title: editingId.value ? '编辑自定义SQL' : '添加自定义SQL', style: _isMobile.value ? 'width:95vw' : 'width:1120px;max-width:96vw', segmented: true }, () => h(NForm, { model: form, labelPlacement: _isMobile.value ? 'top' : 'left', labelWidth: _isMobile.value ? undefined : 120 }, [
                h(NGrid, { cols: gridCols.value, xGap: 12 }, () => [
                editingId.value ? null : h(NGi, { span: 2 }, () => h(NFormItem, { label: '预置模板' }, () => h('div', { style: 'width:100%;display:flex;align-items:center;gap:10px' }, [
                    h(NDropdown, { trigger: 'click', options: sqlTemplateOptions, onSelect: applySQLTemplate },
                        () => h(NButton, { size: 'small', secondary: true, type: 'info' }, () => '从模板套用 ▾')),
                    h(NText, { depth: 3, style: 'font-size:12px' }, () => '覆盖数据库深度指标与配置漂移检测，选中后仍需指定数据库连接'),
                ]))),
                    h(NGi, null, () => h(NFormItem, { label: '名称' }, () => h(NInput, { value: form.name, 'onUpdate:value': v => form.name = v, placeholder: '如: 待处理订单数量' }))),
                    h(NGi, null, () => h(NFormItem, { label: '数据库连接' }, () => h(NSelect, { value: form.database_id, 'onUpdate:value': v => form.database_id = v, options: dbOptions.value, placeholder: '选择数据库' }))),
                ]),
                h(NFormItem, { label: '执行库' }, () => h(NInput, { value: form.db_name, 'onUpdate:value': v => form.db_name = v, placeholder: '可选，不填默认 performance_schema；也可以在SQL里写库名.表名' })),
                h(NFormItem, { label: 'SQL' }, () => h('div', { style: 'width:100%;display:flex;flex-direction:column;gap:6px' }, [
                    h(NInput, { value: form.sql_text, 'onUpdate:value': v => form.sql_text = v, type: 'textarea', autosize: { minRows: 4, maxRows: 10 }, placeholder: 'SELECT COUNT(*) AS process_count FROM information_schema.PROCESSLIST' }),
                    h(NText, { depth: 3, style: 'font-size:12px;line-height:1.45' }, () => '只允许查询 SQL。禁止写入/锁表/SLEEP/SELECT *；普通 SELECT 必须带 LIMIT，聚合单行查询如 COUNT/SUM 可不带 LIMIT。'),
                ])),
                h(NGrid, { cols: gridCols.value, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '检查间隔(秒)' }, () => h(NInputNumber, { value: form.interval_sec, 'onUpdate:value': v => form.interval_sec = v, min: 1 }))),
                    h(NGi, null, () => h(NFormItem, { label: '超时(秒)' }, () => h(NInputNumber, { value: form.timeout_sec, 'onUpdate:value': v => form.timeout_sec = v, min: 1 }))),
                ]),
                h(NFormItem, { label: '结果规则' }, () => h('div', { style: 'width:100%;display:flex;flex-direction:column;gap:10px' }, [
                    h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
                        h(NButton, { size: 'small', secondary: true, onClick: () => addCustomSQLAlertRule({ name: '新规则', alert_strategy: 'threshold', condition: 'gt', expected_value: '0' }) }, () => '+ 规则'),
                        h(NText, { depth: 3, style: 'font-size:12px' }, () => 'SQL 返回多列时，可为不同列分别配置告警规则；任意一条命中就会上报。'),
                    ]),
                    (form.alert_rules || []).length === 0 ? h(NText, { depth: 3, style: 'font-size:12px' }, () => '未配置时会按第一列和旧的单规则字段判断。') : null,
                    ...(form.alert_rules || []).map((rule, index) => h('div', { style: 'border:1px solid rgba(128,128,128,.22);border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:8px' }, [
                        h(NGrid, { cols: _isMobile.value ? 1 : 2, xGap: 8, yGap: 8 }, () => [
                            h(NGi, null, () => h(NInput, { value: rule.name, 'onUpdate:value': v => rule.name = v, placeholder: '规则名称，如 连接数异常' })),
                            h(NGi, null, () => h(NInput, { value: rule.result_field, 'onUpdate:value': v => rule.result_field = v, placeholder: '结果字段：列名或序号；不填取第一列' })),
                            h(NGi, null, () => h(NSelect, { value: rule.alert_strategy, 'onUpdate:value': v => rule.alert_strategy = v, options: strategyOptions })),
                            h(NGi, null, () => h(NSelect, { value: rule.condition, 'onUpdate:value': v => rule.condition = v, options: conditionOptions })),
                            ruleNeedsExpected(rule) ? h(NGi, null, () => h(NInput, { value: rule.expected_value, 'onUpdate:value': v => rule.expected_value = v, placeholder: '期望值/阈值，如 3' })) : null,
                            ruleUsesDelta(rule) ? h(NGi, null, () => h(NInput, { value: rule.alert_delta_value, 'onUpdate:value': v => rule.alert_delta_value = v, placeholder: '变化量>=，如 500' })) : null,
                            ruleUsesDelta(rule) ? h(NGi, null, () => h(NInput, { value: rule.alert_delta_percent, 'onUpdate:value': v => rule.alert_delta_percent = v, placeholder: '变化率>=，如 30' })) : null,
                            ruleUsesConsecutive(rule) ? h(NGi, null, () => h(NInputNumber, { value: rule.alert_consecutive, 'onUpdate:value': v => rule.alert_consecutive = v, min: 1, max: 100, style: 'width:100%', placeholder: '连续次数' })) : null,
                        ]),
                        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' }, [
                            h(NText, { depth: 3, style: 'font-size:12px;line-height:1.4' }, () => {
                                if (rule.alert_strategy === 'increase') return '突增：与上一次采样比较，变化量和变化率任一满足即可。';
                                if (rule.alert_strategy === 'continuous_increase') return '连续上升：连续多次比上一次采样更高，可叠加当前值阈值。';
                                if (rule.alert_strategy === 'sustained') return '连续命中阈值：连续多次满足条件才告警。';
                                return '单次阈值：本次满足条件即告警。';
                            }),
                            h(NButton, { size: 'tiny', secondary: true, type: 'error', onClick: () => removeCustomSQLAlertRule(index) }, () => '删除'),
                        ]),
                    ])),
                ])),
                customSQLTriggerActionFields(),
                h(NFormItem, { label: '通知' }, () => h(NGrid, { cols: _isMobile.value ? 1 : 2, xGap: 12, yGap: 8, style: 'width:100%' }, () => [
                    h(NGi, null, () => h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid rgba(128,128,128,.18);border-radius:6px;padding:10px 12px' }, [
                        h('div', null, [
                            h(NText, null, () => '命中后通知'),
                            h(NText, { depth: 3, style: 'display:block;font-size:12px;line-height:1.35;margin-top:2px' }, () => '异常首次命中时发送，未恢复前不重复刷屏。'),
                        ]),
                        h(NSwitch, { value: form.notify_enabled, 'onUpdate:value': v => form.notify_enabled = v }),
                    ])),
                    h(NGi, null, () => h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid rgba(128,128,128,.18);border-radius:6px;padding:10px 12px' }, [
                        h('div', null, [
                            h(NText, null, () => '恢复通知'),
                            h(NText, { depth: 3, style: 'display:block;font-size:12px;line-height:1.35;margin-top:2px' }, () => '告警恢复正常后发送恢复消息。'),
                        ]),
                        h(NSwitch, { value: form.recovery_notify, disabled: !form.notify_enabled, 'onUpdate:value': v => form.recovery_notify = v }),
                    ])),
                ])),
                h(NButton, { type: 'primary', block: true, loading: saving.value, onClick: save, style: 'margin-top:8px' }, () => editingId.value ? '保存' : '创建'),
            ])),
        ]);
    }
});

// --- Custom SQL Logs ---
const CustomSQLLogsPage = defineComponent({
    setup() {
        // 「SQL流水」合并视图：自定义 SQL 结果 + 慢查询一张表按时间归并
        const data = ref({ data: [], total: 0, page: 1, total_pages: 0 });
        const dbs = ref([]);
        const loading = ref(true);
        const filterDB = ref(null);
        const page = ref(1);
        const clearing = ref(false);
        const message = useMessage();

        const { connected, messages, stop } = useWebSocket('/ws/custom-sql-logs');
        onUnmounted(stop);
        // WS 只当"有新数据"的信号用：第 1 页时节流重拉，避免两种行结构手工拼装
        let reloadTimer = null;
        watch(() => messages.value.length, () => {
            if (page.value !== 1 || reloadTimer) return;
            reloadTimer = setTimeout(() => { reloadTimer = null; load(); }, 2000);
        });

        async function load() {
            loading.value = true;
            try {
                let url = '/api/sql-stream?page=' + page.value;
                if (filterDB.value) url += '&db_id=' + filterDB.value;
                data.value = await api.get(url);
                dbs.value = await api.get('/api/databases') || [];
            } catch {}
            loading.value = false;
        }
        onMounted(load);
        watch([page, filterDB], () => load());

        const dbOptions = computed(() => [
            { label: '全部数据库', value: null },
            ...dbs.value.map(d => ({ label: d.name, value: d.id })),
        ]);

        async function clearAll() {
            clearing.value = true;
            try {
                const r1 = await api.del('/api/custom-sql/logs');
                let n = r1.deleted || 0;
                try { const r2 = await api.del('/api/slow-queries'); n += r2.deleted || 0; } catch {}
                message.success('已清空 ' + n + ' 条流水');
                page.value = 1;
                await load();
            } catch (e) { message.error(e.message); }
            clearing.value = false;
        }

        const columns = useColumns([
            { title: '检测时间', key: 'detected_at', width: 130, render: row => h(NText, { depth: 3, style: 'font-size:12px' }, () => formatTime(row.detected_at)) },
            { title: '类型', key: 'kind', width: 70, render: row => row.kind === 'slow'
                ? h(NTag, { type: 'warning', size: 'small', bordered: false }, () => '慢SQL')
                : h(NTag, { size: 'small', bordered: false }, () => '结果') },
            { title: '数据库', key: 'database_name', width: 170, ellipsis: { tooltip: true }, _hideOnMobile: true },
            // 内容主体：结果行是规则名（去掉与数据库重复的前缀），慢SQL行是 SQL 文本
            { title: '规则 / SQL', key: 'title', width: 320, ellipsis: { tooltip: true }, render: row => {
                if (row.kind === 'slow') return h('code', { style: 'font-family:var(--font-mono);font-size:11.5px' }, row.title);
                const n = row.title || '';
                const db = row.database_name || '';
                return db && n.startsWith(db + ' · ') ? n.slice(db.length + 3) : n;
            } },
            { title: '状态', key: 'status', width: 80, render: row =>
                row.status === 'alert' ? h(NTag, { type: 'error', size: 'small' }, () => '告警')
                : row.status === 'error' ? h(NTag, { type: 'warning', size: 'small' }, () => '错误')
                : row.status === 'slow' ? h(NTag, { type: 'warning', size: 'small' }, () => '慢')
                : h(NTag, { type: 'success', size: 'small' }, () => '正常') },
            { title: '值 / 来源', key: 'value', width: 260, render: row => h('code', { style: 'font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;word-break:break-word;line-height:1.55' }, String(row.value || '').replace(/;\s*/g, ';\n')) },
            { title: '结果', key: 'message', ellipsis: { tooltip: true }, render: row => row.message },
            { title: '耗时', key: 'duration_ms', width: 90, _hideOnMobile: true, render: row =>
                row.kind === 'slow' ? h('span', { style: 'color:#f0a020;font-weight:600' }, row.exec_sec.toFixed(1) + 's') : row.duration_ms + 'ms' },
        ]);

        return () => h('div', { class: 'page-body log-page-fit' }, [
            h('div', { class: 'log-page-header', style: _isMobile.value ? 'display:block;margin-bottom:12px' : undefined }, [
                h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:' + (_isMobile.value ? '8px' : '0') }, [
                    h('h3', { class: 'page-title' }, 'SQL流水'),
                    h(NText, { depth: 3 }, () => '共 ' + data.value.total + ' 条'),
                    h('div', { style: 'display:flex;align-items:center;gap:4px;font-size:12px;opacity:0.5' }, [
                        h('span', { class: connected.value ? 'ws-dot connected' : 'ws-dot disconnected' }),
                        connected.value ? '实时' : '断开'
                    ]),
                ]),
                h('div', { style: _isMobile.value ? 'display:flex;gap:8px;width:100%' : 'display:flex;gap:8px;align-items:center' }, [
                    h(NPopconfirm, { onPositiveClick: clearAll }, {
                        trigger: () => h(NButton, { size: 'small', secondary: true, type: 'error', loading: clearing.value, disabled: loading.value || data.value.total === 0 }, () => '清空'),
                        default: () => '确定清空全部 SQL 流水（结果 + 慢SQL）？'
                    }),
                    h(NSelect, { value: filterDB.value, 'onUpdate:value': v => { filterDB.value = v; page.value = 1; }, options: dbOptions.value, style: _isMobile.value ? 'flex:1;min-width:0' : 'width:200px', placeholder: '筛选数据库', clearable: true, size: 'small' }),
                ]),
            ]),
            h('div', { class: 'log-page-table' }, [
                h(NDataTable, { columns: columns.value, data: data.value.data || [], bordered: false, size: 'small', loading: loading.value, flexHeight: true, style: 'height:100%', scrollX: _isMobile.value ? 620 : undefined }),
            ]),
            data.value.total_pages > 1 ? h('div', { class: 'log-page-pagination center' }, [
                h(NPagination, { page: page.value, 'onUpdate:page': v => page.value = v, pageCount: data.value.total_pages, size: 'small' }),
            ]) : null,
        ]);
    }
});

// --- Cloud Logging ---
const CloudLoggingPage = defineComponent({
    setup() {
        const route = VueRouter.useRoute();
        const configs = ref([]);
        const checks = ref([]);
        const alertLogs = ref([]);
        const alertTotal = ref(0);
        const alertPage = ref(1);
        const pageSize = 50;
        const loading = ref(true);
        const queryLoading = ref(false);
        const queryEntries = ref([]);
        const effectiveFilter = ref('');
        const queryStats = ref(null);
        const showQueryFilterEditor = ref(false);
        const showEffectiveFilterPanel = ref(false);
        const showEntryDetail = ref(false);
        const entryDetail = ref(null);
        const showAlertLogDetail = ref(false);
        const alertLogDetail = ref(null);
        const showConfigModal = ref(false);
        const showCheckModal = ref(false);
        const editingConfigId = ref(null);
        const editingCheckId = ref(null);
        const configForm = reactive({ name: '', project_id: '', resource_names: '', credentials_file: '', default_filter: '', interval_sec: 60, enabled: true });
        const checkForm = reactive({ config_id: null, name: '', filter: 'severity>=ERROR', content_keyword: '', exclude_keyword: '', metric_type: 'count', lookback_minutes: 5, threshold_count: 0, interval_sec: 60, notify_enabled: true, recovery_notify: true, enabled: true });
        const queryForm = reactive({ config_id: null, filter: 'severity>=ERROR', content_keyword: '', exclude_keyword: '', lookback_minutes: 30, limit: 50 });
        const queryDimensionKeys = ref([]);
        const queryPresetKey = ref('error');
        const checkDimensionKeys = ref([]);
        const checkPresetKey = ref('');
        const saving = ref(false);
        const message = useMessage();
        const { connected, messages, stop } = useWebSocket('/ws/cloud-logging-logs');
        onUnmounted(stop);

        async function load() {
            loading.value = true;
            try {
                configs.value = await api.get('/api/cloud-logging/configs');
                checks.value = await api.get('/api/cloud-logging/checks');
                if (!queryForm.config_id && configs.value.length) queryForm.config_id = configs.value[0].id;
                if (!checkForm.config_id && configs.value.length) checkForm.config_id = configs.value[0].id;
                await loadAlertLogs();
            } catch (e) {
                message.error(e.message || '加载失败');
            }
            loading.value = false;
        }
        async function loadAlertLogs() {
            const res = await api.get('/api/cloud-logging/logs?page=' + alertPage.value);
            alertLogs.value = res.data || [];
            alertTotal.value = res.total || 0;
        }
        onMounted(load);
        watch(alertPage, loadAlertLogs);
        watch(() => messages.value.length, () => {
            const latest = messages.value[messages.value.length - 1];
            if (latest && ['cloud_logging_alert', 'cloud_logging_recovery', 'cloud_logging_error'].includes(latest.type) && alertPage.value === 1) {
                loadAlertLogs();
            }
        });

        const configOptions = computed(() => configs.value.map(c => ({ label: c.name + (c.project_id ? ' (' + c.project_id + ')' : ''), value: c.id })));
        const cloudMetricOptions = [
            { label: '日志数量', value: 'count' },
            { label: '最大并发', value: 'peak_concurrency' },
        ];
        const cloudLogDimensions = [
            {
                key: 'api_requests',
                label: '接口请求',
                name: 'HTTP 接口请求',
                filter: `(
  resource.type="http_load_balancer"
  OR logName:"requests"
)`,
            },
            {
                key: 'nginx',
                label: 'Nginx',
                name: 'Nginx / 负载均衡日志',
                filter: `(
  resource.type="http_load_balancer"
  OR logName:"nginx"
  OR textPayload:"nginx"
  OR jsonPayload.message:"nginx"
  OR resource.labels.container_name:"nginx"
)`,
            },
            {
                key: 'golang',
                label: 'Golang 容器',
                name: 'Golang 容器日志',
                filter: `(
  logName:"main_log"
  OR logName:"queue_log"
  OR resource.labels.container_name:"golang"
  OR resource.labels.container_name:"ttpos-saas-golang"
  OR textPayload:"ttpos-saas-golang"
  OR jsonPayload.message:"ttpos-saas-golang"
)`,
            },
            {
                key: 'ttpos',
                label: 'TTPOS 日志文件',
                name: 'TTPOS 日志文件',
                filter: `(
  logName:"main_log"
  OR logName:"queue_log"
  OR logName:"mysql_slow"
  OR textPayload:"ttpos"
  OR jsonPayload.msg:"ttpos"
  OR jsonPayload.message:"ttpos"
)`,
            },
        ];
        const cloudTimeRangeOptions = [
            { label: '最近 5 分钟', value: 5 },
            { label: '最近 15 分钟', value: 15 },
            { label: '最近 30 分钟', value: 30 },
            { label: '最近 1 小时', value: 60 },
            { label: '最近 3 小时', value: 180 },
            { label: '最近 6 小时', value: 360 },
            { label: '最近 12 小时', value: 720 },
            { label: '最近 24 小时', value: 1440 },
            { label: '最近 2 天', value: 2880 },
            { label: '最近 3 天', value: 4320 },
            { label: '最近 7 天', value: 10080 },
        ];
        const cloudErrorPresetFilter = `(
  severity>=ERROR
  OR jsonPayload.level="error"
  OR jsonPayload.level="fatal"
  OR jsonPayload.level="panic"
  OR textPayload:"\\"level\\":\\"error\\""
  OR textPayload:"\\"level\\":\\"fatal\\""
  OR textPayload:"\\"level\\":\\"panic\\""
)`;
        const cloudWarningPresetFilter = `(
  severity>=WARNING
  OR jsonPayload.level="warn"
  OR jsonPayload.level="warning"
  OR jsonPayload.level="error"
  OR jsonPayload.level="fatal"
  OR jsonPayload.level="panic"
  OR textPayload:"\\"level\\":\\"warn\\""
  OR textPayload:"\\"level\\":\\"warning\\""
  OR textPayload:"\\"level\\":\\"error\\""
  OR textPayload:"\\"level\\":\\"fatal\\""
  OR textPayload:"\\"level\\":\\"panic\\""
)`;
        const queryPresets = [
            { key: 'error', label: '错误日志', filter: cloudErrorPresetFilter },
            { key: 'warning', label: '警告以上', filter: cloudWarningPresetFilter },
            { key: 'cloud_run_5xx', label: 'Cloud Run 5xx', filter: 'resource.type="cloud_run_revision"\nhttpRequest.status>=500' },
            { key: 'gke_error', label: 'GKE 错误', filter: 'resource.type="k8s_container"\nseverity>=ERROR' },
        ];
        const routeMode = computed(() => {
            const key = route.path.replace('/', '') || 'cloud-logging-configs';
            if (key === 'cloud-logging-configs') return 'configs';
            if (key === 'cloud-logging-checks') return 'checks';
            if (key === 'cloud-logging-logs') return 'logs';
            return 'query';
        });
        const pageTitle = computed(() => ({
            query: 'Cloud Logging 查询',
            checks: 'Cloud Logging 监控',
            configs: 'Cloud Logging 配置',
            logs: 'Cloud Logging 告警日志',
        }[routeMode.value]));
        function resetConfigForm() {
            editingConfigId.value = null;
            Object.assign(configForm, { name: '', project_id: '', resource_names: '', credentials_file: '', default_filter: '', interval_sec: 60, enabled: true });
        }
        function openConfig(row) {
            if (row) {
                editingConfigId.value = row.id;
                Object.assign(configForm, {
                    name: row.name || '', project_id: row.project_id || '', resource_names: row.resource_names || '',
                    credentials_file: row.credentials_file || '', default_filter: row.default_filter || '',
                    interval_sec: row.interval_sec || 60, enabled: row.enabled !== false,
                });
            } else {
                resetConfigForm();
            }
            showConfigModal.value = true;
        }
        async function saveConfig() {
            saving.value = true;
            try {
                const payload = { ...configForm };
                if (editingConfigId.value) {
                    await api.put('/api/cloud-logging/configs/' + editingConfigId.value, payload);
                    message.success('配置已保存');
                } else {
                    await api.post('/api/cloud-logging/configs', payload);
                    message.success('配置已创建');
                }
                showConfigModal.value = false;
                await load();
            } catch (e) {
                message.error(e.message || '保存失败');
            }
            saving.value = false;
        }
        async function toggleConfig(row) {
            try {
                await api.post('/api/cloud-logging/configs/' + row.id + '/toggle');
                await load();
            } catch (e) {
                message.error(e.message || '操作失败');
            }
        }
        async function testConfig(row) {
            try {
                const res = await api.post('/api/cloud-logging/configs/' + row.id + '/test');
                res.ok ? message.success(res.message) : message.error(res.message);
            } catch (e) {
                message.error(e.message || '测试失败');
            }
        }
        async function deleteConfig(row) {
            try {
                await api.del('/api/cloud-logging/configs/' + row.id);
                await load();
            } catch (e) {
                message.error(e.message || '删除失败');
            }
        }
        function resetCheckForm() {
            editingCheckId.value = null;
            checkDimensionKeys.value = [];
            checkPresetKey.value = 'error';
            Object.assign(checkForm, { config_id: queryForm.config_id || (configs.value[0] && configs.value[0].id) || null, name: '', filter: 'severity>=ERROR', content_keyword: '', exclude_keyword: '', metric_type: 'count', lookback_minutes: 5, threshold_count: 0, interval_sec: 60, notify_enabled: true, recovery_notify: true, enabled: true });
        }
        function openCheck(row) {
            checkDimensionKeys.value = [];
            checkPresetKey.value = '';
            if (row) {
                editingCheckId.value = row.id;
                Object.assign(checkForm, {
                    config_id: row.config_id, name: row.name || '', filter: row.filter || '', content_keyword: '', exclude_keyword: '',
                    metric_type: row.metric_type || 'count',
                    lookback_minutes: row.lookback_minutes || 5, threshold_count: row.threshold_count || 0,
                    interval_sec: row.interval_sec || 60, notify_enabled: row.notify_enabled !== false,
                    recovery_notify: row.recovery_notify !== false, enabled: row.enabled !== false,
                });
            } else {
                resetCheckForm();
            }
            showCheckModal.value = true;
        }
        async function saveCheck() {
            saving.value = true;
            try {
                const payload = { ...checkForm, filter: buildCloudCheckFilterForSave() };
                delete payload.content_keyword;
                delete payload.exclude_keyword;
                if (editingCheckId.value) {
                    await api.put('/api/cloud-logging/checks/' + editingCheckId.value, payload);
                    message.success('监控已保存');
                } else {
                    await api.post('/api/cloud-logging/checks', payload);
                    message.success('监控已创建');
                }
                showCheckModal.value = false;
                await load();
            } catch (e) {
                message.error(e.message || '保存失败');
            }
            saving.value = false;
        }
        async function toggleCheck(row) {
            try {
                await api.post('/api/cloud-logging/checks/' + row.id + '/toggle');
                await load();
            } catch (e) {
                message.error(e.message || '操作失败');
            }
        }
        async function testCheck(row) {
            try {
                const res = await api.post('/api/cloud-logging/checks/' + row.id + '/test');
                res.ok ? message.success(res.message) : message.error(res.message);
            } catch (e) {
                message.error(e.message || '测试失败');
            }
        }
        async function deleteCheck(row) {
            try {
                await api.del('/api/cloud-logging/checks/' + row.id);
                await load();
            } catch (e) {
                message.error(e.message || '删除失败');
            }
        }
        async function runQuery() {
            queryLoading.value = true;
            try {
                const res = await api.post('/api/cloud-logging/query', {
                    config_id: queryForm.config_id,
                    filter: buildCloudQueryFilter(),
                    lookback_minutes: queryForm.lookback_minutes,
                    limit: queryForm.limit,
                });
                queryEntries.value = res.entries || [];
                effectiveFilter.value = res.effective_filter || '';
                queryStats.value = res.stats || null;
                showEffectiveFilterPanel.value = false;
                const totalText = queryStats.value ? formatCloudStatNumber(queryStats.value.total, queryStats.value.truncated) : queryEntries.value.length;
                message.success('查询完成：' + totalText + ' 条');
            } catch (e) {
                queryStats.value = null;
                message.error(e.message || '查询失败');
            }
            queryLoading.value = false;
        }
        function statusTag(status) {
            const type = status === 'alert' || status === 'error' ? 'error' : status === 'recovery' ? 'success' : 'default';
            return h(NTag, { type, size: 'small', bordered: false }, () => ({ alert: '告警', recovery: '恢复', error: '错误' }[status] || status || '-'));
        }
        function openCloudEntryDetail(row) {
            entryDetail.value = row;
            showEntryDetail.value = true;
        }
        function openCloudAlertLogDetail(row) {
            alertLogDetail.value = row;
            showAlertLogDetail.value = true;
        }
        function prettyCloudJSON(value) {
            if (value == null || value === '') return '';
            if (typeof value !== 'string') {
                try { return JSON.stringify(value, null, 2); } catch { return String(value); }
            }
            try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
        }
        function renderCloudClickableText(text, row, maxLen, multiline = false) {
            const value = text || '-';
            return h('code', {
                style: 'font-family:var(--font-mono);font-size:11px;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;' + (multiline ? 'white-space:pre-wrap' : 'white-space:nowrap'),
                onClick: () => openCloudEntryDetail(row),
            }, truncate(value, maxLen));
        }
        function renderCloudEntryDetail() {
            const row = entryDetail.value;
            if (!row) return null;
            const payload = row.payload || '';
            const labels = prettyCloudJSON(row.resource_labels || {});
            const raw = prettyCloudJSON(row.raw || row);
            return h('div', { style: 'display:flex;flex-direction:column;gap:14px' }, [
                h(NDescriptions, { bordered: true, column: _isMobile.value ? 1 : 2, labelPlacement: 'top', size: 'small' }, () => [
                    h(NDescriptionsItem, { label: '时间' }, () => formatTime(row.timestamp)),
                    h(NDescriptionsItem, { label: '级别' }, () => h(NTag, { type: ['ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'].includes(row.severity) ? 'error' : row.severity === 'WARNING' ? 'warning' : 'default', size: 'small', bordered: false }, () => row.severity || 'DEFAULT')),
                    h(NDescriptionsItem, { label: '资源' }, () => row.resource_type || '-'),
                    h(NDescriptionsItem, { label: '日志' }, () => h('code', { style: 'font-family:var(--font-mono);font-size:12px;word-break:break-all' }, row.log_name || '-')),
                ]),
                h('div', { class: 'sql-detail-block' }, [
                    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' }, [
                        h(NText, { depth: 3, style: 'font-size:12px' }, () => '内容'),
                        h(NButton, { size: 'tiny', secondary: true, onClick: () => copyText(payload || raw) }, () => '复制'),
                    ]),
                    h('pre', { class: 'sql-detail-code', style: 'max-height:260px' }, payload || '-'),
                ]),
                h('div', { class: 'sql-detail-block' }, [
                    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' }, [
                        h(NText, { depth: 3, style: 'font-size:12px' }, () => '资源标签'),
                        h(NButton, { size: 'tiny', secondary: true, onClick: () => copyText(labels) }, () => '复制'),
                    ]),
                    h('pre', { class: 'sql-detail-code', style: 'max-height:180px' }, labels || '{}'),
                ]),
                h('div', { class: 'sql-detail-block' }, [
                    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' }, [
                        h(NText, { depth: 3, style: 'font-size:12px' }, () => '原始 JSON'),
                        h(NButton, { size: 'tiny', secondary: true, onClick: () => copyText(raw) }, () => '复制'),
                    ]),
                    h('pre', { class: 'sql-detail-code', style: 'max-height:360px' }, raw || '-'),
                ]),
            ]);
        }
        function renderCloudAlertLogDetail() {
            const row = alertLogDetail.value;
            if (!row) return null;
            const sample = prettyCloudJSON(row.sample || '');
            const filter = row.filter || '';
            const error = row.error || '';
            return h('div', { style: 'display:flex;flex-direction:column;gap:14px' }, [
                h(NDescriptions, { bordered: true, column: _isMobile.value ? 1 : 3, labelPlacement: 'top', size: 'small' }, () => [
                    h(NDescriptionsItem, { label: '时间' }, () => formatTime(row.detected_at)),
                    h(NDescriptionsItem, { label: '规则' }, () => row.check_name || '-'),
                    h(NDescriptionsItem, { label: '状态' }, () => statusTag(row.status)),
                    h(NDescriptionsItem, { label: '命中' }, () => (row.match_count || 0) + ' / >' + (row.threshold_count || 0)),
                    h(NDescriptionsItem, { label: '配置' }, () => row.config_name || '-'),
                    h(NDescriptionsItem, { label: '耗时' }, () => (row.duration_ms || 0) + 'ms'),
                ]),
                h('div', { class: 'sql-detail-block' }, [
                    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' }, [
                        h(NText, { depth: 3, style: 'font-size:12px' }, () => 'Filter'),
                        h(NButton, { size: 'tiny', secondary: true, disabled: !filter, onClick: () => copyText(filter) }, () => '复制'),
                    ]),
                    h('pre', { class: 'sql-detail-code', style: 'max-height:220px' }, filter || '-'),
                ]),
                error ? h('div', { class: 'sql-detail-block' }, [
                    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' }, [
                        h(NText, { depth: 3, style: 'font-size:12px' }, () => '错误'),
                        h(NButton, { size: 'tiny', secondary: true, onClick: () => copyText(error) }, () => '复制'),
                    ]),
                    h('pre', { class: 'sql-detail-code', style: 'max-height:260px' }, error),
                ]) : null,
                h('div', { class: 'sql-detail-block' }, [
                    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' }, [
                        h(NText, { depth: 3, style: 'font-size:12px' }, () => '样例'),
                        h(NButton, { size: 'tiny', secondary: true, disabled: !sample, onClick: () => copyText(sample) }, () => '复制'),
                    ]),
                    h('pre', { class: 'sql-detail-code', style: 'max-height:460px' }, sample || '[]'),
                ]),
            ]);
        }
        function formatCloudStatNumber(value, approximate = false) {
            const n = Number(value || 0);
            return (approximate ? '≥ ' : '') + n.toLocaleString('en-US');
        }
        function formatCloudDuration(ms) {
            const n = Number(ms || 0);
            if (!n) return '-';
            if (n < 1000) return n + 'ms';
            return (n / 1000).toFixed(n >= 10000 ? 1 : 2).replace(/\.0+$/, '') + 's';
        }
        function cloudMetricLabel(metricType) {
            return metricType === 'peak_concurrency' ? '最大并发' : '日志数量';
        }
        function updateCloudCheckMetricType(value) {
            checkForm.metric_type = value || 'count';
            if (checkForm.metric_type === 'peak_concurrency') {
                checkForm.lookback_minutes = 5;
                if (!String(checkForm.name || '').trim()) checkForm.name = '接口最大并发';
                checkDimensionKeys.value = ['api_requests'];
                checkPresetKey.value = '';
                applyCloudFilterSelection('check');
            }
        }
        function renderCloudStatCard(label, value, hint, tone = 'default') {
            return h('div', { class: 'cloud-stat-card cloud-stat-card-' + tone }, [
                h('div', { class: 'cloud-stat-label' }, label),
                h('div', { class: 'cloud-stat-value' }, value),
                hint ? h('div', { class: 'cloud-stat-hint' }, hint) : null,
            ]);
        }
        function renderCloudQueryStats() {
            if (!queryStats.value) return null;
            const stats = queryStats.value;
            const totalHint = stats.truncated
                ? '达到统计上限 ' + formatCloudStatNumber(stats.stats_limit)
                : '当前条件完整统计';
            return h('div', { class: 'cloud-result-stats' }, [
                renderCloudStatCard('总数', formatCloudStatNumber(stats.total, stats.truncated), totalHint, stats.truncated ? 'warning' : 'primary'),
                renderCloudStatCard('返回', formatCloudStatNumber(stats.returned), '列表展示条数'),
                renderCloudStatCard('每秒峰值', formatCloudStatNumber(stats.peak_concurrency), stats.with_latency ? '每秒内最大并发' : '无 latency 数据', 'success'),
                renderCloudStatCard('峰值秒', stats.peak_at ? formatTime(stats.peak_at) : '-', '按请求开始时间'),
                renderCloudStatCard('平均耗时', formatCloudDuration(stats.avg_latency_ms), '有 latency 的日志'),
                renderCloudStatCard('5xx', formatCloudStatNumber(stats.status_5xx), 'HTTP 错误响应', stats.status_5xx ? 'danger' : 'default'),
            ]);
        }
        const configColumns = useColumns([
            { title: '名称', key: 'name', width: 160 },
            { title: 'Project', key: 'project_id', width: 180, ellipsis: { tooltip: true } },
            { title: '资源', key: 'resource_names', _hideOnMobile: true, ellipsis: { tooltip: true }, render: row => row.resource_names || (row.project_id ? 'projects/' + row.project_id : '-') },
            { title: '运行规则', key: 'running_checks', width: 90, render: row => row.running_checks || 0 },
            { title: '状态', key: 'enabled', width: 70, render: row => h(NTag, { type: row.enabled ? 'success' : 'default', size: 'small' }, () => row.enabled ? '启用' : '禁用') },
            { title: '操作', key: 'actions', width: 260, render: row => h(NSpace, { size: 'small' }, () => [
                h(NButton, { size: 'small', secondary: true, onClick: () => toggleConfig(row) }, () => row.enabled ? '禁用' : '启用'),
                h(NButton, { size: 'small', secondary: true, onClick: () => openConfig(row) }, () => '编辑'),
                !_isMobile.value ? h(NButton, { size: 'small', secondary: true, onClick: () => testConfig(row) }, () => '测试') : null,
                h(NPopconfirm, { onPositiveClick: () => deleteConfig(row) }, { trigger: () => h(NButton, { size: 'small', secondary: true, type: 'error' }, () => '删除'), default: () => '确定删除？' }),
            ].filter(Boolean)) },
        ]);
        const checkColumns = useColumns([
            { title: '名称', key: 'name', width: 170 },
            { title: '配置', key: 'config_name', width: 140 },
            { title: '指标', key: 'metric_type', width: 110, render: row => cloudMetricLabel(row.metric_type) },
            { title: 'Filter', key: 'filter', ellipsis: { tooltip: true }, render: row => h('code', { style: 'font-family:var(--font-mono);font-size:11px;opacity:.75' }, truncate(row.filter || '-', 80)) },
            { title: '窗口', key: 'lookback_minutes', width: 80, _hideOnMobile: true, render: row => row.lookback_minutes + 'm' },
            { title: '阈值', key: 'threshold_count', width: 100, render: row => cloudMetricLabel(row.metric_type) + ' > ' + row.threshold_count },
            { title: '状态', key: 'enabled', width: 80, render: row => row.running ? h(NTag, { type: 'success', size: 'small' }, () => '运行') : h(NTag, { size: 'small' }, () => row.enabled ? '待运行' : '禁用') },
            { title: '操作', key: 'actions', width: 280, render: row => h(NSpace, { size: 'small' }, () => [
                h(NButton, { size: 'small', secondary: true, onClick: () => toggleCheck(row) }, () => row.enabled ? '禁用' : '启用'),
                h(NButton, { size: 'small', secondary: true, onClick: () => openCheck(row) }, () => '编辑'),
                !_isMobile.value ? h(NButton, { size: 'small', secondary: true, onClick: () => testCheck(row) }, () => '测试') : null,
                h(NPopconfirm, { onPositiveClick: () => deleteCheck(row) }, { trigger: () => h(NButton, { size: 'small', secondary: true, type: 'error' }, () => '删除'), default: () => '确定删除？' }),
            ].filter(Boolean)) },
        ]);
        const entryColumns = useColumns([
            { title: '时间', key: 'timestamp', width: 170, render: row => formatTime(row.timestamp) },
            { title: '级别', key: 'severity', width: 90, render: row => h(NTag, { type: ['ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'].includes(row.severity) ? 'error' : row.severity === 'WARNING' ? 'warning' : 'default', size: 'small' }, () => row.severity || 'DEFAULT') },
            { title: '资源', key: 'resource_type', width: 160, _hideOnMobile: true, ellipsis: { tooltip: true } },
            { title: '内容', key: 'payload', ellipsis: { tooltip: true }, render: row => renderCloudClickableText(row.payload || row.raw || '-', row, _isMobile.value ? 80 : 180, true) },
            { title: '日志', key: 'log_name', width: 220, _hideOnMobile: true, ellipsis: { tooltip: true }, render: row => renderCloudClickableText(row.log_name || '-', row, 80) },
        ]);
        const logColumns = useColumns([
            { title: '时间', key: 'detected_at', width: 150, render: row => formatTime(row.detected_at) },
            { title: '规则', key: 'check_name', width: 160 },
            { title: '状态', key: 'status', width: 80, render: row => statusTag(row.status) },
            { title: '命中', key: 'match_count', width: 80, render: row => row.match_count + ' / >' + row.threshold_count },
            { title: 'Filter', key: 'filter', ellipsis: { tooltip: true }, _hideOnMobile: true, render: row => h('code', { style: 'font-family:var(--font-mono);font-size:11px;opacity:.7' }, truncate(row.filter || '-', 120)) },
            { title: '错误/样例', key: 'sample', ellipsis: { tooltip: true }, render: row => h('code', {
                style: 'display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:11px;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;',
                onClick: () => openCloudAlertLogDetail(row),
            }, String(row.error || row.sample || '-').replace(/\s+/g, ' ')) },
        ]);
        function cloudFilterTarget(target) {
            return target === 'check'
                ? { form: checkForm, dimensionKeys: checkDimensionKeys, presetKey: checkPresetKey }
                : { form: queryForm, dimensionKeys: queryDimensionKeys, presetKey: queryPresetKey };
        }
        function cloudPresetByKey(key) {
            return queryPresets.find(p => p.key === key) || null;
        }
        function buildCloudCombinedFilter(dimensionKeys, preset) {
            const dimensionFilters = dimensionKeys
                .map(key => cloudLogDimensions.find(dim => dim.key === key))
                .filter(Boolean)
                .map(dim => stringsTrim(dim.filter));
            const parts = [];
            if (dimensionFilters.length === 1) {
                parts.push(dimensionFilters[0]);
            } else if (dimensionFilters.length > 1) {
                parts.push('(\n' + dimensionFilters.join('\nOR\n') + '\n)');
            }
            if (preset && stringsTrim(preset.filter)) {
                parts.push(stringsTrim(preset.filter));
            }
            return parts.join('\nAND\n');
        }
        function gcpLogString(value) {
            return '"' + String(value || '').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';
        }
        function cloudContentTerms(keyword) {
            return String(keyword || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
        }
        function cloudSingleContentKeywordFilter(term) {
            const quoted = gcpLogString(term);
            return `(
  ${quoted}
  OR textPayload:${quoted}
  OR jsonPayload.message:${quoted}
  OR jsonPayload.msg:${quoted}
  OR jsonPayload.caller:${quoted}
  OR protoPayload.methodName:${quoted}
  OR protoPayload.serviceName:${quoted}
  OR protoPayload.resourceName:${quoted}
  OR protoPayload.status.message:${quoted}
)`;
        }
        function cloudContentKeywordFilter(keyword) {
            const filters = cloudContentTerms(keyword).map(cloudSingleContentKeywordFilter);
            if (filters.length === 0) return '';
            if (filters.length === 1) return filters[0];
            return `(
${filters.join('\nOR\n')}
)`;
        }
        function cloudExcludeKeywordFilter(keyword) {
            const includeFilter = cloudContentKeywordFilter(keyword);
            return includeFilter ? 'NOT ' + includeFilter : '';
        }
        function buildCloudQueryFilter() {
            const parts = [];
            const baseFilter = stringsTrim(queryForm.filter);
            const keywordFilter = cloudContentKeywordFilter(queryForm.content_keyword);
            const excludeFilter = cloudExcludeKeywordFilter(queryForm.exclude_keyword);
            if (baseFilter) parts.push(baseFilter);
            if (keywordFilter) parts.push(keywordFilter);
            if (excludeFilter) parts.push(excludeFilter);
            return parts.join('\nAND\n');
        }
        function buildCloudCheckFilterForSave() {
            const parts = [];
            const baseFilter = stringsTrim(checkForm.filter);
            const keywordFilter = cloudContentKeywordFilter(checkForm.content_keyword);
            const excludeFilter = cloudExcludeKeywordFilter(checkForm.exclude_keyword);
            if (baseFilter) parts.push(baseFilter);
            if (keywordFilter) parts.push(keywordFilter);
            if (excludeFilter) parts.push(excludeFilter);
            return parts.join('\nAND\n');
        }
        function stringsTrim(value) {
            return String(value || '').trim();
        }
        function applyCloudFilterSelection(target = 'query') {
            const state = cloudFilterTarget(target);
            const preset = cloudPresetByKey(state.presetKey.value);
            const combinedFilter = buildCloudCombinedFilter(state.dimensionKeys.value, preset);
            if (combinedFilter) {
                state.form.filter = combinedFilter;
            } else if (preset && !preset.keepFilter) {
                state.form.filter = preset.filter || '';
            } else if (!preset && state.dimensionKeys.value.length === 0) {
                state.form.filter = '';
            }
        }
        function isCloudDimensionActive(dim, target) {
            return cloudFilterTarget(target).dimensionKeys.value.includes(dim.key);
        }
        function isCloudPresetActive(preset, target) {
            return cloudFilterTarget(target).presetKey.value === preset.key;
        }
        function toggleCloudLogDimension(dim, target = 'query') {
            const state = cloudFilterTarget(target);
            const set = new Set(state.dimensionKeys.value);
            if (set.has(dim.key)) {
                set.delete(dim.key);
            } else {
                set.add(dim.key);
                if (target === 'check' && !String(checkForm.name || '').trim()) {
                    checkForm.name = dim.name;
                }
            }
            state.dimensionKeys.value = Array.from(set);
            applyCloudFilterSelection(target);
        }
        function applyQueryPreset(preset, target = 'query') {
            const state = cloudFilterTarget(target);
            state.presetKey.value = state.presetKey.value === preset.key ? '' : preset.key;
            applyCloudFilterSelection(target);
        }
        function clearCloudFilterSelection(target = 'query') {
            const state = cloudFilterTarget(target);
            state.dimensionKeys.value = [];
            state.presetKey.value = '';
        }
        function renderCloudDimensionButtons(target = 'query') {
            return h('div', { class: 'cloud-query-dimensions' }, [
                h('span', { class: 'cloud-query-dimension-label' }, '日志维度'),
                ...cloudLogDimensions.map(dim =>
                    h(NButton, {
                        size: 'tiny',
                        secondary: !isCloudDimensionActive(dim, target),
                        type: isCloudDimensionActive(dim, target) ? 'primary' : 'default',
                        onClick: () => toggleCloudLogDimension(dim, target),
                    }, () => dim.label)
                ),
            ]);
        }
        function renderCloudPresetButtons(target = 'query') {
            return h('div', { class: 'cloud-query-presets' }, [
                h('span', { class: 'cloud-query-dimension-label' }, '条件预设'),
                ...queryPresets.map(p =>
                    h(NButton, {
                        size: 'tiny',
                        secondary: !isCloudPresetActive(p, target),
                        type: isCloudPresetActive(p, target) ? 'primary' : 'default',
                        onClick: () => applyQueryPreset(p, target),
                    }, () => p.label)
                ),
            ]);
        }
        function renderQuery() {
            return h('div', { class: 'cloud-query-page' }, [
                h('div', { class: 'cloud-query-workbench' }, [
                    configs.value.length === 0 ? h(NAlert, { type: 'warning', showIcon: false, style: 'margin-bottom:14px' }, () => '暂无 Cloud Logging 配置') : null,
                    h('div', { class: 'cloud-query-toolbar' }, [
                        h('div', { class: 'cloud-query-field cloud-query-config-field' }, [
                            h('label', '配置'),
                            h(NSelect, { value: queryForm.config_id, 'onUpdate:value': v => queryForm.config_id = v, options: configOptions.value, placeholder: '选择配置', clearable: true }),
                        ]),
                        h('div', { class: 'cloud-query-field' }, [
                            h('label', '时间范围'),
                            h(NSelect, { value: queryForm.lookback_minutes, 'onUpdate:value': v => queryForm.lookback_minutes = v, options: cloudTimeRangeOptions, style: 'width:100%' }),
                        ]),
                        h('div', { class: 'cloud-query-field' }, [
                            h('label', '条数'),
                            h(NInputNumber, { value: queryForm.limit, 'onUpdate:value': v => queryForm.limit = v, min: 1, max: 1000, style: 'width:100%' }),
                        ]),
                        h('div', { class: 'cloud-query-field' }, [
                            h('label', '内容包含'),
                            h(NInput, {
                                value: queryForm.content_keyword,
                                'onUpdate:value': v => queryForm.content_keyword = v,
                                type: 'textarea',
                                autosize: { minRows: 1, maxRows: 4 },
                                clearable: true,
                                placeholder: '每行一个需要匹配的文本',
                                onKeyup: e => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && queryForm.config_id && runQuery(),
                            }),
                        ]),
                        h('div', { class: 'cloud-query-field' }, [
                            h('label', '内容不包含'),
                            h(NInput, {
                                value: queryForm.exclude_keyword,
                                'onUpdate:value': v => queryForm.exclude_keyword = v,
                                type: 'textarea',
                                autosize: { minRows: 1, maxRows: 4 },
                                clearable: true,
                                placeholder: '每行一个需要排除的文本',
                                onKeyup: e => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && queryForm.config_id && runQuery(),
                            }),
                        ]),
                        h(NButton, { type: 'primary', block: true, loading: queryLoading.value, disabled: !queryForm.config_id, onClick: runQuery }, () => '查询'),
                    ]),
                    h('div', { class: 'cloud-query-editor' }, [
                        h('div', { class: 'cloud-query-editor-head' }, [
	                            h('div', { class: 'cloud-query-title-row' }, [
	                                h('div', null, [
	                                    h('div', { class: 'cloud-query-section-title' }, 'Filter'),
	                                ]),
	                                h(NButton, { size: 'tiny', secondary: true, onClick: () => showQueryFilterEditor.value = !showQueryFilterEditor.value }, () => showQueryFilterEditor.value ? '收起' : '展开'),
	                            ]),
                            h('div', { class: 'cloud-query-head-actions' }, [
                                renderCloudDimensionButtons('query'),
                                renderCloudPresetButtons('query'),
                            ]),
                        ]),
                        showQueryFilterEditor.value
                            ? h(NInput, { value: queryForm.filter, 'onUpdate:value': v => { queryForm.filter = v; clearCloudFilterSelection('query'); }, type: 'textarea', autosize: { minRows: 5, maxRows: 12 }, placeholder: 'severity>=ERROR\nresource.type="cloud_run_revision"' })
                            : h('div', { class: 'cloud-collapsed-filter-preview' }, truncate(queryForm.filter || '未设置 Filter', 220)),
                    ]),
	                    effectiveFilter.value ? h('div', { class: 'cloud-effective-filter' }, [
	                        h('div', { class: 'cloud-query-title-row' }, [
	                            h('div', { class: 'cloud-query-section-title' }, '最终查询'),
	                            h(NButton, { size: 'tiny', secondary: true, onClick: () => showEffectiveFilterPanel.value = !showEffectiveFilterPanel.value }, () => showEffectiveFilterPanel.value ? '收起' : '展开'),
	                        ]),
                        showEffectiveFilterPanel.value
                            ? h('pre', null, effectiveFilter.value)
                            : h('div', { class: 'cloud-collapsed-filter-preview' }, truncate(effectiveFilter.value, 220)),
                    ]) : null,
                ]),
                h('div', { class: 'cloud-result-shell' }, [
                    h('div', { class: 'cloud-result-head' }, [
                        h('div', null, [
                            h('div', { class: 'cloud-query-section-title' }, '查询结果'),
                            h('div', { class: 'cloud-query-muted' }, queryStats.value ? '按时间倒序，统计按当前 Filter 聚合' : (queryEntries.value.length ? '按时间倒序' : '暂无数据')),
                        ]),
                        h(NTag, { size: 'small', bordered: false, type: queryEntries.value.length ? 'info' : 'default' }, () => {
                            if (queryStats.value) return formatCloudStatNumber(queryStats.value.total, queryStats.value.truncated) + ' 条';
                            return queryEntries.value.length + ' 条';
                        }),
                    ]),
                    renderCloudQueryStats(),
                    h(NDataTable, { columns: entryColumns.value, data: queryEntries.value, bordered: false, size: 'small', loading: queryLoading.value, maxHeight: 'calc(100vh - 520px)', scrollX: _isMobile.value ? 680 : undefined, rowProps: row => ({ style: 'cursor:pointer', onClick: () => openCloudEntryDetail(row) }) }),
                ]),
            ]);
        }
        function renderConfigs() {
            return h('div', null, [
                h('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:12px' }, h(NButton, { type: 'primary', onClick: () => openConfig(null) }, () => '+ 添加配置')),
                h(NDataTable, { columns: configColumns.value, data: configs.value, bordered: false, size: 'small', loading: loading.value, maxHeight: 'calc(100vh - 250px)', scrollX: _isMobile.value ? 680 : undefined }),
            ]);
        }
        function renderChecks() {
            return h('div', null, [
                h('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:12px' }, h(NButton, { type: 'primary', onClick: () => openCheck(null), disabled: configs.value.length === 0 }, () => '+ 添加监控')),
                h(NDataTable, { columns: checkColumns.value, data: checks.value, bordered: false, size: 'small', loading: loading.value, maxHeight: 'calc(100vh - 250px)', scrollX: _isMobile.value ? 860 : undefined }),
            ]);
        }
        function renderLogs() {
            return h('div', { class: 'log-page-table', style: 'display:flex;flex-direction:column' }, [
                h('div', { class: 'log-page-table' }, [
                    h(NDataTable, { columns: logColumns.value, data: alertLogs.value, bordered: false, size: 'small', loading: loading.value, flexHeight: true, style: 'height:100%', scrollX: _isMobile.value ? 680 : undefined, rowProps: row => ({ style: 'cursor:pointer', onClick: () => openCloudAlertLogDetail(row) }) }),
                ]),
                alertTotal.value > pageSize ? h('div', { class: 'log-page-pagination' },
                    h(NPagination, { page: alertPage.value, pageSize, itemCount: alertTotal.value, onUpdatePage: p => alertPage.value = p })
                ) : null,
            ]);
        }
        return () => h('div', { class: routeMode.value === 'logs' ? 'page-body log-page-fit' : 'page-body' }, [
            h('div', { class: 'page-header' }, [
                h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:' + (_isMobile.value ? '10px' : '0') }, [
                    h('h3', { class: 'page-title' }, pageTitle.value),
                    h('div', { style: 'display:flex;align-items:center;gap:4px;font-size:12px;opacity:0.5' }, [
                        h('span', { class: connected.value ? 'ws-dot connected' : 'ws-dot disconnected' }),
                        connected.value ? '实时' : '离线',
                    ]),
                ]),
            ]),
            routeMode.value === 'query' ? renderQuery() : routeMode.value === 'configs' ? renderConfigs() : routeMode.value === 'checks' ? renderChecks() : renderLogs(),
            h(NModal, { show: showEntryDetail.value, 'onUpdate:show': v => showEntryDetail.value = v, preset: 'card', title: '日志详情', style: _isMobile.value ? 'width:95vw' : 'width:1180px;max-width:94vw', segmented: true }, () => renderCloudEntryDetail()),
            h(NModal, { show: showAlertLogDetail.value, 'onUpdate:show': v => showAlertLogDetail.value = v, preset: 'card', title: '告警日志详情', style: _isMobile.value ? 'width:95vw' : 'width:1180px;max-width:94vw', segmented: true }, () => renderCloudAlertLogDetail()),
            h(NModal, { show: showConfigModal.value, 'onUpdate:show': v => showConfigModal.value = v, preset: 'card', title: editingConfigId.value ? '编辑 Cloud Logging 配置' : '添加 Cloud Logging 配置', style: _isMobile.value ? 'width:95vw' : 'width:860px', segmented: true }, () =>
                h(NForm, { labelPlacement: _isMobile.value ? 'top' : 'left', labelWidth: _isMobile.value ? undefined : 110 }, () => [
                    h(NGrid, { cols: _isMobile.value ? 1 : 2, xGap: 12 }, () => [
                        h(NGi, null, () => h(NFormItem, { label: '名称' }, () => h(NInput, { value: configForm.name, 'onUpdate:value': v => configForm.name = v, placeholder: 'prod-logs' }))),
                        h(NGi, null, () => h(NFormItem, { label: 'Project ID' }, () => h(NInput, { value: configForm.project_id, 'onUpdate:value': v => configForm.project_id = v, placeholder: 'my-gcp-project' }))),
                    ]),
                    h(NFormItem, { label: '资源名称' }, () => h(NInput, { value: configForm.resource_names, 'onUpdate:value': v => configForm.resource_names = v, type: 'textarea', autosize: { minRows: 2, maxRows: 4 }, placeholder: '默认使用 projects/{Project ID}；也可每行一个 resourceNames' })),
                    h(NFormItem, { label: '凭证文件' }, () => h(NInput, { value: configForm.credentials_file, 'onUpdate:value': v => configForm.credentials_file = v, placeholder: '/app/data/gcp-sa.json；留空使用 GOOGLE_APPLICATION_CREDENTIALS/ADC' })),
                    h(NFormItem, { label: '默认 Filter' }, () => h(NInput, { value: configForm.default_filter, 'onUpdate:value': v => configForm.default_filter = v, type: 'textarea', autosize: { minRows: 3, maxRows: 8 }, placeholder: 'resource.type=\"cloud_run_revision\"' })),
                    h(NGrid, { cols: _isMobile.value ? 1 : 2, xGap: 12 }, () => [
                        h(NGi, null, () => h(NFormItem, { label: '间隔(秒)' }, () => h(NInputNumber, { value: configForm.interval_sec, 'onUpdate:value': v => configForm.interval_sec = v, min: 10, style: 'width:100%' }))),
                        h(NGi, null, () => h(NFormItem, { label: '启用' }, () => h(NSwitch, { value: configForm.enabled, 'onUpdate:value': v => configForm.enabled = v }))),
                    ]),
                    h(NButton, { type: 'primary', block: true, loading: saving.value, onClick: saveConfig }, () => editingConfigId.value ? '保存' : '创建'),
                ])
            ),
            h(NModal, { show: showCheckModal.value, 'onUpdate:show': v => showCheckModal.value = v, preset: 'card', title: editingCheckId.value ? '编辑 Cloud Logging 监控' : '添加 Cloud Logging 监控', style: _isMobile.value ? 'width:95vw' : 'width:860px', segmented: true }, () =>
                h(NForm, { labelPlacement: _isMobile.value ? 'top' : 'left', labelWidth: _isMobile.value ? undefined : 110 }, () => [
                    h(NGrid, { cols: _isMobile.value ? 1 : 2, xGap: 12 }, () => [
                        h(NGi, null, () => h(NFormItem, { label: '名称' }, () => h(NInput, { value: checkForm.name, 'onUpdate:value': v => checkForm.name = v, placeholder: '错误日志突增' }))),
                        h(NGi, null, () => h(NFormItem, { label: '配置' }, () => h(NSelect, { value: checkForm.config_id, 'onUpdate:value': v => checkForm.config_id = v, options: configOptions.value }))),
                    ]),
                    h(NFormItem, { label: '快捷选择' }, () => h('div', { class: 'cloud-check-filter-picker' }, [
                        renderCloudDimensionButtons('check'),
                        renderCloudPresetButtons('check'),
                    ])),
                    h(NGrid, { cols: _isMobile.value ? 1 : 2, xGap: 12 }, () => [
                        h(NGi, null, () => h(NFormItem, { label: '内容包含' }, () => h(NInput, { value: checkForm.content_keyword, 'onUpdate:value': v => checkForm.content_keyword = v, type: 'textarea', autosize: { minRows: 1, maxRows: 4 }, clearable: true, placeholder: '每行一个需要匹配的文本' }))),
                        h(NGi, null, () => h(NFormItem, { label: '内容不包含' }, () => h(NInput, { value: checkForm.exclude_keyword, 'onUpdate:value': v => checkForm.exclude_keyword = v, type: 'textarea', autosize: { minRows: 1, maxRows: 4 }, clearable: true, placeholder: '每行一个需要排除的文本' }))),
                    ]),
                    h(NFormItem, { label: 'Filter' }, () => h(NInput, { value: checkForm.filter, 'onUpdate:value': v => { checkForm.filter = v; clearCloudFilterSelection('check'); }, type: 'textarea', autosize: { minRows: 4, maxRows: 10 }, placeholder: 'severity>=ERROR' })),
                    h(NGrid, { cols: _isMobile.value ? 1 : 4, xGap: 12 }, () => [
                        h(NGi, null, () => h(NFormItem, { label: '检测方式', labelPlacement: 'top' }, () => h(NSelect, { value: checkForm.metric_type, 'onUpdate:value': updateCloudCheckMetricType, options: cloudMetricOptions, style: 'width:100%' }))),
                        h(NGi, null, () => h(NFormItem, { label: '回看(分钟)', labelPlacement: 'top' }, () => h(NInputNumber, { value: checkForm.lookback_minutes, 'onUpdate:value': v => checkForm.lookback_minutes = v, min: 1, max: 1440, style: 'width:100%' }))),
                        h(NGi, null, () => h(NFormItem, { label: checkForm.metric_type === 'peak_concurrency' ? '并发阈值' : '阈值', labelPlacement: 'top' }, () => h(NInputNumber, { value: checkForm.threshold_count, 'onUpdate:value': v => checkForm.threshold_count = v, min: 0, style: 'width:100%' }))),
                        h(NGi, null, () => h(NFormItem, { label: '间隔(秒)', labelPlacement: 'top' }, () => h(NInputNumber, { value: checkForm.interval_sec, 'onUpdate:value': v => checkForm.interval_sec = v, min: 10, style: 'width:100%' }))),
                    ]),
                    h(NGrid, { cols: _isMobile.value ? 1 : 3, xGap: 12 }, () => [
                        h(NGi, null, () => h(NFormItem, { label: '通知' }, () => h(NSwitch, { value: checkForm.notify_enabled, 'onUpdate:value': v => checkForm.notify_enabled = v }))),
                        h(NGi, null, () => h(NFormItem, { label: '恢复通知' }, () => h(NSwitch, { value: checkForm.recovery_notify, disabled: !checkForm.notify_enabled, 'onUpdate:value': v => checkForm.recovery_notify = v }))),
                        h(NGi, null, () => h(NFormItem, { label: '启用' }, () => h(NSwitch, { value: checkForm.enabled, 'onUpdate:value': v => checkForm.enabled = v }))),
                    ]),
                    h(NButton, { type: 'primary', block: true, loading: saving.value, onClick: saveCheck }, () => editingCheckId.value ? '保存' : '创建'),
                ])
            ),
        ]);
    }
});

// --- Monitor Logs ---
const MonitorLogsPage = defineComponent({
    setup() {
        const paused = ref(false);
        const logEntries = ref([]);
        const maxEntries = 500;

        const { connected, messages, stop, clear } = useWebSocket('/ws/monitor-logs');
        onUnmounted(stop);

        watch(() => messages.value.length, () => {
            const latest = messages.value[messages.value.length - 1];
            if (!latest) return;
            logEntries.value.push(latest);
            if (logEntries.value.length > maxEntries) logEntries.value = logEntries.value.slice(-maxEntries);
            if (!paused.value) {
                nextTick(() => {
                    const el = document.getElementById('log-scroll');
                    if (el) el.scrollTop = el.scrollHeight;
                });
            }
        });

        function clearLogs() { logEntries.value = []; clear(); }
        function getIcon(type) {
            if (String(type || '').includes('notify_error')) return '\u2717';
            switch(type) {
                case 'checking': return '...';
                case 'no_queries': return '\u2713';
                case 'found_queries': return '\u26a0';
                case 'notified': return '\u2709';
                case 'error': return '\u2717';
                default: return '\u2022';
            }
        }
        function getMsgClass(type) {
            if (String(type || '').includes('notify_error')) return 'log-msg-error';
            switch(type) {
                case 'checking': return 'log-msg-checking';
                case 'no_queries': return 'log-msg-ok';
                case 'found_queries': return 'log-msg-found';
                case 'notified': return 'log-msg-notify';
                case 'error': return 'log-msg-error';
                default: return 'log-msg-info';
            }
        }

        return () => h('div', { class: 'page-body log-page-fit' }, [
            h('div', { class: 'log-page-header' }, [
                h('div', { style: 'display:flex;align-items:center;gap:12px' }, [
                    h('h3', { class: 'page-title' }, '运行日志'),
                    h('div', { style: 'display:flex;align-items:center;gap:4px;font-size:12px;opacity:0.5' }, [
                        h('span', { class: connected.value ? 'ws-dot connected' : 'ws-dot disconnected' }),
                        connected.value ? '已连接' : '已断开'
                    ]),
                ]),
                h(NSpace, { size: 'small' }, () => [
                    h(NButton, { size: 'small', secondary: true, onClick: () => paused.value = !paused.value }, () => paused.value ? '继续' : '暂停'),
                    h(NButton, { size: 'small', secondary: true, onClick: clearLogs }, () => '清除'),
                ]),
            ]),
            h('div', { id: 'log-scroll', class: 'log-container log-container-fit' },
                logEntries.value.length === 0
                    ? h('div', { class: 'log-entry', style: 'opacity:0.4' }, '等待监控事件...')
                    : logEntries.value.map((entry, i) => h('div', { class: 'log-entry', key: i }, [
                        h('span', { class: 'log-time' }, '[' + formatTimeShort(entry.timestamp) + '] '),
                        h('span', { class: 'log-db' }, entry.db_name + ' '),
                        h('span', { class: getMsgClass(entry.type) }, getIcon(entry.type) + ' ' + entry.message),
                    ]))
            ),
        ]);
    }
});

// --- Settings ---

// ============================================================
// 指标监控（Prometheus 端点）
// 一套采集器覆盖主机 / 容器 / 中间件 / 应用 / 业务五个维度
// ============================================================

const PROM_DIMENSIONS = [
    { label: '主机资源', value: 'host' },
    { label: '容器', value: 'container' },
    { label: '数据库', value: 'database' },
    { label: '中间件', value: 'middleware' },
    { label: '应用', value: 'app' },
    { label: '业务', value: 'business' },
    { label: '自定义', value: 'custom' },
];

const PROM_TARGET_KINDS = [
    { label: 'node_exporter（主机）', value: 'node' },
    { label: 'cAdvisor（容器）', value: 'cadvisor' },
    { label: '应用 /metrics', value: 'app' },
    { label: 'redis_exporter', value: 'redis' },
    { label: 'Nacos', value: 'nacos' },
    { label: 'MySQL Router', value: 'router' },
    { label: '自定义', value: 'custom' },
];

const PROM_AGGREGATES = [
    { label: '最后一个样本 last', value: 'last' },
    { label: '求和 sum', value: 'sum' },
    { label: '平均 avg', value: 'avg' },
    { label: '最大 max', value: 'max' },
    { label: '最小 min', value: 'min' },
    { label: '样本数 count', value: 'count' },
];

const PROM_EXPR_KINDS = [
    { label: '直接取值', value: 'raw' },
    { label: '增量 = 本次 − 上次采集（累计计数器换算成每周期新增）', value: 'delta' },
    { label: '比率 = 指标 / 分母 × 100', value: 'ratio' },
    { label: '使用率 = (1 - 指标/分母) × 100', value: 'available_ratio' },
];

const PROM_STRATEGIES = [
    { label: '阈值：越界即告警', value: 'threshold' },
    { label: '持续：连续 N 次才告警', value: 'sustained' },
    { label: '增长：变化量或变化率超标', value: 'increase' },
];

const PROM_CONDITIONS = [
    { label: '> 大于', value: 'gt' },
    { label: '>= 大于等于', value: 'gte' },
    { label: '< 小于', value: 'lt' },
    { label: '<= 小于等于', value: 'lte' },
    { label: '== 等于', value: 'eq' },
    { label: '!= 不等于', value: 'ne' },
];

const PROM_SEVERITIES = [
    { label: '提示 info', value: 'info' },
    { label: '警告 warning', value: 'warning' },
    { label: '严重 critical', value: 'critical' },
];

// 开箱即用的规则模板。每条都对应一类常见故障，
// 用户挑一个即可，不用自己去查指标名。
const PROM_RULE_TEMPLATES = [
    {
        group: '主机资源（node_exporter）',
        items: [
            { name: 'Swap 使用率 > 10%', dimension: 'host', metric: 'node_memory_SwapFree_bytes', expr_kind: 'available_ratio', expr_denominator: 'node_memory_SwapTotal_bytes', alert_strategy: 'sustained', alert_condition: 'gt', alert_value: '10', alert_consecutive: 3, severity: 'critical' },
            { name: '内存使用率 > 90%', dimension: 'host', metric: 'node_memory_MemAvailable_bytes', expr_kind: 'available_ratio', expr_denominator: 'node_memory_MemTotal_bytes', alert_strategy: 'sustained', alert_condition: 'gt', alert_value: '90', alert_consecutive: 3, severity: 'warning' },
            { name: '磁盘使用率 > 80%', dimension: 'host', metric: 'node_filesystem_avail_bytes', label_filter: 'mountpoint="/"', expr_kind: 'available_ratio', expr_denominator: 'node_filesystem_size_bytes', alert_condition: 'gt', alert_value: '80', severity: 'warning' },
            { name: '文件描述符使用率 > 80%', dimension: 'host', metric: 'process_open_fds', expr_kind: 'ratio', expr_denominator: 'process_max_fds', alert_condition: 'gt', alert_value: '80', severity: 'critical' },
            { name: '换页速率持续 > 0', dimension: 'host', metric: 'node_vmstat_pswpout', alert_strategy: 'increase', alert_delta_value: '1', severity: 'warning' },
            { name: '系统负载 > 核心数', dimension: 'host', metric: 'node_load5', alert_strategy: 'sustained', alert_condition: 'gt', alert_value: '8', alert_consecutive: 3, severity: 'warning' },
        ],
    },
    {
        group: '容器（cAdvisor）',
        items: [
            { name: '容器重启次数增加', dimension: 'container', metric: 'container_start_time_seconds', alert_strategy: 'increase', alert_delta_value: '1', severity: 'warning' },
            { name: '容器内存接近上限', dimension: 'container', metric: 'container_memory_usage_bytes', expr_kind: 'ratio', expr_denominator: 'container_spec_memory_limit_bytes', alert_condition: 'gt', alert_value: '90', severity: 'warning' },
        ],
    },
    {
        group: '应用 RED 与连接池',
        items: [
            { name: '连接池等待次数增长', dimension: 'app', metric: 'ttpos_db_pool_wait_total', alert_strategy: 'increase', alert_delta_value: '10', severity: 'warning' },
            { name: '连接池使用率 > 80%', dimension: 'app', metric: 'ttpos_db_pool_in_use_connections', expr_kind: 'ratio', expr_denominator: 'ttpos_db_pool_max_open_connections', alert_condition: 'gt', alert_value: '80', severity: 'warning' },
            { name: '连接因存活到期被关闭', dimension: 'app', metric: 'ttpos_db_pool_max_lifetime_closed_total', alert_strategy: 'increase', alert_delta_value: '100', severity: 'info' },
            { name: '5xx 请求数增长', dimension: 'app', metric: 'http_requests_total', label_filter: 'status="500"', alert_strategy: 'increase', alert_delta_value: '10', severity: 'critical' },
        ],
    },
    {
        group: '业务指标',
        items: [
            { name: '订单量长时间无增长', dimension: 'business', metric: 'orders_total', alert_strategy: 'sustained', alert_condition: 'eq', alert_value: '0', alert_consecutive: 10, severity: 'warning' },
            { name: '支付量长时间无增长', dimension: 'business', metric: 'payments_total', alert_strategy: 'sustained', alert_condition: 'eq', alert_value: '0', alert_consecutive: 10, severity: 'warning' },
        ],
    },
];

function promDimensionLabel(v) {
    const d = PROM_DIMENSIONS.find(x => x.value === v);
    return d ? d.label : (v || '自定义');
}

function promSeverityType(v) {
    if (v === 'critical') return 'error';
    if (v === 'info') return 'info';
    return 'warning';
}

// ---------- 采集目标 ----------
const PromTargetsPage = defineComponent({
    setup() {
        const items = ref([]);
        const loading = ref(true);
        const showModal = ref(false);
        const editingId = ref(null);
        const testing = ref(false);
        const testResult = ref(null);
        const message = useMessage();

        const emptyForm = () => ({
            name: '', url: '', kind: 'node', headers_json: '{}',
            timeout_sec: 10, interval_sec: 30, labels_json: '{}',
        });
        const form = reactive(emptyForm());

        async function load() {
            loading.value = true;
            try { items.value = await api.get('/api/prom-targets'); } catch {}
            loading.value = false;
        }
        onMounted(load);

        function openAdd() {
            editingId.value = null;
            testResult.value = null;
            Object.assign(form, emptyForm());
            showModal.value = true;
        }
        function openEdit(row) {
            const t = row.target;
            editingId.value = t.id;
            testResult.value = null;
            Object.assign(form, {
                name: t.name, url: t.url, kind: t.kind || 'custom',
                headers_json: t.headers_json || '{}', timeout_sec: t.timeout_sec,
                interval_sec: t.interval_sec, labels_json: t.labels_json || '{}',
            });
            showModal.value = true;
        }

        async function save() {
            if (!form.name.trim() || !form.url.trim()) { message.error('名称与 URL 不能为空'); return; }
            try {
                if (editingId.value) await api.put('/api/prom-targets/' + editingId.value, { ...form });
                else await api.post('/api/prom-targets', { ...form });
                message.success('已保存');
                showModal.value = false;
                load();
            } catch (e) { message.error(String(e.message || e)); }
        }

        async function doTest() {
            if (!form.url.trim()) { message.error('请先填写 URL'); return; }
            testing.value = true;
            testResult.value = null;
            try {
                testResult.value = await api.post('/api/prom-targets/test', { ...form });
            } catch (e) { message.error(String(e.message || e)); }
            testing.value = false;
        }

        async function toggle(row) {
            try { await api.post('/api/prom-targets/' + row.target.id + '/toggle'); load(); }
            catch (e) { message.error(String(e.message || e)); }
        }
        async function remove(row) {
            try { await api.del('/api/prom-targets/' + row.target.id); message.success('已删除'); load(); }
            catch (e) { message.error(String(e.message || e)); }
        }

        const columns = computed(() => [
            { title: '名称', key: 'name', render: r => r.target.name },
            { title: '类型', key: 'kind', width: 130, render: r => h(NTag, { size: 'small', bordered: false }, () => r.target.kind) },
            { title: '端点', key: 'url', ellipsis: { tooltip: true }, render: r => h('span', { class: 'mono' }, r.target.url) },
            { title: '规则数', key: 'check_count', width: 80, render: r => r.check_count },
            { title: '间隔', key: 'interval', width: 80, render: r => r.target.interval_sec + 's' },
            {
                title: '状态', key: 'status', width: 90,
                render: r => h(NTag, { size: 'small', type: r.running ? 'success' : 'default', bordered: false },
                    () => r.running ? '运行中' : '已停止'),
            },
            {
                title: '操作', key: 'actions', width: 190,
                render: r => h(NSpace, { size: 4 }, () => [
                    h(NButton, { size: 'tiny', secondary: true, onClick: () => openEdit(r) }, () => '编辑'),
                    h(NButton, { size: 'tiny', secondary: true, onClick: () => toggle(r) }, () => r.target.enabled ? '停用' : '启用'),
                    h(NPopconfirm, { onPositiveClick: () => remove(r) }, {
                        trigger: () => h(NButton, { size: 'tiny', secondary: true, type: 'error' }, () => '删除'),
                        default: () => '删除后其下所有规则一并移除，确认？',
                    }),
                ]),
            },
        ]);

        return () => h('div', null, [
            h(NSpace, { justify: 'space-between', align: 'center', style: 'margin-bottom:12px' }, () => [
                h(NText, { depth: 3, style: 'font-size:13px' },
                    () => '采集 Prometheus 文本端点：node_exporter 给主机、cAdvisor 给容器、应用 /metrics 给 RED 与业务指标'),
                h(NButton, { type: 'primary', size: 'small', onClick: openAdd }, () => '+ 添加'),
            ]),
            h(NDataTable, {
                columns: columns.value, data: items.value, bordered: false, size: 'small',
                loading: loading.value, maxHeight: 'calc(100vh - 220px)',
                scrollX: _isMobile.value ? 700 : undefined,
            }),
            items.value.length ? h('div', { style: 'margin-top:10px;font-size:12.5px;opacity:.65;text-align:right' },
                `共 ${items.value.length} 个目标 · ${items.value.filter(r => r.running).length} 运行中 · 合计 ${items.value.reduce((n, r) => n + (r.check_count || 0), 0)} 条规则`) : null,
            h(NModal, {
                show: showModal.value, 'onUpdate:show': v => showModal.value = v,
                preset: 'card', title: editingId.value ? '编辑采集目标' : '添加采集目标',
                style: _isMobile.value ? 'width:95vw' : 'width:680px;max-width:96vw', segmented: true,
            }, () => h(NForm, { labelPlacement: _isMobile.value ? 'top' : 'left', labelWidth: _isMobile.value ? undefined : 96 }, () => [
                h(NFormItem, { label: '名称' }, () => h(NInput, {
                    value: form.name, onUpdateValue: v => form.name = v, placeholder: '如 core-01 主机指标',
                })),
                h(NFormItem, { label: '类型' }, () => h(NSelect, {
                    value: form.kind, onUpdateValue: v => form.kind = v, options: PROM_TARGET_KINDS,
                })),
                h(NFormItem, { label: '端点 URL' }, () => h(NInput, {
                    value: form.url, onUpdateValue: v => form.url = v,
                    placeholder: 'http://10.70.20.12:9100/metrics',
                })),
                h(NGrid, { cols: 2, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '超时(秒)' }, () => h(NInputNumber, {
                        value: form.timeout_sec, onUpdateValue: v => form.timeout_sec = v,
                        min: 1, max: 120, style: 'width:100%',
                    }))),
                    h(NGi, null, () => h(NFormItem, { label: '间隔(秒)' }, () => h(NInputNumber, {
                        value: form.interval_sec, onUpdateValue: v => form.interval_sec = v,
                        min: 5, max: 3600, style: 'width:100%',
                    }))),
                ]),
                h(NFormItem, { label: '请求头' }, () => h(NInput, {
                    type: 'textarea', rows: 2, value: form.headers_json,
                    onUpdateValue: v => form.headers_json = v,
                    placeholder: '{"Authorization": "Bearer token"}',
                })),
                testResult.value ? h(NFormItem, { label: '测试结果' }, () => h('div', { style: 'width:100%' }, [
                    testResult.value.success
                        ? h(NAlert, { type: 'success', style: 'margin-bottom:8px' },
                            () => '连接成功，端点共 ' + testResult.value.metric_count + ' 个指标')
                        : h(NAlert, { type: 'error' }, () => String(testResult.value.error || '连接失败')),
                    testResult.value.success && testResult.value.metrics
                        ? h(NScrollbar, { style: 'max-height:180px' },
                            () => h('div', { class: 'mono', style: 'font-size:12px;line-height:1.7' },
                                testResult.value.metrics.map(m => h('div', null, m))))
                        : null,
                ])) : null,
                h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:8px' }, [
                    h(NButton, { onClick: doTest, loading: testing.value }, () => '测试连接'),
                    h(NButton, { onClick: () => showModal.value = false }, () => '取消'),
                    h(NButton, { type: 'primary', onClick: save }, () => '保存'),
                ]),
            ])),
        ]);
    },
});

// ---------- 告警规则 ----------
const PromChecksPage = defineComponent({
    setup() {
        const checks = ref([]);
        const targets = ref([]);
        const loading = ref(true);
        const showModal = ref(false);
        const editingId = ref(null);
        const dimFilter = ref('');
        const targetFilter = ref(null);   // 按对象（采集目标）筛选
        const kw = ref('');               // 名称/指标关键字，前端过滤
        const testing = ref(false);
        const testResult = ref(null);
        const message = useMessage();

        const emptyForm = () => ({
            target_id: null, name: '', dimension: 'host', metric: '', label_filter: '',
            aggregate: 'last', expr_kind: 'raw', expr_denominator: '',
            alert_strategy: 'threshold', alert_condition: 'gt', alert_value: '',
            alert_delta_value: '', alert_delta_percent: '', alert_consecutive: 1,
            severity: 'warning', notify_enabled: true, recovery_notify: true, message_template: '',
            diag_url: '', absent_as_zero: false, observe_only: false,
        });
        const form = reactive(emptyForm());

        async function load() {
            loading.value = true;
            try {
                const qs = [];
                if (dimFilter.value) qs.push('dimension=' + dimFilter.value);
                if (targetFilter.value) qs.push('target_id=' + targetFilter.value);
                checks.value = await api.get('/api/prom-checks' + (qs.length ? '?' + qs.join('&') : ''));
                const t = await api.get('/api/prom-targets');
                targets.value = t.map(x => {
                    let labels = {};
                    try { labels = JSON.parse(x.target.labels_json || '{}'); } catch {}
                    return { label: x.target.name + ' — ' + x.target.url, value: x.target.id, labels };
                });
            } catch {}
            loading.value = false;
        }
        onMounted(load);
        watch([dimFilter, targetFilter], load);

        function openAdd() {
            editingId.value = null;
            testResult.value = null;
            Object.assign(form, emptyForm());
            if (targets.value.length) form.target_id = targets.value[0].value;
            showModal.value = true;
        }
        function openEdit(row) {
            editingId.value = row.id;
            testResult.value = null;
            Object.assign(form, {
                target_id: row.target_id, name: row.name, dimension: row.dimension,
                metric: row.metric, label_filter: row.label_filter || '',
                aggregate: row.aggregate || 'last', expr_kind: row.expr_kind || 'raw',
                expr_denominator: row.expr_denominator || '',
                alert_strategy: row.alert_strategy || 'threshold',
                alert_condition: row.alert_condition || 'gt',
                alert_value: row.alert_value || '', alert_delta_value: row.alert_delta_value || '',
                alert_delta_percent: row.alert_delta_percent || '',
                alert_consecutive: row.alert_consecutive || 1,
                severity: row.severity || 'warning',
                notify_enabled: !!row.notify_enabled, recovery_notify: !!row.recovery_notify,
                message_template: row.message_template || '',
                diag_url: row.diag_url || '',
                absent_as_zero: !!row.absent_as_zero,
                observe_only: !!row.observe_only,
            });
            showModal.value = true;
        }

        // 套用模板：只填规则本身，采集目标仍由用户选
        function applyTemplate(tpl) {
            Object.assign(form, emptyForm(), tpl, { target_id: form.target_id });
            delete form.hint;
            delete form.group;
            message.success('已套用模板：' + tpl.name);
        }

        const templateOptions = computed(() => PROM_RULE_TEMPLATES.map(g => ({
            type: 'group', label: g.group, key: g.group,
            children: g.items.map((it, i) => ({ label: it.name, key: g.group + '::' + i })),
        })));

        function onTemplateSelect(key) {
            const [group, idx] = key.split('::');
            const g = PROM_RULE_TEMPLATES.find(x => x.group === group);
            if (g && g.items[idx]) applyTemplate({ ...g.items[idx] });
        }

        async function save() {
            if (!form.target_id) { message.error('请选择采集目标'); return; }
            if (!form.name.trim() || !form.metric.trim()) { message.error('名称与指标不能为空'); return; }
            try {
                if (editingId.value) await api.put('/api/prom-checks/' + editingId.value, { ...form });
                else await api.post('/api/prom-checks', { ...form });
                message.success('已保存');
                showModal.value = false;
                load();
            } catch (e) { message.error(String(e.message || e)); }
        }

        async function doTest() {
            if (!form.target_id || !form.metric.trim()) { message.error('请先选择目标并填写指标'); return; }
            testing.value = true;
            testResult.value = null;
            try { testResult.value = await api.post('/api/prom-checks/test', { ...form }); }
            catch (e) { message.error(String(e.message || e)); }
            testing.value = false;
        }

        async function toggle(row) {
            try { await api.post('/api/prom-checks/' + row.id + '/toggle'); load(); }
            catch (e) { message.error(String(e.message || e)); }
        }
        async function remove(row) {
            try { await api.del('/api/prom-checks/' + row.id); message.success('已删除'); load(); }
            catch (e) { message.error(String(e.message || e)); }
        }

        const columns = computed(() => [
            { title: '名称', key: 'name', ellipsis: { tooltip: true } },
            {
                title: '维度', key: 'dimension', width: 100,
                render: r => h(NTag, { size: 'small', bordered: false }, () => promDimensionLabel(r.dimension)),
            },
            { title: '指标', key: 'metric', ellipsis: { tooltip: true }, render: r => h('span', { class: 'mono', style: 'font-size:12px' }, r.metric + (r.label_filter ? '{' + r.label_filter + '}' : '')) },
            { title: '目标', key: 'target_name', width: 140, ellipsis: { tooltip: true } },
            {
                title: '条件', key: 'cond', width: 150,
                render: r => {
                    if (r.observe_only) return h('span', { style: 'opacity:.45;font-size:12px' }, '—');
                    if (r.alert_strategy === 'increase') {
                        return h('span', { class: 'mono', style: 'font-size:12px' },
                            '增量 ≥ ' + (r.alert_delta_value || r.alert_delta_percent + '%'));
                    }
                    const sym = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', ne: '≠' }[r.alert_condition] || r.alert_condition;
                    const suffix = r.alert_strategy === 'sustained' ? ' ×' + r.alert_consecutive : '';
                    return h('span', { class: 'mono', style: 'font-size:12px' }, sym + ' ' + r.alert_value + suffix);
                },
            },
            {
                title: '级别', key: 'severity', width: 90,
                render: r => r.observe_only
                    ? h(NTag, { size: 'small', bordered: false }, () => '观测')
                    : h(NTag, { size: 'small', type: promSeverityType(r.severity), bordered: false }, () => r.severity),
            },
            {
                title: '状态', key: 'enabled', width: 80,
                render: r => h(NTag, { size: 'small', type: r.enabled ? 'success' : 'default', bordered: false },
                    () => r.enabled ? '启用' : '停用'),
            },
            {
                title: '操作', key: 'actions', width: 190,
                render: r => h(NSpace, { size: 4 }, () => [
                    h(NButton, { size: 'tiny', secondary: true, onClick: () => openEdit(r) }, () => '编辑'),
                    h(NButton, { size: 'tiny', secondary: true, onClick: () => toggle(r) }, () => r.enabled ? '停用' : '启用'),
                    h(NPopconfirm, { onPositiveClick: () => remove(r) }, {
                        trigger: () => h(NButton, { size: 'tiny', secondary: true, type: 'error' }, () => '删除'),
                        default: () => '确认删除该规则？',
                    }),
                ]),
            },
        ]);

        const isIncrease = computed(() => form.alert_strategy === 'increase');
        const needDenominator = computed(() => form.expr_kind === 'ratio' || form.expr_kind === 'available_ratio');

        // 关键字在前端过滤（272 条全在内存，即敲即出）；对象/维度走后端参数
        const shownChecks = computed(() => {
            const k = kw.value.trim().toLowerCase();
            if (!k) return checks.value;
            return checks.value.filter(c =>
                (c.name || '').toLowerCase().includes(k) ||
                (c.metric || '').toLowerCase().includes(k));
        });
        // 目标下拉用短名（去掉 URL），搜索友好
        // 物理机（labels.vm）为组、其承载的 VM（labels.host==vm）归入组内，
        // 物理机自身排组首；没有宿主标签的目标归入「其他」。
        const groupedTargets = computed(() => {
            const short = t => ({ label: t.label.split(' — ')[0], value: t.value });
            const phs = targets.value.filter(t => t.labels && t.labels.vm);
            const used = new Set();
            const groups = phs.map(ph => {
                used.add(ph.value);
                const children = [short(ph)];
                for (const t of targets.value) {
                    if (t.labels && t.labels.host === ph.labels.vm && !used.has(t.value)) {
                        used.add(t.value);
                        children.push(short(t));
                    }
                }
                return { type: 'group', label: ph.labels.vm + '（物理机及其 VM）', key: 'g-' + ph.labels.vm, children };
            });
            const others = targets.value.filter(t => !used.has(t.value)).map(short);
            if (others.length) groups.push({ type: 'group', label: '其他', key: 'g-other', children: others });
            return groups.length ? groups : targets.value.map(short);
        });
        const targetOptions = computed(() => [{ label: '全部对象', value: null }, ...groupedTargets.value]);

        return () => h('div', null, [
            h(NSpace, { justify: 'space-between', align: 'center', style: 'margin-bottom:12px' }, () => [
                h(NSpace, { align: 'center', size: 8 }, () => [
                    h(NSelect, {
                        value: targetFilter.value, onUpdateValue: v => targetFilter.value = v,
                        options: targetOptions.value, filterable: true, clearable: true,
                        placeholder: '按对象筛选', style: 'width:210px', size: 'small',
                    }),
                    h(NSelect, {
                        value: dimFilter.value, onUpdateValue: v => dimFilter.value = v,
                        options: [{ label: '全部维度', value: '' }, ...PROM_DIMENSIONS],
                        style: 'width:140px', size: 'small',
                    }),
                    h(NInput, {
                        value: kw.value, onUpdateValue: v => kw.value = v, clearable: true,
                        placeholder: '搜名称 / 指标', style: 'width:190px', size: 'small',
                    }),
                    h(NText, { depth: 3, style: 'font-size:12px' }, () => shownChecks.value.length + ' 条'),
                ]),
                h(NButton, { type: 'primary', size: 'small', onClick: openAdd }, () => '+ 添加规则'),
            ]),
            h(NDataTable, {
                columns: columns.value, data: shownChecks.value, bordered: false, size: 'small',
                loading: loading.value, maxHeight: 'calc(100vh - 220px)',
                scrollX: _isMobile.value ? 900 : undefined,
            }),
            h(NModal, {
                show: showModal.value, 'onUpdate:show': v => showModal.value = v,
                preset: 'card', title: editingId.value ? '编辑规则' : '添加规则',
                style: _isMobile.value ? 'width:95vw' : 'width:860px;max-width:96vw', segmented: true,
            }, () => h(NForm, { labelPlacement: _isMobile.value ? 'top' : 'left', labelWidth: _isMobile.value ? undefined : 110 }, () => [
                editingId.value ? null : h(NFormItem, { label: '快速模板' }, () => h(NDropdown, {
                    trigger: 'click', options: templateOptions.value, onSelect: onTemplateSelect,
                }, () => h(NButton, { size: 'small', secondary: true, type: 'info' }, () => '从模板套用 ▾'))),
                h(NGrid, { cols: 2, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '采集目标' }, () => h(NSelect, {
                        value: form.target_id, onUpdateValue: v => form.target_id = v,
                        options: groupedTargets.value, filterable: true, placeholder: '选择端点',
                    }))),
                    h(NGi, null, () => h(NFormItem, { label: '维度' }, () => h(NSelect, {
                        value: form.dimension, onUpdateValue: v => form.dimension = v, options: PROM_DIMENSIONS,
                    }))),
                ]),
                h(NFormItem, { label: '规则名称' }, () => h(NInput, {
                    value: form.name, onUpdateValue: v => form.name = v, placeholder: '如 Swap 使用量过高',
                })),
                h(NFormItem, { label: '指标名' }, () => h(NInput, {
                    value: form.metric, onUpdateValue: v => form.metric = v,
                    placeholder: 'node_memory_SwapFree_bytes',
                })),
                h(NGrid, { cols: 2, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '标签过滤' }, () => h(NInput, {
                        value: form.label_filter, onUpdateValue: v => form.label_filter = v,
                        placeholder: 'mountpoint="/"，末尾 * 可前缀匹配',
                    }))),
                    h(NGi, null, () => h(NFormItem, { label: '聚合' }, () => h(NSelect, {
                        value: form.aggregate, onUpdateValue: v => form.aggregate = v, options: PROM_AGGREGATES,
                    }))),
                ]),
                h(NFormItem, { label: '表达式' }, () => h(NSelect, {
                    value: form.expr_kind, onUpdateValue: v => form.expr_kind = v, options: PROM_EXPR_KINDS,
                })),
                needDenominator.value ? h(NFormItem, { label: '分母指标' }, () => h(NInput, {
                    value: form.expr_denominator, onUpdateValue: v => form.expr_denominator = v,
                    placeholder: 'node_memory_SwapTotal_bytes（结果为百分比，阈值按 % 填）',
                })) : null,
                h(NDivider, { style: 'margin:4px 0' }),
                h(NFormItem, { label: '仅观测' }, () => h(NSpace, { align: 'center' }, () => [
                    h(NSwitch, { value: form.observe_only, onUpdateValue: v => form.observe_only = v }),
                    h(NText, { depth: 3, style: 'font-size:12px' }, () =>
                        '只采样出趋势图，不做告警判定（无阈值、不进事件、不通知）。适合请求量、TPS 这类看走势的指标'),
                ])),
                form.observe_only ? null : h(NGrid, { cols: 2, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '告警策略' }, () => h(NSelect, {
                        value: form.alert_strategy, onUpdateValue: v => form.alert_strategy = v, options: PROM_STRATEGIES,
                    }))),
                    h(NGi, null, () => h(NFormItem, { label: '级别' }, () => h(NSelect, {
                        value: form.severity, onUpdateValue: v => form.severity = v, options: PROM_SEVERITIES,
                    }))),
                ]),
                form.observe_only ? null : isIncrease.value
                    ? h(NGrid, { cols: 2, xGap: 12 }, () => [
                        h(NGi, null, () => h(NFormItem, { label: '增量阈值' }, () => h(NInput, {
                            value: form.alert_delta_value, onUpdateValue: v => form.alert_delta_value = v,
                            placeholder: '相对上次的绝对增量',
                        }))),
                        h(NGi, null, () => h(NFormItem, { label: '增幅阈值(%)' }, () => h(NInput, {
                            value: form.alert_delta_percent, onUpdateValue: v => form.alert_delta_percent = v,
                            placeholder: '相对上次的百分比',
                        }))),
                    ])
                    : h(NGrid, { cols: 3, xGap: 12 }, () => [
                        h(NGi, null, () => h(NFormItem, { label: '条件' }, () => h(NSelect, {
                            value: form.alert_condition, onUpdateValue: v => form.alert_condition = v, options: PROM_CONDITIONS,
                        }))),
                        h(NGi, null, () => h(NFormItem, { label: '阈值' }, () => h(NInput, {
                            value: form.alert_value, onUpdateValue: v => form.alert_value = v, placeholder: '如 80',
                        }))),
                        h(NGi, null, () => h(NFormItem, { label: '连续次数' }, () => h(NInputNumber, {
                            value: form.alert_consecutive, onUpdateValue: v => form.alert_consecutive = v,
                            min: 1, max: 60, style: 'width:100%',
                            disabled: form.alert_strategy !== 'sustained',
                        }))),
                    ]),
                form.observe_only ? null : h(NGrid, { cols: 2, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '触发通知' }, () => h(NSwitch, {
                        value: form.notify_enabled, onUpdateValue: v => form.notify_enabled = v,
                    }))),
                    h(NGi, null, () => h(NFormItem, { label: '恢复通知' }, () => h(NSwitch, {
                        value: form.recovery_notify, onUpdateValue: v => form.recovery_notify = v,
                    }))),
                ]),
                form.observe_only ? null : h(NFormItem, { label: '消息模板' }, () => h(NInput, {
                    type: 'textarea', rows: 2, value: form.message_template,
                    onUpdateValue: v => form.message_template = v,
                    placeholder: '留空用默认。可用变量：{{target}} {{check}} {{metric}} {{value}} {{threshold}} {{severity}} {{reason}}',
                })),
                form.observe_only ? null : h(NFormItem, { label: '诊断 URL' }, () => h(NInput, {
                    value: form.diag_url, onUpdateValue: v => form.diag_url = v,
                    placeholder: '可选。告警通知前 GET 此地址，把响应附进消息（如各 VM 的 :9101 错误样本）',
                })),
                form.observe_only ? null : h(NFormItem, { label: '无数据按 0 评估' }, () => h(NSpace, { align: 'center' }, () => [
                    h(NSwitch, { value: form.absent_as_zero, onUpdateValue: v => form.absent_as_zero = v }),
                    h(NText, { depth: 3, style: 'font-size:12px' }, () =>
                        '序列缺失时按 0 参与评估。掉线检测（up 类指标 < 1）必开：容器停止后序列直接消失，不开则永远不告警'),
                ])),
                testResult.value ? h(NFormItem, { label: '测试结果' }, () => (
                    testResult.value.success
                        ? h(NAlert, { type: testResult.value.matched ? 'warning' : 'success' }, () =>
                            '当前值 ' + testResult.value.value + (testResult.value.matched ? ' — 会触发告警' : ' — 不触发') +
                            '\n' + (testResult.value.reason || ''))
                        : h(NAlert, { type: 'error' }, () => String(testResult.value.error || '求值失败'))
                )) : null,
                h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:8px' }, [
                    h(NButton, { onClick: doTest, loading: testing.value }, () => '测试规则'),
                    h(NButton, { onClick: () => showModal.value = false }, () => '取消'),
                    h(NButton, { type: 'primary', onClick: save }, () => '保存'),
                ]),
            ])),
        ]);
    },
});

// ---------- 指标告警日志 ----------
const PromLogsPage = defineComponent({
    setup() {
        const logs = ref([]);
        const total = ref(0);
        const page = ref(1);
        const pageSize = ref(50);
        const dimFilter = ref('');
        const loading = ref(true);

        async function load() {
            loading.value = true;
            try {
                const params = new URLSearchParams({ page: page.value, page_size: pageSize.value });
                if (dimFilter.value) params.set('dimension', dimFilter.value);
                const data = await api.get('/api/prom-checks/logs?' + params.toString());
                logs.value = data.logs || [];
                total.value = data.total || 0;
            } catch {}
            loading.value = false;
        }
        onMounted(load);
        watch([page, dimFilter], load);
        watch(dimFilter, () => { page.value = 1; });

        const columns = computed(() => [
            { title: '时间', key: 'detected_at', width: 160, render: r => formatTime(r.detected_at) },
            {
                title: '状态', key: 'status', width: 90,
                render: r => {
                    const map = { alert: 'error', ok: 'success', error: 'warning', recovered: 'info' };
                    const label = { alert: '告警', ok: '正常', error: '异常', recovered: '恢复' };
                    return h(NTag, { size: 'small', type: map[r.status] || 'default', bordered: false },
                        () => label[r.status] || r.status);
                },
            },
            {
                title: '维度', key: 'dimension', width: 90,
                render: r => promDimensionLabel(r.dimension),
            },
            { title: '规则', key: 'check_name', ellipsis: { tooltip: true } },
            { title: '目标', key: 'target_name', width: 130, ellipsis: { tooltip: true } },
            { title: '指标', key: 'metric', ellipsis: { tooltip: true }, render: r => h('span', { class: 'mono', style: 'font-size:12px' }, r.metric) },
            { title: '当前值', key: 'value', width: 110, render: r => h('span', { class: 'mono' }, r.value || '-') },
            { title: '阈值', key: 'threshold', width: 80, render: r => r.threshold || '-' },
            { title: '说明', key: 'message', ellipsis: { tooltip: true }, render: r => {
                const txt = r.error || r.message || '-';
                // 带错误样本的多行消息：单元格只放首行，悬停给可滚动的等宽全文
                if (!txt.includes('\n')) return txt;
                return h(NTooltip, { style: 'max-width:680px' }, {
                    trigger: () => h('span', { style: 'cursor:help' }, txt.split('\n')[0] + ' …'),
                    default: () => h('pre', { style: 'margin:0;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:420px;overflow:auto' }, txt),
                });
            } },
        ]);

        return () => h('div', null, [
            h(NSpace, { justify: 'space-between', align: 'center', style: 'margin-bottom:12px' }, () => [
                h(NSelect, {
                    value: dimFilter.value, onUpdateValue: v => dimFilter.value = v,
                    options: [{ label: '全部维度', value: '' }, ...PROM_DIMENSIONS],
                    style: 'width:150px', size: 'small',
                }),
                h(NButton, { size: 'small', secondary: true, onClick: load }, () => '刷新'),
            ]),
            h(NDataTable, {
                columns: columns.value, data: logs.value, bordered: false, size: 'small',
                loading: loading.value, maxHeight: 'calc(100vh - 260px)',
                scrollX: _isMobile.value ? 1100 : undefined,
            }),
            h('div', { style: 'display:flex;justify-content:flex-end;margin-top:12px' }, [
                h(NPagination, {
                    page: page.value, pageSize: pageSize.value, itemCount: total.value,
                    onUpdatePage: v => page.value = v,
                }),
            ]),
        ]);
    },
});

// ---------- 证书检查 ----------
const CertChecksPage = defineComponent({
    setup() {
        const items = ref([]);
        const loading = ref(true);
        const showModal = ref(false);
        const editingId = ref(null);
        const testing = ref(false);
        const testResult = ref(null);
        const message = useMessage();

        const emptyForm = () => ({
            name: '', endpoint: '', server_name: '',
            warn_days: 30, critical_days: 7, interval_sec: 3600, notify_enabled: true,
        });
        const form = reactive(emptyForm());

        async function load() {
            loading.value = true;
            try { items.value = await api.get('/api/cert-checks'); } catch {}
            loading.value = false;
        }
        onMounted(load);

        function openAdd() {
            editingId.value = null;
            testResult.value = null;
            Object.assign(form, emptyForm());
            showModal.value = true;
        }
        function openEdit(row) {
            const c = row.check;
            editingId.value = c.id;
            testResult.value = null;
            Object.assign(form, {
                name: c.name, endpoint: c.endpoint, server_name: c.server_name || '',
                warn_days: c.warn_days, critical_days: c.critical_days,
                interval_sec: c.interval_sec, notify_enabled: !!c.notify_enabled,
            });
            showModal.value = true;
        }

        async function save() {
            if (!form.name.trim() || !form.endpoint.trim()) { message.error('名称与地址不能为空'); return; }
            try {
                if (editingId.value) await api.put('/api/cert-checks/' + editingId.value, { ...form });
                else await api.post('/api/cert-checks', { ...form });
                message.success('已保存');
                showModal.value = false;
                load();
            } catch (e) { message.error(String(e.message || e)); }
        }

        async function doTest() {
            if (!form.endpoint.trim()) { message.error('请先填写地址'); return; }
            testing.value = true;
            testResult.value = null;
            try { testResult.value = await api.post('/api/cert-checks/test', { ...form }); }
            catch (e) { message.error(String(e.message || e)); }
            testing.value = false;
        }

        async function toggle(row) {
            try { await api.post('/api/cert-checks/' + row.check.id + '/toggle'); load(); }
            catch (e) { message.error(String(e.message || e)); }
        }
        async function remove(row) {
            try { await api.del('/api/cert-checks/' + row.check.id); message.success('已删除'); load(); }
            catch (e) { message.error(String(e.message || e)); }
        }

        const columns = computed(() => [
            { title: '名称', key: 'name', render: r => r.check.name },
            { title: '地址', key: 'endpoint', ellipsis: { tooltip: true }, render: r => h('span', { class: 'mono', style: 'font-size:12px' }, r.check.endpoint) },
            {
                title: '剩余天数', key: 'days', width: 110,
                render: r => {
                    if (!r.last) return h(NText, { depth: 3 }, () => '未检查');
                    const d = r.last.days_left;
                    const type = d < 0 ? 'error' : d <= r.check.critical_days ? 'error'
                        : d <= r.check.warn_days ? 'warning' : 'success';
                    return h(NTag, { size: 'small', type, bordered: false },
                        () => d < 0 ? '已过期 ' + (-d) + ' 天' : d + ' 天');
                },
            },
            { title: '到期时间', key: 'not_after', width: 160, render: r => r.last && r.last.not_after ? formatTime(r.last.not_after) : '-' },
            { title: '签发者', key: 'issuer', ellipsis: { tooltip: true }, render: r => r.last ? (r.last.issuer || '-') : '-' },
            { title: '阈值', key: 'th', width: 110, render: r => '警告 ' + r.check.warn_days + ' / 严重 ' + r.check.critical_days },
            {
                title: '状态', key: 'status', width: 90,
                render: r => h(NTag, { size: 'small', type: r.running ? 'success' : 'default', bordered: false },
                    () => r.running ? '运行中' : '已停止'),
            },
            {
                title: '操作', key: 'actions', width: 190,
                render: r => h(NSpace, { size: 4 }, () => [
                    h(NButton, { size: 'tiny', secondary: true, onClick: () => openEdit(r) }, () => '编辑'),
                    h(NButton, { size: 'tiny', secondary: true, onClick: () => toggle(r) }, () => r.check.enabled ? '停用' : '启用'),
                    h(NPopconfirm, { onPositiveClick: () => remove(r) }, {
                        trigger: () => h(NButton, { size: 'tiny', secondary: true, type: 'error' }, () => '删除'),
                        default: () => '确认删除该检查？',
                    }),
                ]),
            },
        ]);

        return () => h('div', null, [
            h(NSpace, { justify: 'space-between', align: 'center', style: 'margin-bottom:12px' }, () => [
                h(NText, { depth: 3, style: 'font-size:13px' },
                    () => '证书过期是能提前几十天预知的故障，建立一次 TLS 握手即可检查，不影响业务'),
                h(NButton, { type: 'primary', size: 'small', onClick: openAdd }, () => '+ 添加'),
            ]),
            h(NDataTable, {
                columns: columns.value, data: items.value, bordered: false, size: 'small',
                loading: loading.value, maxHeight: 'calc(100vh - 220px)',
                scrollX: _isMobile.value ? 900 : undefined,
            }),
            h(NModal, {
                show: showModal.value, 'onUpdate:show': v => showModal.value = v,
                preset: 'card', title: editingId.value ? '编辑证书检查' : '添加证书检查',
                style: _isMobile.value ? 'width:95vw' : 'width:620px;max-width:96vw', segmented: true,
            }, () => h(NForm, { labelPlacement: _isMobile.value ? 'top' : 'left', labelWidth: _isMobile.value ? undefined : 110 }, () => [
                h(NFormItem, { label: '名称' }, () => h(NInput, {
                    value: form.name, onUpdateValue: v => form.name = v, placeholder: '如 Coolify 控制台',
                })),
                h(NFormItem, { label: '地址' }, () => h(NInput, {
                    value: form.endpoint, onUpdateValue: v => form.endpoint = v,
                    placeholder: 'example.com:443，也可直接填 https://example.com',
                })),
                h(NFormItem, { label: 'SNI' }, () => h(NInput, {
                    value: form.server_name, onUpdateValue: v => form.server_name = v,
                    placeholder: '留空则用地址中的域名',
                })),
                h(NGrid, { cols: 3, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '警告(天)' }, () => h(NInputNumber, {
                        value: form.warn_days, onUpdateValue: v => form.warn_days = v, min: 1, max: 365, style: 'width:100%',
                    }))),
                    h(NGi, null, () => h(NFormItem, { label: '严重(天)' }, () => h(NInputNumber, {
                        value: form.critical_days, onUpdateValue: v => form.critical_days = v, min: 1, max: 180, style: 'width:100%',
                    }))),
                    h(NGi, null, () => h(NFormItem, { label: '间隔(秒)' }, () => h(NInputNumber, {
                        value: form.interval_sec, onUpdateValue: v => form.interval_sec = v, min: 60, max: 86400, style: 'width:100%',
                    }))),
                ]),
                h(NFormItem, { label: '触发通知' }, () => h(NSwitch, {
                    value: form.notify_enabled, onUpdateValue: v => form.notify_enabled = v,
                })),
                testResult.value ? h(NFormItem, { label: '测试结果' }, () => (
                    testResult.value.success
                        ? h(NAlert, { type: testResult.value.status === 'ok' ? 'success' : 'warning' }, () =>
                            '剩余 ' + testResult.value.days_left + ' 天，签发者：' + (testResult.value.issuer || '-'))
                        : h(NAlert, { type: 'error' }, () => String(testResult.value.error || '检查失败'))
                )) : null,
                h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:8px' }, [
                    h(NButton, { onClick: doTest, loading: testing.value }, () => '立即检查'),
                    h(NButton, { onClick: () => showModal.value = false }, () => '取消'),
                    h(NButton, { type: 'primary', onClick: save }, () => '保存'),
                ]),
            ])),
        ]);
    },
});

const SettingsPage = defineComponent({
    setup() {
        const settings = reactive({
            github_client_id: '',
            github_client_secret: '',
            github_enabled: '0',
            password_login_enabled: '1',
            oauth_public_base_url: '',
            show_rocketmq_menu: '1',
            show_grafana_menu: '1',
            show_cloud_logging_menu: '1',
        });
        const users = ref([]);
        const loading = ref(true);
        const saving = ref(false);
        const newUser = reactive({ github_login: '', role: 'member' });
        const message = useMessage();

        async function load() {
            loading.value = true;
            try {
                const s = await api.get('/api/settings');
                Object.assign(settings, s);
                applyUISettings(s);
                users.value = await api.get('/api/users');
            } catch {}
            loading.value = false;
        }
        onMounted(load);

        async function saveSettings() {
            saving.value = true;
            try {
                await api.put('/api/settings', {
                    github_client_id: settings.github_client_id,
                    github_client_secret: settings.github_client_secret,
                    github_enabled: settings.github_enabled,
                    password_login_enabled: settings.password_login_enabled,
                    oauth_public_base_url: settings.oauth_public_base_url,
                    show_rocketmq_menu: settings.show_rocketmq_menu,
                    show_grafana_menu: settings.show_grafana_menu,
                    show_cloud_logging_menu: settings.show_cloud_logging_menu,
                });
                applyUISettings(settings);
                message.success('设置已保存');
            } catch (e) { message.error(e.message); }
            saving.value = false;
        }
        async function addUser() {
            if (!newUser.github_login) { message.warning('请输入 GitHub 用户名'); return; }
            try {
                await api.post('/api/users', newUser);
                message.success('已添加');
                newUser.github_login = '';
                await load();
            } catch (e) { message.error(e.message); }
        }
        async function delUser(row) {
            try { await api.del('/api/users/' + row.id); message.success('已删除'); await load(); } catch (e) { message.error(e.message); }
        }

        const userColumns = useColumns([
            { title: '用户名', key: 'username' },
            { title: 'GitHub', key: 'github_login' },
            { title: '角色', key: 'role', width: 80, render: row => h(NTag, { type: row.role === 'admin' ? 'warning' : 'info', size: 'small' }, () => row.role) },
            { title: '操作', key: 'actions', width: 80, render: row => h(NPopconfirm, { onPositiveClick: () => delUser(row) }, { trigger: () => h(NButton, { size: 'small', secondary: true, type: 'error' }, () => '删除'), default: () => '确定删除？' }) },
        ]);

        return () => h(NSpin, { show: loading.value }, () => h('div', [
            h('h3', { class: 'page-title', style: 'margin-bottom:20px' }, '系统设置'),
            h(NCard, { title: 'GitHub OAuth', size: 'small', style: 'margin-bottom:20px' }, () => h(NForm, { model: settings, labelPlacement: _isMobile.value ? 'top' : 'left', labelWidth: _isMobile.value ? undefined : 140 }, [
                h(NFormItem, { label: 'OAuth 公网根地址' }, () => h(NInput, { value: settings.oauth_public_base_url, 'onUpdate:value': v => settings.oauth_public_base_url = v, placeholder: 'https://你的域名（无末尾/），Docker/反代后必填' })),
                h(NFormItem, { label: 'Client ID' }, () => h(NInput, { value: settings.github_client_id, 'onUpdate:value': v => settings.github_client_id = v, placeholder: 'GitHub OAuth App Client ID' })),
                h(NFormItem, { label: 'Client Secret' }, () => h(NInput, { value: settings.github_client_secret, 'onUpdate:value': v => settings.github_client_secret = v, type: 'password', placeholder: '留空不修改' })),
                h(NFormItem, { label: '启用 GitHub 登录' }, () => h(NSwitch, { value: settings.github_enabled === '1', 'onUpdate:value': v => settings.github_enabled = v ? '1' : '0' })),
                h(NFormItem, { label: '启用密码登录' }, () => h(NSwitch, { value: settings.password_login_enabled !== '0', 'onUpdate:value': v => settings.password_login_enabled = v ? '1' : '0' })),
                h(NButton, { type: 'primary', loading: saving.value, onClick: saveSettings }, () => '保存设置'),
            ])),
            h(NCard, { title: '界面显示', size: 'small', style: 'margin-bottom:20px' }, () => h(NForm, { model: settings, labelPlacement: _isMobile.value ? 'top' : 'left', labelWidth: _isMobile.value ? undefined : 140 }, [
                h(NFormItem, { label: '显示 RocketMQ' }, () => h(NSwitch, { value: settings.show_rocketmq_menu !== '0', 'onUpdate:value': v => settings.show_rocketmq_menu = v ? '1' : '0' })),
                h(NFormItem, { label: '显示 Grafana' }, () => h(NSwitch, { value: settings.show_grafana_menu !== '0', 'onUpdate:value': v => settings.show_grafana_menu = v ? '1' : '0' })),
                h(NFormItem, { label: '显示 Cloud Logging' }, () => h(NSwitch, { value: settings.show_cloud_logging_menu !== '0', 'onUpdate:value': v => settings.show_cloud_logging_menu = v ? '1' : '0' })),
                h(NButton, { type: 'primary', loading: saving.value, onClick: saveSettings }, () => '保存设置'),
            ])),
            h(NCard, { title: 'GitHub 授权用户', size: 'small' }, () => h('div', [
                h('div', { style: _isMobile.value ? 'display:flex;flex-direction:column;gap:8px;margin-bottom:16px' : 'display:flex;gap:8px;margin-bottom:16px' }, [
                    h(NInput, { value: newUser.github_login, 'onUpdate:value': v => newUser.github_login = v, placeholder: 'GitHub 用户名', style: _isMobile.value ? 'width:100%' : 'width:200px', onKeyup: e => e.key === 'Enter' && addUser() }),
                    h('div', { style: 'display:flex;gap:8px' }, [
                        h(NSelect, { value: newUser.role, 'onUpdate:value': v => newUser.role = v, options: [{ label: '成员', value: 'member' }, { label: '管理员', value: 'admin' }], style: 'width:120px' }),
                        h(NButton, { type: 'primary', onClick: addUser }, () => '添加'),
                    ]),
                ]),
                h(NDataTable, { columns: userColumns.value, data: users.value, bordered: false, size: 'small' }),
            ])),
        ]));
    }
});

// ============================================================
// Utility
// ============================================================
function formatTime(t) {
    if (!t) return '';
    const d = new Date(t);
    if (Number.isNaN(d.getTime()) || d.getFullYear() < 2000) return '';
    return (d.getMonth()+1).toString().padStart(2,'0') + '-' +
           d.getDate().toString().padStart(2,'0') + ' ' +
           d.getHours().toString().padStart(2,'0') + ':' +
           d.getMinutes().toString().padStart(2,'0') + ':' +
           d.getSeconds().toString().padStart(2,'0');
}

function formatTimeShort(t) {
    if (!t) return '';
    const d = new Date(t);
    if (Number.isNaN(d.getTime()) || d.getFullYear() < 2000) return '';
    return d.getHours().toString().padStart(2,'0') + ':' +
           d.getMinutes().toString().padStart(2,'0') + ':' +
           d.getSeconds().toString().padStart(2,'0');
}

function isInvalidTime(t) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) || d.getFullYear() < 2000;
}

function truncate(s, n) {
    if (!s) return '';
    return s.length <= n ? s : s.substring(0, n) + '...';
}

function copyText(text) {
    function onDone() { window.$message && window.$message.success('已复制到剪贴板'); }
    function onFail() { window.$message && window.$message.error('复制失败'); }
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(onDone).catch(onFail);
    } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); onDone(); } catch { onFail(); }
        document.body.removeChild(ta);
    }
}

// --- RocketMQ ---
const RocketMQPage = defineComponent({
    setup() {
        const configs = ref([]);
        const loading = ref(true);
        const showModal = ref(false);
        const editingId = ref(null);
        const form = reactive({ name: '', dashboard_url: '', username: '', password: '', consumer_group: '', topic: '', threshold: 1000, interval_sec: 30, notify_new_msg: false });
        const saving = ref(false);
        const groupOptions = ref([]);
        const topicOptions = ref([]);
        const groupLoading = ref(false);
        const topicLoading = ref(false);
        const message = useMessage();

        async function fetchGroups() {
            if (!form.dashboard_url) return;
            groupLoading.value = true;
            try {
                const payload = editingId.value
                    ? { config_id: editingId.value }
                    : { dashboard_url: form.dashboard_url, username: form.username, password: form.password };
                const res = await api.post('/api/rocketmq/consumer-groups', payload);
                groupOptions.value = (res || []).map(g => ({ label: g, value: g }));
            } catch (e) { message.error('获取消费组失败: ' + (e.message || '')); }
            groupLoading.value = false;
        }
        async function fetchTopics() {
            if (!form.dashboard_url) return;
            topicLoading.value = true;
            try {
                const payload = editingId.value
                    ? { config_id: editingId.value }
                    : { dashboard_url: form.dashboard_url, username: form.username, password: form.password };
                const res = await api.post('/api/rocketmq/topics', payload);
                topicOptions.value = (res || []).map(t => ({ label: t, value: t }));
            } catch (e) { message.error('获取Topic失败: ' + (e.message || '')); }
            topicLoading.value = false;
        }

        async function load() {
            loading.value = true;
            try { configs.value = await api.get('/api/rocketmq'); } catch {}
            loading.value = false;
        }
        onMounted(load);

        function openAdd() {
            editingId.value = null;
            Object.assign(form, { name: '', dashboard_url: '', username: '', password: '', consumer_group: '', topic: '', threshold: 1000, interval_sec: 30, notify_new_msg: false });
            groupOptions.value = []; topicOptions.value = [];
            showModal.value = true;
        }
        function openEdit(row) {
            editingId.value = row.id;
            Object.assign(form, { name: row.name, dashboard_url: row.dashboard_url, username: row.username, password: '', consumer_group: row.consumer_group, topic: row.topic, threshold: row.threshold, interval_sec: row.interval_sec, notify_new_msg: !!row.notify_new_msg });
            groupOptions.value = []; topicOptions.value = [];
            showModal.value = true;
        }
        function openClone(row) {
            editingId.value = null;
            Object.assign(form, { name: row.name + ' (副本)', dashboard_url: row.dashboard_url, username: row.username, password: '', consumer_group: row.consumer_group, topic: row.topic, threshold: row.threshold, interval_sec: row.interval_sec, notify_new_msg: !!row.notify_new_msg });
            groupOptions.value = []; topicOptions.value = [];
            showModal.value = true;
        }
        async function save() {
            if (!form.name || !form.dashboard_url || !form.consumer_group || !form.topic) { message.error('请填写必填项'); return; }
            saving.value = true;
            try {
                if (editingId.value) await api.put('/api/rocketmq/' + editingId.value, form);
                else await api.post('/api/rocketmq', form);
                showModal.value = false;
                message.success(editingId.value ? '已更新' : '已创建');
                load();
            } catch (e) { message.error(e.message || '保存失败'); }
            saving.value = false;
        }
        async function del(row) {
            try { await api.del('/api/rocketmq/' + row.id); message.success('已删除'); load(); } catch (e) { message.error(e.message); }
        }
        async function toggle(row) {
            try { await api.post('/api/rocketmq/' + row.id + '/toggle'); load(); } catch (e) { message.error(e.message); }
        }
        async function test(row) {
            try {
                const res = await api.post('/api/rocketmq/' + row.id + '/test');
                res.ok ? message.success(res.message) : message.error(res.message);
            } catch (e) { message.error(e.message); }
        }

        const columns = useColumns([
            { title: '名称', key: 'name', width: 120 },
            { title: 'Dashboard', key: 'dashboard_url', ellipsis: { tooltip: true }, _hideOnMobile: true },
            { title: '消费组', key: 'consumer_group', width: 140, ellipsis: { tooltip: true } },
            { title: 'Topic', key: 'topic', width: 120, ellipsis: { tooltip: true }, _hideOnMobile: true },
            { title: '阈值', key: 'threshold', width: 80, _hideOnMobile: true },
            { title: '状态', key: 'status', width: 100, render: row => h(NSpace, { size: 4 }, () => [
                h(NTag, { size: 'small', type: row.enabled ? 'success' : 'default' }, () => row.enabled ? '启用' : '禁用'),
                row.running ? h(NBadge, { dot: true, type: 'success' }) : null,
            ])},
            { title: '操作', key: 'actions', width: _isMobile.value ? 180 : 300, render: row => h(NSpace, { size: 'small' }, () => [
                h(NButton, { size: 'tiny', secondary: true, onClick: () => openEdit(row) }, () => '编辑'),
                h(NButton, { size: 'tiny', secondary: true, onClick: () => openClone(row) }, () => '复制'),
                h(NButton, { size: 'tiny', secondary: true, onClick: () => toggle(row) }, () => row.enabled ? '禁用' : '启用'),
                h(NButton, { size: 'tiny', secondary: true, onClick: () => test(row) }, () => '测试'),
                h(NPopconfirm, { onPositiveClick: () => del(row) }, { trigger: () => h(NButton, { size: 'tiny', type: 'error', secondary: true }, () => '删除'), default: () => '确认删除？' }),
            ])},
        ]);

        const gridCols = computed(() => _isMobile.value ? 1 : 2);
        return () => h('div', { class: 'page-body' }, [
            h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px' }, [
                h('h3', { class: 'page-title' }, 'RocketMQ 监控'),
                h(NButton, { type: 'primary', size: 'small', onClick: openAdd }, () => '+ 新增'),
            ]),
            h(NDataTable, { columns: columns.value, data: configs.value, bordered: false, size: 'small', loading: loading.value, maxHeight: 'calc(100vh - 200px)', scrollX: _isMobile.value ? 500 : undefined }),
            h(NModal, { show: showModal.value, onUpdateShow: v => showModal.value = v, preset: 'card', title: editingId.value ? '编辑配置' : '新增配置', style: _isMobile.value ? 'width:95vw' : 'width:680px' }, () =>
                h(NGrid, { cols: gridCols.value, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '名称', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NInput, { value: form.name, onUpdateValue: v => form.name = v, placeholder: '如: 订单系统MQ' }))),
                    h(NGi, null, () => h(NFormItem, { label: 'Dashboard URL', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NInput, { value: form.dashboard_url, onUpdateValue: v => form.dashboard_url = v, placeholder: 'http://host:port' }))),
                    h(NGi, null, () => h(NFormItem, { label: '用户名', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NInput, { value: form.username, onUpdateValue: v => form.username = v, placeholder: '可选' }))),
                    h(NGi, null, () => h(NFormItem, { label: '密码', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NInput, { value: form.password, onUpdateValue: v => form.password = v, type: 'password', showPasswordOn: 'click', placeholder: editingId.value ? '留空不修改' : '可选' }))),
                    h(NGi, null, () => h(NFormItem, { label: '消费组', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NSpace, { align: 'center', size: 'small', wrap: false }, () => [
                        h(NSelect, { value: form.consumer_group, onUpdateValue: v => form.consumer_group = v, options: groupOptions.value, filterable: true, tag: true, placeholder: '选择或输入消费组', style: 'flex:1;min-width:0', loading: groupLoading.value }),
                        h(NButton, { size: 'small', secondary: true, loading: groupLoading.value, onClick: fetchGroups }, () => '获取'),
                    ]))),
                    h(NGi, null, () => h(NFormItem, { label: 'Topic', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NSpace, { align: 'center', size: 'small', wrap: false }, () => [
                        h(NSelect, { value: form.topic, onUpdateValue: v => form.topic = v, options: topicOptions.value, filterable: true, tag: true, placeholder: '选择或输入Topic', style: 'flex:1;min-width:0', loading: topicLoading.value }),
                        h(NButton, { size: 'small', secondary: true, loading: topicLoading.value, onClick: fetchTopics }, () => '获取'),
                    ]))),
                    h(NGi, null, () => h(NFormItem, { label: '堆积阈值', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NInputNumber, { value: form.threshold, onUpdateValue: v => form.threshold = v, min: 1, disabled: form.notify_new_msg }))),
                    h(NGi, null, () => h(NFormItem, { label: '检查间隔(秒)', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NInputNumber, { value: form.interval_sec, onUpdateValue: v => form.interval_sec = v, min: 5 }))),
                    h(NGi, { span: gridCols.value }, () => h(NFormItem, { labelPlacement: 'left', label: '有新消息即告警' }, () => h(NSpace, { align: 'center' }, () => [
                        h(NSwitch, { value: form.notify_new_msg, onUpdateValue: v => form.notify_new_msg = v }),
                        h('span', { style: 'color:#999;font-size:12px' }, form.notify_new_msg ? '每次检查有新消息时即发送告警（根据消息ID去重）' : '关闭：按堆积量阈值告警'),
                    ]))),
                    h(NGi, { span: gridCols.value }, () => h(NButton, { type: 'primary', block: true, loading: saving.value, onClick: save }, () => '保存')),
                ])
            ),
        ]);
    }
});

// --- RocketMQ Alerts ---
const RocketMQAlertsPage = defineComponent({
    setup() {
        const alerts = ref([]);
        const total = ref(0);
        const page = ref(1);
        const pageSize = 20;
        const loading = ref(true);
        const detailRow = ref(null);
        const showDetail = ref(false);
        const { connected, messages, stop } = useWebSocket('/ws/rocketmq-logs');
        onUnmounted(stop);

        async function load() {
            loading.value = true;
            try {
                const res = await api.get('/api/rocketmq/alerts?page=' + page.value + '&page_size=' + pageSize);
                alerts.value = res.data || [];
                total.value = res.total || 0;
            } catch {}
            loading.value = false;
        }
        onMounted(load);
        watch(page, load);

        // Live updates from WebSocket
        watch(() => messages.value.length, () => {
            const latest = messages.value[messages.value.length - 1];
            if (latest && latest.type === 'rocketmq_alert' && page.value === 1) {
                load();
            }
        });

        const columns = useColumns([
            { title: '时间', key: 'detected_at', width: 150, render: row => h('span', { style: 'font-size:12px;opacity:0.65' }, formatTime(row.detected_at)) },
            { title: '配置', key: 'config_name', width: 120 },
            { title: '消费组', key: 'consumer_group', width: 140, _hideOnMobile: true },
            { title: 'Topic', key: 'topic', width: 120 },
            { title: '堆积量', key: 'diff_total', width: 100, render: row => h(NText, { type: 'error', strong: true }, () => String(row.diff_total)) },
        ]);

        function onRowClick(row) {
            detailRow.value = row;
            showDetail.value = true;
        }

        const rowProps = (row) => ({ style: 'cursor:pointer', onClick: () => onRowClick(row) });

        return () => h('div', { class: 'page-body log-page-fit' }, [
            h('div', { class: 'log-page-header' }, [
                h('div', { style: 'display:flex;align-items:center;gap:12px' }, [
                    h('h3', { class: 'page-title' }, 'MQ 告警记录'),
                    h('div', { style: 'display:flex;align-items:center;gap:4px;font-size:12px;opacity:0.5' }, [
                        h('span', { class: connected.value ? 'ws-dot connected' : 'ws-dot disconnected' }),
                        connected.value ? '实时' : '离线'
                    ]),
                ]),
            ]),
            h('div', { class: 'log-page-table' }, [
                h(NDataTable, { columns: columns.value, data: alerts.value, bordered: false, size: 'small', loading: loading.value, flexHeight: true, style: 'height:100%', scrollX: _isMobile.value ? 400 : undefined, rowProps }),
            ]),
            total.value > pageSize ? h('div', { class: 'log-page-pagination' },
                h(NPagination, { page: page.value, pageSize, itemCount: total.value, onUpdatePage: p => page.value = p })
            ) : null,
            // Detail modal
            h(NModal, {
                show: showDetail.value, 'onUpdate:show': v => showDetail.value = v,
                preset: 'card', title: '告警详情',
                style: _isMobile.value ? 'width:95vw' : 'width:520px',
            }, () => detailRow.value ? h(NDescriptions, { bordered: true, column: 1, labelPlacement: 'top', size: 'small' }, () => [
                h(NDescriptionsItem, { label: '时间' }, () => formatTime(detailRow.value.detected_at)),
                h(NDescriptionsItem, { label: '配置' }, () => detailRow.value.config_name),
                h(NDescriptionsItem, { label: '消费组' }, () => detailRow.value.consumer_group),
                h(NDescriptionsItem, { label: 'Topic' }, () => detailRow.value.topic),
                h(NDescriptionsItem, { label: '堆积量' }, () => h(NText, { type: 'error', strong: true }, () => String(detailRow.value.diff_total))),
                detailRow.value.message_body ? h(NDescriptionsItem, { label: '消息详情' }, () => h('pre', { style: 'white-space:pre-wrap;word-break:break-all;font-family:var(--font-mono);font-size:12px;margin:0;max-height:400px;overflow:auto' }, detailRow.value.message_body)) : null,
            ]) : null),
        ]);
    }
});

// --- Audit Logs ---
const AuditLogsPage = defineComponent({
    setup() {
        const logs = ref([]);
        const total = ref(0);
        const page = ref(1);
        const pageSize = 50;
        const loading = ref(true);

        async function load() {
            loading.value = true;
            try {
                const res = await api.get('/api/audit-logs?page=' + page.value + '&page_size=' + pageSize);
                logs.value = res.data || [];
                total.value = res.total || 0;
            } catch {}
            loading.value = false;
        }
        onMounted(load);
        watch(page, load);

        const actionTagType = (action) => {
            const map = { create: 'success', update: 'warning', delete: 'error', toggle: 'info', login: 'success', logout: 'default' };
            return map[action] || 'default';
        };

        const columns = useColumns([
            { title: '时间', key: 'created_at', width: 150, render: row => h('span', { style: 'font-size:12px;opacity:0.65' }, formatTime(row.created_at)) },
            { title: '操作人', key: 'user', width: 100 },
            { title: '操作', key: 'action', width: 80, render: row => h(NTag, { type: actionTagType(row.action), size: 'small', bordered: false }, () => row.action) },
            { title: '对象', key: 'target', width: 100 },
            { title: '详情', key: 'detail', ellipsis: { tooltip: true } },
            { title: 'IP', key: 'ip', width: 130, _hideOnMobile: true },
        ]);

        return () => h('div', { class: 'page-body log-page-fit' }, [
            h('div', { class: 'log-page-header' }, [
                h('h3', { class: 'page-title' }, '操作记录'),
            ]),
            h('div', { class: 'log-page-table' }, [
                h(NDataTable, { columns: columns.value, data: logs.value, bordered: false, size: 'small', loading: loading.value, flexHeight: true, style: 'height:100%', scrollX: _isMobile.value ? 500 : undefined }),
            ]),
            total.value > pageSize ? h('div', { class: 'log-page-pagination' },
                h(NPagination, { page: page.value, pageSize, itemCount: total.value, onUpdatePage: p => page.value = p })
            ) : null,
        ]);
    }
});

// --- Health Checks ---
const HealthChecksPage = defineComponent({
    setup() {
        const checks = ref([]);
        const loading = ref(true);
        const showModal = ref(false);
        const editingId = ref(null);
        const message = useMessage();
        const form = reactive({
            name: '', url: '', method: 'GET', headers_json: '{}', body: '',
            expected_status: 200, expected_field: '', expected_value: '',
            alert_field: '', alert_strategy: 'threshold', alert_condition: 'gt', alert_value: '',
            alert_delta_value: '', alert_delta_percent: '', alert_consecutive: 1,
            alert_rules: [],
            trigger_actions: [],
            timeout_sec: 10, interval_sec: 30
        });

        async function load() {
            loading.value = true;
            try { checks.value = await api.get('/api/health-checks'); } catch {}
            loading.value = false;
        }
        onMounted(load);

        function openAdd() {
            editingId.value = null;
            Object.assign(form, { name: '', url: '', method: 'GET', headers_json: '{}', body: '', expected_status: 200, expected_field: '', expected_value: '', alert_field: '', alert_strategy: 'threshold', alert_condition: 'gt', alert_value: '', alert_delta_value: '', alert_delta_percent: '', alert_consecutive: 1, alert_rules: [], trigger_actions: [], timeout_sec: 10, interval_sec: 30 });
            showModal.value = true;
        }
        function openEdit(row) {
            editingId.value = row.id;
            const rules = parseAlertRules(row.alert_rules, row);
            Object.assign(form, { name: row.name, url: row.url, method: row.method, headers_json: row.headers_json || '{}', body: row.body || '', expected_status: row.expected_status, expected_field: row.expected_field || '', expected_value: row.expected_value || '', alert_field: row.alert_field || '', alert_strategy: row.alert_strategy || 'threshold', alert_condition: row.alert_condition || 'gt', alert_value: row.alert_value || '', alert_delta_value: row.alert_delta_value || '', alert_delta_percent: row.alert_delta_percent || '', alert_consecutive: row.alert_consecutive || 1, alert_rules: rules, trigger_actions: parseTriggerActions(row.trigger_actions), timeout_sec: row.timeout_sec, interval_sec: row.interval_sec });
            showModal.value = true;
        }
        function openClone(row) {
            editingId.value = null;
            const rules = parseAlertRules(row.alert_rules, row);
            Object.assign(form, { name: row.name + ' (副本)', url: row.url, method: row.method, headers_json: row.headers_json || '{}', body: row.body || '', expected_status: row.expected_status, expected_field: row.expected_field || '', expected_value: row.expected_value || '', alert_field: row.alert_field || '', alert_strategy: row.alert_strategy || 'threshold', alert_condition: row.alert_condition || 'gt', alert_value: row.alert_value || '', alert_delta_value: row.alert_delta_value || '', alert_delta_percent: row.alert_delta_percent || '', alert_consecutive: row.alert_consecutive || 1, alert_rules: rules, trigger_actions: parseTriggerActions(row.trigger_actions), timeout_sec: row.timeout_sec, interval_sec: row.interval_sec });
            showModal.value = true;
        }
        function normalizeAlertRule(rule) {
            const normalized = {
                name: rule.name || '',
                field: rule.field || rule.alert_field || '',
                strategy: rule.strategy || rule.alert_strategy || 'threshold',
                condition: rule.condition || rule.alert_condition || 'gt',
                value: rule.value || rule.alert_value || '',
                delta_value: rule.delta_value || rule.alert_delta_value || '',
                delta_percent: rule.delta_percent || rule.alert_delta_percent || '',
                consecutive: rule.consecutive || rule.alert_consecutive || 1,
            };
            normalized.value = normalizeRuleMetricInput(normalized.field, normalized.value);
            normalized.delta_value = normalizeRuleMetricInput(normalized.field, normalized.delta_value);
            return normalized;
        }
        function parseAlertRules(raw, row) {
            let parsed = [];
            if (Array.isArray(raw)) parsed = raw;
            else {
                try {
                    const value = JSON.parse(raw || '[]');
                    parsed = Array.isArray(value) ? value : [];
                } catch { parsed = []; }
            }
            parsed = parsed.map(normalizeAlertRule).filter(r => r.field);
            if (parsed.length === 0 && row && row.alert_field) {
                parsed.push(normalizeAlertRule({
                    name: row.alert_field,
                    field: row.alert_field,
                    strategy: row.alert_strategy,
                    condition: row.alert_condition,
                    value: row.alert_value,
                    delta_value: row.alert_delta_value,
                    delta_percent: row.alert_delta_percent,
                    consecutive: row.alert_consecutive,
                }));
            }
            return parsed;
        }
        function parseTriggerActions(raw) {
            if (Array.isArray(raw)) return raw;
            try {
                const parsed = JSON.parse(raw || '[]');
                return Array.isArray(parsed) ? parsed.map(normalizeTriggerAction) : [];
            } catch { return []; }
        }
        function normalizeTriggerAction(action) {
            return {
                name: action.name || '',
                type: action.type || 'command',
                command: action.command || '',
                url: action.url || '',
                method: action.method || 'GET',
                headers_json: action.headers_json || '{}',
                body: action.body || '',
                timeout_sec: action.timeout_sec || 30,
                notify_max_chars: action.notify_max_chars || 2000,
                enabled: action.enabled !== false,
            };
        }
        function payload() {
            const actions = (form.trigger_actions || []).map(normalizeTriggerAction).filter(a =>
                a.name || a.command || a.url
            );
            const rules = (form.alert_rules || []).map(normalizeAlertRule).filter(r => r.field);
            const firstRule = rules[0] || normalizeAlertRule({
                field: form.alert_field,
                strategy: form.alert_strategy,
                condition: form.alert_condition,
                value: form.alert_value,
                delta_value: form.alert_delta_value,
                delta_percent: form.alert_delta_percent,
                consecutive: form.alert_consecutive,
            });
            return {
                ...form,
                alert_rules: JSON.stringify(rules),
                alert_field: firstRule.field || '',
                alert_strategy: firstRule.strategy || 'threshold',
                alert_condition: firstRule.condition || 'gt',
                alert_value: firstRule.value || '',
                alert_delta_value: firstRule.delta_value || '',
                alert_delta_percent: firstRule.delta_percent || '',
                alert_consecutive: firstRule.consecutive || 1,
                trigger_actions: JSON.stringify(actions),
            };
        }
        async function save() {
            try {
                if (editingId.value) {
                    await api.put('/api/health-checks/' + editingId.value, payload());
                } else {
                    await api.post('/api/health-checks', payload());
                }
                showModal.value = false;
                load();
            } catch (e) { message.error(e.message || '保存失败'); }
        }
        async function toggle(row) {
            try { await api.post('/api/health-checks/' + row.id + '/toggle'); load(); } catch {}
        }
        async function test(row) {
            try {
                const res = await api.post('/api/health-checks/' + row.id + '/test');
                if (res.ok) message.success('状态: UP (' + res.latency_ms + 'ms)');
                else message.error('状态: DOWN - ' + (res.error || 'HTTP ' + res.http_status));
            } catch (e) { message.error(e.message); }
        }
        async function remove(row) {
            try { await api.del('/api/health-checks/' + row.id); load(); } catch {}
        }
        function addTriggerAction(type = 'command') {
            form.trigger_actions.push(normalizeTriggerAction({
                name: type === 'http' ? '抓取诊断接口' : '执行诊断命令',
                type,
                timeout_sec: 30,
            }));
        }
        function addPprofTemplate() {
            const templates = [
                ['抓取 heap', 'curl -s "http://localhost:8080/debug/pprof/heap" > /tmp/heap.pb.gz'],
                ['pprof top', 'go tool pprof -top -sample_index=inuse_space /tmp/heap.pb.gz'],
                ['pprof cum', 'go tool pprof -top -cum -sample_index=inuse_space /tmp/heap.pb.gz'],
                ['pprof traces', 'go tool pprof -traces -sample_index=inuse_space -nodefraction=0 /tmp/heap.pb.gz | head -120'],
            ];
            templates.forEach(([name, command]) => form.trigger_actions.push(normalizeTriggerAction({
                name, type: 'command', command, timeout_sec: 60, notify_max_chars: 2000,
            })));
        }
        function removeTriggerAction(index) {
            form.trigger_actions.splice(index, 1);
        }
        function addAlertRule(rule = {}) {
            form.alert_rules.push(normalizeAlertRule(rule));
        }
        function removeAlertRule(index) {
            form.alert_rules.splice(index, 1);
        }
        function addTTPOSMetricRules() {
            form.alert_rules.push(
                normalizeAlertRule({ name: 'heap 当前占用过高', field: 'data.heap_alloc_kb', strategy: 'sustained', condition: 'gt', value: '1000', consecutive: 3 }),
                normalizeAlertRule({ name: 'heap 对象数过高', field: 'data.heap_objects', strategy: 'sustained', condition: 'gt', value: '9000000', consecutive: 3 }),
                normalizeAlertRule({ name: 'goroutine 数过高', field: 'data.goroutines', strategy: 'sustained', condition: 'gt', value: '1500', consecutive: 3 }),
                normalizeAlertRule({ name: 'heap 持续上升', field: 'data.heap_alloc_kb', strategy: 'continuous_increase', condition: 'gt', value: '800', consecutive: 5 }),
                normalizeAlertRule({ name: '字体处理排队', field: 'data.imgFontSemaphore.semaphore_length', strategy: 'sustained', condition: 'gt', value: '0', consecutive: 2 }),
            );
        }

        const columns = useColumns([
            { title: '名称', key: 'name', width: 120 },
            { title: 'URL', key: 'url', ellipsis: { tooltip: true }, _hideOnMobile: true },
            { title: '方法', key: 'method', width: 70 },
            { title: '异常规则', key: 'alert_rule', width: 260, _hideOnMobile: true, render: row => {
                const rules = parseAlertRules(row.alert_rules, row);
                if (!rules.length) return h(NText, { depth: 3, style: 'font-size:12px' }, () => '-');
                if (rules.length > 1) return h(NText, { depth: 3, style: 'font-size:12px' }, () => rules.length + ' 条: ' + rules.map(r => r.name || r.field).join(' / '));
                return h(NText, { depth: 3, style: 'font-size:12px' }, () => formatAlertRule({ ...row, alert_field: rules[0].field, alert_strategy: rules[0].strategy, alert_condition: rules[0].condition, alert_value: rules[0].value, alert_delta_value: rules[0].delta_value, alert_delta_percent: rules[0].delta_percent, alert_consecutive: rules[0].consecutive }));
            } },
            { title: '触发', key: 'trigger_actions', width: 80, _hideOnMobile: true, render: row => {
                const actions = parseTriggerActions(row.trigger_actions);
                return actions.length ? h(NTag, { size: 'small', type: 'warning', bordered: false }, () => actions.length + ' 个') : h(NText, { depth: 3 }, () => '-');
            }},
            { title: '间隔', key: 'interval_sec', width: 70, render: row => row.interval_sec + 's', _hideOnMobile: true },
            { title: '状态', key: 'enabled', width: 100, render: row => h('div', { style: 'display:flex;gap:4px' }, [
                h(NTag, { type: row.enabled ? 'success' : 'default', size: 'small', bordered: false }, () => row.enabled ? '启用' : '停用'),
                row.running ? h(NTag, { type: 'info', size: 'small', bordered: false }, () => '运行中') : null,
            ])},
            { title: '操作', key: 'actions', width: 280, render: row => h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' }, [
                h(NButton, { size: 'tiny', secondary: true, onClick: () => openEdit(row) }, () => '编辑'),
                h(NButton, { size: 'tiny', secondary: true, onClick: () => openClone(row) }, () => '复制'),
                h(NButton, { size: 'tiny', secondary: true, type: row.enabled ? 'warning' : 'success', onClick: () => toggle(row) }, () => row.enabled ? '禁用' : '启用'),
                h(NButton, { size: 'tiny', secondary: true, type: 'info', onClick: () => test(row) }, () => '测试'),
                h(NPopconfirm, { onPositiveClick: () => remove(row) }, { trigger: () => h(NButton, { size: 'tiny', secondary: true, type: 'error' }, () => '删除'), default: () => '确认删除？' }),
            ])},
        ]);

        const methodOptions = [
            { label: 'GET', value: 'GET' },
            { label: 'POST', value: 'POST' },
            { label: 'PUT', value: 'PUT' },
            { label: 'HEAD', value: 'HEAD' },
        ];
        const alertConditionOptions = [
            { label: '> 大于', value: 'gt' },
            { label: '>= 大于等于', value: 'gte' },
            { label: '< 小于', value: 'lt' },
            { label: '<= 小于等于', value: 'lte' },
            { label: '== 等于', value: 'eq' },
            { label: '!= 不等于', value: 'ne' },
            { label: '包含', value: 'contains' },
            { label: '不包含', value: 'not_contains' },
            { label: '为空', value: 'empty' },
            { label: '不为空', value: 'not_empty' },
        ];
        const alertStrategyOptions = [
            { label: '单次阈值', value: 'threshold' },
            { label: '连续命中阈值', value: 'sustained' },
            { label: '突增', value: 'increase' },
            { label: '连续上升', value: 'continuous_increase' },
        ];
        const ruleNeedsValue = rule => !['empty', 'not_empty'].includes(rule.condition);
        const ruleUsesThreshold = rule => ['threshold', 'sustained', 'increase', 'continuous_increase'].includes(rule.strategy);
        const ruleUsesDelta = rule => rule.strategy === 'increase';
        const ruleUsesConsecutive = rule => ['sustained', 'continuous_increase'].includes(rule.strategy);
        const isKBMetricField = field => /(^|\.)[^.]+_kb$/.test(String(field || ''));
        function normalizeRuleMetricInput(field, value) {
            if (!isKBMetricField(field) || value === '' || value == null) return value || '';
            const raw = String(value).replace(/,/g, '');
            if (raw === '1024000') return '1000';
            if (raw === '150000000') return '1000';
            if (raw === '819200') return '800';
            if (raw === '1500000') return '1464.84';
            if (raw === '1200000') return '1171.88';
            return String(value);
        }
        function formatRuleMetricValue(field, value) {
            if (value === '' || value == null) return '';
            const numeric = Number(String(value).replace(/,/g, ''));
            if (!Number.isFinite(numeric)) return value;
            if (isKBMetricField(field)) return formatNumber(numeric) + ' MB';
            return formatNumber(numeric);
        }
        function ruleInputValue(rule, key = 'value') {
            return normalizeRuleMetricInput(rule.field, rule[key]);
        }
        function setRuleInputValue(rule, value, key = 'value') {
            rule[key] = value == null ? '' : String(value);
        }
        function ruleValuePlaceholder(rule) {
            return isKBMetricField(rule.field) ? '当前值阈值，单位 MB，如 1000' : (rule.strategy === 'threshold' || rule.strategy === 'sustained' ? '当前值阈值，如 2000' : '当前值阈值，可选');
        }
        function ruleValueInput(rule, key = 'value', placeholder = '') {
            const input = h(NInput, { value: ruleInputValue(rule, key), onUpdateValue: v => setRuleInputValue(rule, v, key), placeholder });
            if (!isKBMetricField(rule.field)) return input;
            return h(NInputGroup, null, () => [
                input,
                h(NButton, { disabled: true, secondary: true, style: 'width:64px;pointer-events:none' }, () => 'MB'),
            ]);
        }
        function formatAlertRule(row) {
            const strategyLabels = { threshold: '单次', sustained: '连续命中', increase: '突增', continuous_increase: '连续上升' };
            const strategy = row.alert_strategy || 'threshold';
            let text = (strategyLabels[strategy] || strategy) + ': ' + row.alert_field;
            if (strategy === 'increase') {
                const parts = [];
                if (row.alert_delta_value) parts.push('涨幅>=' + formatRuleMetricValue(row.alert_field, row.alert_delta_value));
                if (row.alert_delta_percent) parts.push('涨幅率>=' + row.alert_delta_percent + '%');
                if (row.alert_value) parts.push((row.alert_condition || 'gt') + ' ' + formatRuleMetricValue(row.alert_field, row.alert_value));
                return text + ' ' + (parts.join(' 且/或 ') || '比上次上升');
            }
            if (strategy === 'continuous_increase') {
                text += ' 连续上升 ' + (row.alert_consecutive || 1) + ' 次';
                if (row.alert_value) text += ' 且 ' + (row.alert_condition || 'gt') + ' ' + formatRuleMetricValue(row.alert_field, row.alert_value);
                return text;
            }
            if (strategy === 'sustained') {
                return text + ' ' + (row.alert_condition || 'gt') + ' ' + formatRuleMetricValue(row.alert_field, row.alert_value || '') + ' 连续 ' + (row.alert_consecutive || 1) + ' 次';
            }
            return text + ' ' + (row.alert_condition || 'gt') + ' ' + formatRuleMetricValue(row.alert_field, row.alert_value || '');
        }
        const triggerActionTypeOptions = [
            { label: '命令', value: 'command' },
            { label: 'HTTP', value: 'http' },
        ];
        function baseHealthFields() {
            return [
                h(NFormItem, { label: '名称' }, () => h(NInput, { value: form.name, onUpdateValue: v => form.name = v, placeholder: '服务名称' })),
                h(NFormItem, { label: 'URL' }, () => h(NInput, { value: form.url, onUpdateValue: v => form.url = v, placeholder: 'https://example.com/health' })),
                h(NGrid, { cols: _isMobile.value ? 1 : 2, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '方法' }, () => h(NSelect, { value: form.method, onUpdateValue: v => form.method = v, options: methodOptions }))),
                    h(NGi, null, () => h(NFormItem, { label: '期望状态码' }, () => h(NInputNumber, { value: form.expected_status, onUpdateValue: v => form.expected_status = v, min: 100, max: 599, style: 'width:100%' }))),
                ]),
                h(NFormItem, { label: '请求头' }, () => h(NInput, { type: 'textarea', value: form.headers_json, onUpdateValue: v => form.headers_json = v, placeholder: '{"Authorization": "Bearer token"}', rows: 3 })),
                form.method !== 'GET' && form.method !== 'HEAD' ? h(NFormItem, { label: '请求体' }, () => h(NInput, { type: 'textarea', value: form.body, onUpdateValue: v => form.body = v, placeholder: '请求体内容', rows: 3 })) : null,
                h(NDivider, { style: 'margin:16px 0' }),
                h(NFormItem, { label: '期望字段' }, () => h(NInput, { value: form.expected_field, onUpdateValue: v => form.expected_field = v, placeholder: '如: code 或 data.status，留空则只检查状态码' })),
                h(NFormItem, { label: '期望值' }, () => h(NInput, { value: form.expected_value, onUpdateValue: v => form.expected_value = v, placeholder: '如: 0, UP, ok' })),
                h(NDivider, { style: 'margin:16px 0' }),
                h(NGrid, { cols: _isMobile.value ? 1 : 2, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '超时(秒)' }, () => h(NInputNumber, { value: form.timeout_sec, onUpdateValue: v => form.timeout_sec = v, min: 1, max: 300, style: 'width:100%' }))),
                    h(NGi, null, () => h(NFormItem, { label: '间隔(秒)' }, () => h(NInputNumber, { value: form.interval_sec, onUpdateValue: v => form.interval_sec = v, min: 5, max: 3600, style: 'width:100%' }))),
                ]),
            ];
        }
        function triggerActionFields() {
            return [
                h(NFormItem, { label: '触发操作' }, () => h('div', { style: 'width:100%;display:flex;flex-direction:column;gap:10px' }, [
                    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
                        h(NButton, { size: 'small', secondary: true, onClick: () => addTriggerAction('command') }, () => '+ 命令'),
                        h(NButton, { size: 'small', secondary: true, onClick: () => addTriggerAction('http') }, () => '+ HTTP'),
                        h(NButton, { size: 'small', secondary: true, type: 'warning', onClick: addPprofTemplate }, () => '+ pprof模板'),
                    ]),
                    (form.trigger_actions || []).length === 0 ? h(NText, { depth: 3, style: 'font-size:12px' }, () => '异常首次命中时执行；恢复后再次异常会重新执行。') : null,
                    ...(form.trigger_actions || []).map((action, index) => h('div', { style: 'border:1px solid rgba(128,128,128,.22);border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:8px' }, [
                        h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap' }, [
                            h('div', { style: _isMobile.value ? 'display:flex;flex-direction:column;gap:8px;flex:1 1 100%;min-width:0' : 'display:grid;grid-template-columns:minmax(150px,1fr) 132px 118px 150px;gap:8px;align-items:end;flex:1 1 auto;min-width:0' }, [
                                h(NInput, { value: action.name, onUpdateValue: v => action.name = v, placeholder: '动作名称' }),
                                h(NSelect, { value: action.type, onUpdateValue: v => action.type = v, options: triggerActionTypeOptions }),
                                h('div', { style: 'display:flex;flex-direction:column;gap:4px;min-width:0' }, [
                                    h(NText, { depth: 3, style: 'font-size:12px;line-height:1' }, () => '超时(秒)'),
                                    h(NInputNumber, { value: action.timeout_sec, onUpdateValue: v => action.timeout_sec = v, min: 1, max: 300, style: 'width:100%' }),
                                ]),
                                h('div', { style: 'display:flex;flex-direction:column;gap:4px;min-width:0' }, [
                                    h(NText, { depth: 3, style: 'font-size:12px;line-height:1' }, () => '飞书截断字数'),
                                    h(NInputNumber, { value: action.notify_max_chars, onUpdateValue: v => action.notify_max_chars = v, min: 100, max: 50000, step: 100, style: 'width:100%' }),
                                ]),
                            ]),
                            h('div', { style: 'display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:0 0 auto;padding-bottom:2px' }, [
                                h(NSwitch, { value: action.enabled !== false, onUpdateValue: v => action.enabled = v, size: 'small' }),
                                h(NButton, { size: 'tiny', secondary: true, type: 'error', onClick: () => removeTriggerAction(index) }, () => '删除'),
                            ]),
                        ]),
                        action.type === 'http' ? h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, [
                            h(NInputGroup, null, () => [
                                h(NSelect, { value: action.method || 'GET', onUpdateValue: v => action.method = v, options: methodOptions, style: 'width:110px' }),
                                h(NInput, { value: action.url, onUpdateValue: v => action.url = v, placeholder: 'http://host/path' }),
                            ]),
                            h(NInput, { type: 'textarea', value: action.headers_json || '{}', onUpdateValue: v => action.headers_json = v, placeholder: '请求头 JSON', rows: 2 }),
                            action.method !== 'GET' && action.method !== 'HEAD' ? h(NInput, { type: 'textarea', value: action.body || '', onUpdateValue: v => action.body = v, placeholder: '请求体', rows: 2 }) : null,
                        ]) : h(NInput, { type: 'textarea', value: action.command, onUpdateValue: v => action.command = v, placeholder: '如: go tool pprof -top -sample_index=inuse_space /tmp/heap.pb.gz', rows: 3 }),
                    ])),
                ])),
            ];
        }
        function alertHealthFields() {
            return [
                h(NFormItem, { label: '异常规则' }, () => h('div', { style: 'width:100%;display:flex;flex-direction:column;gap:10px' }, [
                    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
                        h(NButton, { size: 'small', secondary: true, onClick: () => addAlertRule({ name: '新规则', strategy: 'sustained', condition: 'gt', consecutive: 3 }) }, () => '+ 规则'),
                        h(NButton, { size: 'small', secondary: true, type: 'info', onClick: addTTPOSMetricRules }, () => '+ ttpos模板'),
                    ]),
                    (form.alert_rules || []).length === 0 ? h(NText, { depth: 3, style: 'font-size:12px' }, () => '可添加多条规则；任意一条命中都会告警。') : null,
                    ...(form.alert_rules || []).map((rule, index) => h('div', { style: 'border:1px solid rgba(128,128,128,.22);border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:8px' }, [
                        h(NGrid, { cols: _isMobile.value ? 1 : 2, xGap: 8, yGap: 8 }, () => [
                            h(NGi, null, () => h(NInput, { value: rule.name, onUpdateValue: v => rule.name = v, placeholder: '规则名称，如 heap 当前占用过高' })),
                            h(NGi, null, () => h(NInput, { value: rule.field, onUpdateValue: v => rule.field = v, placeholder: '字段，如 data.heap_alloc_kb' })),
                            h(NGi, null, () => h(NSelect, { value: rule.strategy, onUpdateValue: v => rule.strategy = v, options: alertStrategyOptions })),
                            ruleUsesThreshold(rule) ? h(NGi, null, () => h(NSelect, { value: rule.condition, onUpdateValue: v => rule.condition = v, options: alertConditionOptions })) : null,
                            ruleUsesThreshold(rule) && ruleNeedsValue(rule) ? h(NGi, null, () => ruleValueInput(rule, 'value', ruleValuePlaceholder(rule))) : null,
                            ruleUsesDelta(rule) ? h(NGi, null, () => ruleValueInput(rule, 'delta_value', isKBMetricField(rule.field) ? '变化量>=，单位 MB，如 200' : '变化量>=，如 500')) : null,
                            ruleUsesDelta(rule) ? h(NGi, null, () => h(NInput, { value: rule.delta_percent, onUpdateValue: v => rule.delta_percent = v, placeholder: '变化率>=，如 30' })) : null,
                            ruleUsesConsecutive(rule) ? h(NGi, null, () => h(NInputNumber, { value: rule.consecutive, onUpdateValue: v => rule.consecutive = v, min: 1, max: 100, style: 'width:100%', placeholder: '连续次数' })) : null,
                        ]),
                        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' }, [
                            h(NText, { depth: 3, style: 'font-size:12px' }, () => {
                                if (rule.strategy === 'increase') return '突增：与上一次采样比较；变化量和变化率任一满足即可。';
                                if (rule.strategy === 'continuous_increase') return '连续上升：连续多次比上一次采样更高，可叠加当前值阈值。';
                                if (rule.strategy === 'sustained') return '连续命中阈值：连续多次满足条件才告警。';
                                return '单次阈值：本次满足条件即告警。';
                            }),
                            h(NButton, { size: 'tiny', secondary: true, type: 'error', onClick: () => removeAlertRule(index) }, () => '删除'),
                        ]),
                    ])),
                ])),
                h(NDivider, { style: 'margin:8px 0 16px' }),
                ...triggerActionFields(),
            ];
        }

        return () => h('div', { class: 'page-body' }, [
            h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px' }, [
                h('h3', { class: 'page-title' }, '健康检查'),
                h(NButton, { type: 'primary', size: 'small', onClick: openAdd }, () => '+ 添加'),
            ]),
            h(NDataTable, { columns: columns.value, data: checks.value, bordered: false, size: 'small', loading: loading.value, maxHeight: 'calc(100vh - 200px)', scrollX: _isMobile.value ? 500 : undefined }),
            h(NModal, { show: showModal.value, 'onUpdate:show': v => showModal.value = v, preset: 'card', title: editingId.value ? '编辑健康检查' : '添加健康检查', style: _isMobile.value ? 'width:95vw' : 'width:1520px;max-width:98vw', segmented: true }, () =>
                h(NForm, { labelPlacement: _isMobile.value ? 'top' : 'left', labelWidth: _isMobile.value ? undefined : 100 }, () => [
                    h(NGrid, { cols: _isMobile.value ? 1 : 2, xGap: 24, yGap: 0 }, () => [
                        h(NGi, null, () => h('div', { style: 'min-width:0' }, baseHealthFields())),
                        h(NGi, null, () => h('div', { style: 'min-width:0' }, alertHealthFields())),
                    ]),
                    h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid rgba(128,128,128,.2)' }, [
                        h(NButton, { onClick: () => showModal.value = false }, () => '取消'),
                        h(NButton, { type: 'primary', onClick: save }, () => '保存'),
                    ]),
                ])
            ),
        ]);
    }
});

// --- Health Check Logs ---
const HealthCheckLogsPage = defineComponent({
    setup() {
        const logs = ref([]);
        const total = ref(0);
        const page = ref(1);
        const pageSize = 20;
        const loading = ref(true);
        const showDetail = ref(false);
        const detailRow = ref(null);
        const detailFieldsExpanded = ref(false);
        const { connected, messages, stop } = useWebSocket('/ws/healthcheck-logs');
        onUnmounted(stop);

        async function load() {
            loading.value = true;
            try {
                const res = await api.get('/api/health-checks/logs?page=' + page.value + '&page_size=' + pageSize);
                logs.value = res.data || [];
                total.value = res.total || 0;
            } catch {}
            loading.value = false;
        }
        onMounted(load);
        watch(page, load);

        // Live updates
        watch(() => messages.value.length, () => {
            const latest = messages.value[messages.value.length - 1];
            if (latest && (latest.type === 'healthcheck_success' || latest.type === 'healthcheck_error') && page.value === 1) {
                load();
            }
        });

        function openDetail(row) {
            detailRow.value = row;
            detailFieldsExpanded.value = false;
            showDetail.value = true;
        }
        const rowProps = row => ({
            style: 'cursor:pointer',
            onClick: () => openDetail(row),
        });
        const responseFieldDescriptions = {
            code: '业务状态码，通常 0 表示接口调用成功。',
            message: '接口返回消息，用来快速判断接口层是否成功。',
            'data.alloc_kb': '当前已分配且仍在使用的堆内存，按 MB 展示，通常等同 heap_alloc_kb。',
            'data.heap_alloc_kb': 'Go 堆上当前仍被对象占用的内存，按 MB 展示，是观察进程内存压力的核心指标。',
            'data.heap_inuse_kb': '已经从系统拿到并正在被堆使用的内存页，按 MB 展示。',
            'data.heap_idle_kb': '堆中空闲但尚未全部归还系统的内存，按 MB 展示。',
            'data.heap_released_kb': '已经归还给操作系统的堆内存，按 MB 展示。',
            'data.heap_sys_kb': 'Go 堆从操作系统申请到的总内存，按 MB 展示。',
            'data.heap_objects': '当前堆上存活对象数量。持续上涨通常说明对象未释放或缓存增长。',
            'data.goroutines': '当前 goroutine 数量。异常上涨可能说明协程泄漏、请求阻塞或后台任务堆积。',
            'data.gc_cpu_fraction': 'GC 消耗 CPU 的比例。持续偏高说明 GC 压力较大。',
            'data.gc_cycles': 'GC 周期数。',
            'data.num_gc': 'GC 执行次数。',
            'data.next_gc_kb': '下次触发 GC 的堆目标值，按 MB 展示。',
            'data.total_alloc_kb': '进程启动以来累计分配的内存，按 MB 展示，只增不减。',
            'data.sys_kb': 'Go runtime 从系统申请的总内存，按 MB 展示。',
            'data.stack_inuse_kb': 'goroutine 栈当前使用内存，按 MB 展示。',
            'data.stack_sys_kb': 'goroutine 栈从系统申请的内存，按 MB 展示。',
            'data.mspan_inuse_kb': 'runtime mspan 元数据当前使用内存，按 MB 展示。',
            'data.mspan_sys_kb': 'runtime mspan 元数据系统内存，按 MB 展示。',
            'data.mcache_inuse_kb': 'runtime mcache 当前使用内存，按 MB 展示。',
            'data.mcache_sys_kb': 'runtime mcache 系统内存，按 MB 展示。',
            'data.gcsys_kb': 'GC 元数据占用的系统内存，按 MB 展示。',
            'data.other_sys_kb': '其他 runtime 系统内存，按 MB 展示。',
            'data.pause_total_ns': 'GC 累计暂停时间，单位纳秒。',
            'data.num_forced_gc': '手动触发 GC 的次数。',
            'data.enable_gc': 'GC 是否启用。',
            'data.debug_gc': '是否开启 GC 调试。',
            'data.imgFontSemaphore.active_count': '图片/字体处理当前活跃任务数。',
            'data.imgFontSemaphore.available': '图片/字体处理可用并发额度。',
            'data.imgFontSemaphore.max_concurrent': '图片/字体处理最大并发数。',
            'data.imgFontSemaphore.semaphore_length': '图片/字体处理等待队列长度，大于 0 表示有排队堵塞。',
            'data.imgFontSemaphore.memory_usage': '图片/字体相关缓存或处理占用内存，按 MB 展示。',
            'data.imgFontSemaphore.font_count': '已加载字体数量。',
            'data.imgFontSemaphore.access_cache_count': '访问缓存条目数量。',
            'data.imgFontSemaphore.width_cache_count': '宽度缓存条目数量。',
        };
        function parseLogJSON(text) {
            const raw = String(text || '').trim();
            if (!raw) return { text: '', json: null };
            if (!(raw.startsWith('{') || raw.startsWith('['))) return { text: raw, json: null };
            try {
                const json = JSON.parse(raw);
                return { text: JSON.stringify(json, null, 2), json };
            } catch {
                return { text: raw, json: null };
            }
        }
        function flattenJSONFields(value, prefix = '', out = []) {
            if (value == null || typeof value !== 'object') {
                if (prefix) out.push({ path: prefix, value });
                return out;
            }
            if (Array.isArray(value)) {
                out.push({ path: prefix || '[]', value: '[' + value.length + ' items]' });
                return out;
            }
            Object.keys(value).forEach(key => {
                const path = prefix ? prefix + '.' + key : key;
                flattenJSONFields(value[key], path, out);
            });
            return out;
        }
        function formatNumberWithUnit(value, divisor, unit) {
            const n = Number(value);
            if (!Number.isFinite(n)) return String(value);
            return (n / divisor).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ' + unit;
        }
        function formatFieldValue(path, value) {
            if (value == null) return '-';
            if (typeof value === 'number' && /_kb$/.test(path)) return formatNumberWithUnit(value, 1024, 'MB');
            if (typeof value === 'number' && path === 'data.imgFontSemaphore.memory_usage') return formatNumberWithUnit(value, 1024 * 1024, 'MB');
            if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : String(value);
            if (typeof value === 'boolean') return value ? 'true' : 'false';
            return String(value);
        }
        const defaultResponseDescriptionPaths = [
            'data.heap_alloc_kb',
            'data.heap_objects',
            'data.goroutines',
            'data.heap_inuse_kb',
            'data.heap_idle_kb',
            'data.heap_released_kb',
            'data.gc_cpu_fraction',
            'data.total_alloc_kb',
            'data.imgFontSemaphore.semaphore_length',
            'data.imgFontSemaphore.active_count',
            'data.imgFontSemaphore.available',
            'data.imgFontSemaphore.memory_usage',
        ];
        function fieldDescriptionBlock(json, responseText, maxHeight = 260) {
            if (!json && !String(responseText || '').trim()) return null;
            let rows = json ? flattenJSONFields(json)
                .filter(item => responseFieldDescriptions[item.path])
                .slice(0, 80) : [];
            if (!rows.length) {
                rows = defaultResponseDescriptionPaths.map(path => ({ path, value: '-' }));
            }
            const expanded = detailFieldsExpanded.value;
            return h('div', { style: 'display:flex;flex-direction:column;gap:6px;min-width:0' }, [
                h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:8px' }, [
                    h('div', { style: 'font-weight:600' }, '字段说明'),
                    h(NButton, { size: 'tiny', secondary: true, onClick: () => detailFieldsExpanded.value = !detailFieldsExpanded.value }, () => expanded ? '收起' : '展开'),
                ]),
                expanded ? h('div', { style: `max-height:${maxHeight}px;overflow:auto;border:1px solid rgba(128,128,128,.18);border-radius:6px;background:rgba(128,128,128,.05)` }, [
                    h('table', { style: 'width:100%;border-collapse:collapse;font-size:12px;line-height:1.45' }, [
                        h('tbody', null, rows.map(item => h('tr', { style: 'border-bottom:1px solid rgba(128,128,128,.12)' }, [
                            h('td', { style: 'width:34%;vertical-align:top;padding:7px 8px;font-family:var(--font-mono);color:#63e2b7;word-break:break-word' }, item.path),
                            h('td', { style: 'width:18%;vertical-align:top;padding:7px 8px;font-family:var(--font-mono);opacity:.85;word-break:break-word' }, formatFieldValue(item.path, item.value)),
                            h('td', { style: 'vertical-align:top;padding:7px 8px;opacity:.82;word-break:break-word' }, responseFieldDescriptions[item.path]),
                        ]))),
                    ]),
                ]) : null,
            ]);
        }
        function detailSections(row) {
            let error = String(row?.error || '');
            let diagnostic = String(row?.diagnostic_output || '');
            const response = parseLogJSON(row?.response);
            const markers = ['\n\n诊断输出:\n', '\n诊断输出:\n', '诊断输出:\n'];
            if (!diagnostic) {
                for (const marker of markers) {
                    const index = error.indexOf(marker);
                    if (index >= 0) {
                        diagnostic = error.slice(index + marker.length);
                        error = error.slice(0, index);
                        break;
                    }
                }
            }
            return {
                error: error.trim(),
                diagnostic: diagnostic.trim(),
                response: response.text,
                responseJSON: response.json,
            };
        }
        function logBlock(text, maxHeight = 360, fill = false) {
            const sizeStyle = fill ? 'flex:1;min-height:0;overflow:auto' : `max-height:${maxHeight}px;overflow:auto`;
            return h('pre', { style: `white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-size:12px;line-height:1.55;margin:0;${sizeStyle};background:rgba(128,128,128,.08);border:1px solid rgba(128,128,128,.18);border-radius:6px;padding:10px` }, text || '-');
        }
        function sectionBlock(title, text, maxHeight = 360, emptyText = '-', fill = false) {
            return h('div', { style: `display:flex;flex-direction:column;gap:6px;min-width:0;${fill ? 'flex:1;min-height:0' : ''}` }, [
                h('div', { style: 'font-weight:600' }, title),
                logBlock(text || emptyText, maxHeight, fill),
            ]);
        }
        function renderDetail() {
            if (!detailRow.value) return null;
            const sections = detailSections(detailRow.value);
            const shellStyle = _isMobile.value
                ? 'display:flex;flex-direction:column;gap:14px;max-height:calc(100vh - 180px);overflow:auto'
                : 'display:grid;grid-template-columns:minmax(0,0.95fr) minmax(0,1.05fr);gap:16px;align-items:stretch;height:calc(100vh - 190px);overflow:hidden';
            const panelStyle = _isMobile.value
                ? 'display:flex;flex-direction:column;gap:14px;min-width:0'
                : 'display:flex;flex-direction:column;gap:14px;min-width:0;min-height:0;overflow:auto;padding-right:2px';
            return h('div', { style: shellStyle }, [
                h('div', { style: panelStyle }, [
                    h(NDescriptions, { bordered: true, column: 2, labelPlacement: 'top', size: 'small' }, () => [
                        h(NDescriptionsItem, { label: '时间' }, () => formatTime(detailRow.value.detected_at)),
                        h(NDescriptionsItem, { label: '服务' }, () => detailRow.value.check_name || '-'),
                        h(NDescriptionsItem, { label: '状态' }, () => h(NTag, { type: detailRow.value.status === 'up' ? 'success' : 'error', size: 'small', bordered: false }, () => (detailRow.value.status || '').toUpperCase())),
                        h(NDescriptionsItem, { label: 'HTTP' }, () => String(detailRow.value.http_status || 0)),
                        h(NDescriptionsItem, { label: '延迟' }, () => (detailRow.value.latency_ms || 0) + 'ms'),
                        h(NDescriptionsItem, { label: '日志ID' }, () => String(detailRow.value.id || '-')),
                    ]),
                    sectionBlock('响应 / 规则跟踪', sections.response, 240),
                    fieldDescriptionBlock(sections.responseJSON, sections.response, 260),
                ]),
                h('div', { style: panelStyle }, [
                    sectionBlock('错误', sections.error, 260),
                    sectionBlock('诊断输出', sections.diagnostic, 720, '本条日志没有保存诊断输出。只有配置了触发操作并命中首次异常时，才会写入这里。', !_isMobile.value),
                ]),
            ]);
        }

        const columns = useColumns([
            { title: '时间', key: 'detected_at', width: 150, render: row => h('span', { style: 'font-size:12px;opacity:0.65' }, formatTime(row.detected_at)) },
            { title: '服务', key: 'check_name', width: 120 },
            { title: '状态', key: 'status', width: 80, render: row => h(NTag, { type: row.status === 'up' ? 'success' : 'error', size: 'small', bordered: false }, () => row.status.toUpperCase()) },
            { title: 'HTTP', key: 'http_status', width: 70, _hideOnMobile: true },
            { title: '延迟', key: 'latency_ms', width: 80, render: row => row.latency_ms + 'ms' },
            { title: '错误', key: 'error', ellipsis: { tooltip: true }, _hideOnMobile: true, render: row => row.error ? h('span', { style: 'cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px', onClick: e => { e.stopPropagation(); openDetail(row); } }, truncate(row.error.replace(/\n/g, ' / '), 120)) : h(NText, { depth: 3 }, () => '-') },
        ]);

        return () => h('div', { class: 'page-body log-page-fit' }, [
            h('div', { class: 'log-page-header' }, [
                h('div', { style: 'display:flex;align-items:center;gap:12px' }, [
                    h('h3', { class: 'page-title' }, '检查日志'),
                    h('div', { style: 'display:flex;align-items:center;gap:4px;font-size:12px;opacity:0.5' }, [
                        h('span', { class: connected.value ? 'ws-dot connected' : 'ws-dot disconnected' }),
                        connected.value ? '实时' : '离线'
                    ]),
                ]),
            ]),
            h('div', { class: 'log-page-table' }, [
                h(NDataTable, { columns: columns.value, data: logs.value, bordered: false, size: 'small', loading: loading.value, flexHeight: true, style: 'height:100%', scrollX: _isMobile.value ? 400 : undefined, rowProps }),
            ]),
            total.value > pageSize ? h('div', { class: 'log-page-pagination' },
                h(NPagination, { page: page.value, pageSize, itemCount: total.value, onUpdatePage: p => page.value = p })
            ) : null,
            h(NModal, { show: showDetail.value, 'onUpdate:show': v => showDetail.value = v, preset: 'card', title: '检查日志详情', style: _isMobile.value ? 'width:95vw' : 'width:1280px;max-width:94vw', segmented: true }, () => renderDetail()),
        ]);
    }
});

// --- Grafana ---
const GrafanaPage = defineComponent({
    setup() {
        const configs = ref([]);
        const ruleDefs = ref([]);
        const loading = ref(true);
        const showModal = ref(false);
        const editingId = ref(null);
        const form = reactive({ name: '', grafana_url: '', username: '', password: '', datasource_uid: '', auto_rules: [], webhook_url: '', webhook_secret: '', interval_sec: 60 });
        const saving = ref(false);
        const provisioning = ref(null);
        const datasources = ref([]);
        const dsLoading = ref(false);
        const message = useMessage();

        async function fetchDatasources() {
            dsLoading.value = true;
            try {
                let res;
                if (editingId.value) {
                    res = await api.get('/api/grafana/' + editingId.value + '/datasources');
                } else {
                    if (!form.grafana_url || !form.username) { dsLoading.value = false; return; }
                    res = await api.post('/api/grafana/datasources', { grafana_url: form.grafana_url, username: form.username, password: form.password });
                }
                datasources.value = (res || []).map(d => ({ label: d.name + ' (' + d.uid + ')', value: d.uid }));
            } catch (e) { message.error('获取数据源失败: ' + (e.message || '')); }
            dsLoading.value = false;
        }

        async function load() {
            loading.value = true;
            try { configs.value = await api.get('/api/grafana'); } catch {}
            loading.value = false;
        }
        async function loadRuleDefs() {
            try { ruleDefs.value = await api.get('/api/grafana/rule-defs'); } catch {}
        }
        onMounted(() => { load(); loadRuleDefs(); });

        const ruleOptions = computed(() => ruleDefs.value.map(r => ({ label: r.title + ' (' + r.key + ')', value: r.key })));

        async function openAdd() {
            editingId.value = null;
            let secret = '';
            try { const res = await api.post('/api/grafana/generate-secret'); secret = res.secret || ''; } catch {}
            Object.assign(form, { name: '', grafana_url: '', username: '', password: '', datasource_uid: '', auto_rules: [], webhook_url: location.origin, webhook_secret: secret, interval_sec: 60 });
            datasources.value = [];
            showModal.value = true;
        }
        function openEdit(row) {
            editingId.value = row.id;
            let rules = [];
            try { rules = JSON.parse(row.auto_rules || '[]'); } catch {}
            Object.assign(form, { name: row.name, grafana_url: row.grafana_url, username: row.username, password: '', datasource_uid: row.datasource_uid, auto_rules: rules, webhook_url: row.webhook_url, webhook_secret: row.webhook_secret || '', interval_sec: row.interval_sec });
            datasources.value = [];
            showModal.value = true;
        }
        async function save() {
            if (!form.name || !form.grafana_url) { message.error('请填写名称和 Grafana URL'); return; }
            saving.value = true;
            try {
                if (editingId.value) await api.put('/api/grafana/' + editingId.value, form);
                else await api.post('/api/grafana', form);
                showModal.value = false;
                message.success(editingId.value ? '已更新' : '已创建');
                load();
            } catch (e) { message.error(e.message || '保存失败'); }
            saving.value = false;
        }
        async function del(row) {
            try { await api.del('/api/grafana/' + row.id); message.success('已删除'); load(); } catch (e) { message.error(e.message); }
        }
        async function toggle(row) {
            try { await api.post('/api/grafana/' + row.id + '/toggle'); load(); } catch (e) { message.error(e.message); }
        }
        async function test(row) {
            try {
                const res = await api.post('/api/grafana/' + row.id + '/test');
                res.ok ? message.success(res.message) : message.error(res.message);
            } catch (e) { message.error(e.message); }
        }
        async function provision(row) {
            provisioning.value = row.id;
            try {
                await api.post('/api/grafana/' + row.id + '/provision');
                message.success('告警规则已同步到 Grafana');
            } catch (e) { message.error(e.message || '同步失败'); }
            provisioning.value = null;
        }
        async function cleanupRules(row) {
            try {
                const res = await api.post('/api/grafana/' + row.id + '/cleanup-rules');
                message.success('已清理 ' + (res.deleted || 0) + ' 条告警规则');
            } catch (e) { message.error(e.message || '清理失败'); }
        }

        const columns = useColumns([
            { title: '名称', key: 'name', width: 120 },
            { title: 'Grafana URL', key: 'grafana_url', ellipsis: { tooltip: true }, _hideOnMobile: true },
            { title: '数据源 UID', key: 'datasource_uid', width: 120, ellipsis: { tooltip: true }, _hideOnMobile: true },
            { title: '状态', key: 'status', width: 100, render: row => h(NSpace, { size: 4 }, () => [
                h(NTag, { size: 'small', type: row.enabled ? 'success' : 'default' }, () => row.enabled ? '启用' : '禁用'),
                row.running ? h(NBadge, { dot: true, type: 'success' }) : null,
            ])},
            { title: '操作', key: 'actions', width: _isMobile.value ? 260 : 400, render: row => h(NSpace, { size: 'small' }, () => [
                h(NButton, { size: 'tiny', secondary: true, onClick: () => openEdit(row) }, () => '编辑'),
                h(NButton, { size: 'tiny', secondary: true, onClick: () => toggle(row) }, () => row.enabled ? '禁用' : '启用'),
                h(NButton, { size: 'tiny', secondary: true, onClick: () => test(row) }, () => '测试'),
                h(NButton, { size: 'tiny', type: 'info', secondary: true, loading: provisioning.value === row.id, onClick: () => provision(row) }, () => '同步规则'),
                h(NPopconfirm, { onPositiveClick: () => cleanupRules(row) }, { trigger: () => h(NButton, { size: 'tiny', type: 'warning', secondary: true }, () => '清理规则'), default: () => '确认清理该配置在Grafana中的所有告警规则？' }),
                h(NPopconfirm, { onPositiveClick: () => del(row) }, { trigger: () => h(NButton, { size: 'tiny', type: 'error', secondary: true }, () => '删除'), default: () => '确认删除？' }),
            ])},
        ]);

        const gridCols = computed(() => _isMobile.value ? 1 : 2);
        return () => h('div', { class: 'page-body' }, [
            h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px' }, [
                h('h3', { class: 'page-title' }, 'Grafana 告警配置'),
                h(NButton, { type: 'primary', size: 'small', onClick: openAdd }, () => '+ 新增'),
            ]),
            h(NDataTable, { columns: columns.value, data: configs.value, bordered: false, size: 'small', loading: loading.value, maxHeight: 'calc(100vh - 200px)', scrollX: _isMobile.value ? 500 : undefined }),
            h(NModal, { show: showModal.value, onUpdateShow: v => showModal.value = v, preset: 'card', title: editingId.value ? '编辑 Grafana 配置' : '新增 Grafana 配置', style: _isMobile.value ? 'width:95vw' : 'width:680px' }, () =>
                h(NGrid, { cols: gridCols.value, xGap: 12 }, () => [
                    h(NGi, null, () => h(NFormItem, { label: '名称', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NInput, { value: form.name, onUpdateValue: v => form.name = v, placeholder: '如: 生产环境 Grafana' }))),
                    h(NGi, null, () => h(NFormItem, { label: 'Grafana URL', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NInput, { value: form.grafana_url, onUpdateValue: v => form.grafana_url = v, placeholder: 'http://grafana:3000' }))),
                    h(NGi, null, () => h(NFormItem, { label: '用户名', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NInput, { value: form.username, onUpdateValue: v => form.username = v, placeholder: 'admin' }))),
                    h(NGi, null, () => h(NFormItem, { label: '密码', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NInput, { value: form.password, onUpdateValue: v => form.password = v, type: 'password', showPasswordOn: 'click', placeholder: editingId.value ? '留空不修改' : 'Grafana 密码' }))),
                    h(NGi, { span: gridCols.value }, () => h(NFormItem, { label: '数据源 UID', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NSpace, { align: 'center', size: 'small', wrap: false, style: 'width:100%' }, () => [
                        h(NSelect, { value: form.datasource_uid, onUpdateValue: v => form.datasource_uid = v, options: datasources.value, filterable: true, tag: true, placeholder: '选择或输入数据源', style: 'flex:1;min-width:0', loading: dsLoading.value }),
                        h(NButton, { size: 'small', secondary: true, loading: dsLoading.value, onClick: fetchDatasources }, () => '获取'),
                    ]))),
                    h(NGi, null, () => h(NFormItem, { label: 'Webhook URL', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NInput, { value: form.webhook_url, onUpdateValue: v => form.webhook_url = v, placeholder: '本系统公网地址' }))),
                    h(NGi, null, () => h(NFormItem, { label: 'Webhook 密钥', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NSpace, { align: 'center', size: 'small', wrap: false }, () => [
                        h(NInput, { value: form.webhook_secret, onUpdateValue: v => form.webhook_secret = v, placeholder: '自动生成', style: 'flex:1;min-width:0', readonly: true }),
                        h(NButton, { size: 'small', secondary: true, onClick: async () => { try { const res = await api.post('/api/grafana/generate-secret'); form.webhook_secret = res.secret; } catch {} } }, () => '重新生成'),
                    ]))),
                    h(NGi, { span: gridCols.value }, () => h(NFormItem, { label: '告警规则', labelPlacement: 'top' }, () => h(NSelect, { value: form.auto_rules, onUpdateValue: v => form.auto_rules = v, options: ruleOptions.value, multiple: true, placeholder: '选择要自动创建的告警规则' }))),
                    h(NGi, null, () => h(NFormItem, { label: '检查间隔(秒)', labelPlacement: _isMobile.value ? 'top' : 'left' }, () => h(NInputNumber, { value: form.interval_sec, onUpdateValue: v => form.interval_sec = v, min: 10 }))),
                    h(NGi, { span: gridCols.value }, () => h(NButton, { type: 'primary', block: true, loading: saving.value, onClick: save }, () => '保存')),
                ])
            ),
        ]);
    }
});

// --- Grafana Alerts ---
const GrafanaAlertsPage = defineComponent({
    setup() {
        const alerts = ref([]);
        const total = ref(0);
        const page = ref(1);
        const pageSize = 20;
        const loading = ref(true);
        const { connected, messages, stop } = useWebSocket('/ws/grafana-logs');
        onUnmounted(stop);

        async function load() {
            loading.value = true;
            try {
                const res = await api.get('/api/grafana/alerts?page=' + page.value + '&page_size=' + pageSize);
                alerts.value = res.data || [];
                total.value = res.total || 0;
            } catch {}
            loading.value = false;
        }
        onMounted(load);
        watch(page, load);

        watch(() => messages.value.length, () => {
            const latest = messages.value[messages.value.length - 1];
            if (latest && latest.type === 'grafana_alert' && page.value === 1) {
                load();
            }
        });

        const statusType = (s) => {
            const map = { firing: 'error', resolved: 'success' };
            return map[s] || 'default';
        };

        const columns = useColumns([
            { title: '时间', key: 'detected_at', width: 150, render: row => h('span', { style: 'font-size:12px;opacity:0.65' }, formatTime(row.detected_at)) },
            { title: '配置', key: 'config_name', width: 100 },
            { title: '告警名称', key: 'alert_name', width: 150, ellipsis: { tooltip: true } },
            { title: '状态', key: 'status', width: 80, render: row => h(NTag, { type: statusType(row.status), size: 'small', bordered: false }, () => row.status) },
            { title: '严重度', key: 'severity', width: 80, _hideOnMobile: true, render: row => row.severity ? h(NTag, { size: 'small', bordered: false }, () => row.severity) : '-' },
            { title: '摘要', key: 'summary', ellipsis: { tooltip: true }, _hideOnMobile: true },
        ]);

        return () => h('div', { class: 'page-body log-page-fit' }, [
            h('div', { class: 'log-page-header' }, [
                h('div', { style: 'display:flex;align-items:center;gap:12px' }, [
                    h('h3', { class: 'page-title' }, 'Grafana 告警记录'),
                    h('div', { style: 'display:flex;align-items:center;gap:4px;font-size:12px;opacity:0.5' }, [
                        h('span', { class: connected.value ? 'ws-dot connected' : 'ws-dot disconnected' }),
                        connected.value ? '实时' : '离线'
                    ]),
                ]),
            ]),
            h('div', { class: 'log-page-table' }, [
                h(NDataTable, { columns: columns.value, data: alerts.value, bordered: false, size: 'small', loading: loading.value, flexHeight: true, style: 'height:100%', scrollX: _isMobile.value ? 400 : undefined }),
            ]),
            total.value > pageSize ? h('div', { class: 'log-page-pagination' },
                h(NPagination, { page: page.value, pageSize, itemCount: total.value, onUpdatePage: p => page.value = p })
            ) : null,
        ]);
    }
});

// ============================================================
// Layout
// ============================================================
const AppLayout = defineComponent({
    setup() {
        const route = VueRouter.useRoute();
        const router = VueRouter.useRouter();
        const user = ref(null);
        const siderCollapsed = ref(_isMobile.value);

        // 顶栏状态条：值班的人无论在哪一页都不该错过新告警
        const alertSummary = ref({ critical: 0, warning: 0 });
        let _sumTimer = null;
        async function loadAlertSummary() {
            if (route.path === '/login') return;   // 未登录时轮询只会制造 401 噪音
            try { alertSummary.value = await api.get('/api/alert-summary'); } catch {}
        }
        onMounted(() => { loadAlertSummary(); _sumTimer = setInterval(loadAlertSummary, 30000); });
        onUnmounted(() => clearInterval(_sumTimer));
        function statusStrip() {
            const sm = alertSummary.value;
            const pill = (cls, text) => h('span', {
                class: 'strip-pill ' + cls,
                onClick: () => router.push('/overview'),
            }, text);
            const pills = [];
            if (sm.critical > 0) pills.push(pill('strip-r', '● ' + sm.critical));
            if (sm.warning > 0) pills.push(pill('strip-y', '▲ ' + sm.warning));
            if (!pills.length) pills.push(pill('strip-g', '✓ 正常'));
            return h('div', { style: 'display:flex;gap:6px;margin-left:14px;align-items:center' }, pills);
        }

        onMounted(async () => {
            try { user.value = await api.get('/api/auth/me'); } catch (e) {
                if (e.message !== 'network_error' && route.path !== '/login') router.push('/login');
            }
            try { applyUISettings(await api.get('/api/settings')); } catch {}
        });

        watch(_isMobile, (mobile) => { siderCollapsed.value = mobile; });

        const menuOptions = computed(() => {
            const firing = alertSummary.value.critical + alertSummary.value.warning;
            return [
                { label: () => h('span', null, firing > 0 ? `总览 (${firing})` : '总览'), key: 'overview' },
                { label: '监控对象', key: 'objects' },
                { label: '规则与配置', key: 'g-rules' },
                isUISettingEnabled('show_rocketmq_menu') ? { label: 'RocketMQ', key: 'g-rocketmq' } : null,
                isUISettingEnabled('show_grafana_menu') ? { label: 'Grafana', key: 'g-grafana' } : null,
                { label: '系统', key: 'g-system' },
            ].filter(Boolean);
        });

        const groupTabs = {
            'g-rules': [
                { type: 'group', label: '指标', key: 'sec-prom', children: [
                    { label: '采集目标', key: 'prom-targets' },
                    { label: '告警规则', key: 'prom-checks' },
                    { label: '评估流水', key: 'prom-logs' },
                ] },
                { type: 'group', label: '证书与站点', key: 'sec-edge', children: [
                    { label: '证书检查', key: 'cert-checks' },
                    { label: '健康检查', key: 'health-checks' },
                    { label: '检查日志', key: 'health-checks-logs' },
                ] },
                { type: 'group', label: 'MySQL', key: 'sec-mysql', children: [
                    { label: '数据库', key: 'databases' },
                    { label: '已忽略SQL', key: 'ignored-sql' },
                    { label: '自定义SQL', key: 'custom-sql' },
                    { label: 'SQL流水', key: 'custom-sql-logs' },
                ] },
                { type: 'group', label: 'Cloud Logging', key: 'sec-cl', children: [
                    { label: '配置', key: 'cloud-logging-configs' },
                    { label: '查询', key: 'cloud-logging-query' },
                    { label: '监控', key: 'cloud-logging-checks' },
                    { label: '告警日志', key: 'cloud-logging-logs' },
                ] },
            ],
            'g-rocketmq': [
                { label: 'MQ 配置', key: 'rocketmq' },
                { label: 'MQ 告警', key: 'rocketmq-alerts' },
            ],
            'g-grafana': [
                { label: '告警配置', key: 'grafana' },
                { label: '告警日志', key: 'grafana-alerts' },
            ],
            'g-system': [
                { label: '通知配置', key: 'notifications' },
                { label: '运行日志', key: 'monitor-logs' },
                { label: '操作记录', key: 'audit-logs' },
                { label: '系统设置', key: 'settings' },
            ],
        };
        const routeToGroup = {};
        for (const [g, tabs] of Object.entries(groupTabs)) {
            for (const t of tabs) {
                if (t.type === 'group') { for (const c of t.children) routeToGroup[c.key] = g; }
                else routeToGroup[t.key] = g;
            }
        }

        const routeKey = computed(() => route.path.replace('/', '') || 'overview');
        const activeKey = computed(() => {
            const rk = routeKey.value;
            if (rk.startsWith('objects')) return 'objects';
            return routeToGroup[rk] || rk;
        });
        function isGroupVisible(group) {
            if (group === 'g-rocketmq') return isUISettingEnabled('show_rocketmq_menu');
            if (group === 'g-grafana') return isUISettingEnabled('show_grafana_menu');
            return true;
        }
        const currentTabs = computed(() => {
            const group = routeToGroup[routeKey.value];
            if (group && !isGroupVisible(group)) return null;
            let tabs = group ? groupTabs[group] : null;
            if (tabs && group === 'g-rules' && !isUISettingEnabled('show_cloud_logging_menu')) {
                tabs = tabs.filter(t => t.key !== 'sec-cl');
            }
            return tabs;
        });

        function handleMenuUpdate(key) {
            if (groupTabs[key]) {
                const first = groupTabs[key][0];
                router.push('/' + (first.type === 'group' ? first.children[0].key : first.key));
            } else {
                router.push('/' + key);
            }
            if (_isMobile.value) siderCollapsed.value = true;
        }

        async function logout() {
            try { await api.post('/api/auth/logout'); } catch {}
            router.push('/login');
        }

        return () => {
            if (route.path === '/login') return h(VueRouter.RouterView);

            // Mobile layout
            if (_isMobile.value) {
                return h(NLayout, { style: 'height:100vh' }, () => [
                    h('div', { class: 'topbar' }, [
                        h('div', { class: 'topbar-left' }, [
                            h(NButton, { quaternary: true, size: 'small', onClick: () => siderCollapsed.value = false, style: 'font-size:18px' }, () => '\u2630'),
                            h('span', { style: 'font-size:14px;font-weight:600' }, 'Ops Monitor'),
                            statusStrip(),
                        ]),
                        h('div', { class: 'topbar-right' }, [
                            h(NButton, { quaternary: true, circle: true, size: 'small', onClick: toggleTheme }, () => themeIcon()),
                            user.value ? h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
                                user.value.avatar_url ? h(NAvatar, { src: user.value.avatar_url, size: 22, round: true }) : null,
                                h(NButton, { size: 'tiny', secondary: true, onClick: logout }, () => '退出'),
                            ]) : null,
                        ]),
                    ]),
                    h(NDrawer, { show: !siderCollapsed.value, 'onUpdate:show': v => { siderCollapsed.value = !v; }, placement: 'left', width: 220 }, () =>
                        h(NDrawerContent, { bodyContentStyle: 'padding:0' }, () => [
                            h('div', { class: 'sider-header' }, [
                                h('div', { class: 'sider-logo' }, 'O'),
                                h('span', { style: 'font-size:14px;font-weight:600' }, 'Ops Monitor'),
                            ]),
                            h(NMenu, { value: activeKey.value, options: menuOptions.value, onUpdateValue: handleMenuUpdate }),
                        ])
                    ),
                    h(NLayout, { contentStyle: 'padding:16px;overflow-y:auto' }, () => [
                        currentTabs.value ? h(NMenu, {
                            mode: 'horizontal',
                            value: routeKey.value,
                            options: currentTabs.value,
                            onUpdateValue: (key) => router.push('/' + key),
                            style: 'margin-bottom:12px',
                        }) : null,
                        h(VueRouter.RouterView),
                    ]),
                ]);
            }

            // Desktop layout: top bar → sidebar | sub-sidebar | content
            const topbarH = '60px';
            return h('div', { style: 'height:100vh;overflow:hidden' }, [
                // Full-width top bar: logo left, user info right
                h('div', { class: 'topbar' }, [
                    h('div', { class: 'topbar-left', style: 'cursor:pointer', onClick: () => router.push('/overview') }, [
                        h('div', { class: 'sider-logo' }, 'O'),
                        h('span', { class: 'sider-title' }, 'Ops Monitor'),
                        statusStrip(),
                    ]),
                    h('div', { class: 'topbar-right' }, [
                        h(NButton, { quaternary: true, circle: true, size: 'small', onClick: toggleTheme }, () => themeIcon()),
                        user.value ? h('div', { style: 'display:flex;align-items:center;gap:8px' }, [
                            user.value.avatar_url ? h(NAvatar, { src: user.value.avatar_url, size: 24, round: true }) : null,
                            h(NText, { depth: 2, style: 'font-size:12px' }, () => user.value.username || user.value.github_login || 'admin'),
                            h(NButton, { size: 'tiny', secondary: true, onClick: logout }, () => '退出'),
                        ]) : null,
                    ]),
                ]),
                // Below: sidebar | sub-sidebar | content — fills remaining height
                h(NLayout, { hasSider: true, style: `height:calc(100vh - ${topbarH});overflow:hidden` }, () => [
                    // Left sidebar (menu only)
                    h(NLayoutSider, { bordered: true, width: 180, nativeScrollbar: false }, () => [
                        h(NMenu, { value: activeKey.value, options: menuOptions.value, onUpdateValue: handleMenuUpdate }),
                    ]),
                    // Sub sidebar (when group has children)
                    currentTabs.value ? h(NLayoutSider, { bordered: true, width: 184, nativeScrollbar: false, contentStyle: 'padding:12px 0;background:var(--content-bg)' }, () => [
                        h(NMenu, {
                            value: routeKey.value,
                            options: currentTabs.value,
                            onUpdateValue: (key) => router.push('/' + key),
                        }),
                    ]) : null,
                    // Content
                    h(NLayout, { contentStyle: 'padding:28px 36px 48px;overflow-y:auto;background:var(--body-bg)' }, () => [
                        h('div', { class: 'content-wrap' }, [h(VueRouter.RouterView)]),
                    ]),
                ]),
            ]);
        };
    }
});

// ============================================================
// 重设计三页：总览 / 告警中心 / 监控对象（+详情）
// 数据分两层：触发中/已恢复走 alert_events（事件生命周期），
// 当前值/容量风险走 PromManager 内存快照（最新鲜）。
// ============================================================

function fmtSince(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0 || isNaN(ms)) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟';
    const hrs = Math.floor(m / 60);
    if (hrs < 48) return hrs + ' 小时';
    return Math.floor(hrs / 24) + ' 天';
}

function sevTagType(sev) {
    return (sev === 'critical' || sev === 'error') ? 'error' : 'warning';
}

// 同一条规则在多个对象上触发 → 聚合成一件事（按去掉对象前缀的 title）
function groupEvents(events) {
    const groups = new Map();
    for (const e of events) {
        const key = (e.title || e.check_name) + '|' + e.source;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
    }
    return [...groups.values()];
}

// svgLine 把 [[t,v],...] 画成内联 SVG 折线（无依赖）。
// w/h 是 viewBox 尺寸；fill 为 true 画渐变面积。
function svgLine(points, w, hg, opts) {
    if (!points || points.length < 2) return null;
    const vs = points.map(p => p.v);
    let min = Math.min(...vs), max = Math.max(...vs);
    if (max === min) { max += 1; min -= 1; }
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;
    const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
    const X = t => ((t - t0) / (t1 - t0 || 1)) * w;
    const Y = v => hg - ((v - min) / (max - min)) * hg;
    const pts = points.map(p => X(p.t).toFixed(1) + ',' + Y(p.v).toFixed(1)).join(' ');
    const color = (opts && opts.color) || '#36ad6a';
    const children = [];
    if (opts && opts.fill) {
        children.push(h('polygon', {
            points: '0,' + hg + ' ' + pts + ' ' + w + ',' + hg,
            fill: color, opacity: 0.12,
        }));
    }
    children.push(h('polyline', {
        points: pts, fill: 'none', stroke: color,
        'stroke-width': (opts && opts.width) || 1.5, 'stroke-linejoin': 'round',
    }));
    if (!(opts && opts.interactive)) {
        return h('svg', {
            viewBox: '0 0 ' + w + ' ' + hg, preserveAspectRatio: 'none',
            style: (opts && opts.style) || ('width:' + w + 'px;height:' + hg + 'px;display:block'),
        }, children);
    }
    // 交互版（趋势弹窗用）：悬停显示最近采样点的时间与数值。
    // svgLine 是无状态渲染函数，悬停高亮直接操作 DOM，不进 Vue 响应式。
    children.push(h('line', { class: 'tt-line', y1: 0, y2: hg, stroke: color, 'stroke-width': 1, opacity: 0, 'stroke-dasharray': '4,3' }));
    children.push(h('circle', { class: 'tt-dot', r: 3.5, fill: color, stroke: '#fff', 'stroke-width': 1.2, opacity: 0 }));
    const fmtV = v => Math.round(v * 100) / 100;
    return h('div', { style: 'position:relative' }, [
        h('svg', {
            viewBox: '0 0 ' + w + ' ' + hg, preserveAspectRatio: 'none',
            style: (opts && opts.style) || ('width:' + w + 'px;height:' + hg + 'px;display:block'),
            onMousemove: ev => {
                const svg = ev.currentTarget, rect = svg.getBoundingClientRect();
                const tx = t0 + ((ev.clientX - rect.left) / (rect.width || 1)) * (t1 - t0);
                let best = 0, bd = Infinity;
                for (let i = 0; i < points.length; i++) {
                    const dd = Math.abs(points[i].t - tx);
                    if (dd < bd) { bd = dd; best = i; }
                }
                const p = points[best], px = X(p.t), py = Y(p.v);
                const lineEl = svg.querySelector('.tt-line'), dotEl = svg.querySelector('.tt-dot');
                const tip = svg.parentNode.querySelector('.tt-tip');
                lineEl.setAttribute('x1', px); lineEl.setAttribute('x2', px); lineEl.setAttribute('opacity', '0.45');
                dotEl.setAttribute('cx', px); dotEl.setAttribute('cy', py); dotEl.setAttribute('opacity', '1');
                if (tip) {
                    tip.textContent = new Date(p.t * 1000).toLocaleString() + '  ·  ' + fmtV(p.v);
                    tip.style.display = 'block';
                    const leftPx = (px / w) * rect.width;
                    tip.style.left = Math.min(Math.max(leftPx - 70, 0), Math.max(rect.width - 190, 0)) + 'px';
                }
            },
            onMouseleave: ev => {
                const svg = ev.currentTarget;
                svg.querySelector('.tt-line').setAttribute('opacity', '0');
                svg.querySelector('.tt-dot').setAttribute('opacity', '0');
                const tip = svg.parentNode.querySelector('.tt-tip');
                if (tip) tip.style.display = 'none';
            },
        }, children),
        h('div', {
            class: 'tt-tip',
            style: 'position:absolute;top:8px;pointer-events:none;display:none;background:rgba(15,23,32,.85);color:#fff;font-size:11.5px;font-family:monospace;padding:4px 9px;border-radius:4px;white-space:nowrap;z-index:5',
        }),
    ]);
}

// detailKeyValue 从聚合来源里取主标签值（container=xxx 的 xxx），
// Coolify 容器名末段是 20+ 位随机串，剥掉再展示；完整值仍在悬停里。
function detailKeyValue(detail) {
    if (!detail) return '';
    const m = detail.match(/[a-z_]+=(\S+)/);
    if (!m) return '';
    let v = m[1];
    const parts = v.split('-');
    if (parts.length > 1 && /^[a-z0-9]{14,}$/.test(parts[parts.length - 1])) {
        v = parts.slice(0, -1).join('-');
    }
    return v.length > 26 ? v.slice(0, 26) + '…' : v;
}

function firingCard(router, group) {
    const first = group[0];
    const earliest = group.reduce((a, e) => (e.first_at < a ? e.first_at : a), first.first_at);
    const multi = group.length > 1;
    return h('div', {
        class: 'sen-card sen-ev' + (sevTagType(first.severity) === 'error' ? ' crit' : ''),
    }, [
        h('div', { style: 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap' }, [
            h('span', { style: 'font-weight:650;font-size:14px' }, first.title || first.check_name),
            h(NTag, { size: 'tiny', type: sevTagType(first.severity) }, () => first.severity),
            h('span', { style: 'margin-left:auto;font-size:12px;opacity:.55;font-family:monospace' }, '已持续 ' + fmtSince(earliest)),
        ]),
        multi ? h('div', { style: 'margin-top:9px' }, [
            h('div', { style: 'font-size:12px;opacity:.6;margin-bottom:6px' }, '命中 ' + group.length + ' 个对象'),
            h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, group.map(e =>
                h('div', {
                    style: 'display:flex;align-items:baseline;gap:6px;padding:3px 10px;border-radius:6px;background:var(--stat-card-bg,rgba(128,128,128,.08));font-size:12.5px' + (e.detail ? ';cursor:help' : ''),
                    title: e.detail || undefined,
                }, [
                    h('span', null, (e.target_name || '').replace(' 主机指标', '').replace(' 应用指标', '')),
                    detailKeyValue(e.detail) ? h('span', { style: 'font-family:monospace;font-size:11.5px;opacity:.65' }, detailKeyValue(e.detail)) : null,
                    h('span', { style: 'font-family:monospace;font-weight:600' }, e.value),
                ]))),
        ]) : h('div', { style: 'font-size:13px;opacity:.75;margin-top:7px;line-height:1.7' },
            h('span', { title: (first.value || '').length > 90 ? first.value : undefined },
                    [first.target_name, `当前 ${(first.value || '').length > 90 ? first.value.slice(0, 90) + '…' : first.value}`,
                     first.threshold ? '阈值 ' + first.threshold : '',
                     first.peak_value && first.peak_value !== first.value && first.peak_value.length <= 24 ? '峰值 ' + first.peak_value : '']
                        .filter(Boolean).join(' · '))),
        !multi && first.message && first.message !== first.value ? h('div', {
            style: 'font-size:12.5px;opacity:.65;margin-top:4px;line-height:1.6;white-space:pre-line',
            title: first.message.length > 160 ? first.message : undefined,
        }, first.message.length > 160 ? first.message.slice(0, 160) + '…' : first.message) : null,
        // message 摘要里已含"来源："时不再单独重复一行
        !multi && first.detail && !(first.message || '').includes('来源：') ? h('div', { style: 'font-size:12px;font-family:monospace;opacity:.7;margin-top:4px' }, '来源：' + first.detail) : null,
        h('div', { style: 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;font-size:12px' }, [
            h(NTag, { size: 'tiny', bordered: false }, () => ({ prom: '指标', prom_target: '采集目标', health: '站点', cert: '证书', custom_sql: 'SQL' }[first.source] || first.source)),
            first.dimension ? h(NTag, { size: 'tiny', bordered: false }, () => first.dimension) : null,
            h(NTag, { size: 'tiny', bordered: false, type: first.notify_count > 0 ? 'success' : 'default' },
                () => first.notify_count > 0 ? `已通知 ${first.notify_count} 次` : '未通知'),
            (() => {
                // 各来源跳到能解释这条告警的页面：prom 有对象详情，其余跳规则/流水页
                let to = null, label = null;
                if ((first.source === 'prom' || first.source === 'prom_target') && first.target_id) { to = '/objects/' + first.target_id; label = '查看对象 ›'; }
                else if (first.source === 'custom_sql') { to = '/custom-sql-logs'; label = '查看流水 ›'; }
                else if (first.source === 'health') { to = '/health-checks-logs'; label = '查看流水 ›'; }
                else if (first.source === 'cert') { to = '/cert-checks'; label = '查看证书 ›'; }
                return to ? h(NButton, { size: 'tiny', quaternary: true, type: 'primary', onClick: () => router.push(to) }, () => label) : null;
            })(),
        ]),
    ]);
}

const OverviewPage = defineComponent({
    setup() {
        const router = VueRouter.useRouter();
        const data = ref(null);
        const loading = ref(true);
        let timer = null;
        const resolved = ref([]);
        async function load() {
            try { data.value = await api.get('/api/overview'); } catch {}
            loading.value = false;
            try { resolved.value = await api.get('/api/alert-events?status=resolved&limit=100') || []; } catch {}
        }
        onMounted(() => { load(); timer = setInterval(load, 30000); });
        onUnmounted(() => clearInterval(timer));

        const riskColumns = [
            { title: '对象', key: 'target', render: r => h('div', null, [
                h('div', null, r.target.replace(' 主机指标', '').replace(' 应用指标', ' (应用)')),
                r.detail ? h('div', { style: 'font-size:11px;font-family:monospace;opacity:.6' }, r.detail) : null,
            ]) },
            { title: '规则', key: 'check' },
            { title: '当前值', key: 'value', render: r => h('span', { style: 'font-family:monospace' }, (Math.round(r.value * 100) / 100).toString()) },
            { title: '阈值', key: 'threshold', render: r => h('span', { style: 'font-family:monospace' }, r.threshold) },
            {
                title: '距告警', key: 'closeness', render: r =>
                    h(NTag, { size: 'small', type: r.closeness >= 0.95 ? 'error' : 'warning', bordered: false },
                        () => Math.round(r.closeness * 100) + '%'),
            },
        ];

        return () => h(NSpin, { show: loading.value }, () => {
            const d = data.value;
            if (!d) return h('div', { style: 'height:200px' });
            const groups = groupEvents(d.firing || []);
            return h('div', { class: 'page-body' }, [
                h('div', { class: 'page-header' }, [
                    h('h3', { class: 'page-title' }, '总览'),
                    h('span', { style: 'font-size:12px;opacity:.5' }, `${d.self.targets_running} 采集目标在线 · ${d.summary.ok_rules} 条规则正常`),
                ]),

                d.self.notify_channels === 0 ? h(NAlert, { type: 'error', style: 'margin-bottom:14px', title: '通知渠道未配置 —— 所有告警只落库，不会发给任何人' }, {
                    default: () => h(NButton, { size: 'small', type: 'primary', onClick: () => router.push('/notifications') }, () => '去配置'),
                }) : null,

                (() => {
                    // 顶部统计卡：与对象详情页同一套卡片语言（网格、大数字、副标题、状态色底）
                    const firingN = (d.firing || []).length;
                    const cards = [{
                        label: '告警', value: firingN, tone: firingN > 0 ? 'crit' : '',
                        caption: firingN > 0 ? `${groups.length} 个问题触发中` : `全部正常 · 最近已恢复 ${resolved.value.length} 条`,
                    }];
                    for (const [dim, v] of Object.entries(d.dims || {})) {
                        const name = { host: '主机', container: '容器', app: '应用', business: '业务', database: '数据库', middleware: '中间件' }[dim] || dim;
                        cards.push({ label: name + '规则', value: v[1], tone: v[0] > 0 ? 'crit' : '', caption: v[0] > 0 ? `${v[0]} 条触发中` : '全部正常' });
                    }
                    cards.push({
                        label: '通知渠道', value: d.self.notify_channels, tone: d.self.notify_channels > 0 ? '' : 'crit',
                        caption: d.self.notify_channels > 0 ? '可用 · 点击管理' : '未配置 · 告警不会外发', onClick: () => router.push('/notifications'),
                    });
                    cards.push({ label: '指标采集', value: d.self.targets_running, caption: '个端点在线', onClick: () => router.push('/objects') });
                    cards.push({ label: '证书检查', value: d.self.cert_running, caption: '个域名在跑', onClick: () => router.push('/cert-checks') });
                    cards.push({ label: '站点检查', value: d.self.health_running, caption: '个站点在跑', onClick: () => router.push('/health-checks') });
                    return h('div', { class: 'kpi-grid', style: 'margin-bottom:6px' }, cards.map(k => h('div', {
                        class: 'sen-card sen-kpi ' + (k.tone || '') + (k.onClick ? ' sen-card-click' : ''), onClick: k.onClick,
                    }, [
                        h('div', { class: 'k-label' }, k.label),
                        h('div', { class: 'k-value' }, k.value),
                        h('div', { class: 'k-caption' }, k.caption),
                    ])));
                })(),
                h('div', { class: 'sen-sec first', style: 'color:#d03050' },
                    groups.length ? `触发中（${groups.length} 个问题 / ${(d.firing || []).length} 条）` : '触发中'),
                groups.length
                    ? groups.map(g => firingCard(router, g))
                    : h('div', { class: 'sen-card', style: 'border-style:dashed;opacity:.65;font-size:13px' }, '✓ 当前没有触发中的告警'),

                d.risks && d.risks.length ? [
                    h('div', { class: 'sen-sec', style: 'color:#f0a020' }, `容量风险（未触发但已接近阈值）`),
                    h(NDataTable, { columns: riskColumns, data: d.risks, size: 'small', bordered: false }),
                ] : null,

                // 已恢复：原「告警」页唯一独有的内容，并到总览底部；逐次判定明细走「评估流水」
                h('div', { class: 'sen-sec', style: 'display:flex;align-items:center;gap:10px' }, [
                    `已恢复（最近 ${resolved.value.length} 条）`,
                    h(NButton, { size: 'tiny', quaternary: true, style: 'margin-left:auto', onClick: () => router.push('/prom-logs') }, () => '评估流水 ›'),
                ]),
                resolved.value.length
                    ? h(NDataTable, { columns: RESOLVED_EVENT_COLUMNS, data: resolved.value, size: 'small', bordered: false, pagination: { pageSize: 10 } })
                    : h('div', { class: 'sen-card', style: 'border-style:dashed;opacity:.65;font-size:13px' }, '暂无已恢复的事件'),
            ]);
        });
    },
});

// 已恢复事件表的列（总览页底部用）。
// 站点/SQL 类事件的"峰值"是整段错误文本，必须单行省略、悬停看全文——
// 否则一条 connection reset 的报错能把行高撑成一整块。
function fmtSince2(a, b) {
    const m = Math.floor((new Date(b) - new Date(a)) / 60000);
    if (m < 60) return m + ' 分钟';
    const hrs = Math.floor(m / 60);
    return hrs < 48 ? hrs + ' 小时' : Math.floor(hrs / 24) + ' 天';
}
const RESOLVED_EVENT_COLUMNS = [
    { title: '规则', key: 'check_name', ellipsis: { tooltip: true }, render: r => h('div', null, [
        h('span', null, r.check_name),
        r.detail ? h('span', { style: 'font-size:11px;font-family:monospace;opacity:.55;margin-left:8px' }, r.detail) : null,
    ]) },
    { title: '来源', key: 'source', width: 72, render: r => ({ prom: '指标', prom_target: '采集目标', health: '站点', cert: '证书', custom_sql: 'SQL' }[r.source] || r.source) },
    { title: '峰值', key: 'peak_value', width: 170, render: r => {
        const v = r.peak_value || r.value || '';
        return h('span', {
            style: 'display:block;max-width:158px;font-family:monospace;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' + (v.length > 24 ? ';cursor:help' : ''),
            title: v.length > 24 ? v : undefined,
        }, v);
    } },
    { title: '首次触发', key: 'first_at', width: 130, render: r => (r.first_at || '').replace('T', ' ').slice(5, 16) },
    { title: '持续', key: 'dur', width: 78, render: r => r.resolved_at ? fmtSince2(r.first_at, r.resolved_at) : '' },
    { title: '恢复于', key: 'resolved_at', width: 130, render: r => (r.resolved_at || '').replace('T', ' ').slice(5, 16) },
];

// 对象列表列的关键水位：按指标名匹配，稳定（规则名可改，指标名不会）
const OBJ_METRIC_COLS = [
    { label: '内存', metric: 'node_memory_MemAvailable_bytes', pct: true },
    { label: 'Swap', metric: 'node_memory_SwapFree_bytes', pct: true },
    { label: '根分区', metric: 'node_filesystem_avail_bytes', pct: true },
    { label: '负载', metric: 'node_load1', pct: false },
    { label: '容器最高', metric: 'ttpos_container_memory_usage_ratio', pct: true },
];

function objMetricCell(o, def) {
    const c = (o.checks || []).find(x => x.metric === def.metric && x.has_value);
    if (!c) return h('span', { style: 'opacity:.3' }, '–');
    const v = Math.round(c.value * 10) / 10;
    const color = c.matched ? '#d03050' : (c.risk ? '#f0a020' : '');
    // 内存列：有总量时悬停给出 已用 / 可用 / 总（总量来自主机资源采样）
    const memTip = def.metric === 'node_memory_MemAvailable_bytes' && o.mem_total
        ? `已用 ${fmtGB(c.value * o.mem_total / 100)} · 可用 ${fmtGB((100 - c.value) * o.mem_total / 100)} · 共 ${fmtGB(o.mem_total)}`
        : '';
    const tip = [memTip, c.detail].filter(Boolean).join('\n');
    return h('span', {
        style: `font-family:monospace;${color ? 'color:' + color + ';font-weight:700' : ''}${tip ? ';cursor:help;border-bottom:1px dotted currentColor' : ''}`,
        title: tip || undefined,
    }, v + (def.pct ? '%' : ''));
}

function objStatusTag(o) {
    const map = { firing: ['error', '告警'], risk: ['warning', '风险'], stale: ['default', '停止'], ok: ['success', '正常'] };
    const [type, label] = map[o.status] || map.ok;
    return h(NTag, { size: 'small', type, bordered: false }, () => label);
}

const ObjectsPage = defineComponent({
    setup() {
        const router = VueRouter.useRouter();
        const objects = ref([]);
        const kind = ref('');
        const loading = ref(true);
        let timer = null;
        async function load() {
            try { objects.value = await api.get('/api/objects') || []; } catch {}
            loading.value = false;
        }
        onMounted(() => { load(); timer = setInterval(load, 30000); });
        onUnmounted(() => clearInterval(timer));

        const kinds = computed(() => [...new Set(objects.value.map(o => o.kind))]);
        const hostFilter = ref(null);
        const roleFilter = ref(null);
        const labelOpts = key => computed(() => {
            const vs = [...new Set(objects.value.map(o => (o.labels || {})[key]).filter(v => v && v !== '-'))].sort();
            return vs.map(v => ({ label: (key === 'host' ? '@' : '') + v, value: v }));
        });
        const hostOpts = labelOpts('host');
        const roleOpts = labelOpts('role');
        const filtered = computed(() => {
            let list = kind.value ? objects.value.filter(o => o.kind === kind.value) : objects.value;
            if (hostFilter.value) list = list.filter(o => (o.labels || {}).host === hostFilter.value);
            if (roleFilter.value) list = list.filter(o => (o.labels || {}).role === roleFilter.value);
            const rank = { firing: 0, risk: 1, stale: 2, ok: 3 };
            return [...list].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.name.localeCompare(b.name));
        });

        const columns = computed(() => [
            {
                title: '对象', key: 'name', width: 250, ellipsis: { tooltip: true }, render: o => h('div', null, [
                    h('span', { style: 'font-weight:600' }, o.name.replace(' 主机指标', '').replace(' 应用指标', '')),
                    h('span', { style: 'font-size:11px;opacity:.5;margin-left:8px' },
                        [o.kind, o.labels && o.labels.host && o.labels.host !== '-' ? '@' + o.labels.host : '', o.labels && o.labels.role].filter(Boolean).join(' · ')),
                ]),
            },
            { title: '状态', key: 'status', width: 70, render: objStatusTag },
            ...OBJ_METRIC_COLS.map(def => ({ title: def.label, key: def.metric, width: 84, render: o => objMetricCell(o, def) })),
            { title: '触发/风险', key: 'fr', width: 84, render: o => h('span', { style: 'font-family:monospace' }, [
                o.firing ? h('span', { style: 'color:#d03050;font-weight:700' }, o.firing) : '0', ' / ',
                o.risks ? h('span', { style: 'color:#f0a020;font-weight:700' }, o.risks) : '0']) },
            { title: '规则', key: 'rules', width: 60, render: o => (o.checks || []).length + ' 条' },
        ]);

        return () => h('div', { class: 'page-body' }, [
            h('div', { class: 'page-header' }, [
                h('h3', { class: 'page-title' }, '监控对象'),
                h('div', { style: 'display:flex;gap:6px;align-items:center' }, [
                    h(NSelect, {
                        value: hostFilter.value, onUpdateValue: v => hostFilter.value = v,
                        options: hostOpts.value, clearable: true, placeholder: '宿主机',
                        size: 'small', style: 'width:120px',
                    }),
                    h(NSelect, {
                        value: roleFilter.value, onUpdateValue: v => roleFilter.value = v,
                        options: roleOpts.value, clearable: true, placeholder: '角色',
                        size: 'small', style: 'width:130px',
                    }),
                    h(NButton, { size: 'small', secondary: kind.value !== '', type: kind.value === '' ? 'primary' : 'default', onClick: () => kind.value = '' }, () => `全部 ${objects.value.length}`),
                    ...kinds.value.map(k => h(NButton, { size: 'small', secondary: kind.value !== k, type: kind.value === k ? 'primary' : 'default', onClick: () => kind.value = k },
                        () => `${k} ${objects.value.filter(o => o.kind === k).length}`)),
                    h(NText, { depth: 3, style: 'font-size:12px;margin-left:4px' }, () => filtered.value.length + ' 个'),
                ]),
            ]),
            h(NSpin, { show: loading.value }, () =>
                // 限宽：不设的话"对象"列会把 2K 屏的剩余空间全吃掉，
                // 名字和数字之间隔一大片空白，数字被推到屏幕右缘。
h('div', null, [
                    h(NDataTable, {
                        columns: columns.value, data: filtered.value, size: 'small', bordered: false,
                        rowProps: o => ({ style: 'cursor:pointer', onClick: () => router.push('/objects/' + o.id) }),
                    }),
                ])),
        ]);
    },
});

// ---- 主机资源趋势图（ECharts）----
// points: /api/objects/:id/resources 的 points；series: [{key,name,color,yAxisIndex,unit,area}]
// yAxes: [{unit:'pct'|'bps'|'iops', offset?}]。ECharts 由 index.html 同源引入，缺失时静默不画。
function fmtBps(v) {
    if (v >= 1073741824) return (v / 1073741824).toFixed(2) + ' GB/s';
    if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB/s';
    if (v >= 1024) return (v / 1024).toFixed(1) + ' KB/s';
    return Math.round(v) + ' B/s';
}
function fmtGB(bytes) { return (bytes / 1073741824).toFixed(1) + ' GB'; }
function fmtUnit(v, unit) {
    if (unit === 'pct') return (Math.round(v * 10) / 10) + '%';
    if (unit === 'bps') return fmtBps(v);
    if (unit === 'iops') return (Math.round(v * 10) / 10) + ' 次/s';
    return v;
}
const ResChart = defineComponent({
    props: { points: Array, series: Array, yAxes: Array, height: { type: Number, default: 230 } },
    setup(props) {
        const el = ref(null);
        let chart = null;
        const dark = () => typeof currentTheme !== 'undefined' && currentTheme.value === darkTheme;
        const unitOf = s => s.unit || (props.yAxes[s.yAxisIndex || 0] || {}).unit;
        function render() {
            if (!el.value || typeof echarts === 'undefined') return;
            if (!chart) chart = echarts.init(el.value, dark() ? 'dark' : null);
            const pts = props.points || [];
            const rightAxes = props.yAxes.length - 1;
            chart.setOption({
                backgroundColor: 'transparent', animation: false,
                grid: { left: 60, right: 16 + rightAxes * 56, top: 34, bottom: 62 },
                legend: { top: 2, right: 8, textStyle: { fontSize: 11 }, itemWidth: 14 },
                tooltip: {
                    trigger: 'axis', axisPointer: { type: 'line' },
                    formatter: params => {
                        const t = new Date(params[0].value[0]);
                        const head = t.toLocaleString('zh-CN', { hour12: false });
                        const pt = pts[params[0].dataIndex] || {};
                        return head + '<br/>' + params.map(p => {
                            const sd = props.series[p.seriesIndex];
                            const extra = sd.extra ? sd.extra(pt) : '';
                            return `${p.marker} ${p.seriesName}: <b>${fmtUnit(p.value[1], unitOf(sd))}</b>${extra ? ' <span style="opacity:.75">· ' + extra + '</span>' : ''}`;
                        }).join('<br/>');
                    },
                },
                xAxis: { type: 'time', axisLabel: { fontSize: 11, hideOverlap: true } },
                yAxis: props.yAxes.map((a, i) => ({
                    type: 'value', min: 0, max: a.unit === 'pct' ? 100 : null,
                    position: i ? 'right' : 'left', offset: a.offset || (i > 1 ? (i - 1) * 56 : 0),
                    axisLabel: { fontSize: 11, formatter: v => fmtUnit(v, a.unit) },
                    splitLine: { show: i === 0, lineStyle: { type: 'dashed', opacity: .35 } },
                })),
                dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8, brushSelect: false }],
                series: props.series.map(s => ({
                    name: s.name, type: 'line', showSymbol: false, smooth: false,
                    lineStyle: { width: 1.4 }, itemStyle: { color: s.color }, yAxisIndex: s.yAxisIndex || 0,
                    areaStyle: s.area ? { opacity: .08 } : undefined,
                    data: pts.map(p => [p.t * 1000, Math.round((p[s.key] || 0) * 100) / 100]),
                })),
            }, true);
        }
        const onResize = () => chart && chart.resize();
        onMounted(() => { render(); window.addEventListener('resize', onResize); });
        watch(() => props.points, render);
        if (typeof currentTheme !== 'undefined') watch(currentTheme, () => { if (chart) { chart.dispose(); chart = null; } render(); });
        onUnmounted(() => { window.removeEventListener('resize', onResize); if (chart) chart.dispose(); });
        return () => h('div', { ref: el, style: `height:${props.height}px;width:100%` });
    },
});
const RES_CHARTS = [
    { title: 'CPU', yAxes: [{ unit: 'pct' }], series: [
        { key: 'cpu', name: '使用率', color: '#2080f0', area: true },
        { key: 'iowait', name: 'IO 等待', color: '#f0a020' }] },
    { title: '内存', yAxes: [{ unit: 'pct' }], series: [
        { key: 'mem', name: '使用率', color: '#18a058', area: true,
          // 总内存从采样点带出来，换算已用 / 可用（老采样点没有总量时不显示）
          extra: pt => pt.mem_total ? `已用 ${fmtGB(pt.mem * pt.mem_total / 100)} / 可用 ${fmtGB((100 - pt.mem) * pt.mem_total / 100)} / 共 ${fmtGB(pt.mem_total)}` : '' }] },
    { title: '磁盘 IO', yAxes: [{ unit: 'bps' }, { unit: 'iops' }, { unit: 'pct' }], series: [
        { key: 'disk_r', name: '读取', color: '#e0407a' },
        { key: 'disk_w', name: '写入', color: '#36cfc9' },
        { key: 'disk_iops', name: '读写次数', color: '#2080f0', yAxisIndex: 1 },
        { key: 'disk_util', name: '繁忙度', color: '#f0a020', yAxisIndex: 2 }] },
    { title: '网络 IO', yAxes: [{ unit: 'bps' }], series: [
        { key: 'net_tx', name: '上行', color: '#e0407a' },
        { key: 'net_rx', name: '下行', color: '#36cfc9' }] },
];

const ObjectDetailPage = defineComponent({
    setup() {
        const router = VueRouter.useRouter();
        const route = VueRouter.useRoute();
        const data = ref(null);
        const loading = ref(true);
        const objects = ref([]);         // 全部对象，标题栏下拉切换用
        const sparks = ref({});          // check_id -> [{t,v},...]
        const trend = ref(null);         // 大图弹窗：{check, points, hours}
        const trendLoading = ref(false);
        // 资源趋势（仅 node 目标）：昨天 / 今天 / 最近七天 / 自定义
        const resRange = ref('today');
        const resCustom = ref(null);
        const res = ref([]);
        const resLoading = ref(false);
        function resWindow() {
            const now = Date.now();
            const d0 = new Date(); d0.setHours(0, 0, 0, 0);
            switch (resRange.value) {
                case 'yesterday': return [d0.getTime() - 86400000, d0.getTime()];
                case '7d': return [now - 7 * 86400000, now];
                case 'custom': if (resCustom.value) return resCustom.value; break;
            }
            return [d0.getTime(), now];
        }
        async function loadResources() {
            const o = data.value && data.value.object;
            if (!o || o.kind !== 'node') return;
            const [f, t] = resWindow();
            resLoading.value = true;
            try {
                const r = await api.get(`/api/objects/${route.params.id}/resources?from=${Math.floor(f / 1000)}&to=${Math.floor(t / 1000)}`);
                res.value = (r && r.points) || [];
            } catch { res.value = []; }
            resLoading.value = false;
        }
        watch([resRange, resCustom], loadResources);
        // 告警事件：服务端分页
        const evPage = ref(1);
        const evPageSize = ref(10);
        const evTotal = ref(0);
        const events = ref([]);
        const evLoading = ref(false);
        async function loadEvents() {
            evLoading.value = true;
            try {
                const r = await api.get(`/api/objects/${route.params.id}/events?page=${evPage.value}&page_size=${evPageSize.value}`);
                events.value = (r && r.items) || [];
                evTotal.value = (r && r.total) || 0;
            } catch { events.value = []; }
            evLoading.value = false;
        }
        watch([evPage, evPageSize], loadEvents);
        let timer = null;
        async function load() {
            try { data.value = await api.get('/api/objects/' + route.params.id); } catch { data.value = null; }
            loading.value = false;
            try { sparks.value = await api.get('/api/objects/' + route.params.id + '/sparklines?hours=6') || {}; } catch {}
            loadResources();
            loadEvents();
        }
        async function openTrend(check, hours) {
            trend.value = { check, points: trend.value && trend.value.check.id === check.id ? trend.value.points : [], hours };
            trendLoading.value = true;
            try {
                trend.value = { check, hours, points: await api.get('/api/prom-checks/' + check.id + '/samples?hours=' + hours) || [] };
            } catch { trend.value = { check, hours, points: [] }; }
            trendLoading.value = false;
        }
        watch(() => route.params.id, () => { if (route.params.id) { loading.value = true; load(); } });
        onMounted(async () => {
            load(); timer = setInterval(load, 30000);
            try { objects.value = await api.get('/api/objects') || []; } catch {}
        });
        onUnmounted(() => clearInterval(timer));
        const objName = n => (n || '').replace(' 主机指标', '').replace(' 应用指标', ' (应用)');
        const objectOptions = computed(() => objects.value
            .map(o => ({ label: objName(o.name), value: o.id, status: o.status }))
            .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN', { numeric: true })));

        // computed：sparklines 异步加载后触发表格重渲（静态数组不会）
        const checkColumns = computed(() => [
            { title: '规则', key: 'name', ellipsis: { tooltip: true } },
            { title: '指标', key: 'metric', width: 300, ellipsis: { tooltip: true }, render: c => h('span', { style: 'font-family:monospace;font-size:11.5px;opacity:.7' }, c.metric) },
            {
                title: '趋势 6h', key: 'spark', width: 140, render: c => {
                    const pts = sparks.value[c.id];
                    if (!pts || pts.length < 2) return h('span', { style: 'opacity:.3;font-size:11px' }, '—');
                    return h('div', { style: 'cursor:pointer', title: '点击看大图', onClick: () => openTrend(c, 24) },
                        [svgLine(pts, 120, 26, { color: c.matched ? '#d03050' : '#36ad6a', fill: true })]);
                },
            },
            {
                title: '当前值', key: 'value', width: 130, render: c => c.err
                    ? h(NTooltip, null, { trigger: () => h(NTag, { size: 'tiny', type: 'default' }, () => '无数据'), default: () => c.err })
                    : h('div', null, [
                        h('span', { style: 'font-family:monospace;font-weight:600' }, Math.round(c.value * 100) / 100),
                        c.detail ? h(NTooltip, null, {
                            trigger: () => h('div', { style: 'font-size:10.5px;font-family:monospace;opacity:.6;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help' }, c.detail),
                            default: () => h('div', { style: 'font-family:monospace;font-size:12px;max-width:480px;word-break:break-all' }, c.detail),
                        }) : null,
                    ]),
            },
            { title: '条件', key: 'cond', width: 120, render: c => h('span', { style: 'font-family:monospace;font-size:12px' }, c.strategy === 'increase' ? '增长>' + '' : ({ gt: '>', gte: '≥', lt: '<', lte: '≤' }[c.condition] || c.condition) + ' ' + c.threshold) },
            {
                title: '状态', key: 'st', width: 76, render: c => c.matched
                    ? h(NTag, { size: 'small', type: 'error', bordered: false }, () => '触发中')
                    : (c.risk ? h(NTag, { size: 'small', type: 'warning', bordered: false }, () => '接近')
                        : h(NTag, { size: 'small', type: 'success', bordered: false }, () => '正常')),
            },
        ]);
        const eventColumns = [
            { title: '规则', key: 'check_name', width: 260, ellipsis: { tooltip: true } },
            { title: '说明', key: 'message', ellipsis: { tooltip: true }, render: e => {
                const txt = (e.message || '').trim();
                if (!txt) return h('span', { style: 'opacity:.35' }, '—');
                // 事件消息第一行是判定摘要，后面是来源/错误样本；单元格放首行，悬停看全文
                const first = txt.split('\n').find(l => l.trim()) || txt;
                if (!txt.includes('\n')) return first;
                return h(NTooltip, { style: 'max-width:680px' }, {
                    trigger: () => h('span', { style: 'cursor:help' }, first + ' …'),
                    default: () => h('pre', { style: 'margin:0;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:420px;overflow:auto' }, txt),
                });
            } },
            { title: '状态', key: 'status', width: 80, render: e => e.status === 'firing' ? h(NTag, { size: 'tiny', type: 'error', bordered: false }, () => '触发中') : h(NTag, { size: 'tiny', bordered: false }, () => '已恢复') },
            { title: '峰值', key: 'peak_value', width: 100, render: e => h('span', { style: 'font-family:monospace' }, e.peak_value || e.value) },
            { title: '首次', key: 'first_at', width: 150, render: e => (e.first_at || '').replace('T', ' ').slice(0, 16) },
            { title: '恢复', key: 'resolved_at', width: 150, render: e => e.resolved_at ? e.resolved_at.replace('T', ' ').slice(0, 16) : '—' },
        ];
        const childColumns = [
            { title: '对象', key: 'name', render: o => o.name.replace(' 主机指标', '').replace(' 应用指标', '') },
            { title: '角色', key: 'role', width: 100, render: o => (o.labels && o.labels.role) || '' },
            { title: '状态', key: 'status', width: 76, render: objStatusTag },
            ...OBJ_METRIC_COLS.slice(0, 4).map(def => ({ title: def.label, key: def.metric, width: 84, render: o => objMetricCell(o, def) })),
        ];

        return () => h(NSpin, { show: loading.value }, () => {
            const d = data.value;
            if (!d) return h('div', { style: 'height:200px' });
            const o = d.object;
            const kpis = OBJ_METRIC_COLS.map(def => {
                const c = (o.checks || []).find(x => x.metric === def.metric && x.has_value);
                return c ? { label: def.label, check: c, pct: def.pct } : null;
            }).filter(Boolean);
            return h('div', { class: 'page-body' }, [
                h('div', { class: 'obj-head' }, [
                    h('div', { class: 'obj-head-main' }, [
                        h(NButton, { size: 'medium', secondary: true, circle: true, class: 'obj-back', onClick: () => router.push('/objects'), title: '返回对象列表' },
                            () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
                                [h('path', { d: 'M15 18l-6-6 6-6' })])),
                        // 标题即下拉：可搜索、直接切到另一台；选中态只显示名字，状态标签由右侧统一给
                        objectOptions.value.length > 1 ? h('div', { class: 'obj-title-select' }, [h(NSelect, {
                            value: o.id, options: objectOptions.value, filterable: true, size: 'large',
                            consistentMenuWidth: false, placeholder: '选择对象',
                            renderLabel: (opt, selected) => selected ? opt.label : h('span', { style: 'display:inline-flex;align-items:center;gap:8px' }, [
                                opt.label,
                                opt.status && opt.status !== 'ok' ? h(NTag, { size: 'tiny', bordered: false, type: opt.status === 'firing' ? 'error' : opt.status === 'risk' ? 'warning' : 'default' },
                                    () => ({ firing: '告警', risk: '风险', stale: '停止' }[opt.status] || opt.status)) : null,
                            ]),
                            'onUpdate:value': id => { if (id && id !== o.id) router.push('/objects/' + id); },
                        })]) : h('span', { class: 'page-title' }, objName(o.name)),
                        objStatusTag(o),
                    ]),
                    h('div', { class: 'obj-head-meta' }, [
                        ...Object.entries(o.labels || {}).filter(([, v]) => v && v !== '-').map(([k, v]) =>
                            h('span', { class: 'obj-chip' }, [h('span', { class: 'obj-chip-k' }, ({ host: '宿主', role: '角色', vm: 'VM' }[k] || k)), v])),
                        h('span', { class: 'obj-chip' }, [h('span', { class: 'obj-chip-k' }, '采集'), `每 ${o.interval_sec}s`]),
                    ]),
                ]),
                (() => {
                    const last = res.value.length ? res.value[res.value.length - 1] : null;
                    const cards = kpis.map(k => {
                        const v = k.check.value;
                        let caption = k.check.matched ? '▲ 触发中' : (k.check.risk ? '接近阈值 ' + k.check.threshold : '阈值 ' + k.check.threshold);
                        if (k.label === '内存' && o.mem_total) caption = `已用 ${(v * o.mem_total / 100 / 1073741824).toFixed(1)} / 共 ${fmtGB(o.mem_total)}`;
                        return { label: k.label, value: (Math.round(v * 10) / 10) + (k.pct ? '%' : ''), caption,
                            tone: k.check.matched ? 'crit' : (k.check.risk ? 'warn' : '') };
                    });
                    // node 目标补两张来自资源采样的卡：CPU、网络（规则里没有这两个指标）
                    if (last && o.kind === 'node') {
                        cards.splice(1, 0, { label: 'CPU', value: (Math.round(last.cpu * 10) / 10) + '%', caption: `IO 等待 ${(Math.round(last.iowait * 10) / 10)}%`, tone: last.cpu >= 90 ? 'warn' : '' });
                        cards.push({ label: '网络', value: '↓ ' + fmtBps(last.net_rx), caption: '↑ ' + fmtBps(last.net_tx), tone: '', small: true });
                    }
                    return cards.length ? h('div', { class: 'obj-kpis' }, cards.map(k => h('div', { class: 'sen-card sen-kpi ' + k.tone }, [
                        h('div', { class: 'k-label' }, k.label),
                        h('div', { class: 'k-value' + (k.small ? ' k-small' : '') }, k.value),
                        h('div', { class: 'k-caption' }, k.caption),
                    ]))) : null;
                })(),

                o.kind === 'node' ? [
                    h('div', { class: 'sen-sec', style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' }, [
                        '资源趋势',
                        h('div', { style: 'margin-left:auto;display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:10px;background:var(--stat-card-bg,rgba(128,128,128,.07))' }, [
                            h(NButtonGroup, { size: 'small' }, () =>
                                [['yesterday', '昨天'], ['today', '今天'], ['7d', '最近七天']].map(([k, l]) =>
                                    h(NButton, {
                                        type: resRange.value === k ? 'primary' : 'default', secondary: resRange.value !== k,
                                        style: 'padding:0 14px', onClick: () => { resCustom.value = null; resRange.value = k; },
                                    }, () => l))),
                            h(NDatePicker, {
                                type: 'datetimerange', size: 'small', clearable: true, style: 'width:360px',
                                value: resCustom.value, startPlaceholder: '开始时间', endPlaceholder: '结束时间',
                                format: 'MM-dd HH:mm', status: resRange.value === 'custom' ? 'success' : undefined,
                                'onUpdate:value': v => { resCustom.value = v; resRange.value = v ? 'custom' : 'today'; },
                            }),
                            h(NTooltip, null, {
                                trigger: () => h(NButton, { size: 'small', circle: true, secondary: true, loading: resLoading.value, onClick: loadResources },
                                    () => h('span', { style: 'font-size:15px;line-height:1' }, '↻')),
                                default: () => '刷新（页面每 30 秒也会自动刷新）',
                            }),
                        ]),
                    ]),
                    res.value.length < 2
                        ? h('div', { class: 'sen-card', style: 'padding:22px;text-align:center;opacity:.55;font-size:13px;margin-bottom:20px' },
                            resLoading.value ? '加载中…' : '该时间段暂无采样数据（每分钟采一次，新部署后约 2 分钟出现第一批点）')
                        : h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(480px,1fr));gap:12px;margin-bottom:20px' },
                            RES_CHARTS.map(c => h('div', { class: 'sen-card', style: 'padding:10px 12px 4px' }, [
                                h('div', { style: 'font-weight:600;font-size:13px;margin-bottom:2px' }, c.title),
                                h(ResChart, { points: res.value, series: c.series, yAxes: c.yAxes }),
                            ]))),
                ] : null,

                h('div', { class: 'sen-sec' }, `全部规则（${(o.checks || []).length} 条，来源混排）`),
                h(NDataTable, { columns: checkColumns.value, data: o.checks || [], size: 'small', bordered: false }),

                d.children && d.children.length ? [
                    h('div', { class: 'sen-sec' }, `承载的对象（${d.children.length}）`),
                    h(NDataTable, {
                        columns: childColumns, data: d.children, size: 'small', bordered: false,
                        rowProps: c => ({ style: 'cursor:pointer', onClick: () => router.push('/objects/' + c.id) }),
                    }),
                ] : null,

                evTotal.value > 0 ? [
                    h('div', { class: 'sen-sec' }, `告警事件（${evTotal.value}）`),
                    h(NDataTable, {
                        columns: eventColumns, data: events.value, size: 'small', bordered: false,
                        loading: evLoading.value, remote: true,
                        pagination: {
                            page: evPage.value, pageSize: evPageSize.value, itemCount: evTotal.value,
                            showSizePicker: true, pageSizes: [10, 20, 50, 100],
                            onUpdatePage: p => { evPage.value = p; },
                            onUpdatePageSize: ps => { evPageSize.value = ps; evPage.value = 1; },
                        },
                    }),
                ] : null,

                h(NModal, {
                    show: !!trend.value, 'onUpdate:show': v => { if (!v) trend.value = null; },
                    preset: 'card', title: trend.value ? trend.value.check.name : '',
                    style: 'width:860px;max-width:96vw', segmented: true,
                }, () => trend.value ? h('div', null, [
                    h(NSpace, { style: 'margin-bottom:10px' }, () => [24, 72].map(hs =>
                        h(NButton, { size: 'tiny', type: trend.value.hours === hs ? 'primary' : 'default', secondary: trend.value.hours !== hs, onClick: () => openTrend(trend.value.check, hs) },
                            () => '最近 ' + hs + ' 小时'))),
                    h(NSpin, { show: trendLoading.value }, () =>
                        trend.value.points.length >= 2
                            ? h('div', null, [
                                svgLine(trend.value.points, 800, 240, { fill: true, width: 2, interactive: true, style: 'width:100%;height:240px;display:block' }),
                                h('div', { style: 'display:flex;justify-content:space-between;font-size:11px;opacity:.55;font-family:monospace;margin-top:4px' }, [
                                    h('span', null, new Date(trend.value.points[0].t * 1000).toLocaleString()),
                                    h('span', null, '峰值 ' + Math.round(Math.max(...trend.value.points.map(p => p.v)) * 100) / 100 +
                                        ' · 均值 ' + Math.round(trend.value.points.reduce((a, p) => a + p.v, 0) / trend.value.points.length * 100) / 100),
                                    h('span', null, new Date(trend.value.points[trend.value.points.length - 1].t * 1000).toLocaleString()),
                                ]),
                            ])
                            : h(NEmpty, { description: '样本还不够（每分钟采一点，稍后再来）', style: 'margin:60px 0' })),
                ]) : null),
            ]);
        });
    },
});

// ============================================================
// Router
// ============================================================
const routes = [
    { path: '/', redirect: '/overview' },
    { path: '/login', component: LoginPage },
    { path: '/overview', component: OverviewPage },
    { path: '/alerts', redirect: '/overview' },
    { path: '/objects', component: ObjectsPage },
    { path: '/objects/:id', component: ObjectDetailPage },
    { path: '/dashboard', component: DashboardPage },
    { path: '/databases', component: DatabasesPage },
    { path: '/notifications', component: NotificationsPage },
    { path: '/slow-queries', component: SlowQueriesPage },
    { path: '/ignored-sql', component: IgnoredSQLPage },
    { path: '/custom-sql', component: CustomSQLPage },
    { path: '/custom-sql-logs', component: CustomSQLLogsPage },
    { path: '/cloud-logging', redirect: '/cloud-logging-configs' },
    { path: '/cloud-logging-query', component: CloudLoggingPage },
    { path: '/cloud-logging-checks', component: CloudLoggingPage },
    { path: '/cloud-logging-configs', component: CloudLoggingPage },
    { path: '/cloud-logging-logs', component: CloudLoggingPage },
    { path: '/monitor-logs', component: MonitorLogsPage },
    { path: '/rocketmq', component: RocketMQPage },
    { path: '/rocketmq-alerts', component: RocketMQAlertsPage },
    { path: '/health-checks', component: HealthChecksPage },
    { path: '/health-checks-logs', component: HealthCheckLogsPage },
    { path: '/grafana', component: GrafanaPage },
    { path: '/grafana-alerts', component: GrafanaAlertsPage },
    { path: '/prom-targets', component: PromTargetsPage },
    { path: '/prom-checks', component: PromChecksPage },
    { path: '/prom-logs', component: PromLogsPage },
    { path: '/cert-checks', component: CertChecksPage },
    { path: '/audit-logs', component: AuditLogsPage },
    { path: '/settings', component: SettingsPage },
];

const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach(async (to) => {
    if (to.path === '/login') { _sessionValid = false; return true; }
    if (_sessionValid) return true;
    try {
        await api.get('/api/auth/me');
        _sessionValid = true;
        return true;
    } catch (e) {
        // Network error — allow navigation, don't force login
        if (e.message === 'network_error') return true;
        return '/login';
    }
});

// ============================================================
// App
// ============================================================
// Expose message API globally for non-component usage
const MessageBridge = defineComponent({
    setup() {
        window.$message = useMessage();
        return () => null;
    }
});

const app = createApp({
    setup() {
        const currentTheme = computed(() => _isDark.value ? darkTheme : null);
        return () => h(NConfigProvider, { theme: currentTheme.value, locale: zhCN, dateLocale: dateZhCN }, () =>
            h(NMessageProvider, { containerStyle: 'z-index:9999' }, () => [h(MessageBridge), h(AppLayout), SqlDetailModal()])
        );
    }
});

app.use(router);
app.mount('#app');
