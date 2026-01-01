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
        this.currentToolCalls = new Map(); // Track tool calls by ID
        this.sessions = [];
        this.chatHistory = this.loadHistory();

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
                this.sendMessage();
            }
        });

        // Send button
        this.elements.sendBtn.addEventListener('click', () => this.sendMessage());

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
    }

    async createSession() {
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
                throw new Error(`Failed to create session: ${response.statusText}`);
            }

            const data = await response.json();
            this.sessionId = data.session_id;

            // Build WebSocket URL
            const wsProtocol = this.serverUrl.startsWith('https') ? 'wss:' : 'ws:';
            const wsHost = this.serverUrl.replace(/^https?:\/\//, '');
            this.wsUrl = `${wsProtocol}//${wsHost}/ws/${this.sessionId}`;

            // Connect WebSocket
            this.connectWebSocket();

        } catch (error) {
            console.error('Failed to create session:', error);
            this.addLogMessage('error', `Failed to connect to server: ${error.message}`);
            this.updateConnectionStatus('disconnected');
        }
    }

    connectWebSocket() {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.updateConnectionStatus('connected');
            this.reconnectAttempts = 0;
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (error) {
                console.error('Failed to parse message:', error);
            }
        };

        this.ws.onclose = () => {
            console.log('WebSocket closed');
            this.updateConnectionStatus('disconnected');
            this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.updateConnectionStatus('disconnected');
        };
    }

    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Attempting to reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            this.addLogMessage('info', `Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

            setTimeout(() => {
                this.connectWebSocket();
            }, this.reconnectDelay);
        } else {
            this.addLogMessage('error', 'Failed to reconnect. Please refresh the page.');
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
                console.log('Unknown event type:', eventType, data);
        }
    }

    handleRunQueued(data) {
        console.log('Run queued:', data.run_id);
    }

    handleRunStarted(data) {
        console.log('Run started:', data.run_id);
        this.currentRunId = data.run_id;
        this.isRunning = true;
        this.updateCancelButton(true);
        this.messageBuffer.set(data.run_id, '');

        // Hide welcome message
        this.elements.welcomeMessage.style.display = 'none';

        // Add run status indicator
        this.addRunStatus('running', `Running: ${data.run_id.slice(0, 8)}`);
    }

    handleRunEnded(data) {
        const status = data.type.split('.')[1];
        console.log('Run ended:', status, data);

        if (data.run_id) {
            this.messageBuffer.delete(data.run_id);
        }
        this.currentRunId = null;
        this.isRunning = false;
        this.updateCancelButton(false);

        // Update run status
        const statusElement = document.querySelector('.run-status');
        if (statusElement) {
            statusElement.className = `run-status ${status}`;
            statusElement.innerHTML = `<span>${status.charAt(0).toUpperCase() + status.slice(1)}</span>`;
        }

        // Save to history
        this.saveCurrentChat();

        // Remove typing indicator
        if (this.typingIndicator) {
            this.typingIndicator.remove();
            this.typingIndicator = null;
        }
    }

    handleAssistantDelta(data) {
        const text = data.text;
        if (!text) return;

        const runId = data.run_id || this.currentRunId || 'default';
        const currentText = this.messageBuffer.get(runId) || '';
        const nextText = currentText + text;
        this.messageBuffer.set(runId, nextText);

        // Get or create current message element
        if (!this.currentMessageElement) {
            this.currentMessageElement = this.createMessageElement('assistant');
            this.elements.messages.appendChild(this.currentMessageElement);
        }

        const markdownElement = this.getOrCreateAssistantMarkdownElement(this.currentMessageElement);
        markdownElement.innerHTML = this.parseMarkdown(nextText);

        this.scrollToBottom();
    }

    handleAssistantMessage(data) {
        const text = data.text;
        if (!text) return;

        const runId = data.run_id || this.currentRunId || 'default';
        this.messageBuffer.set(runId, text);

        if (!this.currentMessageElement) {
            this.currentMessageElement = this.createMessageElement('assistant');
            this.elements.messages.appendChild(this.currentMessageElement);
        }

        const markdownElement = this.getOrCreateAssistantMarkdownElement(this.currentMessageElement);
        markdownElement.innerHTML = this.parseMarkdown(text);

        this.scrollToBottom();
    }

    handleToolCallStarted(data) {
        const { tool_name, args, tool_call_id } = data;

        // Create tool call element
        const toolElement = this.createToolCallElement({
            name: tool_name,
            args: args,
            id: tool_call_id,
            status: 'running'
        });

        // Append to current message or create new one
        if (!this.currentMessageElement) {
            this.currentMessageElement = this.createMessageElement('assistant');
            this.elements.messages.appendChild(this.currentMessageElement);
        }

        const contentElement = this.currentMessageElement.querySelector('.message-text');
        contentElement.appendChild(toolElement);

        // Store reference
        if (tool_call_id) {
            this.currentToolCalls.set(tool_call_id, toolElement);
        }

        this.scrollToBottom();
    }

    handleToolCallEnded(data) {
        const { tool_name, status, tool_call_id, content_preview } = data;

        if (tool_call_id && this.currentToolCalls.has(tool_call_id)) {
            const toolElement = this.currentToolCalls.get(tool_call_id);

            // Update status
            const statusElement = toolElement.querySelector('.tool-status');
            if (statusElement) {
                statusElement.className = `tool-status ${status}`;
                statusElement.textContent = status;
            }

            // Add result if available
            if (content_preview) {
                const bodyElement = toolElement.querySelector('.tool-call-body');
                if (bodyElement && !bodyElement.querySelector('.tool-result')) {
                    const resultElement = document.createElement('div');
                    resultElement.className = 'tool-result';
                    resultElement.innerHTML = `
                        <div class="tool-result-label">Result</div>
                        <div class="tool-result-content">${this.formatToolResult(content_preview)}</div>
                    `;
                    bodyElement.appendChild(resultElement);
                }
            }
        }

        this.currentToolCalls.delete(tool_call_id);
    }

    handleFileOp(data) {
        const { tool_name, path, status, error, metrics, diff } = data;

        const fileOpElement = this.createFileOpElement({
            toolName: tool_name,
            path: path,
            status: status,
            error: error,
            metrics: metrics,
            diff: diff
        });

        if (!this.currentMessageElement) {
            this.currentMessageElement = this.createMessageElement('assistant');
            this.elements.messages.appendChild(this.currentMessageElement);
        }

        const contentElement = this.currentMessageElement.querySelector('.message-text');
        contentElement.appendChild(fileOpElement);

        this.scrollToBottom();
    }

    handleTodosUpdated(data) {
        const todos = data.todos;
        if (!todos || !Array.isArray(todos)) return;

        // Create or update todo list
        let todoElement = this.currentMessageElement?.querySelector('.todo-list');

        if (!todoElement) {
            if (!this.currentMessageElement) {
                this.currentMessageElement = this.createMessageElement('assistant');
                this.elements.messages.appendChild(this.currentMessageElement);
            }

            todoElement = this.createTodoListElement(todos);
            const contentElement = this.currentMessageElement.querySelector('.message-text');
            contentElement.appendChild(todoElement);
        } else {
            // Update existing todo list
            todoElement.innerHTML = `
                <div class="todo-list-header">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 11l3 3L22 4"></path>
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                    </svg>
                    <span>Tasks</span>
                </div>
                <div class="todo-items">
                    ${todos.map(todo => this.createTodoItemHTML(todo)).join('')}
                </div>
            `;
        }

        this.scrollToBottom();
    }

    handleInterruptRequest(data) {
        const { interrupt_id, request } = data;
        console.log('Interrupt request:', interrupt_id, request);

        this.pendingInterrupts.push({ interrupt_id, request, run_id: data.run_id });
        this.showInterruptModal(request, interrupt_id, data.run_id);
    }

    handleInterruptAutoApproved(data) {
        this.addLogMessage('info', `Auto-approved: ${data.interrupt_id.slice(0, 8)}`);
    }

    handleSessionAutoApprove(data) {
        this.autoApprove = data.enabled;
        this.elements.autoApproveToggle.checked = data.enabled;
    }

    handleLog(data) {
        const { level, message } = data;
        this.addLogMessage(level || 'info', message);
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

    getOrCreateAssistantMarkdownElement(messageElement) {
        const contentElement = messageElement.querySelector('.message-text');
        let markdownElement = contentElement.querySelector('.assistant-markdown');
        if (!markdownElement) {
            markdownElement = document.createElement('div');
            markdownElement.className = 'assistant-markdown';
            contentElement.prepend(markdownElement);
        }
        return markdownElement;
    }

    createToolCallElement({ name, args, id, status }) {
        const toolDiv = document.createElement('div');
        toolDiv.className = 'tool-call';
        toolDiv.setAttribute('data-tool-id', id);

        const argsJson = typeof args === 'string' ? args : JSON.stringify(args, null, 2);

        toolDiv.innerHTML = `
            <div class="tool-call-header" onclick="this.parentElement.classList.toggle('expanded')">
                <svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M12 1v6m0 6v6"></path>
                    <path d="m1 12h6m6 0h6"></path>
                </svg>
                <span class="tool-name">${this.escapeHtml(name)}</span>
                <span class="tool-status ${status}">${status}</span>
                <svg class="tool-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
            </div>
            <div class="tool-call-body">
                <div class="tool-args">
                    <div class="tool-args-label">Arguments</div>
                    <div class="tool-args-content">${this.escapeHtml(argsJson)}</div>
                </div>
            </div>
        `;

        return toolDiv;
    }

    createFileOpElement({ toolName, path, status, error, metrics, diff }) {
        const fileOpDiv = document.createElement('div');
        const hasBody = Boolean(metrics || diff);
        fileOpDiv.className = hasBody ? 'file-operation expanded' : 'file-operation';

        // Check if file is PDF
        const isPdf = path.toLowerCase().endsWith('.pdf');

        const metricsHtml = metrics ? `
            <div class="file-op-metrics">
                ${metrics.lines_read ? `<span>Read: ${metrics.lines_read} lines</span>` : ''}
                ${metrics.lines_written ? `<span>Written: ${metrics.lines_written} lines</span>` : ''}
                ${metrics.lines_added ? `<span>+${metrics.lines_added}</span>` : ''}
                ${metrics.lines_removed ? `<span>-${metrics.lines_removed}</span>` : ''}
                ${metrics.bytes_written ? `<span>Size: ${this.formatFileSize(metrics.bytes_written)}</span>` : ''}
            </div>
        ` : '';

        const diffHtml = diff ? `
            <div class="file-op-diff">
                <pre>${this.formatDiff(diff)}</pre>
            </div>
        ` : '';

        // Add download button for PDF files
        const downloadButtonHtml = isPdf ? `
            <a href="${this.escapeHtml(path)}" download class="file-download-btn" onclick="event.stopPropagation()">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                Download PDF
            </a>
        ` : '';

        const chevronHtml = hasBody ? `
            <svg class="file-op-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
        ` : '';

        const bodyHtml = hasBody ? `
            <div class="file-operation-body">
                ${metricsHtml}
                ${diffHtml}
            </div>
        ` : '';

        fileOpDiv.innerHTML = `
            <div class="file-operation-header" ${hasBody ? "onclick=\"this.parentElement.classList.toggle('expanded')\"" : ''}>
                <svg class="file-op-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                    <polyline points="13 2 13 9 20 9"></polyline>
                </svg>
                <span class="file-op-path">${this.escapeHtml(path)}</span>
                <span class="file-op-status ${status}">${status}</span>
                ${downloadButtonHtml}
                ${chevronHtml}
            </div>
            ${bodyHtml}
        `;

        return fileOpDiv;
    }

    createTodoListElement(todos) {
        const todoDiv = document.createElement('div');
        todoDiv.className = 'todo-list';
        todoDiv.innerHTML = `
            <div class="todo-list-header">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 11l3 3L22 4"></path>
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                </svg>
                <span>Tasks</span>
            </div>
            <div class="todo-items">
                ${todos.map(todo => this.createTodoItemHTML(todo)).join('')}
            </div>
        `;
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

    addRunStatus(status, text) {
        const statusDiv = document.createElement('div');
        statusDiv.className = `run-status ${status}`;
        statusDiv.innerHTML = status === 'running' ? `
            <div class="spinner"></div>
            <span>${text}</span>
        ` : `<span>${text}</span>`;
        this.elements.messages.appendChild(statusDiv);
    }

    addLogMessage(level, message) {
        const logDiv = document.createElement('div');
        logDiv.className = `log-message ${level}`;
        logDiv.textContent = `[${level.toUpperCase()}] ${message}`;

        if (!this.currentMessageElement) {
            this.currentMessageElement = this.createMessageElement('assistant');
            this.elements.messages.appendChild(this.currentMessageElement);
        }

        const contentElement = this.currentMessageElement.querySelector('.message-text');
        contentElement.appendChild(logDiv);

        this.scrollToBottom();
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
                        <div class="interrupt-action-name">${this.escapeHtml(action.name || 'tool')}</div>
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
            <button class="btn btn-danger" onclick="app.respondToInterrupt('${interruptId}', '${runId}', 'reject')">Reject All</button>
            <button class="btn btn-primary" onclick="app.respondToInterrupt('${interruptId}', '${runId}', 'approve')">Approve All</button>
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

        // Send to server
        const runId = this.generateRunId();
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
        this.addLogMessage('info', 'Cancelling current run...');
    }

    newChat() {
        // Clear messages
        this.elements.messages.innerHTML = '';
        this.currentMessageElement = null;

        // Show welcome message
        this.elements.welcomeMessage.style.display = 'flex';

        // Update title
        this.elements.chatTitle.textContent = 'New Conversation';

        // Reset state
        this.currentRunId = null;
        this.isRunning = false;
        this.messageBuffer.clear();
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        } else {
            console.warn('WebSocket not connected, message not sent:', data);
        }
    }

    // UI Updates
    updateConnectionStatus(status) {
        const statusElement = this.elements.connectionStatus;
        statusElement.className = `connection-status ${status}`;

        const textElement = statusElement.querySelector('.status-text');
        textElement.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    }

    updateCancelButton(enabled) {
        this.elements.cancelBtn.disabled = !enabled;
    }

    updateSendButton() {
        const hasText = this.elements.userInput.value.trim().length > 0;
        this.elements.sendBtn.disabled = !hasText;
    }

    adjustTextareaHeight() {
        const textarea = this.elements.userInput;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }

    scrollToBottom() {
        this.elements.chatContainer.scrollTop = this.elements.chatContainer.scrollHeight;
    }

    // History Management
    loadHistory() {
        const stored = localStorage.getItem('deepagents_chat_history');
        return stored ? JSON.parse(stored) : [];
    }

    saveHistory() {
        localStorage.setItem('deepagents_chat_history', JSON.stringify(this.chatHistory));
    }

    saveCurrentChat() {
        const messages = Array.from(this.elements.messages.children).map(msg => {
            const isUser = msg.classList.contains('message') && msg.classList.contains('user');
            const textElement = msg.querySelector('.message-text');
            return {
                role: isUser ? 'user' : 'assistant',
                content: textElement ? textElement.textContent : '',
                html: textElement ? textElement.innerHTML : ''
            };
        }).filter(m => m.content);

        if (messages.length === 0) return;

        const chat = {
            id: Date.now().toString(),
            sessionId: this.sessionId,
            title: messages[0]?.content?.slice(0, 50) + '...' || 'New Chat',
            timestamp: Date.now(),
            messages: messages
        };

        // Avoid duplicates
        const existingIndex = this.chatHistory.findIndex(c => c.id === chat.id);
        if (existingIndex >= 0) {
            this.chatHistory[existingIndex] = chat;
        } else {
            this.chatHistory.unshift(chat);
        }

        // Keep only last 50 chats
        this.chatHistory = this.chatHistory.slice(0, 50);

        this.saveHistory();
        this.renderHistory();
    }

    renderHistory() {
        this.elements.historyList.innerHTML = this.chatHistory.map(chat => `
            <div class="history-item" data-chat-id="${chat.id}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <span class="history-item-title">${this.escapeHtml(chat.title)}</span>
                <button class="history-delete-btn" data-chat-id="${chat.id}" title="Delete chat">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
            </div>
        `).join('');

        // Add click handlers for loading chat
        this.elements.historyList.querySelectorAll('.history-item').forEach(item => {
            const titleSpan = item.querySelector('.history-item-title');
            titleSpan.addEventListener('click', () => {
                const chatId = item.getAttribute('data-chat-id');
                this.loadChat(chatId);
            });
        });

        // Add click handlers for delete buttons
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

        this.newChat();
        this.elements.chatTitle.textContent = chat.title;

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

        this.elements.welcomeMessage.style.display = 'none';
    }

    deleteChat(chatId) {
        // Remove from history array
        this.chatHistory = this.chatHistory.filter(c => c.id !== chatId);

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

    parseMarkdown(text) {
        if (typeof marked !== 'undefined') {
            let html = marked.parse(text);
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
                        <span>HTML Code (Click to expand)</span>
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

    generateRunId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
}

// Initialize the application
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new DeepAgentsClient();
});
