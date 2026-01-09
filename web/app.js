// DeepAgents Web Client
// Main application logic for WebSocket communication and UI management

class DeepAgentsClient {
    constructor() {
        // Configuration
        this.serverUrl = this.getServerUrl();
        this.wsUrl = null;
        this.sessionId = null;
        this.assistantId = 'agent';

        // WebSocket connection
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;

        // State
        this.currentRunId = null;
        this.isRunning = false;
        this.autoApprove = true;
        this.pendingInterrupts = [];
        this.messageBuffer = new Map(); // For assembling streaming messages
        this.currentAssistantSegmentElement = null;
        this.currentAssistantSegmentText = '';
        this.currentToolCalls = new Map(); // Track tool calls by ID
        this.runStatusElements = new Map(); // Track run status elements by run ID
        this.currentRunStatusElement = null;
        this.sessions = [];
        this.chatHistory = this.loadHistory();
        this.todoState = null; // Track last todos to compute progress diffs
        this.activeChatId = null;
        this.runIdToChatId = new Map();
        this.currentRunStatus = null;
        this.shouldReconnect = true;
        this.pendingRunStatusId = null;
        this.pendingSessionSwitch = null;
        this.reconnectLogElement = null;
        this.runStates = new Map();
        this.pendingMessages = [];
        this.isCreatingSession = false;

        this.chatHistory.forEach(chat => {
            if (chat && chat.runId) {
                this.runIdToChatId.set(chat.runId, chat.id);
            }
        });

        // UI elements
        this.elements = {};
        this.currentMessageElement = null;
        this.typingIndicator = null;

        // Initialize
        this.init();
    }

    getServerUrl() {
        // Use current hostname with port 8000 for cross-machine access
        const hostname = window.location.hostname;
        const defaultUrl = `http://${hostname}:8000`;
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('server') || defaultUrl;
    }

    async init() {
        // Cache DOM elements
        this.cacheElements();

        // Load config (auto-approve default, etc.)
        this.loadConfig();

        // Setup event listeners
        this.setupEventListeners();

        // Load chat history
        this.renderHistory();

        // Connect to server
        await this.createSession();
    }

    cacheElements() {
        this.elements = {
            // Sidebar
            sidebar: document.getElementById('sidebar'),
            newChatBtn: document.getElementById('newChatBtn'),
            sessionList: document.getElementById('sessionList'),
            historyList: document.getElementById('historyList'),
            autoApproveToggle: document.getElementById('autoApproveToggle'),
            connectionStatus: document.getElementById('connectionStatus'),

            // Header
            sidebarToggle: document.getElementById('sidebarToggle'),
            chatTitle: document.getElementById('chatTitle'),
            cancelBtn: document.getElementById('cancelBtn'),

            // Chat
            chatContainer: document.getElementById('chatContainer'),
            welcomeMessage: document.getElementById('welcomeMessage'),
            messages: document.getElementById('messages'),

            // Input
            userInput: document.getElementById('userInput'),
            sendBtn: document.getElementById('sendBtn'),

            // Modal
            interruptModal: document.getElementById('interruptModal'),
            interruptModalBody: document.getElementById('interruptModalBody'),
            interruptModalFooter: document.getElementById('interruptModalFooter'),
            closeModalBtn: document.getElementById('closeModalBtn'),
        };
    }

    setupEventListeners() {
        // Sidebar toggle
        this.elements.sidebarToggle.addEventListener('click', () => {
            this.elements.sidebar.classList.toggle('open');
        });

        // New chat
        this.elements.newChatBtn.addEventListener('click', () => this.newChat());

        // Auto approve toggle
        this.elements.autoApproveToggle.addEventListener('change', (e) => {
            this.autoApprove = e.target.checked;
            this.send({ type: 'auto_approve', enabled: this.autoApprove });
            this.saveConfig();
        });

        // Cancel button
        this.elements.cancelBtn.addEventListener('click', () => this.cancelRun());

        // User input
        this.elements.userInput.addEventListener('input', () => {
            this.adjustTextareaHeight();
            this.updateSendButton();
        });

        this.elements.userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (this.isRunning) {
                    this.cancelRun();
                } else {
                    this.sendMessage();
                }
            }
        });

        // Send button
        this.elements.sendBtn.addEventListener('click', () => {
            if (this.isRunning) {
                this.cancelRun();
            } else {
                this.sendMessage();
            }
        });

        // Example prompts
        document.querySelectorAll('.example-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const prompt = btn.getAttribute('data-prompt');
                this.elements.userInput.value = prompt;
                this.adjustTextareaHeight();
                this.updateSendButton();
                this.elements.userInput.focus();
            });
        });

        // Close modal
        this.elements.closeModalBtn.addEventListener('click', () => {
            this.elements.interruptModal.classList.remove('active');
        });

        // Close modal on backdrop click
        this.elements.interruptModal.addEventListener('click', (e) => {
            if (e.target === this.elements.interruptModal) {
                this.elements.interruptModal.classList.remove('active');
            }
        });

        // Close sidebar on outside click (mobile)
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768) {
                if (!this.elements.sidebar.contains(e.target) &&
                    !this.elements.sidebarToggle.contains(e.target)) {
                    this.elements.sidebar.classList.remove('open');
                }
            }
        });

        // Handle window resize
        window.addEventListener('resize', () => {
            if (window.innerWidth > 768) {
                this.elements.sidebar.classList.remove('open');
            }
        });

        // Keyboard shortcut: Esc cancels run (or closes modal)
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (this.elements.interruptModal.classList.contains('active')) {
                this.elements.interruptModal.classList.remove('active');
                return;
            }
            if (this.isRunning) {
                this.cancelRun();
            }
        });

        window.addEventListener('pagehide', () => {
            this.backgroundCurrentChat('pagehide');
            this.disconnectWebSocket({ allowReconnect: false });
        });
    }

    async createSession() {
        if (this.isCreatingSession) return;
        this.isCreatingSession = true;
        try {
            this.updateConnectionStatus('connecting');

            const response = await fetch(`${this.serverUrl}/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    assistant_id: this.assistantId,
                    auto_approve: this.autoApprove
                })
            });

            if (!response.ok) {
                throw new Error(`创建会话失败：${response.statusText}`);
            }

            const data = await response.json();
            this.setSessionId(data.session_id);
            this.connectWebSocket();

        } catch (error) {
            console.error('创建会话失败：', error);
            this.addLogMessage('error', `连接服务器失败：${error.message}`);
            this.updateConnectionStatus('disconnected');
        } finally {
            this.isCreatingSession = false;
        }
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
        const wsProtocol = this.serverUrl.startsWith('https') ? 'wss:' : 'ws:';
        const wsHost = this.serverUrl.replace(/^https?:\/\//, '');
        this.wsUrl = `${wsProtocol}//${wsHost}/ws/${this.sessionId}`;
    }

    connectToSession(sessionId, { requestRunStatusId = null } = {}) {
        if (!sessionId) return;
        this.updateConnectionStatus('connecting');
        this.setSessionId(sessionId);
        this.pendingRunStatusId = requestRunStatusId;
        this.connectWebSocket();
    }

    switchSession(sessionId, { requestRunStatusId = null } = {}) {
        if (!sessionId) return;
        if (this.sessionId === sessionId && this.ws && this.ws.readyState === WebSocket.OPEN) {
            if (requestRunStatusId) {
                this.send({ type: 'run.status', run_id: requestRunStatusId });
            }
            return;
        }
        this.disconnectWebSocket({ allowReconnect: false });
        this.connectToSession(sessionId, { requestRunStatusId });
    }

    disconnectWebSocket({ allowReconnect = false } = {}) {
        this.shouldReconnect = allowReconnect;
        const ws = this.ws;
        if (!ws) return;
        this.ws = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
    }

    hasReconnectWork() {
        if (this.pendingMessages.length > 0) return true;
        if (this.pendingRunStatusId) return true;
        return this.isRunning || this.isActiveRunStatus(this.currentRunStatus);
    }

    ensureConnection() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        if (this.wsUrl) {
            this.updateConnectionStatus('connecting');
            this.connectWebSocket();
            return;
        }
        this.createSession();
    }

    flushPendingMessages() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!this.pendingMessages.length) return;
        const queued = this.pendingMessages.slice();
        this.pendingMessages.length = 0;
        queued.forEach(payload => {
            this.ws.send(JSON.stringify(payload));
        });
    }

    connectWebSocket() {
        if (!this.wsUrl) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        this.shouldReconnect = true;
        const ws = new WebSocket(this.wsUrl);
        this.ws = ws;

        ws.onopen = () => {
            if (this.ws !== ws) return;
            console.log('WebSocket 已连接');
            this.updateConnectionStatus('connected');
            this.reconnectAttempts = 0;
            this.hideReconnectNotice();
            this.send({ type: 'auto_approve', enabled: this.autoApprove });
            const runId = this.pendingRunStatusId || (this.isRunning ? this.currentRunId : null);
            this.pendingRunStatusId = null;
            if (runId) {
                this.send({ type: 'run.status', run_id: runId });
            }
            this.flushPendingMessages();
        };

        ws.onmessage = (event) => {
            if (this.ws !== ws) return;
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (error) {
                console.error('解析消息失败：', error);
            }
        };

        ws.onclose = () => {
            if (this.ws !== ws) return;
            console.log('WebSocket 已断开');
            this.updateConnectionStatus('disconnected');
            if (this.shouldReconnect && this.hasReconnectWork()) {
                this.attemptReconnect();
            } else {
                this.reconnectAttempts = 0;
            }
        };

        ws.onerror = (error) => {
            if (this.ws !== ws) return;
            console.error('WebSocket 错误：', error);
            this.updateConnectionStatus('disconnected');
        };
    }

    attemptReconnect() {
        if (!this.hasReconnectWork()) {
            this.reconnectAttempts = 0;
            return;
        }
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`正在尝试重连…（${this.reconnectAttempts}/${this.maxReconnectAttempts}）`);
            this.showReconnectNotice(this.reconnectAttempts, this.maxReconnectAttempts);

            setTimeout(() => {
                if (!this.hasReconnectWork()) {
                    this.reconnectAttempts = 0;
                    return;
                }
                this.connectWebSocket();
            }, this.reconnectDelay);
        } else {
            this.addLogMessage('error', '重连失败，请刷新页面。');
        }
    }

    handleMessage(data) {
        const eventType = data.type;

        switch (eventType) {
            case 'run.queued':
                this.handleRunQueued(data);
                break;
            case 'run.started':
                this.handleRunStarted(data);
                break;
            case 'run.completed':
            case 'run.failed':
            case 'run.cancelled':
            case 'run.rejected':
                this.handleRunEnded(data);
                break;
            case 'run.status':
                this.handleRunStatus(data);
                break;
            case 'assistant.delta':
                this.handleAssistantDelta(data);
                break;
            case 'assistant.message':
                this.handleAssistantMessage(data);
                break;
            case 'tool.call.started':
                this.handleToolCallStarted(data);
                break;
            case 'tool.call.ended':
                this.handleToolCallEnded(data);
                break;
            case 'file.op':
                this.handleFileOp(data);
                break;
            case 'todos.updated':
                this.handleTodosUpdated(data);
                break;
            case 'interrupt.request':
                this.handleInterruptRequest(data);
                break;
            case 'interrupt.auto_approved':
                this.handleInterruptAutoApproved(data);
                break;
            case 'session.auto_approve':
                this.handleSessionAutoApprove(data);
                break;
            case 'log':
                this.handleLog(data);
                break;
            default:
                console.log('未知事件类型：', eventType, data);
        }
    }

    handleRunQueued(data) {
        console.log('任务已排队：', data.run_id);
        if (!this.currentRunId) {
            this.currentRunId = data.run_id;
        }
        this.currentRunStatus = 'queued';
        if (data.run_id && this.activeChatId && !this.runIdToChatId.has(data.run_id)) {
            this.runIdToChatId.set(data.run_id, this.activeChatId);
        }
        this.updateChatStatus(data.run_id, 'queued');
        if (this.isRunActiveChat(data.run_id)) {
            this.syncRunStatusElement(data.run_id, 'queued', { createIfMissing: true });
        }
    }

    handleRunStarted(data) {
        console.log('任务开始：', data.run_id);
        this.currentRunId = data.run_id;
        this.currentRunStatus = 'running';
        if (data.run_id && this.activeChatId && !this.runIdToChatId.has(data.run_id)) {
            this.runIdToChatId.set(data.run_id, this.activeChatId);
        }
        const isActiveChatRun = this.isRunActiveChat(data.run_id);
        this.isRunning = true;
        this.updateCancelButton(true);
        this.updateSendButton();
        this.messageBuffer.set(data.run_id, '');
        this.currentAssistantSegmentElement = null;
        this.currentAssistantSegmentText = '';

        if (isActiveChatRun) {
            // Hide welcome message
            this.elements.welcomeMessage.style.display = 'none';

            // Add/update run status indicator
            this.finalizeStaleRunStatuses(data.run_id);
            this.syncRunStatusElement(data.run_id, 'running', { createIfMissing: true });
        }
        this.updateChatStatus(data.run_id, 'running');
    }

    handleRunEnded(data) {
        const status = data.type.split('.')[1];
        console.log('任务结束：', status, data);

        const runId = data.run_id || this.currentRunId;
        if (runId) {
            this.currentRunStatus = status;
            this.updateChatStatus(runId, status);
        }

        if (!this.currentRunId || runId === this.currentRunId) {
            this.currentRunId = null;
            this.isRunning = false;
            this.updateCancelButton(false);
            this.updateSendButton();
            this.currentAssistantSegmentElement = null;
            this.currentAssistantSegmentText = '';
        }

        // Update run status
        if (runId && this.isRunActiveChat(runId)) {
            const statusElement =
                (runId ? this.runStatusElements.get(runId) : null) ||
                this.currentRunStatusElement ||
                Array.from(document.querySelectorAll('.run-status')).pop();
            if (statusElement) {
                statusElement.className = `run-status ${status}`;
                statusElement.innerHTML = `<span>${this.formatRunStatus(status)}</span>`;
            }
            this.runStatusElements.delete(runId);
            this.currentRunStatusElement = null;
        }

        // Save to history for the correct chat
        if (runId) {
            this.finalizeRunState(runId, status);
        }

        // Remove typing indicator
        if (this.typingIndicator) {
            this.typingIndicator.remove();
            this.typingIndicator = null;
        }

        this.maybeApplyPendingSessionSwitch();
    }

    handleRunStatus(data) {
        const runId = data.run_id;
        const status = data.status;
        if (!runId || !status || status === 'unknown') return;

        if (this.activeChatId && !this.runIdToChatId.has(runId)) {
            this.runIdToChatId.set(runId, this.activeChatId);
        }
        const isActiveChatRun = this.isRunActiveChat(runId);
        this.updateChatStatus(runId, status);
        if (isActiveChatRun && (status === 'running' || status === 'queued')) {
            this.finalizeStaleRunStatuses(runId);
        }
        if (isActiveChatRun) {
            this.syncRunStatusElement(runId, status, { createIfMissing: status === 'running' || status === 'queued' });
        }

        if (this.currentRunId && runId === this.currentRunId) {
            this.currentRunStatus = status;
            const active = this.isActiveRunStatus(status);
            this.isRunning = active;
            this.updateCancelButton(active);
            this.updateSendButton();
            if (!active) {
                this.currentRunId = null;
            }
        }
    }

    handleAssistantDelta(data) {
        this.appendAssistantText(data.run_id || this.currentRunId || 'default', data.text);
    }

    handleAssistantMessage(data) {
        this.appendAssistantText(data.run_id || this.currentRunId || 'default', data.text);
    }

    handleToolCallStarted(data) {
        const { tool_name, args, tool_call_id } = data;
        const runId = data.run_id || this.currentRunId || 'default';
        const state = this.getRunState(runId);
        this.closeAssistantSegment(state);

        if (tool_call_id && state?.toolCalls?.has(tool_call_id)) {
            const toolElement = state.toolCalls.get(tool_call_id);
            this.updateToolCallElement(toolElement, { name: tool_name, args, status: 'running', todoState: state?.todoState || null });
            if (state.chatId === this.activeChatId) {
                this.scrollToBottom();
            }
            return;
        }

        // Create tool call element
        const toolElement = this.createToolCallElement({
            name: tool_name,
            args: args,
            id: tool_call_id,
            status: 'running',
            todoState: state?.todoState || null
        });

        // Append to current message or create new one
        const messageElement = this.getOrCreateRunMessageElement(runId, state);
        if (!messageElement) return;
        const contentElement = messageElement.querySelector('.message-text');
        contentElement.appendChild(toolElement);

        // Store reference
        if (tool_call_id && state) {
            state.toolCalls.set(tool_call_id, toolElement);
        }

        if (state?.chatId === this.activeChatId) {
            this.scrollToBottom();
        }
    }

    handleToolCallEnded(data) {
        const { tool_name, status, tool_call_id, content_preview, content } = data;
        const toolContent = typeof content === 'string' && content.length ? content : content_preview;
        const runId = data.run_id || this.currentRunId || 'default';
        const state = this.getRunState(runId);

        let toolElement = null;
        if (tool_call_id && state?.toolCalls?.has(tool_call_id)) {
            toolElement = state.toolCalls.get(tool_call_id);
        } else {
            // Fallback: create a tool card even if we missed the started event
            this.closeAssistantSegment(state);
            toolElement = this.createToolCallElement({
                name: tool_name || 'tool',
                args: {},
                id: tool_call_id,
                status: status || 'success',
                todoState: state?.todoState || null
            });

            const messageElement = this.getOrCreateRunMessageElement(runId, state);
            if (!messageElement) return;
            const contentElement = messageElement.querySelector('.message-text');
            contentElement.appendChild(toolElement);
        }

        // Update status
        const statusElement = toolElement.querySelector('.tool-status');
        if (statusElement) {
            statusElement.className = `tool-status ${status}`;
            statusElement.textContent = this.formatToolStatus(status);
        }

        // Add or update result
        if (toolContent) {
            const bodyElement = toolElement.querySelector('.tool-call-body');
            if (bodyElement) {
                let resultElement = bodyElement.querySelector('.tool-result');
                if (!resultElement) {
                    resultElement = document.createElement('div');
                    resultElement.className = 'tool-result';
                    resultElement.innerHTML = `
                        <div class="tool-result-label">结果</div>
                        <div class="tool-result-content"></div>
                    `;
                    bodyElement.appendChild(resultElement);
                }
                const resultContent = resultElement.querySelector('.tool-result-content');
                if (resultContent) {
                    resultContent.innerHTML = this.formatToolResult(toolContent);
                }
            }
        }

        if (tool_call_id && state) state.toolCalls.delete(tool_call_id);
        if (state?.chatId === this.activeChatId) {
            this.scrollToBottom();
        }
    }

    handleFileOp(data) {
        const { tool_name, path, status, error, metrics, diff, content, content_preview, content_truncated, meta } = data;
        const runId = data.run_id || this.currentRunId || 'default';
        const state = this.getRunState(runId);
        this.closeAssistantSegment(state);

        const fileOpElement = this.createFileOpElement({
            toolName: tool_name,
            path: path,
            status: status,
            error: error,
            metrics: metrics,
            diff: diff,
            content: typeof content === 'string' && content.length ? content : content_preview,
            contentTruncated: Boolean(content_truncated),
            meta: meta || {}
        });

        const messageElement = this.getOrCreateRunMessageElement(runId, state);
        if (!messageElement) return;
        const contentElement = messageElement.querySelector('.message-text');
        contentElement.appendChild(fileOpElement);

        if (state?.chatId === this.activeChatId) {
            this.scrollToBottom();
        }
    }

    handleTodosUpdated(data) {
        const todos = data.todos;
        if (!todos || !Array.isArray(todos)) return;
        const runId = data.run_id || this.currentRunId || 'default';
        const state = this.getRunState(runId);

        const prevTodos = state?.todoState || null;

        // Create or update todo list
        let todoElement = state?.messageElement?.querySelector('.todo-list');

        if (!todoElement) {
            this.closeAssistantSegment(state);
            const messageElement = this.getOrCreateRunMessageElement(runId, state);
            if (!messageElement) return;

            todoElement = this.createTodoListElement(todos, prevTodos);
            const contentElement = messageElement.querySelector('.message-text');
            contentElement.appendChild(todoElement);
        } else {
            // Update existing todo list
            todoElement.innerHTML = this.renderTodoListHtml(todos, prevTodos);
        }

        if (state) {
            state.todoState = JSON.parse(JSON.stringify(todos));
        }
        if (state?.chatId === this.activeChatId) {
            this.todoState = state.todoState;
            this.scrollToBottom();
        }
    }

    handleInterruptRequest(data) {
        const { interrupt_id, request } = data;
        console.log('Interrupt request:', interrupt_id, request);

        this.pendingInterrupts.push({ interrupt_id, request, run_id: data.run_id });
        this.showInterruptModal(request, interrupt_id, data.run_id);
    }

    handleInterruptAutoApproved(data) {
        // Keep the UI clean: auto-approve is expected behavior when enabled.
        // Still log to console for debugging.
        try {
            console.debug('Auto-approved interrupt:', data?.interrupt_id);
        } catch {}
    }

    handleSessionAutoApprove(data) {
        this.autoApprove = data.enabled;
        this.elements.autoApproveToggle.checked = data.enabled;
    }

    handleLog(data) {
        const { level, message, run_id } = data;
        this.addLogMessage(level || 'info', message, run_id || null);
    }

    // UI Creation Methods
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
        if (!runId) return null;
        let state = this.runStates.get(runId);
        if (!state) {
            const chatId = this.resolveChatIdForRun(runId) || this.activeChatId;
            state = {
                runId,
                chatId,
                messageElement: null,
                assistantSegmentElement: null,
                assistantSegmentText: '',
                toolCalls: new Map(),
                todoState: null
            };
            this.runStates.set(runId, state);
        } else if (!state.chatId) {
            state.chatId = this.resolveChatIdForRun(runId) || this.activeChatId;
        }
        return state;
    }

    isRunActiveChat(runId) {
        const state = this.getRunState(runId);
        return Boolean(state && state.chatId && state.chatId === this.activeChatId);
    }

    getOrCreateRunMessageElement(runId, state) {
        if (!state) return null;
        if (!state.messageElement) {
            state.messageElement = this.createMessageElement('assistant');
        }
        if (state.chatId && state.chatId === this.activeChatId && !state.messageElement.isConnected) {
            this.elements.messages.appendChild(state.messageElement);
        }
        if (state.chatId && state.chatId === this.activeChatId) {
            this.currentMessageElement = state.messageElement;
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
        if (!chatId) return;
        let lastMessageElement = null;
        for (const state of this.runStates.values()) {
            if (state.chatId !== chatId || !state.messageElement) continue;
            if (!state.messageElement.isConnected) {
                this.elements.messages.appendChild(state.messageElement);
            }
            lastMessageElement = state.messageElement;
        }
        if (lastMessageElement) {
            this.currentMessageElement = lastMessageElement;
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
        const state = this.runStates.get(runId);
        if (!state || !state.chatId) return;

        const index = this.findChatIndex({ id: state.chatId, runId });
        const existing = index >= 0 ? this.chatHistory[index] : null;
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

        this.upsertChatRecord({
            id: state.chatId,
            taskId: state.chatId,
            runId: runId,
            sessionId: existing?.sessionId || this.sessionId || null,
            status: status,
            messages: messages
        });
    }

    finalizeRunState(runId, status) {
        const state = this.runStates.get(runId);
        const chatId = state?.chatId || this.resolveChatIdForRun(runId);
        if (chatId && chatId === this.activeChatId) {
            this.saveCurrentChat({ status, runId });
        } else if (state) {
            this.saveRunStateToHistory(runId, status);
        }
        this.runStates.delete(runId);
        this.messageBuffer.delete(runId);
    }

    maybeApplyPendingSessionSwitch() {
        if (this.isRunning || !this.pendingSessionSwitch) return;
        const { sessionId, runId, chatId } = this.pendingSessionSwitch;
        const targetSessionId = sessionId || null;
        if (!targetSessionId || targetSessionId === this.sessionId) {
            this.pendingSessionSwitch = null;
            return;
        }
        if (chatId && chatId !== this.activeChatId) {
            return;
        }
        this.pendingSessionSwitch = null;
        this.switchSession(targetSessionId, { requestRunStatusId: runId || null });
    }

    ingestAssistantText(runId, incomingText) {
        const text = incomingText == null ? '' : String(incomingText);
        if (!text) return '';

        const currentFull = this.messageBuffer.get(runId) || '';
        let nextFull = '';
        let appended = '';

        if (!currentFull) {
            nextFull = text;
            appended = text;
        } else if (text.startsWith(currentFull)) {
            nextFull = text;
            appended = text.slice(currentFull.length);
        } else if (currentFull.startsWith(text)) {
            nextFull = currentFull;
            appended = '';
        } else {
            nextFull = currentFull + text;
            appended = text;
        }

        this.messageBuffer.set(runId, nextFull);
        return appended;
    }

    appendAssistantText(runId, text) {
        const appended = this.ingestAssistantText(runId, text);
        if (!appended) return;

        const state = this.getRunState(runId);
        const messageElement = this.getOrCreateRunMessageElement(runId, state);
        if (!messageElement || !state) return;

        const segmentElement = this.getOrCreateAssistantSegmentElement(messageElement, state);
        state.assistantSegmentText += appended;
        segmentElement.innerHTML = this.parseMarkdown(state.assistantSegmentText);
        if (state.chatId === this.activeChatId) {
            this.scrollToBottom();
        }
    }

    createToolCallElement({ name, args, id, status, todoState = null }) {
        const toolDiv = document.createElement('div');
        toolDiv.className = 'tool-call';
        toolDiv.setAttribute('data-tool-id', id);

        const argsJson = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
        const summary = this.formatToolSummary(name, args, todoState);

        toolDiv.innerHTML = `
            <div class="tool-call-header" onclick="this.parentElement.classList.toggle('expanded')">
                <svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M12 1v6m0 6v6"></path>
                    <path d="m1 12h6m6 0h6"></path>
                </svg>
                <div class="tool-title">
                    <span class="tool-name">${this.escapeHtml(name)}</span>
                    ${summary ? `<span class="tool-summary">${this.escapeHtml(summary)}</span>` : ''}
                </div>
                <span class="tool-status ${status}">${this.escapeHtml(this.formatToolStatus(status))}</span>
                <svg class="tool-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
            </div>
            <div class="tool-call-body">
                <div class="tool-args">
                    <div class="tool-args-label">参数</div>
                    <div class="tool-args-content">${this.escapeHtml(argsJson)}</div>
                </div>
            </div>
        `;

        return toolDiv;
    }

    createFileOpElement({ toolName, path, status, error, metrics, diff, content, contentTruncated, meta }) {
        const fileOpDiv = document.createElement('div');
        const hasBody = Boolean(metrics || diff || content);
        fileOpDiv.className = 'file-operation';

        const downloadUrl = this.getDownloadUrl(path);

        let skillName =
            meta && typeof meta.skill_name === 'string' && meta.skill_name ? meta.skill_name : '';
        if (!skillName && typeof path === 'string' && path.toLowerCase().endsWith('skill.md') && typeof content === 'string') {
            const match = content.match(/^\s*name\s*:\s*(.+?)\s*$/m);
            if (match && match[1]) {
                skillName = match[1].trim().replace(/^['"]|['"]$/g, '');
            }
        }
        const headerMeta = skillName ? `（技能：${skillName}）` : '';

        const metricsHtml = metrics ? `
            <div class="file-op-metrics">
                ${metrics.lines_read ? `<span>读取：${metrics.lines_read} 行</span>` : ''}
                ${metrics.lines_written ? `<span>写入：${metrics.lines_written} 行</span>` : ''}
                ${metrics.lines_added ? `<span>+${metrics.lines_added}</span>` : ''}
                ${metrics.lines_removed ? `<span>-${metrics.lines_removed}</span>` : ''}
                ${metrics.bytes_written ? `<span>大小：${this.formatFileSize(metrics.bytes_written)}</span>` : ''}
            </div>
        ` : '';

        const diffHtml = diff ? `
            <div class="file-op-diff">
                <pre>${this.formatDiff(diff)}</pre>
            </div>
        ` : '';

        const contentHtml = (toolName === 'read_file' && content) ? `
            <div class="file-op-content">
                <div class="file-op-content-label">内容${contentTruncated ? '（已截断）' : ''}</div>
                <pre><code class="${this.escapeHtml(this.guessLanguageClass(path))}">${this.escapeHtml(String(content))}</code></pre>
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
                <span class="file-op-path">${this.escapeHtml(path)}${this.escapeHtml(headerMeta)}</span>
                <span class="file-op-status ${status}">${this.escapeHtml(this.formatFileOpStatus(status))}</span>
                ${actionsHtml}
                ${chevronHtml}
            </div>
            ${bodyHtml}
        `;

        return fileOpDiv;
    }

    updateToolCallElement(toolElement, { name, args, status, todoState = null }) {
        if (!toolElement) return;

        const headerName = toolElement.querySelector('.tool-name');
        if (headerName && name) headerName.textContent = name;

        const summaryText = this.formatToolSummary(name, args, todoState);
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
            statusElement.textContent = this.formatToolStatus(status);
        }
    }

    formatToolSummary(toolName, args, todoStateOverride = null) {
        const name = String(toolName || '');
        const a = args && typeof args === 'object' ? args : {};

        if (name === 'web_search') {
            const query = a.query || a.q || a.text || '';
            return query ? `查询：\n${String(query)}` : '';
        }

        if (name === 'write_todos') {
            const todos = Array.isArray(a.todos) ? a.todos : [];
            const todoState = todoStateOverride ?? this.todoState;
            const progress = this.getTodoProgress(todoState, todos);
            if (progress.summary) return progress.summary;
            const counts = this.countTodosByStatus(todos);
            const total = counts.pending + counts.in_progress + counts.completed;
            if (!total) return '';
            return `处理中：${counts.in_progress}  待处理：${counts.pending}  已完成：${counts.completed}`;
        }

        if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
            const filePath = a.file_path || a.path || a.file || '';
            return filePath ? `路径：\n${String(filePath)}` : '';
        }

        if (name === 'ls') {
            const path = a.path || a.dir || a.directory || '';
            return path ? `路径：\n${String(path)}` : '';
        }

        if (name === 'shell') {
            const command = a.command || a.cmd || a.value || '';
            return command ? `命令：\n${String(command)}` : '';
        }

        if (name === 'glob') {
            const pattern = a.pattern || a.glob || a.value || '';
            const path = a.path || a.dir || a.directory || '';
            if (!pattern && !path) return '';
            const lines = [];
            if (pattern) lines.push(`匹配：\n${String(pattern)}`);
            if (path) lines.push(`目录：\n${String(path)}`);
            return lines.join('\n');
        }

        if (name === 'grep') {
            const pattern = a.pattern || a.query || a.q || a.value || '';
            const path = a.path || a.dir || a.directory || '';
            const glob = a.glob || a.include || a.file_glob || '';
            if (!pattern && !path && !glob) return '';
            const lines = [];
            if (pattern) lines.push(`查找：\n${String(pattern)}`);
            if (glob) lines.push(`文件：\n${String(glob)}`);
            if (path) lines.push(`目录：\n${String(path)}`);
            return lines.join('\n');
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
            if (prevStatus == null) continue; // skip ambiguous duplicates
            const nextStatus = nextByContent.get(content);
            if (nextStatus == null) continue; // missing or ambiguous duplicates
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

    createTodoListElement(todos, prevTodos = null) {
        const todoDiv = document.createElement('div');
        todoDiv.className = 'todo-list';
        todoDiv.innerHTML = this.renderTodoListHtml(todos, prevTodos);
        return todoDiv;
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

    addRunStatus(status, runId, text) {
        const statusDiv = document.createElement('div');
        statusDiv.className = `run-status ${status}`;
        if (runId) statusDiv.dataset.runId = runId;
        statusDiv.innerHTML = status === 'running' ? `
            <div class="spinner"></div>
            <span>${text}</span>
        ` : `<span>${text}</span>`;
        this.elements.messages.appendChild(statusDiv);

        if (runId) this.runStatusElements.set(runId, statusDiv);
        this.currentRunStatusElement = statusDiv;
    }

    getRunStatusElement(runId) {
        if (!runId) return null;
        if (this.runStatusElements.has(runId)) {
            return this.runStatusElements.get(runId);
        }
        const nodes = this.elements.messages.querySelectorAll(`.run-status[data-run-id="${runId}"]`);
        if (nodes.length > 0) {
            const [first, ...rest] = Array.from(nodes);
            rest.forEach(node => node.remove());
            this.runStatusElements.set(runId, first);
            return first;
        }
        return null;
    }

    finalizeStaleRunStatuses(activeRunId) {
        const statusNodes = this.elements.messages.querySelectorAll('.run-status.running, .run-status.queued');
        statusNodes.forEach(node => {
            const nodeRunId = node.dataset.runId || '';
            if (activeRunId && nodeRunId === activeRunId) return;
            node.className = 'run-status completed';
            node.innerHTML = `<span>${this.formatRunStatus('completed')}</span>`;
            if (nodeRunId) this.runStatusElements.delete(nodeRunId);
        });
    }

    syncRunStatusElement(runId, status, { createIfMissing = false } = {}) {
        if (!runId || !status) return;
        const existing = this.getRunStatusElement(runId);
        const isRunning = status === 'running';
        const label = isRunning
            ? `运行中：${runId.slice(0, 8)}`
            : this.formatRunStatus(status);

        if (existing) {
            existing.className = `run-status ${status}`;
            existing.innerHTML = isRunning
                ? `<div class="spinner"></div><span>${label}</span>`
                : `<span>${label}</span>`;
            this.currentRunStatusElement = existing;
            return;
        }
        if (createIfMissing) {
            this.addRunStatus(status, runId, label);
        }
    }

    addLogMessage(level, message, runId = null) {
        const targetRunId = runId || this.currentRunId || null;
        const state = targetRunId ? this.getRunState(targetRunId) : null;
        this.closeAssistantSegment(state);
        const logDiv = document.createElement('div');
        logDiv.className = `log-message ${level}`;
        logDiv.textContent = `[${this.formatLogLevel(level)}] ${message}`;

        let messageElement = null;
        if (targetRunId && state) {
            messageElement = this.getOrCreateRunMessageElement(targetRunId, state);
        }
        if (!messageElement) {
            if (!this.currentMessageElement) {
                this.currentMessageElement = this.createMessageElement('assistant');
                this.elements.messages.appendChild(this.currentMessageElement);
            }
            messageElement = this.currentMessageElement;
        }

        const contentElement = messageElement.querySelector('.message-text');
        contentElement.appendChild(logDiv);

        if (!state || state.chatId === this.activeChatId) {
            this.scrollToBottom();
        }
        return logDiv;
    }

    showReconnectNotice(attempt, total) {
        const message = `正在重连…（${attempt}/${total}）`;
        if (this.reconnectLogElement && this.reconnectLogElement.isConnected) {
            this.reconnectLogElement.textContent = `[${this.formatLogLevel('info')}] ${message}`;
            return;
        }
        this.reconnectLogElement = this.addLogMessage('info', message);
        if (this.reconnectLogElement) {
            this.reconnectLogElement.dataset.transient = 'reconnect';
        }
    }

    hideReconnectNotice() {
        if (this.reconnectLogElement && this.reconnectLogElement.isConnected) {
            const messageElement = this.reconnectLogElement.closest('.message');
            this.reconnectLogElement.remove();
            if (messageElement) {
                const content = messageElement.querySelector('.message-text');
                const hasContent = content && (content.children.length > 0 || content.textContent.trim().length > 0);
                if (!hasContent) {
                    messageElement.remove();
                    if (this.currentMessageElement === messageElement) {
                        this.currentMessageElement = null;
                    }
                }
            }
        }
        this.reconnectLogElement = null;
    }

    // Interrupt Modal
    showInterruptModal(request, interruptId, runId) {
        const actionRequests = request.action_requests || [];

        this.elements.interruptModalBody.innerHTML = actionRequests.map((action, index) => `
            <div class="interrupt-action">
                <div class="interrupt-action-header">
                    <svg class="interrupt-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                    <div>
                        <div class="interrupt-action-name">${this.escapeHtml(action.name || '工具')}</div>
                        ${action.description ? `<div class="interrupt-action-description">${this.escapeHtml(action.description)}</div>` : ''}
                    </div>
                </div>
                ${action.args ? `
                    <div class="interrupt-action-args">
                        <pre>${this.escapeHtml(JSON.stringify(action.args, null, 2))}</pre>
                    </div>
                ` : ''}
            </div>
        `).join('');

        this.elements.interruptModalFooter.innerHTML = `
            <button class="btn btn-danger" onclick="app.respondToInterrupt('${interruptId}', '${runId}', 'reject')">全部拒绝</button>
            <button class="btn btn-primary" onclick="app.respondToInterrupt('${interruptId}', '${runId}', 'approve')">全部批准</button>
        `;

        this.elements.interruptModal.classList.add('active');
    }

    respondToInterrupt(interruptId, runId, decision) {
        const decisions = [{ type: decision }];

        this.send({
            type: 'interrupt_response',
            run_id: runId,
            interrupt_id: interruptId,
            response: { decisions }
        });

        this.elements.interruptModal.classList.remove('active');

        // Remove from pending
        this.pendingInterrupts = this.pendingInterrupts.filter(
            i => i.interrupt_id !== interruptId
        );
    }

    // Message Sending
    sendMessage() {
        const input = this.elements.userInput.value.trim();
        if (!input || this.isRunning) return;

        // Add user message to UI
        const userMessage = this.createMessageElement('user');
        userMessage.querySelector('.message-text').textContent = input;
        this.elements.messages.appendChild(userMessage);

        // Clear input
        this.elements.userInput.value = '';
        this.adjustTextareaHeight();
        this.updateSendButton();

        // Hide welcome message
        this.elements.welcomeMessage.style.display = 'none';

        // Reset current message element
        this.currentMessageElement = null;
        this.currentAssistantSegmentElement = null;
        this.currentAssistantSegmentText = '';

        // Send to server
        const runId = this.generateRunId();
        this.currentRunId = runId;
        this.currentRunStatus = 'queued';
        if (!this.activeChatId) {
            this.activeChatId = this.generateTaskId();
        }
        this.runIdToChatId.set(runId, this.activeChatId);
        this.saveCurrentChat({ status: 'queued', runId, title: input });
        this.send({
            type: 'run',
            input: input,
            run_id: runId
        });

        this.scrollToBottom();
    }

    cancelRun() {
        if (!this.isRunning) return;

        this.send({ type: 'cancel' });
        this.addLogMessage('info', '正在取消当前任务…');
    }

    newChat() {
        this.backgroundCurrentChat('new_chat');
        this.resetChatView();
        this.activeChatId = this.generateTaskId();
        this.currentRunId = null;
        this.currentRunStatus = null;
        this.isRunning = false;
        this.pendingSessionSwitch = null;
        this.updateCancelButton(false);
        this.updateSendButton();
        this.elements.chatTitle.textContent = '新对话';
        this.elements.welcomeMessage.style.display = 'flex';

        this.disconnectWebSocket({ allowReconnect: false });
        this.createSession();
    }

    resetChatView() {
        this.elements.messages.innerHTML = '';
        this.currentMessageElement = null;
        this.currentAssistantSegmentElement = null;
        this.currentAssistantSegmentText = '';
        this.currentToolCalls.clear();
        this.runStatusElements.clear();
        this.currentRunStatusElement = null;
        this.todoState = null;
        this.pendingInterrupts = [];
        this.hideReconnectNotice();
        if (this.typingIndicator) {
            this.typingIndicator.remove();
            this.typingIndicator = null;
        }
        if (this.elements.interruptModal.classList.contains('active')) {
            this.elements.interruptModal.classList.remove('active');
        }
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
            return true;
        }
        this.pendingMessages.push(data);
        this.ensureConnection();
        if (this.pendingMessages.length > 50) {
            this.pendingMessages = this.pendingMessages.slice(-50);
        }
        if (!this.ws || this.ws.readyState !== WebSocket.CONNECTING) {
            console.warn('WebSocket 未连接，消息未发送：', data);
        }
        return false;
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

    // UI Updates
    updateConnectionStatus(status) {
        const statusElement = this.elements.connectionStatus;
        statusElement.className = `connection-status ${status}`;

        const textElement = statusElement.querySelector('.status-text');
        textElement.textContent = this.formatConnectionStatus(status);
    }

    updateCancelButton(enabled) {
        this.elements.cancelBtn.disabled = !enabled;
    }

    updateSendButton() {
        const btn = this.elements.sendBtn;
        const hasText = this.elements.userInput.value.trim().length > 0;

        if (this.isRunning) {
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
        const textarea = this.elements.userInput;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }

    scrollToBottom() {
        // Auto-scroll disabled by request.
    }

    isActiveRunStatus(status) {
        return status === 'running' || status === 'queued';
    }

    getHistoryStatusLabel(status) {
        if (this.isActiveRunStatus(status)) return '进行中';
        return '';
    }

    normalizeTaskId(rawId) {
        const value = rawId == null ? '' : String(rawId).trim();
        if (!value) return this.generateTaskId();
        if (value.startsWith('task_')) return value;
        return `task_${value}`;
    }

    normalizeHistoryEntry(chat) {
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

    // History Management
    loadHistory() {
        const stored = localStorage.getItem('deepagents_chat_history');
        if (!stored) return [];
        try {
            const parsed = JSON.parse(stored);
            if (!Array.isArray(parsed)) return [];
            return parsed.map(item => this.normalizeHistoryEntry(item)).filter(Boolean);
        } catch {
            return [];
        }
    }

    saveHistory() {
        localStorage.setItem('deepagents_chat_history', JSON.stringify(this.chatHistory));
    }

    collectCurrentMessages() {
        return Array.from(this.elements.messages.children).map(msg => {
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
        if (id) {
            const normalizedId = this.normalizeTaskId(id);
            const byId = this.chatHistory.findIndex(c => c.id === normalizedId);
            if (byId >= 0) return byId;
        }
        if (runId) {
            return this.chatHistory.findIndex(c => c.runId === runId);
        }
        return -1;
    }

    resolveChatIdForRun(runId) {
        if (runId && this.runIdToChatId.has(runId)) {
            return this.runIdToChatId.get(runId);
        }
        if (this.activeChatId) return this.activeChatId;
        if (!runId) return null;
        const index = this.findChatIndex({ runId });
        if (index >= 0) return this.chatHistory[index].id;
        return null;
    }

    upsertChatRecord(chat, { promote = false } = {}) {
        const now = Date.now();
        const normalizedId = this.normalizeTaskId(chat.id || chat.taskId || chat.runId || now);
        const index = this.findChatIndex({ id: normalizedId, runId: chat.runId });
        const existing = index >= 0 ? this.chatHistory[index] : null;
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
            sessionId: chat.sessionId || existing?.sessionId || null,
            status: chat.status || existing?.status || null,
            createdAt: existing?.createdAt || chat.createdAt || now,
            timestamp: now,
            title: nextTitle,
            messages: nextMessages,
        };

        if (index >= 0) {
            this.chatHistory.splice(index, 1, next);
        } else if (promote) {
            this.chatHistory.unshift(next);
        } else {
            this.chatHistory.push(next);
        }
        if (next.runId) {
            this.runIdToChatId.set(next.runId, next.id);
        }
        this.chatHistory = this.chatHistory.slice(0, 50);
        this.saveHistory();
        this.renderHistory();
    }

    updateChatStatus(runId, status) {
        const chatId = this.resolveChatIdForRun(runId);
        if (!chatId) return;
        this.upsertChatRecord({
            id: chatId,
            taskId: chatId,
            runId: runId || this.currentRunId,
            sessionId: this.sessionId,
            status: status,
        });
    }

    backgroundCurrentChat(reason) {
        if (!this.activeChatId) return;
        const messages = this.collectCurrentMessages();
        if (!messages.length) return;
        const chat = this.chatHistory.find(c => c.id === this.activeChatId);
        const activeRunId = this.currentRunId && this.resolveChatIdForRun(this.currentRunId) === this.activeChatId
            ? this.currentRunId
            : (chat?.runId || null);
        const status = chat?.status || this.currentRunStatus || (this.isRunning ? 'running' : null);
        this.saveCurrentChat({ status, runId: activeRunId });
    }

    saveCurrentChat({ status = null, runId = null, title = null } = {}) {
        const messages = this.collectCurrentMessages();
        if (messages.length === 0) return;

        const chatId = this.activeChatId || this.generateTaskId();
        this.activeChatId = chatId;

        const inferredRunId = this.currentRunId && this.resolveChatIdForRun(this.currentRunId) === chatId
            ? this.currentRunId
            : null;
        const nextStatus = status || this.currentRunStatus || (this.isRunning ? 'running' : null);
        const existingIndex = this.findChatIndex({ id: chatId, runId });
        const existing = existingIndex >= 0 ? this.chatHistory[existingIndex] : null;
        this.upsertChatRecord({
            id: chatId,
            taskId: chatId,
            runId: runId || inferredRunId,
            sessionId: existing?.sessionId || this.sessionId,
            title: title || this.buildChatTitle(messages, null),
            status: nextStatus,
            messages: messages,
        }, { promote: existingIndex < 0 });
    }

    renderHistory() {
        this.elements.historyList.innerHTML = this.chatHistory.map(chat => {
            const statusLabel = this.getHistoryStatusLabel(chat.status);
            const statusHtml = statusLabel
                ? `<span class="history-item-status running">${this.escapeHtml(statusLabel)}</span>`
                : '';
            const activeClass = chat.id === this.activeChatId ? ' active' : '';
            return `
                <div class="history-item${activeClass}" data-chat-id="${chat.id}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <span class="history-item-title">${this.escapeHtml(chat.title || '新对话')}</span>
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

        this.elements.historyList.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.history-delete-btn')) return;
                const chatId = item.getAttribute('data-chat-id');
                this.loadChat(chatId);
            });
        });

        this.elements.historyList.querySelectorAll('.history-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const chatId = btn.getAttribute('data-chat-id');
                this.deleteChat(chatId);
            });
        });
    }

    loadChat(chatId) {
        const chat = this.chatHistory.find(c => c.id === chatId);
        if (!chat) return;
        if (this.isRunning && this.currentRunId && this.currentRunId !== chat.runId) {
            this.backgroundCurrentChat('switch_chat');
        }

        const activeRunId = this.currentRunId;
        const activeRunChatId = activeRunId ? this.resolveChatIdForRun(activeRunId) : null;
        const hasActiveRun = Boolean(activeRunId && this.isActiveRunStatus(this.currentRunStatus));
        const viewingBackgroundRun = hasActiveRun && activeRunChatId && activeRunChatId !== chat.id;

        this.resetChatView();
        this.elements.chatTitle.textContent = chat.title || '对话';
        this.activeChatId = chat.id;
        if (!viewingBackgroundRun) {
            this.currentRunId = chat.runId || null;
            this.currentRunStatus = chat.status || null;
            this.isRunning = this.isActiveRunStatus(chat.status);
        }
        this.updateCancelButton(this.isRunning);
        this.updateSendButton();
        if (chat.runId) {
            this.runIdToChatId.set(chat.runId, chat.id);
        }

        chat.messages.forEach(msg => {
            const messageElement = this.createMessageElement(msg.role);
            const textElement = messageElement.querySelector('.message-text');

            // Use innerHTML for structured content, fallback to textContent
            if (msg.html) {
                textElement.innerHTML = msg.html;
            } else {
                textElement.textContent = msg.content;
            }
            this.elements.messages.appendChild(messageElement);
        });

        this.attachRunMessagesForChat(chat.id);

        const hasMessages = this.elements.messages.children.length > 0;
        this.elements.welcomeMessage.style.display = hasMessages ? 'none' : 'flex';

        const shouldRequestRunStatus = Boolean(chat.runId && this.isActiveRunStatus(chat.status));
        const requestRunStatusId = shouldRequestRunStatus ? chat.runId : null;
        if (chat.sessionId) {
            if (viewingBackgroundRun && chat.sessionId !== this.sessionId) {
                this.pendingSessionSwitch = { sessionId: chat.sessionId, runId: requestRunStatusId, chatId: chat.id };
            } else {
                this.pendingSessionSwitch = null;
                this.switchSession(chat.sessionId, { requestRunStatusId });
            }
        } else {
            this.pendingSessionSwitch = null;
        }

        this.renderHistory();
    }

    deleteChat(chatId) {
        // Remove from history array
        this.chatHistory = this.chatHistory.filter(c => c.id !== chatId);
        if (this.activeChatId === chatId) {
            this.activeChatId = null;
        }
        for (const [runId, mappedChatId] of this.runIdToChatId.entries()) {
            if (mappedChatId === chatId) {
                this.runIdToChatId.delete(runId);
            }
        }
        for (const [runId, state] of this.runStates.entries()) {
            if (state.chatId === chatId) {
                this.runStates.delete(runId);
                this.messageBuffer.delete(runId);
            }
        }

        // Save and re-render
        this.saveHistory();
        this.renderHistory();
    }

    saveConfig() {
        localStorage.setItem('deepagents_config', JSON.stringify({
            autoApprove: this.autoApprove,
            serverUrl: this.serverUrl
        }));
    }

    loadConfig() {
        const stored = localStorage.getItem('deepagents_config');
        if (stored) {
            const config = JSON.parse(stored);
            if (Object.prototype.hasOwnProperty.call(config, 'autoApprove')) {
                this.autoApprove = Boolean(config.autoApprove);
            }
            this.elements.autoApproveToggle.checked = this.autoApprove;
        }
    }

    // Utility Methods
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    encodePathSegments(pathValue) {
        return pathValue.split('/').map(encodeURIComponent).join('/');
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
        const relative = this.getWorkspaceRelativePath(rawPath);
        if (!relative) return null;
        return `${this.serverUrl}/files/${this.encodePathSegments(relative)}`;
    }

    linkifyWorkspacePaths(text) {
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

        const urlPattern = /https?:\/\/[^\s'"<>),]+/g;
        processed = processed.replace(urlPattern, (match) => {
            const url = this.getDownloadUrl(match) || match;
            if (!url.includes('/files/')) return match;
            const label = `下载：${getFileLabel(match)}`;
            return `[${label}](${url})`;
        });

        const pathPattern = /(?:[A-Za-z]:)?[\\/][^\s'"<>),]+?workspace[\\/][^\s'"<>),]+\.[A-Za-z0-9]+|workspace\/[^\s'"<>),]+\.[A-Za-z0-9]+|\.\/[^\s'"<>),]+\.[A-Za-z0-9]+|[^\s'"<>),]+\/[^\s'"<>),]+\.[A-Za-z0-9]+/g;
        processed = processed.replace(pathPattern, (match) => {
            const url = this.getDownloadUrl(match);
            if (!url) return match;
            const label = `下载：${getFileLabel(match)}`;
            return `[${label}](${url})`;
        });

        codeBlocks.forEach((block, index) => {
            processed = processed.replace(`${placeholderPrefix}${index}__`, block);
        });

        return processed;
    }

    parseMarkdown(text) {
        if (typeof marked !== 'undefined') {
            const processedText = this.linkifyWorkspacePaths(text);
            let html = marked.parse(processedText);
            // Wrap all code blocks with collapsible containers
            // This regex matches both <pre><code class="language-xxx"> and <pre><code>
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
        // Format diff with colors
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
        // Check if content is HTML (contains <!DOCTYPE html> or <html tag)
        const isHtml = content.includes('<!DOCTYPE html>') ||
                      content.includes('<html') ||
                      /<html[^>]*>/i.test(content);

        if (isHtml) {
            // Create collapsible HTML preview
            const escapedContent = this.escapeHtml(content);
            const preview = escapedContent.substring(0, 500) + (escapedContent.length > 500 ? '...' : '');
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

        // Default: just escape and display
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

    generateTaskId() {
        return `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }

    generateRunId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
}

// Initialize the application
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new DeepAgentsClient();
});
