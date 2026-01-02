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
                throw new Error(`创建会话失败：${response.statusText}`);
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
            console.error('创建会话失败：', error);
            this.addLogMessage('error', `连接服务器失败：${error.message}`);
            this.updateConnectionStatus('disconnected');
        }
    }

    connectWebSocket() {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket 已连接');
            this.updateConnectionStatus('connected');
            this.reconnectAttempts = 0;
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (error) {
                console.error('解析消息失败：', error);
            }
        };

        this.ws.onclose = () => {
            console.log('WebSocket 已断开');
            this.updateConnectionStatus('disconnected');
            this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket 错误：', error);
            this.updateConnectionStatus('disconnected');
        };
    }

    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`正在尝试重连…（${this.reconnectAttempts}/${this.maxReconnectAttempts}）`);
            this.addLogMessage('info', `正在重连…（${this.reconnectAttempts}/${this.maxReconnectAttempts}）`);

            setTimeout(() => {
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
    }

    handleRunStarted(data) {
        console.log('任务开始：', data.run_id);
        this.currentRunId = data.run_id;
        this.isRunning = true;
        this.updateCancelButton(true);
        this.updateSendButton();
        this.messageBuffer.set(data.run_id, '');
        this.currentAssistantSegmentElement = null;
        this.currentAssistantSegmentText = '';

        // Hide welcome message
        this.elements.welcomeMessage.style.display = 'none';

        // Add run status indicator
        this.addRunStatus('running', data.run_id, `运行中：${data.run_id.slice(0, 8)}`);
    }

    handleRunEnded(data) {
        const status = data.type.split('.')[1];
        console.log('任务结束：', status, data);

        const runId = data.run_id || this.currentRunId;

        if (runId) this.messageBuffer.delete(runId);
        this.currentRunId = null;
        this.isRunning = false;
        this.updateCancelButton(false);
        this.updateSendButton();
        this.currentAssistantSegmentElement = null;
        this.currentAssistantSegmentText = '';

        // Update run status
        const statusElement =
            (runId ? this.runStatusElements.get(runId) : null) ||
            this.currentRunStatusElement ||
            Array.from(document.querySelectorAll('.run-status')).pop();
        if (statusElement) {
            statusElement.className = `run-status ${status}`;
            statusElement.innerHTML = `<span>${this.formatRunStatus(status)}</span>`;
        }

        if (runId) this.runStatusElements.delete(runId);
        this.currentRunStatusElement = null;

        // Save to history
        this.saveCurrentChat();

        // Remove typing indicator
        if (this.typingIndicator) {
            this.typingIndicator.remove();
            this.typingIndicator = null;
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
        this.closeAssistantSegment();

        if (tool_call_id && this.currentToolCalls.has(tool_call_id)) {
            const toolElement = this.currentToolCalls.get(tool_call_id);
            this.updateToolCallElement(toolElement, { name: tool_name, args, status: 'running' });
            this.scrollToBottom();
            return;
        }

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
        const { tool_name, status, tool_call_id, content_preview, content } = data;
        const toolContent = typeof content === 'string' && content.length ? content : content_preview;

        let toolElement = null;
        if (tool_call_id && this.currentToolCalls.has(tool_call_id)) {
            toolElement = this.currentToolCalls.get(tool_call_id);
        } else {
            // Fallback: create a tool card even if we missed the started event
            this.closeAssistantSegment();
            toolElement = this.createToolCallElement({
                name: tool_name || 'tool',
                args: {},
                id: tool_call_id,
                status: status || 'success'
            });

            if (!this.currentMessageElement) {
                this.currentMessageElement = this.createMessageElement('assistant');
                this.elements.messages.appendChild(this.currentMessageElement);
            }
            const contentElement = this.currentMessageElement.querySelector('.message-text');
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

        if (tool_call_id) this.currentToolCalls.delete(tool_call_id);
        this.scrollToBottom();
    }

    handleFileOp(data) {
        const { tool_name, path, status, error, metrics, diff, content, content_preview, content_truncated, meta } = data;
        this.closeAssistantSegment();

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
            this.closeAssistantSegment();
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
                <div class="todo-list-header" onclick="this.parentElement.classList.toggle('expanded')">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 11l3 3L22 4"></path>
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                    </svg>
                    <span>任务</span>
                    <svg class="todo-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
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
        this.addLogMessage('info', `已自动批准：${data.interrupt_id.slice(0, 8)}`);
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

    closeAssistantSegment() {
        this.currentAssistantSegmentElement = null;
        this.currentAssistantSegmentText = '';
    }

    getOrCreateAssistantSegmentElement(messageElement) {
        const contentElement = messageElement.querySelector('.message-text');
        if (!this.currentAssistantSegmentElement) {
            const segment = document.createElement('div');
            segment.className = 'assistant-markdown assistant-segment';
            contentElement.appendChild(segment);
            this.currentAssistantSegmentElement = segment;
            this.currentAssistantSegmentText = '';
        }
        return this.currentAssistantSegmentElement;
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

        if (!this.currentMessageElement) {
            this.currentMessageElement = this.createMessageElement('assistant');
            this.elements.messages.appendChild(this.currentMessageElement);
        }

        const segmentElement = this.getOrCreateAssistantSegmentElement(this.currentMessageElement);
        this.currentAssistantSegmentText += appended;
        segmentElement.innerHTML = this.parseMarkdown(this.currentAssistantSegmentText);
        this.scrollToBottom();
    }

    createToolCallElement({ name, args, id, status }) {
        const toolDiv = document.createElement('div');
        toolDiv.className = 'tool-call';
        toolDiv.setAttribute('data-tool-id', id);

        const argsJson = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
        const summary = this.formatToolSummary(name, args);

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

        // Check if file is PDF
        const isPdf = path.toLowerCase().endsWith('.pdf');

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

        // Add download button for PDF files
        const downloadButtonHtml = isPdf ? `
            <a href="${this.escapeHtml(path)}" download class="file-download-btn" onclick="event.stopPropagation()">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                下载 PDF
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
                ${downloadButtonHtml}
                ${chevronHtml}
            </div>
            ${bodyHtml}
        `;

        return fileOpDiv;
    }

    updateToolCallElement(toolElement, { name, args, status }) {
        if (!toolElement) return;

        const headerName = toolElement.querySelector('.tool-name');
        if (headerName && name) headerName.textContent = name;

        const summaryText = this.formatToolSummary(name, args);
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

    formatToolSummary(toolName, args) {
        const name = String(toolName || '');
        const a = args && typeof args === 'object' ? args : {};

        if (name === 'web_search') {
            const query = a.query || a.q || a.text || '';
            return query ? `查询：\n${String(query)}` : '';
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

    createTodoListElement(todos) {
        const todoDiv = document.createElement('div');
        todoDiv.className = 'todo-list';
        todoDiv.innerHTML = `
            <div class="todo-list-header" onclick="this.parentElement.classList.toggle('expanded')">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 11l3 3L22 4"></path>
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                </svg>
                <span>任务</span>
                <svg class="todo-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
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

    addLogMessage(level, message) {
        this.closeAssistantSegment();
        const logDiv = document.createElement('div');
        logDiv.className = `log-message ${level}`;
        logDiv.textContent = `[${this.formatLogLevel(level)}] ${message}`;

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
        // Clear messages
        this.elements.messages.innerHTML = '';
        this.currentMessageElement = null;
        this.currentAssistantSegmentElement = null;
        this.currentAssistantSegmentText = '';

        // Show welcome message
        this.elements.welcomeMessage.style.display = 'flex';

        // Update title
        this.elements.chatTitle.textContent = '新对话';

        // Reset state
        this.currentRunId = null;
        this.isRunning = false;
        this.messageBuffer.clear();
        this.runStatusElements.clear();
        this.currentRunStatusElement = null;
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        } else {
            console.warn('WebSocket 未连接，消息未发送：', data);
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
            title: messages[0]?.content?.slice(0, 50) + '…' || '新对话',
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
                <button class="history-delete-btn" data-chat-id="${chat.id}" title="删除对话">
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

    generateRunId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
}

// Initialize the application
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new DeepAgentsClient();
});
