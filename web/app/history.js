/** @typedef {import('../app.js').DeepAgentsClient} DeepAgentsClient */

export class HistoryModule {
    /** @param {DeepAgentsClient} app */
    constructor(app) {
        /** @type {DeepAgentsClient} */
        this.app = app;
    }

    normalizeTaskId(rawId) {
        const app = this.app;
        const value = rawId == null ? '' : String(rawId).trim();
        if (!value) return app.utils.generateTaskId();
        if (value.startsWith('task_')) return value;
        return `task_${value}`;
    }

    coerceDate(value) {
        if (value instanceof Date) return value;
        if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
        if (typeof value === 'string' && value.trim()) {
            const parsed = Date.parse(value);
            if (!Number.isNaN(parsed)) return new Date(parsed);
        }
        return null;
    }

    formatTimestamp(value) {
        const date = value instanceof Date ? value : this.coerceDate(value);
        if (!date) return null;
        return date.toISOString();
    }

    normalizeHistoryEntry(chat) {
        const app = this.app;
        if (!chat || typeof chat !== 'object') return null;
        const updatedAtSource = chat.updatedAt ?? chat.updated_at ?? chat.timestamp ?? chat.createdAt ?? chat.created_at;
        const updatedAtDate = this.coerceDate(updatedAtSource) || new Date();
        const createdAtDate = this.coerceDate(chat.createdAt ?? chat.created_at) || updatedAtDate;
        const rawTaskId = chat.taskId || chat.id || chat.runId || String(updatedAtDate.getTime());
        const taskId = this.normalizeTaskId(rawTaskId);
        const messages = this.sanitizeHistoryMessages(Array.isArray(chat.messages) ? chat.messages : []);
        const createdAt = this.formatTimestamp(createdAtDate) || new Date().toISOString();
        const updatedAt = this.formatTimestamp(updatedAtDate) || createdAt;
        const {
            timestamp: _timestamp,
            createdAt: _createdAt,
            updatedAt: _updatedAt,
            created_at: _created_at,
            updated_at: _updated_at,
            ...rest
        } = chat;
        return {
            ...rest,
            id: taskId,
            taskId,
            runId: chat.runId || null,
            sessionId: chat.sessionId || null,
            status: chat.status || null,
            createdAt,
            updatedAt,
            messages,
        };
    }

    async loadHistory() {
        const app = this.app;
        if (!app.serverUrl || !app.auth.isAuthenticated()) {
            app.chatHistory = [];
            app.runIdToChatId.clear();
            return app.chatHistory;
        }
        try {
            const response = await app.auth.authFetch(`${app.serverUrl}/history`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            const raw = Array.isArray(payload?.history) ? payload.history : [];
            app.chatHistory = raw.map(item => this.normalizeHistoryEntry(item)).filter(Boolean);
        } catch (error) {
            console.warn('加载历史失败：', error);
            app.chatHistory = [];
        }
        app.runIdToChatId.clear();
        app.chatHistory.forEach(chat => {
            if (chat && chat.runId) {
                app.runIdToChatId.set(chat.runId, chat.id);
            }
        });
        return app.chatHistory;
    }

    saveHistory() {
        this.persistHistory();
    }

    async persistHistory() {
        const app = this.app;
        if (!app.serverUrl || !app.auth.isAuthenticated()) return;
        try {
            await app.auth.authFetch(`${app.serverUrl}/history`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ history: app.chatHistory })
            });
        } catch (error) {
            console.warn('保存历史失败：', error);
        }
    }

    collectCurrentMessages() {
        const app = this.app;
        return Array.from(app.elements.messages.children).map(msg => {
            const isUser = msg.classList.contains('message') && msg.classList.contains('user');
            const payload = this.getMessageTextPayload(msg);
            const attachments = this.extractMessageAttachments(msg);
            const entry = {
                role: isUser ? 'user' : 'assistant',
                content: payload.content,
                html: payload.html
            };
            if (attachments.length) {
                entry.attachments = attachments;
            }
            return entry;
        }).filter(m => this.isMeaningfulMessage(m));
    }

    getMessageTextPayload(messageElement) {
        if (!messageElement) return { content: '', html: '' };
        const textElement = messageElement.querySelector('.message-text');
        if (!textElement) return { content: '', html: '' };
        const clone = textElement.cloneNode(true);
        clone.querySelectorAll('.thinking-indicator').forEach(node => node.remove());
        return {
            content: clone.textContent || '',
            html: clone.innerHTML || ''
        };
    }

    isMeaningfulMessage(message) {
        if (!message || typeof message !== 'object') return false;
        const content = String(message.content || '').trim();
        const html = String(message.html || '').trim();
        const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
        return Boolean(content || html || hasAttachments);
    }

    isThinkingMessage(message) {
        if (!message || message.role !== 'assistant') return false;
        const content = String(message.content || '').trim();
        const html = String(message.html || '').trim();
        const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
        if (hasAttachments) return false;
        if (content && content !== '思考中') return false;
        if (html && !html.includes('thinking-indicator') && !html.includes('thinking-text')) {
            return content === '思考中';
        }
        return content === '思考中' || html.includes('thinking-indicator') || html.includes('thinking-text');
    }

    sanitizeHistoryMessages(messages) {
        if (!Array.isArray(messages)) return [];
        const hasRealAssistant = messages.some(msg => msg?.role === 'assistant' && !this.isThinkingMessage(msg) && this.isMeaningfulMessage(msg));
        if (!hasRealAssistant) return messages;
        return messages.filter(msg => !(msg?.role === 'assistant' && this.isThinkingMessage(msg)));
    }

    parseAttachmentPayloads(value) {
        if (!value) return [];
        let payloads = value;
        if (typeof value === 'string') {
            try {
                payloads = JSON.parse(value);
            } catch (error) {
                console.warn('解析附件失败：', error);
                return [];
            }
        }
        if (!Array.isArray(payloads)) return [];
        const normalized = [];
        for (const item of payloads) {
            if (!item || typeof item !== 'object') continue;
            const fileId = item.fileId || item.file_id || item.id || '';
            const filename = item.filename || item.name || '';
            const contentType = item.contentType || item.content_type || item.mime_type || '';
            let size = item.size;
            if (typeof size !== 'number') {
                const parsed = Number(size);
                size = Number.isNaN(parsed) ? null : parsed;
            }
            if (!fileId && !filename) continue;
            normalized.push({ fileId, filename, contentType, size });
        }
        return normalized;
    }

    extractMessageAttachments(messageElement) {
        if (!messageElement) return [];
        const datasetValue = messageElement.dataset?.attachments;
        if (datasetValue) {
            const parsed = this.parseAttachmentPayloads(datasetValue);
            if (parsed.length) return parsed;
        }

        const list = messageElement.querySelector('.message-attachments');
        if (!list) return [];

        const listValue = list.dataset?.attachments;
        if (listValue) {
            const parsed = this.parseAttachmentPayloads(listValue);
            if (parsed.length) return parsed;
        }

        const items = Array.from(list.querySelectorAll('.message-attachment'));
        if (!items.length) return [];
        const payloads = [];
        items.forEach(item => {
            const fileId = item.getAttribute('data-file-id') || '';
            const filename = item.getAttribute('data-filename')
                || item.querySelector('.message-attachment-name')?.textContent?.trim()
                || '';
            const contentType = item.getAttribute('data-content-type') || '';
            const sizeValue = item.getAttribute('data-size');
            let size = null;
            if (sizeValue) {
                const parsed = Number(sizeValue);
                size = Number.isNaN(parsed) ? null : parsed;
            }
            if (!fileId && !filename) return;
            payloads.push({ fileId, filename, contentType, size });
        });
        return payloads;
    }

    buildChatTitle(messages, fallback) {
        const base = fallback || messages[0]?.content || '新对话';
        return this.summarizeTitleFromText(base);
    }

    summarizeTitleFromText(text) {
        const cleaned = this.sanitizeTitleSource(text);
        if (!cleaned) return '新对话';

        const action = this.extractActionVerb(cleaned);
        const phrase = this.extractActionObject(cleaned, action);
        const keywords = this.extractKeywords(cleaned);

        let summary = '';
        if (action && phrase) {
            summary = `${action}：${phrase}`;
        } else if (action && keywords.length) {
            summary = `${action}：${keywords.join('、')}`;
        } else if (keywords.length) {
            summary = keywords.join('、');
        } else {
            summary = cleaned;
        }

        summary = summary.replace(/\s+/g, ' ').trim();
        if (!summary) return '新对话';
        return summary.length > 50 ? summary.slice(0, 50) + '…' : summary;
    }

    sanitizeTitleSource(text) {
        if (!text) return '';
        let value = String(text);
        value = value.replace(/```[\s\S]*?```/g, ' ');
        value = value.replace(/`[^`]*`/g, ' ');
        value = value.replace(/\!\[[^\]]*\]\([^)]+\)/g, ' ');
        value = value.replace(/\[[^\]]+\]\([^)]+\)/g, ' ');
        value = value.replace(/https?:\/\/\S+/g, ' ');
        value = value.replace(/[\r\n]+/g, ' ');
        value = value.replace(/\s+/g, ' ').trim();
        return value;
    }

    extractActionVerb(text) {
        const verbs = [
            '修复', '优化', '实现', '增加', '删除', '调整', '配置', '编写', '生成',
            '分析', '总结', '对比', '翻译', '设计', '搭建', '规划', '整理', '重构',
            '升级', '迁移', '排查', '调试', '解释', '说明', '提取', '转换', '改造'
        ];
        for (const verb of verbs) {
            if (text.includes(verb)) return verb;
        }
        return '';
    }

    extractActionObject(text, action) {
        if (!action) return '';
        const pattern = new RegExp(`${action}([^。！？!?\\n]{2,40})`);
        const match = text.match(pattern);
        if (!match) return '';
        return match[1].replace(/^\s*(一下|一下子|一些|一下吧|一下子)/, '').trim();
    }

    extractKeywords(text) {
        const stopwords = new Set([
            '请', '帮我', '帮忙', '麻烦', '需要', '如何', '怎么', '一下', '一下子',
            '可以', '能否', '是否', '帮', '我', '你', '我们', '他们', '这个', '那个',
            '进行', '完成', '处理', '实现', '方案', '问题', '功能', '内容', '情况',
            '目前', '现在', '如果', '因为', '所以', '请问', '谢谢', '谢谢你'
        ]);
        const tokens = [];
        const cjk = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
        const latin = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || [];
        for (const token of [...cjk, ...latin]) {
            if (stopwords.has(token)) continue;
            tokens.push(token);
        }
        if (!tokens.length) return [];
        const counts = new Map();
        tokens.forEach(token => {
            counts.set(token, (counts.get(token) || 0) + 1);
        });
        return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
            .slice(0, 4)
            .map(([token]) => token);
    }

    findChatIndex({ id, runId }) {
        const app = this.app;
        if (id) {
            const normalizedId = this.normalizeTaskId(id);
            const byId = app.chatHistory.findIndex(c => c.id === normalizedId);
            if (byId >= 0) return byId;
        }
        if (runId) {
            return app.chatHistory.findIndex(c => c.runId === runId);
        }
        return -1;
    }

    resolveChatIdForRun(runId) {
        const app = this.app;
        if (runId && app.runIdToChatId.has(runId)) {
            return app.runIdToChatId.get(runId);
        }
        if (app.activeChatId) return app.activeChatId;
        if (!runId) return null;
        const index = this.findChatIndex({ runId });
        if (index >= 0) return app.chatHistory[index].id;
        return null;
    }

    upsertChatRecord(chat, { promote = false } = {}) {
        const app = this.app;
        const now = new Date();
        const nowIso = this.formatTimestamp(now) || new Date().toISOString();
        const normalizedId = this.normalizeTaskId(chat.id || chat.taskId || chat.runId || now.getTime());
        const index = this.findChatIndex({ id: normalizedId, runId: chat.runId });
        const existing = index >= 0 ? app.chatHistory[index] : null;
        const hasSessionId = Object.prototype.hasOwnProperty.call(chat, 'sessionId');
        const nextMessages = Array.isArray(chat.messages) && chat.messages.length
            ? chat.messages
            : (existing?.messages || []);
        // 历史记录名称仅记录第一次返回的数据，不覆盖
        const nextTitle = existing?.title || chat.title || this.buildChatTitle(nextMessages, null);
        const base = existing ? { ...existing } : {};
        delete base.timestamp;
        delete base.updatedAt;
        delete base.updated_at;
        delete base.createdAt;
        delete base.created_at;
        const incoming = { ...chat };
        delete incoming.timestamp;
        delete incoming.updatedAt;
        delete incoming.updated_at;
        delete incoming.createdAt;
        delete incoming.created_at;
        const createdAtDate = this.coerceDate(existing?.createdAt ?? existing?.created_at)
            || this.coerceDate(chat.createdAt ?? chat.created_at)
            || now;
        const createdAt = this.formatTimestamp(createdAtDate) || nowIso;
        const next = {
            ...base,
            ...incoming,
            id: normalizedId,
            taskId: normalizedId,
            runId: chat.runId || existing?.runId || null,
            sessionId: hasSessionId ? chat.sessionId : (existing?.sessionId || null),
            status: chat.status || existing?.status || null,
            createdAt,
            updatedAt: nowIso,
            title: nextTitle,
            messages: nextMessages,
        };

        if (index >= 0) {
            app.chatHistory.splice(index, 1, next);
        } else if (promote) {
            app.chatHistory.unshift(next);
        } else {
            app.chatHistory.push(next);
        }
        if (next.runId) {
            app.runIdToChatId.set(next.runId, next.id);
        }
        app.chatHistory = app.chatHistory.slice(0, 50);
        this.saveHistory();
        this.renderHistory();
    }

    updateChatStatus(runId, status) {
        const app = this.app;
        const chatId = this.resolveChatIdForRun(runId);
        if (!chatId) return;
        this.upsertChatRecord({
            id: chatId,
            taskId: chatId,
            runId: runId || app.currentRunId,
            sessionId: app.sessionId,
            status: status,
        });
    }

    backgroundCurrentChat(reason) {
        const app = this.app;
        if (!app.activeChatId) return;
        const messages = this.collectCurrentMessages();
        if (!messages.length) return;
        const chat = app.chatHistory.find(c => c.id === app.activeChatId);
        const activeRunId = app.currentRunId && this.resolveChatIdForRun(app.currentRunId) === app.activeChatId
            ? app.currentRunId
            : (chat?.runId || null);
        const status = chat?.status || app.currentRunStatus || (app.isRunning ? 'running' : null);
        this.saveCurrentChat({ status, runId: activeRunId });
    }

    saveCurrentChat({ status = null, runId = null, title = null } = {}) {
        const app = this.app;
        const messages = this.collectCurrentMessages();
        if (messages.length === 0) return;

        const chatId = app.activeChatId || app.utils.generateTaskId();
        app.activeChatId = chatId;

        const inferredRunId = app.currentRunId && this.resolveChatIdForRun(app.currentRunId) === chatId
            ? app.currentRunId
            : null;
        const nextStatus = status || app.currentRunStatus || (app.isRunning ? 'running' : null);
        const existingIndex = this.findChatIndex({ id: chatId, runId });
        const existing = existingIndex >= 0 ? app.chatHistory[existingIndex] : null;
        this.upsertChatRecord({
            id: chatId,
            taskId: chatId,
            runId: runId || inferredRunId,
            sessionId: existing?.sessionId || app.sessionId,
            title: title || this.buildChatTitle(messages, null),
            status: nextStatus,
            messages: messages,
        }, { promote: existingIndex < 0 });
    }

    renderHistory() {
        const app = this.app;
        app.elements.historyList.innerHTML = app.chatHistory.map(chat => {
            const statusType = app.utils.getHistoryStatusType(chat.status);
            // 只有运行中状态才显示状态标签
            const isRunning = statusType === 'running';
            const statusLabel = isRunning ? app.utils.getHistoryStatusLabel(chat.status) : '';
            const statusHtml = statusLabel
                ? `<span class="history-item-status ${statusType}">${app.utils.escapeHtml(statusLabel)}</span>`
                : '';
            const activeClass = chat.id === app.activeChatId ? ' active' : '';
            // 使用用户提供的任务图标
            return `
                <div class="history-item${activeClass}" data-chat-id="${chat.id}">
                    <span class="history-item-icon">
                        <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                            <path d="M742.4 935.7312H405.9648a261.12 261.12 0 0 1-260.7616-260.7616v-430.08a160.3072 160.3072 0 0 1 160.1024-160.256h336.4352a261.12 261.12 0 0 1 260.8128 260.8128v430.08A160.3072 160.3072 0 0 1 742.4 935.7312zM305.3056 146.0736a98.816 98.816 0 0 0-98.6624 98.7136v430.08a199.68 199.68 0 0 0 199.3216 199.3216H742.4a98.7648 98.7648 0 0 0 98.7136-98.6624v-430.08a199.68 199.68 0 0 0-199.3728-199.3728z"></path>
                            <path d="M689.2032 392.8576H358.4a30.72 30.72 0 0 1 0-61.44h330.7008a30.72 30.72 0 0 1 0 61.44zM583.1168 623.5648H358.4a30.72 30.72 0 0 1 0-61.44h224.6144a30.72 30.72 0 0 1 0 61.44z"></path>
                        </svg>
                    </span>
                    <span class="history-item-title">${app.utils.escapeHtml(chat.title || '新对话')}</span>
                    ${statusHtml}
                    <button class="history-delete-btn" data-chat-id="${chat.id}" title="删除对话">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            `;
        }).join('');

        app.elements.historyList.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.history-delete-btn')) return;
                const chatId = item.getAttribute('data-chat-id');
                this.loadChat(chatId);
            });
        });

        app.elements.historyList.querySelectorAll('.history-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const chatId = btn.getAttribute('data-chat-id');
                // Show confirmation modal instead of direct delete
                app.ui.showDeleteConfirmModal(chatId);
            });
        });
    }

    loadChat(chatId, { skipSessionSwitch = false } = {}) {
        const app = this.app;
        const chat = app.chatHistory.find(c => c.id === chatId);
        if (!chat) return;
        if (app.isRunning && app.currentRunId && app.currentRunId !== chat.runId) {
            this.backgroundCurrentChat('switch_chat');
        }

        // 关闭右侧工具详情侧边栏
        app.ui.closeToolDetailSidebar();
        
        app.ui.resetChatView();
        app.elements.chatTitle.textContent = chat.sessionId || chat.title || '对话';
        app.activeChatId = chat.id;
        app.currentRunId = chat.runId || null;
        app.currentRunStatus = chat.status || null;
        app.isRunning = app.utils.isActiveRunStatus(chat.status);
        app.ui.updateCancelButton(app.isRunning);
        app.ui.updateSendButton();
        if (chat.runId) {
            app.runIdToChatId.set(chat.runId, chat.id);
        }

        // 保存当前运行中的 runState（如果是同一个会话）
        let preservedRunState = null;
        if (chat.runId && app.utils.isActiveRunStatus(chat.status)) {
            preservedRunState = app.runStates.get(chat.runId);
        }

        // 清理该对话相关的 runStates，避免与历史消息重复显示
        for (const [runId, state] of app.runStates.entries()) {
            if (state.chatId === chat.id) {
                app.runStates.delete(runId);
                app.messageBuffer.delete(runId);
            }
        }

        let lastAssistantMessage = null;
        chat.messages.forEach(msg => {
            const messageElement = app.ui.createMessageElement(msg.role);
            const textElement = messageElement.querySelector('.message-text');

            if (Array.isArray(msg.attachments) && msg.attachments.length) {
                app.ui.appendMessageAttachments(messageElement, msg.attachments, { sessionId: chat.sessionId });
            }

            if (msg.html) {
                textElement.innerHTML = msg.html;
            } else {
                textElement.textContent = msg.content || '';
            }
            app.elements.messages.appendChild(messageElement);
            
            // 记录最后一个助手消息元素
            if (msg.role === 'assistant') {
                lastAssistantMessage = messageElement;
            }
        });
        app.ui.bindHistoryExpandableEntries(app.elements.messages);
        
        // 如果是正在运行的会话，恢复或创建 runState 并关联到最后一个消息元素
        if (chat.runId && app.utils.isActiveRunStatus(chat.status)) {
            // 检查最后一条消息是否是用户消息
            const lastMessage = chat.messages[chat.messages.length - 1];
            const lastMessageIsUser = lastMessage && lastMessage.role === 'user';
            
            // 如果最后一条是用户消息，需要创建新的AI消息元素来显示思考动效
            let targetMessageElement = lastAssistantMessage;
            if (lastMessageIsUser || !lastAssistantMessage) {
                // 创建新的AI消息元素
                targetMessageElement = app.ui.createMessageElement('assistant');
                app.elements.messages.appendChild(targetMessageElement);
                lastAssistantMessage = targetMessageElement;
            }
            
            let state = preservedRunState;
            if (!state) {
                state = {
                    runId: chat.runId,
                    chatId: chat.id,
                    messageElement: targetMessageElement,
                    assistantSegmentElement: null,
                    assistantSegmentText: '',
                    toolCalls: new Map(),
                    todoState: null,
                    currentTaskElement: null
                };
            } else {
                // 更新 messageElement 为当前显示的最后一个助手消息
                state.messageElement = targetMessageElement;
            }
            app.runStates.set(chat.runId, state);
            app.currentMessageElement = targetMessageElement;
            
            // 如果有 todoState，恢复任务抽屉
            if (state.todoState) {
                app.todoState = state.todoState;
                app.ui.updateTaskDrawer(state.todoState, null);
            }
            
            // 恢复思考动效：如果任务正在运行，显示思考中动效
            app.ui.showThinkingIndicator(targetMessageElement);
        }
        if (chat.sessionId) {
            app.network.setSessionState({ sessionId: chat.sessionId, chatId: chat.id, hasMessages: chat.messages.length > 0 });
        }

        const hasMessages = app.elements.messages.children.length > 0;
        app.elements.welcomeMessage.style.display = hasMessages ? 'none' : 'flex';

        const shouldRequestRunStatus = Boolean(chat.runId && app.utils.isActiveRunStatus(chat.status));
        const requestRunStatusId = shouldRequestRunStatus ? chat.runId : null;
        if (chat.sessionId && !skipSessionSwitch) {
            app.network.switchSession(chat.sessionId, { requestRunStatusId });
        }

        this.renderHistory();
        
        // 加载完成后滚动到底部
        app.ui.scrollToBottom();
    }

    async deleteChat(chatId) {
        const app = this.app;
        const chat = app.chatHistory.find(c => c.id === chatId);
        const sessionId = chat?.sessionId || null;
        const deletingActiveSession = Boolean(sessionId && sessionId === app.sessionId);

        if (deletingActiveSession) {
            app.network.disconnectWebSocket({ allowReconnect: false });
            app.sessionId = null;
            app.wsUrl = null;
            app.currentRunId = null;
            app.currentRunStatus = null;
            app.isRunning = false;
            app.ui.updateCancelButton(false);
            app.cancelRequested = false;
            app.pendingCancelLogElement = null;
        }

        if (sessionId) {
            if (deletingActiveSession) {
                await app.network.deleteSession(sessionId);
            } else {
                app.network.deleteSession(sessionId);
            }
        }

        app.chatHistory = app.chatHistory.filter(c => c.id !== chatId);
        if (app.activeChatId === chatId) {
            app.activeChatId = null;
        }
        for (const [runId, mappedChatId] of app.runIdToChatId.entries()) {
            if (mappedChatId === chatId) {
                app.runIdToChatId.delete(runId);
            }
        }
        for (const [runId, state] of app.runStates.entries()) {
            if (state.chatId === chatId) {
                app.runStates.delete(runId);
                app.messageBuffer.delete(runId);
            }
        }

        this.saveHistory();
        this.renderHistory();

        if (deletingActiveSession) {
            app.ui.resetChatView();
            app.elements.chatTitle.textContent = '对话';
            app.elements.welcomeMessage.style.display = 'flex';
            app.sessionId = null;
            app.wsUrl = null;
            app.ui.updateConnectionStatus('disconnected');
        }
    }

    hasCurrentMessages() {
        return this.collectCurrentMessages().length > 0;
    }

    /**
     * 清空所有历史记录
     */
    async clearAllHistory() {
        const app = this.app;
        
        // 断开当前 WebSocket 连接
        app.network.disconnectWebSocket({ allowReconnect: false });
        
        // 删除所有会话
        const sessionIds = [...new Set(app.chatHistory.map(c => c.sessionId).filter(Boolean))];
        for (const sessionId of sessionIds) {
            try {
                await app.network.deleteSession(sessionId);
            } catch (e) {
                console.warn('删除会话失败:', sessionId, e);
            }
        }
        
        // 清空历史记录
        app.chatHistory = [];
        app.activeChatId = null;
        app.runIdToChatId.clear();
        app.runStates.clear();
        app.messageBuffer.clear();
        app.sessionId = null;
        app.wsUrl = null;
        app.currentRunId = null;
        app.currentRunStatus = null;
        app.isRunning = false;
        
        // 保存并渲染
        this.saveHistory();
        this.renderHistory();
        
        // 重置界面
        app.ui.resetChatView();
        app.elements.chatTitle.textContent = '对话';
        app.elements.welcomeMessage.style.display = 'flex';
        app.ui.updateConnectionStatus('disconnected');
        app.ui.updateCancelButton(false);
        app.ui.updateSendButton();
        app.ui.clearTaskDrawer();
    }
}
