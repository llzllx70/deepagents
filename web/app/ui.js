/** @typedef {import('../app.js').DeepAgentsClient} DeepAgentsClient */

export class UiModule {
    /** @param {DeepAgentsClient} app */
    constructor(app) {
        /** @type {DeepAgentsClient} */
        this.app = app;
    }

    async init() {
        const app = this.app;
        this.cacheElements();
        this.setupEventListeners();

        const navEntry = performance.getEntriesByType('navigation')[0];
        const navType = navEntry?.type || 'navigate';
        const action = navType === 'reload' ? 'refresh' : 'load';
        app.network.logClient('page_load', { url: window.location.href, navType, action });
        app.auth.applyLoggedOutState();
    }

    cacheElements() {
        const app = this.app;
        app.elements = {
            sidebar: document.getElementById('sidebar'),
            newChatBtn: document.getElementById('newChatBtn'),
            sessionList: document.getElementById('sessionList'),
            historyList: document.getElementById('historyList'),
            autoApproveToggle: document.getElementById('autoApproveToggle'),
            connectionStatus: document.getElementById('connectionStatus'),
            loginForm: document.getElementById('loginForm'),
            loginUsername: document.getElementById('loginUsername'),
            loginPassword: document.getElementById('loginPassword'),
            loginBtn: document.getElementById('loginBtn'),
            logoutBtn: document.getElementById('logoutBtn'),
            loginStatus: document.getElementById('loginStatus'),
            loginUser: document.getElementById('loginUser'),

            sidebarToggle: document.getElementById('sidebarToggle'),
            chatTitle: document.getElementById('chatTitle'),
            cancelBtn: document.getElementById('cancelBtn'),

            chatContainer: document.getElementById('chatContainer'),
            welcomeMessage: document.getElementById('welcomeMessage'),
            messages: document.getElementById('messages'),

            userInput: document.getElementById('userInput'),
            sendBtn: document.getElementById('sendBtn'),

            interruptModal: document.getElementById('interruptModal'),
            interruptModalBody: document.getElementById('interruptModalBody'),
            interruptModalFooter: document.getElementById('interruptModalFooter'),
            closeModalBtn: document.getElementById('closeModalBtn'),
        };
        app.defaultInputPlaceholder = app.elements.userInput?.getAttribute('placeholder') || '';
    }

    setupEventListeners() {
        const app = this.app;
        app.elements.sidebarToggle.addEventListener('click', () => {
            app.elements.sidebar.classList.toggle('open');
        });

        if (app.elements.newChatBtn) {
            app.elements.newChatBtn.addEventListener('click', () => app.messages.newChat());
        }

        app.elements.autoApproveToggle.addEventListener('change', (e) => {
            app.autoApprove = e.target.checked;
            if (app.sessionId) {
                app.network.send({ type: 'auto_approve', enabled: app.autoApprove });
            }
            app.auth.saveUserConfig();
        });

        if (app.elements.loginForm) {
            app.elements.loginForm.addEventListener('submit', (e) => {
                e.preventDefault();
                app.auth.handleLogin();
            });
        }

        if (app.elements.logoutBtn) {
            app.elements.logoutBtn.addEventListener('click', () => app.auth.handleLogout());
        }

        if (app.elements.cancelBtn) {
            app.elements.cancelBtn.addEventListener('click', () => app.messages.cancelRun());
        }

        app.elements.userInput.addEventListener('input', () => {
            this.adjustTextareaHeight();
            this.updateSendButton();
        });

        app.elements.userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (app.isRunning) {
                    app.messages.cancelRun();
                } else {
                    app.messages.sendMessage();
                }
            }
        });

        app.elements.sendBtn.addEventListener('click', () => {
            if (app.isRunning) {
                app.messages.cancelRun();
            } else {
                app.messages.sendMessage();
            }
        });

        document.querySelectorAll('.example-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const prompt = btn.getAttribute('data-prompt');
                app.elements.userInput.value = prompt;
                this.adjustTextareaHeight();
                this.updateSendButton();
                app.elements.userInput.focus();
            });
        });

        app.elements.closeModalBtn.addEventListener('click', () => {
            app.elements.interruptModal.classList.remove('active');
        });

        app.elements.interruptModal.addEventListener('click', (e) => {
            if (e.target === app.elements.interruptModal) {
                app.elements.interruptModal.classList.remove('active');
            }
        });

        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768) {
                if (!app.elements.sidebar.contains(e.target) &&
                    !app.elements.sidebarToggle.contains(e.target)) {
                    app.elements.sidebar.classList.remove('open');
                }
            }
        });

        window.addEventListener('resize', () => {
            if (window.innerWidth > 768) {
                app.elements.sidebar.classList.remove('open');
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (app.elements.interruptModal.classList.contains('active')) {
                app.elements.interruptModal.classList.remove('active');
                return;
            }
            if (app.isRunning) {
                app.messages.cancelRun();
            }
        });

        window.addEventListener('pagehide', () => {
            app.network.logClient('page_hide', { reason: 'pagehide' }, 'info', { useBeacon: true });
            app.history.backgroundCurrentChat('pagehide');
            app.network.disconnectWebSocket({ allowReconnect: false });
        });
    }

    createMessageElement(type) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}`;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.textContent = type === 'user' ? 'U' : 'AI';

        const content = document.createElement('div');
        content.className = 'message-content';

        const text = document.createElement('div');
        text.className = 'message-text';

        content.appendChild(text);
        messageDiv.appendChild(avatar);
        messageDiv.appendChild(content);

        return messageDiv;
    }

    getRunState(runId) {
        const app = this.app;
        if (!runId) return null;
        let state = app.runStates.get(runId);
        if (!state) {
            const chatId = app.history.resolveChatIdForRun(runId) || app.activeChatId;
            state = {
                runId,
                chatId,
                messageElement: null,
                assistantSegmentElement: null,
                assistantSegmentText: '',
                toolCalls: new Map(),
                todoState: null
            };
            app.runStates.set(runId, state);
        } else if (!state.chatId) {
            state.chatId = app.history.resolveChatIdForRun(runId) || app.activeChatId;
        }
        return state;
    }

    isRunActiveChat(runId) {
        const state = this.getRunState(runId);
        return Boolean(state && state.chatId && state.chatId === this.app.activeChatId);
    }

    getOrCreateRunMessageElement(runId, state) {
        const app = this.app;
        if (!state) return null;
        if (!state.messageElement) {
            state.messageElement = this.createMessageElement('assistant');
        }
        if (state.chatId && state.chatId === app.activeChatId && !state.messageElement.isConnected) {
            app.elements.messages.appendChild(state.messageElement);
        }
        if (state.chatId && state.chatId === app.activeChatId) {
            app.currentMessageElement = state.messageElement;
        }
        return state.messageElement;
    }

    closeAssistantSegment(state) {
        if (!state) return;
        state.assistantSegmentElement = null;
        state.assistantSegmentText = '';
    }

    getOrCreateAssistantSegmentElement(messageElement, state) {
        const contentElement = messageElement.querySelector('.message-text');
        if (!state.assistantSegmentElement) {
            const segment = document.createElement('div');
            segment.className = 'assistant-markdown assistant-segment';
            contentElement.appendChild(segment);
            state.assistantSegmentElement = segment;
            state.assistantSegmentText = '';
        }
        return state.assistantSegmentElement;
    }

    attachRunMessagesForChat(chatId) {
        const app = this.app;
        if (!chatId) return;
        let lastMessageElement = null;
        for (const state of app.runStates.values()) {
            if (state.chatId !== chatId || !state.messageElement) continue;
            if (!state.messageElement.isConnected) {
                app.elements.messages.appendChild(state.messageElement);
            }
            lastMessageElement = state.messageElement;
        }
        if (lastMessageElement) {
            app.currentMessageElement = lastMessageElement;
        }
    }

    getMessagePayloadFromElement(messageElement) {
        if (!messageElement) return { content: '', html: '' };
        const textElement = messageElement.querySelector('.message-text');
        return {
            content: textElement ? textElement.textContent : '',
            html: textElement ? textElement.innerHTML : ''
        };
    }

    saveRunStateToHistory(runId, status) {
        const app = this.app;
        const state = app.runStates.get(runId);
        if (!state || !state.chatId) return;

        const index = app.history.findChatIndex({ id: state.chatId, runId });
        const existing = index >= 0 ? app.chatHistory[index] : null;
        const messages = Array.isArray(existing?.messages) ? [...existing.messages] : [];

        if (state.messageElement) {
            const payload = this.getMessagePayloadFromElement(state.messageElement);
            if (payload.content || payload.html) {
                const last = messages[messages.length - 1];
                if (last && last.role === 'assistant' && !last.content && !last.html) {
                    messages[messages.length - 1] = { role: 'assistant', ...payload };
                } else {
                    messages.push({ role: 'assistant', ...payload });
                }
            }
        }

        app.history.upsertChatRecord({
            id: state.chatId,
            taskId: state.chatId,
            runId: runId,
            sessionId: existing?.sessionId || app.sessionId || null,
            status: status,
            messages: messages
        });
    }

    finalizeRunState(runId, status) {
        const app = this.app;
        const state = app.runStates.get(runId);
        const chatId = state?.chatId || app.history.resolveChatIdForRun(runId);
        if (chatId && chatId === app.activeChatId) {
            app.history.saveCurrentChat({ status, runId });
        } else if (state) {
            this.saveRunStateToHistory(runId, status);
        }
        app.runStates.delete(runId);
        app.messageBuffer.delete(runId);
    }

    createToolCallElement({ name, args, id, status, todoState = null }) {
        const app = this.app;
        const toolDiv = document.createElement('div');
        toolDiv.className = 'tool-call';
        toolDiv.setAttribute('data-tool-id', id);

        const argsJson = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
        const summary = app.utils.formatToolSummary(name, args, todoState);

        toolDiv.innerHTML = `
            <div class="tool-call-header" onclick="this.parentElement.classList.toggle('expanded')">
                <svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M12 1v6m0 6v6"></path>
                    <path d="m1 12h6m6 0h6"></path>
                </svg>
                <div class="tool-title">
                    <span class="tool-name">${app.utils.escapeHtml(name)}</span>
                    ${summary ? `<span class="tool-summary">${app.utils.escapeHtml(summary)}</span>` : ''}
                </div>
                <span class="tool-status ${status}">${app.utils.escapeHtml(app.utils.formatToolStatus(status))}</span>
                <svg class="tool-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
            </div>
            <div class="tool-call-body">
                <div class="tool-args">
                    <div class="tool-args-label">参数</div>
                    <div class="tool-args-content">${app.utils.escapeHtml(argsJson)}</div>
                </div>
            </div>
        `;

        return toolDiv;
    }

    createFileOpElement({ toolName, path, status, error, metrics, diff, content, contentTruncated, meta }) {
        const app = this.app;
        const fileOpDiv = document.createElement('div');
        const hasBody = Boolean(metrics || diff || content);
        fileOpDiv.className = 'file-operation';

        const downloadUrl = app.utils.getDownloadUrl(path);

        let skillName =
            meta && typeof meta.skill_name === 'string' && meta.skill_name ? meta.skill_name : '';
        if (!skillName && typeof path === 'string' && path.toLowerCase().endsWith('skill.md') && typeof content === 'string') {
            const match = content.match(/^\s*name\s*:\s*(.+?)\s*$/m);
            if (match && match[1]) {
                skillName = match[1].trim().replace(/^["']|["']$/g, '');
            }
        }
        const headerMeta = skillName ? `（技能：${skillName}）` : '';

        const metricsHtml = metrics ? `
            <div class="file-op-metrics">
                ${metrics.lines_read ? `<span>读取：${metrics.lines_read} 行</span>` : ''}
                ${metrics.lines_written ? `<span>写入：${metrics.lines_written} 行</span>` : ''}
                ${metrics.lines_added ? `<span>+${metrics.lines_added}</span>` : ''}
                ${metrics.lines_removed ? `<span>-${metrics.lines_removed}</span>` : ''}
                ${metrics.bytes_written ? `<span>大小：${app.utils.formatFileSize(metrics.bytes_written)}</span>` : ''}
            </div>
        ` : '';

        const diffHtml = diff ? `
            <div class="file-op-diff">
                <pre>${app.utils.formatDiff(diff)}</pre>
            </div>
        ` : '';

        const contentHtml = (toolName === 'read_file' && content) ? `
            <div class="file-op-content">
                <div class="file-op-content-label">内容${contentTruncated ? '（已截断）' : ''}</div>
                <pre><code class="${app.utils.escapeHtml(app.utils.guessLanguageClass(path))}">${app.utils.escapeHtml(String(content))}</code></pre>
            </div>
        ` : '';

        const actionsHtml = '';

        const chevronHtml = hasBody ? `
            <svg class="file-op-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
        ` : '';

        const bodyHtml = hasBody ? `
            <div class="file-operation-body">
                ${metricsHtml}
                ${diffHtml}
                ${contentHtml}
            </div>
        ` : '';

        fileOpDiv.innerHTML = `
            <div class="file-operation-header" ${hasBody ? "onclick=\"this.parentElement.classList.toggle('expanded')\"" : ''}>
                <svg class="file-op-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                    <polyline points="13 2 13 9 20 9"></polyline>
                </svg>
                <span class="file-op-path">${app.utils.escapeHtml(path)}${app.utils.escapeHtml(headerMeta)}</span>
                <span class="file-op-status ${status}">${app.utils.escapeHtml(app.utils.formatFileOpStatus(status))}</span>
                ${actionsHtml}
                ${chevronHtml}
            </div>
            ${bodyHtml}
        `;

        return fileOpDiv;
    }

    updateToolCallElement(toolElement, { name, args, status, todoState = null }) {
        const app = this.app;
        if (!toolElement) return;

        const headerName = toolElement.querySelector('.tool-name');
        if (headerName && name) headerName.textContent = name;

        const summaryText = app.utils.formatToolSummary(name, args, todoState);
        const title = toolElement.querySelector('.tool-title');
        if (title) {
            let summary = title.querySelector('.tool-summary');
            if (summaryText) {
                if (!summary) {
                    summary = document.createElement('span');
                    summary.className = 'tool-summary';
                    title.appendChild(summary);
                }
                summary.textContent = summaryText;
            } else if (summary) {
                summary.remove();
            }
        }

        const argsElement = toolElement.querySelector('.tool-args-content');
        if (argsElement) {
            const argsJson = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
            argsElement.textContent = argsJson;
        }

        const statusElement = toolElement.querySelector('.tool-status');
        if (statusElement && status) {
            statusElement.className = `tool-status ${status}`;
            statusElement.textContent = app.utils.formatToolStatus(status);
        }
    }

    createTodoListElement(todos, prevTodos = null) {
        const app = this.app;
        const todoDiv = document.createElement('div');
        todoDiv.className = 'todo-list';
        todoDiv.innerHTML = app.utils.renderTodoListHtml(todos, prevTodos);
        return todoDiv;
    }

    addRunStatus(status, runId, text) {
        const app = this.app;
        const statusDiv = document.createElement('div');
        statusDiv.className = `run-status ${status}`;
        if (runId) statusDiv.dataset.runId = runId;
        statusDiv.innerHTML = status === 'running' ? `
            <div class="spinner"></div>
            <span>${text}</span>
        ` : `<span>${text}</span>`;
        app.elements.messages.appendChild(statusDiv);

        if (runId) app.runStatusElements.set(runId, statusDiv);
        app.currentRunStatusElement = statusDiv;
    }

    getRunStatusElement(runId) {
        const app = this.app;
        if (!runId) return null;
        if (app.runStatusElements.has(runId)) {
            return app.runStatusElements.get(runId);
        }
        const nodes = app.elements.messages.querySelectorAll(`.run-status[data-run-id="${runId}"]`);
        if (nodes.length > 0) {
            const [first, ...rest] = Array.from(nodes);
            rest.forEach(node => node.remove());
            app.runStatusElements.set(runId, first);
            return first;
        }
        return null;
    }

    finalizeStaleRunStatuses(activeRunId) {
        const app = this.app;
        const statusNodes = app.elements.messages.querySelectorAll('.run-status.running, .run-status.queued');
        statusNodes.forEach(node => {
            const nodeRunId = node.dataset.runId || '';
            if (activeRunId && nodeRunId === activeRunId) return;
            node.className = 'run-status completed';
            node.innerHTML = `<span>${app.utils.formatRunStatus('completed')}</span>`;
            if (nodeRunId) app.runStatusElements.delete(nodeRunId);
        });
    }

    syncRunStatusElement(runId, status, { createIfMissing = false } = {}) {
        const app = this.app;
        if (!runId || !status) return;
        const existing = this.getRunStatusElement(runId);
        const isRunning = status === 'running';
        const label = isRunning
            ? `运行中：${runId.slice(0, 8)}`
            : app.utils.formatRunStatus(status);

        if (existing) {
            existing.className = `run-status ${status}`;
            existing.innerHTML = isRunning
                ? `<div class="spinner"></div><span>${label}</span>`
                : `<span>${label}</span>`;
            app.currentRunStatusElement = existing;
            return;
        }
        if (createIfMissing) {
            this.addRunStatus(status, runId, label);
        }
    }

    addLogMessage(level, message, runId = null) {
        const app = this.app;
        const targetRunId = runId || app.currentRunId || null;
        const state = targetRunId ? this.getRunState(targetRunId) : null;
        this.closeAssistantSegment(state);
        const logDiv = document.createElement('div');
        logDiv.className = `log-message ${level}`;
        logDiv.textContent = `[${app.utils.formatLogLevel(level)}] ${message}`;

        let messageElement = null;
        if (targetRunId && state) {
            messageElement = this.getOrCreateRunMessageElement(targetRunId, state);
        }
        if (!messageElement) {
            if (!app.currentMessageElement) {
                app.currentMessageElement = this.createMessageElement('assistant');
                app.elements.messages.appendChild(app.currentMessageElement);
            }
            messageElement = app.currentMessageElement;
        }

        const contentElement = messageElement.querySelector('.message-text');
        contentElement.appendChild(logDiv);

        if (!state || state.chatId === app.activeChatId) {
            this.scrollToBottom();
        }
        return logDiv;
    }

    showReconnectNotice(attempt, total) {
        const app = this.app;
        const message = `正在重连…（${attempt}/${total}）`;
        if (app.reconnectLogElement && app.reconnectLogElement.isConnected) {
            app.reconnectLogElement.textContent = `[${app.utils.formatLogLevel('info')}] ${message}`;
            return;
        }
        app.reconnectLogElement = this.addLogMessage('info', message);
        if (app.reconnectLogElement) {
            app.reconnectLogElement.dataset.transient = 'reconnect';
        }
    }

    hideReconnectNotice() {
        const app = this.app;
        if (app.reconnectLogElement && app.reconnectLogElement.isConnected) {
            const messageElement = app.reconnectLogElement.closest('.message');
            app.reconnectLogElement.remove();
            if (messageElement) {
                const content = messageElement.querySelector('.message-text');
                const hasContent = content && (content.children.length > 0 || content.textContent.trim().length > 0);
                if (!hasContent) {
                    messageElement.remove();
                    if (app.currentMessageElement === messageElement) {
                        app.currentMessageElement = null;
                    }
                }
            }
        }
        app.reconnectLogElement = null;
    }

    showInterruptModal(request, interruptId, runId) {
        const app = this.app;
        const actionRequests = request.action_requests || [];

        app.elements.interruptModalBody.innerHTML = actionRequests.map((action, index) => `
            <div class="interrupt-action">
                <div class="interrupt-action-header">
                    <svg class="interrupt-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                    <div>
                        <div class="interrupt-action-name">${app.utils.escapeHtml(action.name || '工具')}</div>
                        ${action.description ? `<div class="interrupt-action-description">${app.utils.escapeHtml(action.description)}</div>` : ''}
                    </div>
                </div>
                ${action.args ? `
                    <div class="interrupt-action-args">
                        <pre>${app.utils.escapeHtml(JSON.stringify(action.args, null, 2))}</pre>
                    </div>
                ` : ''}
            </div>
        `).join('');

        app.elements.interruptModalFooter.innerHTML = `
            <button class="btn btn-danger" onclick="app.ui.respondToInterrupt('${interruptId}', '${runId}', 'reject')">全部拒绝</button>
            <button class="btn btn-primary" onclick="app.ui.respondToInterrupt('${interruptId}', '${runId}', 'approve')">全部批准</button>
        `;

        app.elements.interruptModal.classList.add('active');
    }

    respondToInterrupt(interruptId, runId, decision) {
        const app = this.app;
        const decisions = [{ type: decision }];

        app.network.send({
            type: 'interrupt_response',
            run_id: runId,
            interrupt_id: interruptId,
            response: { decisions }
        });

        app.elements.interruptModal.classList.remove('active');

        app.pendingInterrupts = app.pendingInterrupts.filter(
            i => i.interrupt_id !== interruptId
        );
    }

    resetChatView() {
        const app = this.app;
        app.elements.messages.innerHTML = '';
        app.currentMessageElement = null;
        app.currentAssistantSegmentElement = null;
        app.currentAssistantSegmentText = '';
        app.currentToolCalls.clear();
        app.runStatusElements.clear();
        app.currentRunStatusElement = null;
        app.todoState = null;
        app.pendingInterrupts = [];
        this.hideReconnectNotice();
        if (app.typingIndicator) {
            app.typingIndicator.remove();
            app.typingIndicator = null;
        }
        if (app.elements.interruptModal.classList.contains('active')) {
            app.elements.interruptModal.classList.remove('active');
        }
    }

    updateInputState() {
        const app = this.app;
        if (!app.elements.userInput || !app.elements.sendBtn) return;
        const isViewOnly = this.isViewOnlyMode();
        const isLocked = !app.auth.isAuthenticated();
        app.elements.userInput.disabled = isViewOnly || isLocked;
        if (isViewOnly) {
            app.elements.userInput.placeholder = '当前会话正在运行，无法在此发送消息';
            app.elements.userInput.blur();
        } else if (isLocked) {
            app.elements.userInput.placeholder = '请先登录';
            app.elements.userInput.blur();
        } else {
            app.elements.userInput.placeholder = app.defaultInputPlaceholder || '';
        }
        this.updateSendButton();
    }

    updateConnectionStatus(status) {
        const app = this.app;
        const statusElement = app.elements.connectionStatus;
        statusElement.className = `connection-status ${status}`;

        const textElement = statusElement.querySelector('.status-text');
        textElement.textContent = app.utils.formatConnectionStatus(status);
    }

    updateCancelButton(enabled) {
        const app = this.app;
        if (!app.elements.cancelBtn) {
            return;
        }
        app.elements.cancelBtn.disabled = !enabled;
    }

    updateSendButton() {
        const app = this.app;
        const btn = app.elements.sendBtn;
        const hasText = app.elements.userInput.value.trim().length > 0;
        const isViewOnly = this.isViewOnlyMode();
        const isLocked = !app.auth.isAuthenticated();

        if (app.isRunning) {
            btn.disabled = false;
            btn.classList.add('stop');
            btn.title = '中断运行';
            btn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect>
                </svg>
            `;
            return;
        }

        if (isLocked) {
            btn.disabled = true;
            btn.classList.remove('stop');
            btn.title = '请先登录';
            btn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="22" y1="2" x2="11" y2="13"></line>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
            `;
            return;
        }

        if (isViewOnly) {
            btn.disabled = true;
            btn.classList.remove('stop');
            btn.title = '当前会话为只读，无法发送';
            btn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="22" y1="2" x2="11" y2="13"></line>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
            `;
            return;
        }

        btn.disabled = !hasText;
        btn.classList.remove('stop');
        btn.title = '发送';
        btn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
        `;
    }

    adjustTextareaHeight() {
        const app = this.app;
        const textarea = app.elements.userInput;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }

    scrollToBottom() {
        // Auto-scroll disabled by request.
    }

    isViewOnlyMode() {
        return false;
    }

    setViewOnlySession({ chatId = null, sessionId = null } = {}) {
        return;
    }

    clearViewOnlySession() {
        return;
    }
}
