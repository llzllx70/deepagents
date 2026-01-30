/** @typedef {import('../app.js').DeepAgentsClient} DeepAgentsClient */

export class UtilsModule {
    /** @param {DeepAgentsClient} app */
    constructor(app) {
        /** @type {DeepAgentsClient} */
        this.app = app;
    }

    updateBridgeMeta() {
        const app = this.app;
        const doc = document.documentElement;
        const serverUrl = app.serverUrl || '';
        const wsProtocol = serverUrl.startsWith('https') ? 'wss:' : 'ws:';
        const wsHost = serverUrl.replace(/^https?:\/\//, '');
        const wsBase = serverUrl ? `${wsProtocol}//${wsHost}/ws/browser` : '';
        const sessionId = app.sessionId || '';
        const token = app.authToken || '';
        if (doc) {
            if (wsBase) {
                doc.dataset.daServerWsBase = wsBase;
            } else {
                delete doc.dataset.daServerWsBase;
            }
            if (sessionId) {
                doc.dataset.daSessionId = sessionId;
            } else {
                delete doc.dataset.daSessionId;
            }
            if (token) {
                doc.dataset.daToken = token;
            } else {
                delete doc.dataset.daToken;
            }
        }
        try {
            if (wsBase) {
                localStorage.setItem('deepagents_server_ws_base', wsBase);
            } else {
                localStorage.removeItem('deepagents_server_ws_base');
            }
            if (serverUrl) {
                localStorage.setItem('deepagents_server_url', serverUrl);
            } else {
                localStorage.removeItem('deepagents_server_url');
            }
            if (sessionId) {
                localStorage.setItem('deepagents_session_id', sessionId);
            } else {
                localStorage.removeItem('deepagents_session_id');
            }
            if (token) {
                localStorage.setItem('deepagents_auth_token', token);
            } else {
                localStorage.removeItem('deepagents_auth_token');
            }
        } catch {
            // ignore storage failures
        }
    }

    // Text helpers (zh-CN)
    formatConnectionStatus(status) {
        const map = {
            connected: '已连接',
            connecting: '连接中',
            disconnected: '未连接',
        };
        return map[status] || String(status || '');
    }

    formatRunStatus(status) {
        const map = {
            running: '运行中',
            completed: '已完成',
            failed: '失败',
            cancelled: '已取消',
            rejected: '已拒绝',
            queued: '已排队',
        };
        return map[status] || String(status || '');
    }

    formatToolStatus(status) {
        const map = {
            running: '运行中',
            success: '成功',
            error: '失败',
            cancelled: '已取消',
        };
        return map[status] || String(status || '');
    }

    compactInline(value, maxLength = 160) {
        const text = String(value ?? '').replace(/\s+/g, ' ').trim();
        if (!text) return '';
        if (text.length <= maxLength) return text;
        return `${text.slice(0, maxLength)}...`;
    }

    formatToolDisplay(toolName, args, todoStateOverride = null, displayTitle = null, displayContent = null) {
        const name = String(toolName || '');
        const a = args && typeof args === 'object' ? args : {};
        const titleMap = {
            task: '任务分解',
            write_todos: '任务列表',
            web_search: '搜索',
            fetch_url: '浏览',
            http_request: '浏览',
            read_file: '读取文件',
            write_file: '创建文件',
            edit_file: '编辑文件',
            shell: '执行命令',
            execute: '执行命令',
            ls: '查看目录',
            pdf_to_word: '转换文件格式',
            qwen_image_understand: '查看图片',
            qwen_image_generate: '生成图片',
        };
        const title = displayTitle || titleMap[name] || name || 'tool';
        let content = displayContent;
        if (!content) {
            content = this.formatToolSummary(name, a, todoStateOverride);
        }
        content = this.compactInline(content);
        return { title, content: content || '' };
    }

    formatFileOpStatus(status) {
        const map = {
            pending: '进行中',
            success: '成功',
            error: '失败',
        };
        return map[status] || String(status || '');
    }

    formatLogLevel(level) {
        const normalized = String(level || '').toLowerCase();
        const map = {
            info: '信息',
            warning: '警告',
            error: '错误',
        };
        return map[normalized] || normalized.toUpperCase() || '信息';
    }

    formatToolSummary(toolName, args, todoStateOverride = null) {
        const app = this.app;
        const name = String(toolName || '');
        const a = args && typeof args === 'object' ? args : {};

        if (name === 'web_search') {
            const query = a.query || a.q || a.text || '';
            return query ? String(query) : '';
        }

        if (name === 'write_todos') {
            const todos = Array.isArray(a.todos) ? a.todos : [];
            const todoState = todoStateOverride ?? app.todoState;
            const progress = this.getTodoProgress(todoState, todos);
            if (progress.summary) return progress.summary;
            const counts = this.countTodosByStatus(todos);
            const total = counts.pending + counts.in_progress + counts.completed;
            if (!total) return '';
            return `处理中：${counts.in_progress}  待处理：${counts.pending}  已完成：${counts.completed}`;
        }

        if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
            const filePath = a.file_path || a.path || a.file || '';
            return filePath ? String(filePath) : '';
        }

        if (name === 'ls') {
            const path = a.path || a.dir || a.directory || '';
            return path ? String(path) : '当前目录';
        }

        if (name === 'shell' || name === 'execute') {
            const command = a.command || a.cmd || a.value || '';
            return command ? String(command) : '';
        }

        if (name === 'fetch_url') {
            const url = a.url || '';
            return url ? String(url) : '';
        }

        if (name === 'http_request') {
            const method = a.method ? String(a.method).toUpperCase() : '';
            const url = a.url ? String(a.url) : '';
            return [method, url].filter(Boolean).join(' ');
        }

        if (name === 'task') {
            const description = a.description || '';
            return description ? String(description) : '';
        }

        if (name === 'pdf_to_word') {
            const outputPath = a.output_path || a.output || a.out_path || a.pdf_path || '';
            return outputPath ? String(outputPath) : '';
        }

        if (name === 'qwen_image_understand') {
            const imagePath = a.image_path || a.path || '';
            return imagePath ? String(imagePath) : '';
        }

        if (name === 'qwen_image_generate') {
            const outputPath = a.output_path || a.path || '';
            return outputPath ? String(outputPath) : '';
        }

        if (name === 'glob') {
            const pattern = a.pattern || a.glob || a.value || '';
            const path = a.path || a.dir || a.directory || '';
            const parts = [];
            if (pattern) parts.push(String(pattern));
            if (path) parts.push(String(path));
            return parts.join(' / ');
        }

        if (name === 'grep') {
            const pattern = a.pattern || a.query || a.q || a.value || '';
            const path = a.path || a.dir || a.directory || '';
            const glob = a.glob || a.include || a.file_glob || '';
            const parts = [];
            if (pattern) parts.push(String(pattern));
            if (glob) parts.push(String(glob));
            if (path) parts.push(String(path));
            return parts.join(' / ');
        }

        return '';
    }

    countTodosByStatus(todos) {
        const counts = { pending: 0, in_progress: 0, completed: 0 };
        if (!Array.isArray(todos) || !todos.length) return counts;
        for (const todo of todos) {
            const status = String(todo?.status || 'pending');
            if (status === 'completed') counts.completed += 1;
            else if (status === 'in_progress') counts.in_progress += 1;
            else counts.pending += 1;
        }
        return counts;
    }

    normalizeTodos(todos) {
        if (!Array.isArray(todos) || !todos.length) return [];
        return todos
            .map(t => ({
                content: String(t?.content || '').trim(),
                status: String(t?.status || 'pending'),
            }))
            .filter(t => t.content.length > 0);
    }

    getTodoProgress(prevTodos, nextTodos) {
        const prev = this.normalizeTodos(prevTodos);
        const next = this.normalizeTodos(nextTodos);
        if (!prev.length || !next.length) return { started: [], completed: [], summary: '', tooltip: '' };

        const prevByContent = new Map();
        const nextByContent = new Map();

        for (const t of prev) {
            const existing = prevByContent.get(t.content);
            if (existing) {
                prevByContent.set(t.content, null);
            } else {
                prevByContent.set(t.content, t.status);
            }
        }
        for (const t of next) {
            const existing = nextByContent.get(t.content);
            if (existing) {
                nextByContent.set(t.content, null);
            } else {
                nextByContent.set(t.content, t.status);
            }
        }

        const started = [];
        const completed = [];
        for (const [content, prevStatus] of prevByContent.entries()) {
            if (prevStatus == null) continue;
            const nextStatus = nextByContent.get(content);
            if (nextStatus == null) continue;
            if (prevStatus === 'pending' && nextStatus === 'in_progress') started.push(content);
            if (
                (prevStatus === 'in_progress' && nextStatus === 'completed') ||
                (prevStatus === 'pending' && nextStatus === 'completed')
            ) {
                completed.push(content);
            }
        }

        const tooltipLines = [];
        for (const c of completed) tooltipLines.push(`已完成: ${c}`);
        for (const c of started) tooltipLines.push(`开始处理: ${c}`);

        const summaryLines = [];
        if (completed.length) {
            summaryLines.push(
                `已完成：${completed[0]}${completed.length > 1 ? `（+${completed.length - 1}）` : ''}`
            );
        }
        if (started.length) {
            summaryLines.push(
                `开始处理：${started[0]}${started.length > 1 ? `（+${started.length - 1}）` : ''}`
            );
        }
        const summary = summaryLines.join('\n');

        return {
            started,
            completed,
            summary,
            tooltip: tooltipLines.join('\n'),
        };
    }

    renderTodoListHtml(todos, prevTodos = null) {
        const progress = this.getTodoProgress(prevTodos, todos);
        const counts = this.countTodosByStatus(todos);

        const progressChips = [];
        if (progress.completed.length) {
            const label = `已完成：${progress.completed[0]}${progress.completed.length > 1 ? `（+${progress.completed.length - 1}）` : ''}`;
            progressChips.push({ cls: 'completed', label });
        }
        if (progress.started.length) {
            const label = `开始处理：${progress.started[0]}${progress.started.length > 1 ? `（+${progress.started.length - 1}）` : ''}`;
            progressChips.push({ cls: 'started', label });
        }

        const progressHtml = progressChips.length
            ? `
                <div class="todo-progress-chips" title="${this.escapeHtml(progress.tooltip || progressChips.map(c => c.label).join('\n'))}">
                    ${progressChips.map(c => `<span class="todo-progress ${c.cls}">${this.escapeHtml(c.label)}</span>`).join('')}
                </div>
            `
            : '';

        const badges = [
            { cls: 'in-progress', label: `处理中 ${counts.in_progress}` },
            { cls: 'pending', label: `待处理 ${counts.pending}` },
            { cls: 'completed', label: `已完成 ${counts.completed}` },
        ];
        const badgesHtml = `
            <div class="todo-badges">
                ${badges.map(b => `<span class="todo-badge ${b.cls}">${this.escapeHtml(b.label)}</span>`).join('')}
            </div>
        `;

        return `
            <div class="todo-list-header" onclick="this.parentElement.classList.toggle('expanded')">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 11l3 3L22 4"></path>
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                </svg>
                <div class="todo-header-text">
                    <span class="todo-title">任务</span>
                    ${progressHtml}
                    ${badgesHtml}
                </div>
                <svg class="todo-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
            </div>
            <div class="todo-items">
                ${todos.map(todo => this.createTodoItemHTML(todo)).join('')}
            </div>
        `;
    }

    createTodoItemHTML(todo) {
        const isChecked = todo.status === 'completed' ? 'checked' : '';
        const isCompleted = todo.status === 'completed' ? 'completed' : '';
        return `
            <div class="todo-item ${isCompleted}">
                <input type="checkbox" class="todo-checkbox" ${isChecked} disabled>
                <span class="todo-text">${this.escapeHtml(todo.content)}</span>
            </div>
        `;
    }

    truncateText(text, maxLen) {
        const s = String(text || '');
        if (s.length <= maxLen) return s;
        return s.slice(0, Math.max(0, maxLen - 1)) + '…';
    }

    guessLanguageClass(path) {
        const p = String(path || '').toLowerCase();
        if (p.endsWith('.md')) return 'language-markdown';
        if (p.endsWith('.py')) return 'language-python';
        if (p.endsWith('.js')) return 'language-javascript';
        if (p.endsWith('.ts')) return 'language-typescript';
        if (p.endsWith('.json')) return 'language-json';
        if (p.endsWith('.yaml') || p.endsWith('.yml')) return 'language-yaml';
        if (p.endsWith('.html') || p.endsWith('.htm')) return 'language-html';
        if (p.endsWith('.css')) return 'language-css';
        return 'language-text';
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    encodePathSegments(pathValue) {
        return pathValue.split('/').map(encodeURIComponent).join('/');
    }

    getSessionIdForDownload() {
        const app = this.app;
        return app.sessionId || null;
    }

    normalizeDownloadRelativePath(relative) {
        if (!relative) return null;
        const cleaned = relative.replace(/^\/+/, '');
        if (!cleaned || cleaned.split('/').some(part => part === '..')) return null;
        const sessionId = this.getSessionIdForDownload();
        if (!sessionId) return cleaned;
        if (cleaned === sessionId || cleaned.startsWith(`${sessionId}/`)) return cleaned;
        return `${sessionId}/${cleaned}`;
    }

    getFilesRelativePath(rawPath) {
        if (rawPath == null) return null;
        let cleaned = String(rawPath).trim();
        cleaned = cleaned.replace(/^["'`]+|["'`]+$/g, '');
        if (!cleaned) return null;

        const normalized = cleaned.replace(/\\/g, '/');
        const withoutQuery = normalized.split(/[?#]/)[0];
        const lower = withoutQuery.toLowerCase();
        const filesToken = '/files/';
        const idx = lower.lastIndexOf(filesToken);
        if (idx === -1) return null;
        let relative = withoutQuery.slice(idx + filesToken.length);
        relative = relative.replace(/^\/+/, '');
        if (!relative || relative.split('/').some(part => part === '..')) return null;
        return relative;
    }

    getWorkspaceRelativePath(rawPath) {
        if (rawPath == null) return null;
        let cleaned = String(rawPath).trim();
        cleaned = cleaned.replace(/^["'`]+|["'`]+$/g, '');
        if (!cleaned) return null;

        const normalized = cleaned.replace(/\\/g, '/');
        if (/^[a-z]+:\/\//i.test(normalized)) return null;

        const lower = normalized.toLowerCase();
        const workspaceToken = '/workspace/';
        let relative = null;

        if (lower.includes(workspaceToken)) {
            const idx = lower.lastIndexOf(workspaceToken);
            relative = normalized.slice(idx + workspaceToken.length);
        } else if (lower.startsWith('workspace/')) {
            relative = normalized.slice('workspace/'.length);
        } else if (lower.startsWith('./workspace/')) {
            relative = normalized.slice('./workspace/'.length);
        } else {
            const bareToken = 'workspace/';
            const idx = lower.lastIndexOf(bareToken);
            if (idx !== -1) {
                const prevChar = idx === 0 ? '' : lower[idx - 1];
                if (idx === 0 || !/[a-z0-9_]/i.test(prevChar)) {
                    relative = normalized.slice(idx + bareToken.length);
                }
            }
            if (!relative && !normalized.startsWith('/') && !/^[a-zA-Z]:/.test(normalized)) {
                relative = normalized.replace(/^\.?\//, '');
            }
        }

        if (!relative) return null;
        relative = relative.replace(/^\/+/, '');
        if (!relative || relative.split('/').some(part => part === '..')) return null;
        return relative;
    }

    getDownloadUrl(rawPath) {
        const app = this.app;
        const relative = this.getFilesRelativePath(rawPath) || this.getWorkspaceRelativePath(rawPath);
        if (!relative) return null;
        const normalized = this.normalizeDownloadRelativePath(relative);
        if (!normalized) return null;
        return `${app.serverUrl}/files/${this.encodePathSegments(normalized)}`;
    }

    linkifyWorkspacePaths(text) {
        const app = this.app;
        if (!text) return text;
        const codeBlocks = [];
        const placeholderPrefix = '__CODE_BLOCK__';
        let processed = text.replace(/```[\s\S]*?```/g, (match) => {
            const token = `${placeholderPrefix}${codeBlocks.length}__`;
            codeBlocks.push(match);
            return token;
        });

        const getFileLabel = (value) => {
            const normalized = value.replace(/\\/g, '/').split('?')[0];
            const parts = normalized.split('/').filter(Boolean);
            return parts.length ? parts[parts.length - 1] : '文件下载';
        };

        const linkBlocks = [];
        const linkPlaceholderPrefix = '__LINK_BLOCK__';
        const downloadPattern = /下载[:：]\s*\/files\/[^\s'"<>),，。！？；：）】」』》]+/g;
        processed = processed.replace(downloadPattern, (match) => {
            const rawPath = match.replace(/^下载[:：]\s*/, '');
            const relative = this.getFilesRelativePath(rawPath);
            if (!relative) return match;
            const normalized = this.normalizeDownloadRelativePath(relative);
            if (!normalized) return match;
            const url = `${app.serverUrl}/files/${this.encodePathSegments(normalized)}`;
            const label = `下载：${getFileLabel(rawPath)}`;
            const token = `${linkPlaceholderPrefix}${linkBlocks.length}__`;
            linkBlocks.push(`[${label}](${url})`);
            return token;
        });

        const urlPattern = /https?:\/\/[^\s'"<>),，。！？；：）】」』》]+/g;
        processed = processed.replace(urlPattern, (match) => {
            const url = this.getDownloadUrl(match) || match;
            if (!url.includes('/files/')) return match;
            const label = `下载：${getFileLabel(match)}`;
            return `[${label}](${url})`;
        });

        const pathPattern = /(?:[A-Za-z]:)?[\\/][^\s'"<>),，。！？；：）】」』》]+?workspace[\\/][^\s'"<>),，。！？；：）】」』》]+\.[A-Za-z0-9]+|workspace\/[^\s'"<>),，。！？；：）】」』》]+\.[A-Za-z0-9]+|\.\/[^\s'"<>),，。！？；：）】」』》]+\.[A-Za-z0-9]+|[^\s'"<>),，。！？；：）】」』》]+\/[^\s'"<>),，。！？；：）】」』》]+\.[A-Za-z0-9]+/g;
        processed = processed.replace(pathPattern, (match) => {
            const url = this.getDownloadUrl(match);
            if (!url) return match;
            const label = `下载：${getFileLabel(match)}`;
            return `[${label}](${url})`;
        });

        codeBlocks.forEach((block, index) => {
            processed = processed.replace(`${placeholderPrefix}${index}__`, block);
        });

        linkBlocks.forEach((block, index) => {
            processed = processed.replace(`${linkPlaceholderPrefix}${index}__`, block);
        });

        return processed;
    }

    parseMarkdown(text) {
        if (typeof marked !== 'undefined') {
            const processedText = this.linkifyWorkspacePaths(text);
            let html = marked.parse(processedText);
            html = html.replace(/<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g, (match, lang, code) => {
                const langDisplay = lang ? lang.toUpperCase() : 'CODE';
                const codeClass = lang ? `language-${lang}` : '';
                return `
                    <div class="code-block-container">
                        <div class="code-block-header" onclick="this.parentElement.classList.toggle('collapsed')">
                            <span class="code-language">${langDisplay}</span>
                            <svg class="code-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        </div>
                        <pre><code class="${codeClass}">${code}</code></pre>
                    </div>
                `;
            });
            return html;
        }
        return this.escapeHtml(text).replace(/\n/g, '<br>');
    }

    formatDiff(diff) {
        return diff.split('\n').map(line => {
            if (line.startsWith('+')) {
                return `<span class="diff-add">${this.escapeHtml(line)}</span>`;
            } else if (line.startsWith('-')) {
                return `<span class="diff-remove">${this.escapeHtml(line)}</span>`;
            } else if (line.startsWith('@@') || line.startsWith('index') || line.startsWith('diff')) {
                return `<span class="diff-header">${this.escapeHtml(line)}</span>`;
            }
            return this.escapeHtml(line);
        }).join('\n');
    }

    formatToolResult(content) {
        if (content == null) return '';
        content = String(content);
        const isHtml = content.includes('<!DOCTYPE html>') ||
                      content.includes('<html') ||
                      /<html[^>]*>/i.test(content);

        if (isHtml) {
            const escapedContent = this.escapeHtml(content);
            return `
                <div class="html-preview-container">
                    <div class="html-preview-header" onclick="this.parentElement.classList.toggle('expanded')">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="16 18 22 12 16 6"></polyline>
                            <polyline points="8 6 2 12 8 18"></polyline>
                        </svg>
                        <span>HTML 代码（点击展开）</span>
                        <svg class="html-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </div>
                    <div class="html-preview-body">
                        <pre><code class="language-html">${escapedContent}</code></pre>
                    </div>
                </div>
            `;
        }

        return this.escapeHtml(content);
    }

    formatFileSize(bytes) {
        if (!bytes || bytes === 0) return '';
        const units = ['B', 'KB', 'MB', 'GB'];
        const k = 1024;
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        const size = (bytes / Math.pow(k, i)).toFixed(1);
        return `${size} ${units[i]}`;
    }

    isActiveRunStatus(status) {
        return status === 'running' || status === 'queued';
    }

    getHistoryStatusLabel(status) {
        if (this.isActiveRunStatus(status)) return '进行中';
        return '';
    }

    getHistoryStatusType(status) {
        if (this.isActiveRunStatus(status)) return 'running';
        if (status === 'completed' || status === 'success') return 'success';
        if (status === 'failed' || status === 'cancelled' || status === 'rejected' || status === 'error') {
            return 'failed';
        }
        return 'default';
    }

    getHistoryStatusIcon(statusType) {
        switch (statusType) {
            case 'success':
                return `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="9"></circle>
                        <path d="M8 12l2.5 2.5L16 9"></path>
                    </svg>
                `;
            case 'failed':
                return `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="9"></circle>
                        <line x1="9" y1="9" x2="15" y2="15"></line>
                        <line x1="15" y1="9" x2="9" y2="15"></line>
                    </svg>
                `;
            case 'running':
                return `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="9"></circle>
                        <path d="M12 7v5l3 2"></path>
                    </svg>
                `;
            default:
                return `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                `;
        }
    }

    generateTaskId() {
        return `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }

    generateRunId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
}
