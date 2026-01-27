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

    normalizeHistoryEntry(chat) {
        const app = this.app;
        if (!chat || typeof chat !== 'object') return null;
        const rawTaskId = chat.taskId || chat.id || chat.runId || String(chat.timestamp || Date.now());
        const taskId = this.normalizeTaskId(rawTaskId);
        const messages = Array.isArray(chat.messages) ? chat.messages : [];
        const timestamp = typeof chat.timestamp === 'number' ? chat.timestamp : Date.now();
        const createdAt = typeof chat.createdAt === 'number'
            ? chat.createdAt
            : (typeof chat.timestamp === 'number' ? chat.timestamp : Date.now());
        return {
            ...chat,
            id: taskId,
            taskId,
            runId: chat.runId || null,
            sessionId: chat.sessionId || null,
            status: chat.status || null,
            createdAt,
            timestamp,
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
            const textElement = msg.querySelector('.message-text');
            return {
                role: isUser ? 'user' : 'assistant',
                content: textElement ? textElement.textContent : '',
                html: textElement ? textElement.innerHTML : ''
            };
        }).filter(m => m.content);
    }

    buildChatTitle(messages, fallback) {
        const base = fallback || messages[0]?.content || '新对话';
        const trimmed = String(base).trim();
        if (!trimmed) return '新对话';
        return trimmed.length > 50 ? trimmed.slice(0, 50) + '…' : trimmed;
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
        const now = Date.now();
        const normalizedId = this.normalizeTaskId(chat.id || chat.taskId || chat.runId || now);
        const index = this.findChatIndex({ id: normalizedId, runId: chat.runId });
        const existing = index >= 0 ? app.chatHistory[index] : null;
        const hasSessionId = Object.prototype.hasOwnProperty.call(chat, 'sessionId');
        const nextMessages = Array.isArray(chat.messages) && chat.messages.length
            ? chat.messages
            : (existing?.messages || []);
        const nextTitle = chat.title || existing?.title || this.buildChatTitle(nextMessages, null);
        const next = {
            ...(existing || {}),
            ...chat,
            id: normalizedId,
            taskId: normalizedId,
            runId: chat.runId || existing?.runId || null,
            sessionId: hasSessionId ? chat.sessionId : (existing?.sessionId || null),
            status: chat.status || existing?.status || null,
            createdAt: existing?.createdAt || chat.createdAt || now,
            timestamp: now,
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
            const statusLabel = app.utils.getHistoryStatusLabel(chat.status);
            const statusHtml = statusLabel
                ? `<span class="history-item-status ${statusType}">${app.utils.escapeHtml(statusLabel)}</span>`
                : '';
            const activeClass = chat.id === app.activeChatId ? ' active' : '';
            return `
                <div class="history-item${activeClass}" data-chat-id="${chat.id}">
                    <span class="history-item-icon status-${statusType}">
                        ${app.utils.getHistoryStatusIcon(statusType)}
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
                this.deleteChat(chatId);
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

        chat.messages.forEach(msg => {
            const messageElement = app.ui.createMessageElement(msg.role);
            const textElement = messageElement.querySelector('.message-text');

            if (msg.html) {
                textElement.innerHTML = msg.html;
            } else {
                textElement.textContent = msg.content;
            }
            app.elements.messages.appendChild(messageElement);
        });

        app.ui.attachRunMessagesForChat(chat.id);
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
}
